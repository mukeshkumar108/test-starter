import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import { summarizeRollingSessionFromMessages, summarizeSession } from "@/lib/services/session/sessionSummarizer";
import * as synapseClient from "@/lib/services/synapseClient";

const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const ROLLING_SUMMARY_TURN_INTERVAL = 4;
const ROLLING_SUMMARY_RECENT_MESSAGES = 8;
const ROLLING_SUMMARY_SESSION_KEY = "rollingSummarySessionId";

function isRollingSummaryEnabled() {
  return env.FEATURE_ROLLING_SUMMARY !== "false";
}

function getActiveWindowMs() {
  const raw = env.SESSION_ACTIVE_WINDOW_MS;
  if (!raw) return DEFAULT_ACTIVE_WINDOW_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACTIVE_WINDOW_MS;
  return parsed;
}

function isSummaryEnabled() {
  return env.FEATURE_SESSION_SUMMARY === "true";
}

function asStateRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function withRollingSummarySessionId(state: unknown, sessionId: string) {
  const base = asStateRecord(state);
  return {
    ...base,
    [ROLLING_SUMMARY_SESSION_KEY]: sessionId,
  };
}

function getRollingSummarySessionId(state: unknown) {
  const value = asStateRecord(state)[ROLLING_SUMMARY_SESSION_KEY];
  return typeof value === "string" && value.trim() ? value : null;
}

async function resetRollingSummaryForSession(params: {
  userId: string;
  personaId: string;
  sessionId: string;
}) {
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    select: { state: true },
  });
  const nextState = withRollingSummarySessionId(existing?.state, params.sessionId);
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    update: { rollingSummary: null, state: nextState as any, updatedAt: new Date() },
    create: {
      userId: params.userId,
      personaId: params.personaId,
      rollingSummary: null,
      state: nextState as any,
    },
  });
}

async function createSessionSummary(session: {
  id: string;
  userId: string;
  personaId: string;
  startedAt: Date;
  lastActivityAt: Date;
}) {
  const summary = await summarizeSession({
    sessionId: session.id,
    userId: session.userId,
    personaId: session.personaId,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
  });

  if (!summary) return null;

  return prisma.sessionSummary.upsert({
    where: { sessionId: session.id },
    update: {
      summary: summary.summaryJson,
      metadata: {
        source: "auto_session_summary",
        format: "json",
        ...(summary.metadata ?? {}),
      },
      model: summary.model,
    },
    create: {
      sessionId: session.id,
      userId: session.userId,
      personaId: session.personaId,
      summary: summary.summaryJson,
      metadata: {
        source: "auto_session_summary",
        format: "json",
        ...(summary.metadata ?? {}),
      },
      model: summary.model,
    },
  });
}

function getSynapseSessionIngest() {
  const override = (globalThis as { __synapseSessionIngestOverride?: typeof synapseClient.sessionIngest })
    .__synapseSessionIngestOverride;
  return typeof override === "function" ? override : synapseClient.sessionIngest;
}

function getSynapseSessionIngestWithMeta() {
  const override = (globalThis as { __synapseSessionIngestWithMetaOverride?: typeof synapseClient.sessionIngestWithMeta })
    .__synapseSessionIngestWithMetaOverride;
  return typeof override === "function" ? override : synapseClient.sessionIngestWithMeta;
}

async function fireAndForgetSynapseSessionIngest(session: {
  id: string;
  userId: string;
  personaId: string;
  startedAt: Date;
  endedAt: Date;
}) {
  if (env.FEATURE_SYNAPSE_SESSION_INGEST !== "true") return;

  try {
    const messages = await prisma.message.findMany({
      where: {
        userId: session.userId,
        personaId: session.personaId,
        createdAt: {
          gte: session.startedAt,
          lte: session.endedAt,
        },
      },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true, createdAt: true },
    });

    const start = Date.now();
    void getSynapseSessionIngestWithMeta()({
      tenantId: env.SYNAPSE_TENANT_ID,
      userId: session.userId,
      personaId: session.personaId,
      sessionId: session.id,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt.toISOString(),
      messages: messages.map((message) => ({
        role: message.role,
        text: message.content,
        timestamp: message.createdAt.toISOString(),
      })),
    }).then(async (result) => {
      const ms = Date.now() - start;
      const status = result?.status ?? null;
      const ok = Boolean(result?.ok);
      const errorBody = result?.errorBody ?? null;
      console.log("[synapse.session.ingest]", {
        requestId: null,
        role: "session",
        sessionId: session.id,
        status,
        ms,
      });

      try {
        await prisma.synapseIngestTrace.create({
          data: {
            userId: session.userId,
            personaId: session.personaId,
            sessionId: session.id,
            role: "session",
            status,
            ms,
            ok,
            error: ok ? null : errorBody || "session_ingest_failed",
          },
        });

        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const failedCount = await prisma.synapseIngestTrace.count({
          where: {
            ok: false,
            createdAt: { gte: cutoff },
            NOT: { error: "timeout" },
          },
        });
        if (failedCount > 0) {
          console.warn("[synapse.session.ingest.failures.24h]", {
            count: failedCount,
          });
        }
      } catch (error) {
        console.warn("[synapse.session.ingest.trace.error]", { error });
      }
    }).catch((error) => {
      const ms = Date.now() - start;
      console.warn("[synapse.session.ingest.error]", {
        sessionId: session.id,
        error,
      });
      void prisma.synapseIngestTrace.create({
        data: {
          userId: session.userId,
          personaId: session.personaId,
          sessionId: session.id,
          role: "session",
          status: null,
          ms,
          ok: false,
          error: String(error),
        },
      }).catch((traceError) => {
        console.warn("[synapse.session.ingest.trace.error]", { traceError });
      });
    });
  } catch (error) {
    console.warn("[synapse.session.ingest.error]", { sessionId: session.id, error });
  }
}

