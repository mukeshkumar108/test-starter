import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import { summarizeRollingSessionFromMessages, summarizeSession } from "@/lib/services/session/sessionSummarizer";
import * as synapseClient from "@/lib/services/synapseClient";

const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const ROLLING_SUMMARY_TURN_INTERVAL = 4;
const ROLLING_SUMMARY_RECENT_MESSAGES = 8;
const ROLLING_SUMMARY_SESSION_KEY = "rollingSummarySessionId";
const SYNAPSE_SESSION_RETRY_KEY = "synapseSessionIngestRetry";
const SYNAPSE_SESSION_RETRY_MAX_ATTEMPTS = 3;
const SYNAPSE_SESSION_RETRY_BACKOFF_MS = 60_000;

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

type PendingSynapseSessionIngest = {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  lastAttemptAt: string;
};

type SynapseSessionRetryState = {
  pending: PendingSynapseSessionIngest[];
  lastOk: boolean | null;
  lastError: string | null;
  lastAttemptAt: string | null;
};

function readSynapseSessionRetryState(state: unknown): SynapseSessionRetryState {
  const raw = asStateRecord(asStateRecord(state)[SYNAPSE_SESSION_RETRY_KEY]);
  const pendingRaw = Array.isArray(raw.pending) ? raw.pending : [];
  const pending = pendingRaw
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
      const startedAt = typeof row.startedAt === "string" ? row.startedAt : "";
      const endedAt = typeof row.endedAt === "string" ? row.endedAt : "";
      if (!sessionId || !startedAt || !endedAt) return null;
      const attempts =
        typeof row.attempts === "number" && Number.isFinite(row.attempts)
          ? Math.max(0, Math.floor(row.attempts))
          : 0;
      return {
        sessionId,
        startedAt,
        endedAt,
        attempts,
        nextRetryAt: typeof row.nextRetryAt === "string" ? row.nextRetryAt : null,
        lastError: typeof row.lastError === "string" ? row.lastError : null,
        lastAttemptAt: typeof row.lastAttemptAt === "string" ? row.lastAttemptAt : "",
      } satisfies PendingSynapseSessionIngest;
    })
    .filter((entry): entry is PendingSynapseSessionIngest => Boolean(entry))
    .slice(0, 20);

  return {
    pending,
    lastOk: typeof raw.lastOk === "boolean" ? raw.lastOk : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    lastAttemptAt: typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
  };
}

function withSynapseSessionRetryState(state: unknown, next: SynapseSessionRetryState) {
  const base = asStateRecord(state);
  return {
    ...base,
    [SYNAPSE_SESSION_RETRY_KEY]: {
      pending: next.pending,
      lastOk: next.lastOk,
      lastError: next.lastError,
      lastAttemptAt: next.lastAttemptAt,
    },
  };
}

function parseIsoToMs(value: string | null | undefined) {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function nextRetryIso(now: Date, attempts: number) {
  const delayMs = attempts * SYNAPSE_SESSION_RETRY_BACKOFF_MS;
  return new Date(now.getTime() + delayMs).toISOString();
}

async function enqueueSynapseSessionIngestRetry(params: {
  userId: string;
  personaId: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
  error: string;
}) {
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    select: { state: true },
  });
  const retryState = readSynapseSessionRetryState(existing?.state);
  const now = new Date();
  const prior = retryState.pending.find((row) => row.sessionId === params.sessionId);
  const attempts = Math.min(
    SYNAPSE_SESSION_RETRY_MAX_ATTEMPTS,
    (prior?.attempts ?? 0) + 1
  );
  const nextEntry: PendingSynapseSessionIngest = {
    sessionId: params.sessionId,
    startedAt: params.startedAt.toISOString(),
    endedAt: params.endedAt.toISOString(),
    attempts,
    nextRetryAt:
      attempts >= SYNAPSE_SESSION_RETRY_MAX_ATTEMPTS ? null : nextRetryIso(now, attempts),
    lastError: params.error,
    lastAttemptAt: now.toISOString(),
  };
  const pending = retryState.pending
    .filter((row) => row.sessionId !== params.sessionId)
    .concat(nextEntry)
    .slice(-20);
  const nextState = withSynapseSessionRetryState(existing?.state, {
    pending,
    lastOk: false,
    lastError: params.error,
    lastAttemptAt: now.toISOString(),
  });
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    update: { state: nextState as any, updatedAt: now },
    create: { userId: params.userId, personaId: params.personaId, state: nextState as any },
  });
}

