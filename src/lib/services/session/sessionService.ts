import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import { summarizeSession } from "@/lib/services/session/sessionSummarizer";
import * as synapseClient from "@/lib/services/synapseClient";

const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

function getActiveWindowMs() {
  const raw = env.SESSION_ACTIVE_WINDOW_MS;
  if (!raw) return DEFAULT_ACTIVE_WINDOW_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACTIVE_WINDOW_MS;
  return parsed;
}

function isSummaryEnabled() {
  return env.FEATURE_SESSION_SUMMARY !== "false";
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
            error: ok ? null : "session_ingest_failed",
          },
        });

        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const failedCount = await prisma.synapseIngestTrace.count({
          where: { ok: false, createdAt: { gte: cutoff } },
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
    return prisma.session.create({
      data: {
        userId,
        personaId,
        startedAt: now,
        lastActivityAt: now,
        turnCount: 1,
      },
    });
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

  return prisma.session.create({
    data: {
      userId,
      personaId,
      startedAt: now,
      lastActivityAt: now,
      turnCount: 1,
    },
  });
}

export async function getLatestSessionSummary(userId: string, personaId: string) {
  return prisma.sessionSummary.findFirst({
    where: { userId, personaId },
    orderBy: { createdAt: "desc" },
  });
}