export async function closeStaleSessionIfAny(
  userId: string,
  personaId: string,
  now: Date
) {
  const cutoff = new Date(now.getTime() - getActiveWindowMs());
  const lastUserMessage = await prisma.message.findFirst({
    where: { userId, personaId, role: "user" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const lastUserMessageAt = lastUserMessage?.createdAt ?? null;
  if (!lastUserMessageAt || lastUserMessageAt >= cutoff) {
    return null;
  }
  const staleSession = await prisma.session.findFirst({
    where: {
      userId,
      personaId,
      endedAt: null,
    },
    orderBy: { lastActivityAt: "desc" },
  });

  if (!staleSession) return null;

  const endedAt = lastUserMessageAt ?? staleSession.lastActivityAt ?? now;
  const updated = await prisma.session.update({
    where: { id: staleSession.id },
    data: { endedAt },
  });

  void fireAndForgetSynapseSessionIngest({
    id: updated.id,
    userId: updated.userId,
    personaId: updated.personaId,
    startedAt: updated.startedAt,
    endedAt,
  });

  if (isSummaryEnabled()) {
    void createSessionSummary({
      id: updated.id,
      userId: updated.userId,
      personaId: updated.personaId,
      startedAt: updated.startedAt,
      lastActivityAt: updated.lastActivityAt,
    }).catch((error) => {
      console.warn("[session.summary] failed", error);
    });
  }

  return updated;
}

export async function closeSessionOnExplicitEnd(
  userId: string,
  personaId: string,
  now: Date
) {
  const activeSession = await prisma.session.findFirst({
    where: { userId, personaId, endedAt: null },
    orderBy: { lastActivityAt: "desc" },
  });

  if (!activeSession) return null;

  const updated = await prisma.session.update({
    where: { id: activeSession.id },
    data: { endedAt: now },
  });

  void fireAndForgetSynapseSessionIngest({
    id: updated.id,
    userId: updated.userId,
    personaId: updated.personaId,
    startedAt: updated.startedAt,
    endedAt: now,
  });

  if (isSummaryEnabled()) {
    void createSessionSummary({
      id: updated.id,
      userId: updated.userId,
      personaId: updated.personaId,
      startedAt: updated.startedAt,
      lastActivityAt: updated.lastActivityAt,
    }).catch((error) => {
      console.warn("[session.summary] failed", error);
    });
  }

  return updated;
}

export async function ensureActiveSession(
  userId: string,
  personaId: string,
  now: Date
) {
  await closeStaleSessionIfAny(userId, personaId, now);
  const cutoff = new Date(now.getTime() - getActiveWindowMs());
  const lastUserMessage = await prisma.message.findFirst({
    where: { userId, personaId, role: "user" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const lastUserMessageAt = lastUserMessage?.createdAt ?? null;
  if (!lastUserMessageAt || lastUserMessageAt < cutoff) {
    const session = await prisma.session.create({
      data: {
        userId,
        personaId,
        startedAt: now,
        lastActivityAt: now,
        turnCount: 1,
      },
    });
    await resetRollingSummaryForSession({ userId, personaId, sessionId: session.id });
    return session;
  }
  const activeSession = await prisma.session.findFirst({
    where: {
      userId,
      personaId,
      endedAt: null,
    },
    orderBy: { lastActivityAt: "desc" },
  });

  if (activeSession) {
    return prisma.session.update({
      where: { id: activeSession.id },
      data: {
        lastActivityAt: now,
        turnCount: { increment: 1 },
      },
    });
  }

  const session = await prisma.session.create({
    data: {
      userId,
      personaId,
      startedAt: now,
      lastActivityAt: now,
      turnCount: 1,
    },
  });
  await resetRollingSummaryForSession({ userId, personaId, sessionId: session.id });
  return session;
}

export async function maybeUpdateRollingSummary(params: {
  sessionId: string;
  userId: string;
  personaId: string;
  turnCount: number;
}) {
  if (!isRollingSummaryEnabled()) return;
  if (params.turnCount % ROLLING_SUMMARY_TURN_INTERVAL !== 0) return;

  const session = await prisma.session.findUnique({
    where: { id: params.sessionId },
    select: { startedAt: true, endedAt: true },
  });
  if (!session) return;

  const messages = await prisma.message.findMany({
    where: {
      userId: params.userId,
      personaId: params.personaId,
      createdAt: {
        gte: session.startedAt,
        lte: session.endedAt ?? new Date(),
      },
    },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true },
  });

  if (messages.length <= ROLLING_SUMMARY_RECENT_MESSAGES) return;

  const olderMessages = messages
    .slice(0, -ROLLING_SUMMARY_RECENT_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  const previous = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    select: { rollingSummary: true, state: true },
  });
  const previousSummary =
    getRollingSummarySessionId(previous?.state) === params.sessionId
      ? previous?.rollingSummary ?? undefined
      : undefined;

  const summary = await summarizeRollingSessionFromMessages({
    messages: olderMessages,
    previousSummary,
  });
  if (!summary) return;
  const nextState = withRollingSummarySessionId(previous?.state, params.sessionId);

  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    update: { rollingSummary: summary, state: nextState as any, updatedAt: new Date() },
    create: {
      userId: params.userId,
      personaId: params.personaId,
      rollingSummary: summary,
      state: nextState as any,
    },
  });
}

export async function getLatestSessionSummary(userId: string, personaId: string) {
  return prisma.sessionSummary.findFirst({
    where: { userId, personaId },
    orderBy: { createdAt: "desc" },
  });
}