async function processPendingSynapseSessionIngestRetries(params: {
  userId: string;
  personaId: string;
  now: Date;
}) {
  if (env.FEATURE_SYNAPSE_SESSION_INGEST !== "true") return;
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    select: { state: true },
  });
  const retryState = readSynapseSessionRetryState(existing?.state);
  if (retryState.pending.length === 0) return;

  const due = retryState.pending.find((entry) => {
    if (entry.attempts >= SYNAPSE_SESSION_RETRY_MAX_ATTEMPTS) return false;
    const nextMs = parseIsoToMs(entry.nextRetryAt);
    return !Number.isFinite(nextMs) || nextMs <= params.now.getTime();
  });
  if (!due) return;

  const startedAt = new Date(due.startedAt);
  const endedAt = new Date(due.endedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) return;

  const messages = await prisma.message.findMany({
    where: {
      userId: params.userId,
      personaId: params.personaId,
      createdAt: {
        gte: startedAt,
        lte: endedAt,
      },
    },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  });

  const result = await getSynapseSessionIngestWithMeta()({
    tenantId: env.SYNAPSE_TENANT_ID,
    userId: params.userId,
    personaId: params.personaId,
    sessionId: due.sessionId,
    startedAt: due.startedAt,
    endedAt: due.endedAt,
    messages: messages.map((message) => ({
      role: message.role,
      text: message.content,
      timestamp: message.createdAt.toISOString(),
    })),
  });

  const nowIso = params.now.toISOString();
  if (result?.ok) {
    const pending = retryState.pending.filter((entry) => entry.sessionId !== due.sessionId);
    const nextState = withSynapseSessionRetryState(existing?.state, {
      pending,
      lastOk: true,
      lastError: null,
      lastAttemptAt: nowIso,
    });
    await prisma.sessionState.upsert({
      where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
      update: { state: nextState as any, updatedAt: params.now },
      create: { userId: params.userId, personaId: params.personaId, state: nextState as any },
    });
    await prisma.synapseIngestTrace.create({
      data: {
        userId: params.userId,
        personaId: params.personaId,
        sessionId: due.sessionId,
        role: "session_retry",
        status: result.status,
        ms: result.ms,
        ok: true,
        error: null,
      },
    });
    return;
  }

  const reason = result?.errorBody ?? result?.reason ?? "retry_failed";
  const attempts = Math.min(SYNAPSE_SESSION_RETRY_MAX_ATTEMPTS, due.attempts + 1);
  const updatedEntry: PendingSynapseSessionIngest = {
    ...due,
    attempts,
    lastError: reason,
    lastAttemptAt: nowIso,
    nextRetryAt:
      attempts >= SYNAPSE_SESSION_RETRY_MAX_ATTEMPTS ? null : nextRetryIso(params.now, attempts),
  };
  const pending = retryState.pending
    .filter((entry) => entry.sessionId !== due.sessionId)
    .concat(updatedEntry)
    .slice(-20);
  const nextState = withSynapseSessionRetryState(existing?.state, {
    pending,
    lastOk: false,
    lastError: reason,
    lastAttemptAt: nowIso,
  });
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    update: { state: nextState as any, updatedAt: params.now },
    create: { userId: params.userId, personaId: params.personaId, state: nextState as any },
  });
  await prisma.synapseIngestTrace.create({
    data: {
      userId: params.userId,
      personaId: params.personaId,
      sessionId: due.sessionId,
      role: "session_retry",
      status: result?.status ?? null,
      ms: result?.ms ?? null,
      ok: false,
      error: reason,
    },
  });
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
        if (!ok) {
          await enqueueSynapseSessionIngestRetry({
            userId: session.userId,
            personaId: session.personaId,
            sessionId: session.id,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            error: errorBody || "session_ingest_failed",
          });
        }

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
      const errorText = String(error);
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
          error: errorText,
        },
      }).catch((traceError) => {
        console.warn("[synapse.session.ingest.trace.error]", { traceError });
      });
      void enqueueSynapseSessionIngestRetry({
        userId: session.userId,
        personaId: session.personaId,
        sessionId: session.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        error: errorText,
      }).catch((enqueueError) => {
        console.warn("[synapse.session.ingest.retry.enqueue.error]", {
          sessionId: session.id,
          enqueueError,
        });
      });
    });
  } catch (error) {
    console.warn("[synapse.session.ingest.error]", { sessionId: session.id, error });
    void enqueueSynapseSessionIngestRetry({
      userId: session.userId,
      personaId: session.personaId,
      sessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      error: String(error),
    }).catch((enqueueError) => {
      console.warn("[synapse.session.ingest.retry.enqueue.error]", {
        sessionId: session.id,
        enqueueError,
      });
    });
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
  void processPendingSynapseSessionIngestRetries({ userId, personaId, now }).catch((error) => {
    console.warn("[synapse.session.ingest.retry.error]", { userId, personaId, error });
  });
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
