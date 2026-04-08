import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import { summarizeRollingSessionFromMessages, summarizeSession } from "@/lib/services/session/sessionSummarizer";
import * as synapseClient from "@/lib/services/synapseClient";
import { requestResumePacketRefresh } from "@/lib/services/session/resumePacket";
import { SYNAPSE_CANONICAL_TENANT_ID } from "@/lib/services/synapseTenant";
import { recordTimingProbe } from "@/lib/debug/timingProbe";

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
    tenantId: SYNAPSE_CANONICAL_TENANT_ID,
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
    requestResumePacketRefresh({
      userId: params.userId,
      personaId: params.personaId,
      sourceSessionId: due.sessionId,
      lastSessionEndedAt: due.endedAt,
      reason: "synapse_session_retry_ok",
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
  existingState?: unknown;
  existingRollingSummary?: string | null;
}) {
  const existingState =
    params.existingState !== undefined
      ? params.existingState
      : (
          await prisma.sessionState.findUnique({
            where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
            select: { state: true },
          })
        )?.state;
  const existingRollingSummary =
    params.existingRollingSummary !== undefined
      ? params.existingRollingSummary
      : (
          await prisma.sessionState.findUnique({
            where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
            select: { rollingSummary: true },
          })
        )?.rollingSummary ??
        null;
  const existingSessionId = getRollingSummarySessionId(existingState);
  if (existingRollingSummary === null && existingSessionId === params.sessionId) {
    return { skipped: true as const };
  }
  const nextState = withRollingSummarySessionId(existingState, params.sessionId);
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
  return { skipped: false as const };
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

async function runSynapseSessionIngest(session: {
  id: string;
  userId: string;
  personaId: string;
  startedAt: Date;
  endedAt: Date;
}) {
  if (env.FEATURE_SYNAPSE_SESSION_INGEST !== "true") return;

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
  try {
    const result = await getSynapseSessionIngestWithMeta()({
      tenantId: SYNAPSE_CANONICAL_TENANT_ID,
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
    });
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
    const ms = Date.now() - start;
    const errorText = String(error);
    await prisma.synapseIngestTrace.create({
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
    await enqueueSynapseSessionIngestRetry({
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
    throw error;
  }
}

async function sendSessionClosedEvent(session: {
  id: string;
  userId: string;
  personaId: string;
  startedAt: Date;
  endedAt: Date;
  lastActivityAt: Date;
}) {
  const { inngest } = await import("@/inngest/client");
  console.log("[session.closed.enqueue.start]", {
    sessionId: session.id,
    userId: session.userId,
    personaId: session.personaId,
    endedAt: session.endedAt.toISOString(),
  });
  await inngest.send({
    name: "app/session.closed",
    data: {
      sessionId: session.id,
      userId: session.userId,
      personaId: session.personaId,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
    },
  });
  console.log("[session.closed.enqueue.ok]", {
    sessionId: session.id,
    userId: session.userId,
    personaId: session.personaId,
    endedAt: session.endedAt.toISOString(),
  });
}

export async function runSessionClosedMaintenance(session: {
  id: string;
  userId: string;
  personaId: string;
  startedAt: Date;
  endedAt: Date;
  lastActivityAt: Date;
}) {
  const startedAtMs = Date.now();
  console.log("[session.closed.maintenance.start]", {
    sessionId: session.id,
    userId: session.userId,
    personaId: session.personaId,
    endedAt: session.endedAt.toISOString(),
  });
  const tasks: Promise<unknown>[] = [];

  if (isSummaryEnabled()) {
    tasks.push(
      (async () => {
        const summaryStartedAtMs = Date.now();
        console.log("[session.summary.start]", {
          sessionId: session.id,
          userId: session.userId,
          personaId: session.personaId,
        });
        try {
          await createSessionSummary({
            id: session.id,
            userId: session.userId,
            personaId: session.personaId,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
          });
          console.log("[session.summary.done]", {
            sessionId: session.id,
            userId: session.userId,
            personaId: session.personaId,
            ok: true,
            ms: Date.now() - summaryStartedAtMs,
          });
        } catch (error) {
          console.warn("[session.summary.done]", {
            sessionId: session.id,
            userId: session.userId,
            personaId: session.personaId,
            ok: false,
            ms: Date.now() - summaryStartedAtMs,
            error,
          });
        }
      })()
    );
  }

  if (env.FEATURE_SYNAPSE_SESSION_INGEST === "true") {
    tasks.push(
      (async () => {
        const ingestStartedAtMs = Date.now();
        console.log("[synapse.session.ingest.start]", {
          sessionId: session.id,
          userId: session.userId,
          personaId: session.personaId,
        });
        try {
          await runSynapseSessionIngest(session);
          console.log("[synapse.session.ingest.done]", {
            sessionId: session.id,
            userId: session.userId,
            personaId: session.personaId,
            ok: true,
            ms: Date.now() - ingestStartedAtMs,
          });
        } catch (error) {
          console.warn("[synapse.session.ingest.done]", {
            sessionId: session.id,
            userId: session.userId,
            personaId: session.personaId,
            ok: false,
            ms: Date.now() - ingestStartedAtMs,
            error,
          });
        }
      })()
    );
  }

  await Promise.allSettled(tasks);
  console.log("[session.closed.maintenance.done]", {
    sessionId: session.id,
    userId: session.userId,
    personaId: session.personaId,
    total_ms: Date.now() - startedAtMs,
  });
}

function requestSessionClosedMaintenance(session: {
  id: string;
  userId: string;
  personaId: string;
  startedAt: Date;
  endedAt: Date;
  lastActivityAt: Date;
}) {
  void (async () => {
    if (process.env.NODE_ENV !== "test") {
      requestResumePacketRefresh({
        userId: session.userId,
        personaId: session.personaId,
        sourceSessionId: session.id,
        lastSessionEndedAt: session.endedAt.toISOString(),
        reason: "session_closed_fast_path",
      });
    }
    try {
      if (env.INNGEST_EVENT_KEY || env.INNGEST_DEV === "1") {
        await sendSessionClosedEvent(session);
        return;
      }
    } catch (error) {
      console.warn("[session.closed.enqueue.error]", {
        sessionId: session.id,
        userId: session.userId,
        personaId: session.personaId,
        error,
      });
    }

    await runSessionClosedMaintenance(session);
  })().catch((error) => {
    console.warn("[session.closed.maintenance.error]", {
      sessionId: session.id,
      userId: session.userId,
      personaId: session.personaId,
      error,
    });
  });
}

export async function closeStaleSessionIfAny(
  userId: string,
  personaId: string,
  now: Date,
  lastUserMessageAtOverride?: Date | null
) {
  const cutoff = new Date(now.getTime() - getActiveWindowMs());
  const lastUserMessageAt =
    lastUserMessageAtOverride ??
    (
      await prisma.message.findFirst({
        where: { userId, personaId, role: "user" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      })
    )?.createdAt ??
    null;
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

  requestSessionClosedMaintenance({
    id: updated.id,
    userId: updated.userId,
    personaId: updated.personaId,
    startedAt: updated.startedAt,
    endedAt,
    lastActivityAt: updated.lastActivityAt,
  });

  return updated;
}

type CloseInactiveSessionsBatchParams = {
  now?: Date;
  inactivityMs?: number;
  limit?: number;
  dryRun?: boolean;
};

type CloseInactiveSessionsBatchResult = {
  cutoffIso: string;
  scanned: number;
  closed: number;
  skippedRace: number;
  sessions: Array<{
    sessionId: string;
    userId: string;
    personaId: string;
    lastActivityAt: string;
    endedAt: string;
  }>;
};

const DEFAULT_INACTIVE_CLOSE_MS = 10 * 60 * 1000;
const DEFAULT_INACTIVE_CLOSE_LIMIT = 100;
const MAX_INACTIVE_CLOSE_LIMIT = 500;

export async function closeInactiveSessionsBatch(
  params: CloseInactiveSessionsBatchParams = {}
): Promise<CloseInactiveSessionsBatchResult> {
  const now = params.now ?? new Date();
  const inactivityMs =
    typeof params.inactivityMs === "number" &&
    Number.isFinite(params.inactivityMs) &&
    params.inactivityMs > 0
      ? params.inactivityMs
      : DEFAULT_INACTIVE_CLOSE_MS;
  const requestedLimit =
    typeof params.limit === "number" &&
    Number.isFinite(params.limit) &&
    params.limit > 0
      ? Math.floor(params.limit)
      : DEFAULT_INACTIVE_CLOSE_LIMIT;
  const limit = Math.min(MAX_INACTIVE_CLOSE_LIMIT, requestedLimit);
  const cutoff = new Date(now.getTime() - inactivityMs);
  const dryRun = params.dryRun === true;

  const candidates = await prisma.session.findMany({
    where: {
      endedAt: null,
      lastActivityAt: {
        lte: cutoff,
      },
    },
    orderBy: { lastActivityAt: "asc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      personaId: true,
      startedAt: true,
      lastActivityAt: true,
    },
  });

  let closed = 0;
  let skippedRace = 0;
  const sessions: CloseInactiveSessionsBatchResult["sessions"] = [];

  for (const candidate of candidates) {
    const endedAt = candidate.lastActivityAt;
    if (dryRun) {
      sessions.push({
        sessionId: candidate.id,
        userId: candidate.userId,
        personaId: candidate.personaId,
        lastActivityAt: candidate.lastActivityAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
      continue;
    }

    const update = await prisma.session.updateMany({
      where: {
        id: candidate.id,
        endedAt: null,
      },
      data: {
        endedAt,
      },
    });

    if (update.count === 0) {
      skippedRace += 1;
      continue;
    }

    closed += 1;
    sessions.push({
      sessionId: candidate.id,
      userId: candidate.userId,
      personaId: candidate.personaId,
      lastActivityAt: candidate.lastActivityAt.toISOString(),
      endedAt: endedAt.toISOString(),
    });

    requestSessionClosedMaintenance({
      id: candidate.id,
      userId: candidate.userId,
      personaId: candidate.personaId,
      startedAt: candidate.startedAt,
      endedAt,
      lastActivityAt: candidate.lastActivityAt,
    });
  }

  return {
    cutoffIso: cutoff.toISOString(),
    scanned: candidates.length,
    closed,
    skippedRace,
    sessions,
  };
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

  requestSessionClosedMaintenance({
    id: updated.id,
    userId: updated.userId,
    personaId: updated.personaId,
    startedAt: updated.startedAt,
    endedAt: now,
    lastActivityAt: updated.lastActivityAt,
  });

  return updated;
}

export async function ensureActiveSession(
  userId: string,
  personaId: string,
  now: Date
) {
  const startedAtMs = Date.now();
  void processPendingSynapseSessionIngestRetries({ userId, personaId, now }).catch((error) => {
    console.warn("[synapse.session.ingest.retry.error]", { userId, personaId, error });
  });
  const cutoff = new Date(now.getTime() - getActiveWindowMs());
  const lastUserMessageStartedAtMs = Date.now();
  const lastUserMessage = await prisma.message.findFirst({
    where: { userId, personaId, role: "user" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const lastUserMessageMs = Date.now() - lastUserMessageStartedAtMs;
  const lastUserMessageAt = lastUserMessage?.createdAt ?? null;
  let closeStaleMs = 0;

  if (!lastUserMessageAt) {
    const createSessionStartedAtMs = Date.now();
    const existingSessionStatePromise = prisma.sessionState.findUnique({
      where: { userId_personaId: { userId, personaId } },
      select: { state: true, rollingSummary: true },
    });
    const session = await prisma.session.create({
      data: {
        userId,
        personaId,
        startedAt: now,
        lastActivityAt: now,
        turnCount: 1,
      },
    });
    const createSessionMs = Date.now() - createSessionStartedAtMs;
    const resetSummaryStartedAtMs = Date.now();
    const resetSummaryResult = await resetRollingSummaryForSession({
      userId,
      personaId,
      sessionId: session.id,
      existingState: (await existingSessionStatePromise)?.state,
      existingRollingSummary: (await existingSessionStatePromise)?.rollingSummary ?? null,
    });
    const resetSummaryMs = Date.now() - resetSummaryStartedAtMs;
    recordTimingProbe("ensureActiveSession", {
      path: "create_new_session",
      close_stale_session_ms: closeStaleMs,
      last_user_message_lookup_ms: lastUserMessageMs,
      active_session_lookup_ms: 0,
      create_session_ms: createSessionMs,
      update_session_ms: 0,
      reset_rolling_summary_ms: resetSummaryMs,
      reset_rolling_summary_skipped: resetSummaryResult.skipped,
      total_ms: Date.now() - startedAtMs,
    });
    return session;
  }

  if (lastUserMessageAt < cutoff) {
    const closeStaleStartedAtMs = Date.now();
    await closeStaleSessionIfAny(userId, personaId, now, lastUserMessageAt);
    closeStaleMs = Date.now() - closeStaleStartedAtMs;

    const createSessionStartedAtMs = Date.now();
    const existingSessionStatePromise = prisma.sessionState.findUnique({
      where: { userId_personaId: { userId, personaId } },
      select: { state: true, rollingSummary: true },
    });
    const session = await prisma.session.create({
      data: {
        userId,
        personaId,
        startedAt: now,
        lastActivityAt: now,
        turnCount: 1,
      },
    });
    const createSessionMs = Date.now() - createSessionStartedAtMs;
    const resetSummaryStartedAtMs = Date.now();
    const resetSummaryResult = await resetRollingSummaryForSession({
      userId,
      personaId,
      sessionId: session.id,
      existingState: (await existingSessionStatePromise)?.state,
      existingRollingSummary: (await existingSessionStatePromise)?.rollingSummary ?? null,
    });
    const resetSummaryMs = Date.now() - resetSummaryStartedAtMs;
    recordTimingProbe("ensureActiveSession", {
      path: "create_new_session",
      close_stale_session_ms: closeStaleMs,
      last_user_message_lookup_ms: lastUserMessageMs,
      active_session_lookup_ms: 0,
      create_session_ms: createSessionMs,
      update_session_ms: 0,
      reset_rolling_summary_ms: resetSummaryMs,
      reset_rolling_summary_skipped: resetSummaryResult.skipped,
      total_ms: Date.now() - startedAtMs,
    });
    return session;
  }

  const activeSessionStartedAtMs = Date.now();
  const activeSession = await prisma.session.findFirst({
    where: {
      userId,
      personaId,
      endedAt: null,
    },
    orderBy: { lastActivityAt: "desc" },
    select: { id: true },
  });
  const activeSessionLookupMs = Date.now() - activeSessionStartedAtMs;

  if (activeSession) {
    const updateSessionStartedAtMs = Date.now();
    const updated = await prisma.session.update({
      where: { id: activeSession.id },
      data: {
        lastActivityAt: now,
        turnCount: { increment: 1 },
      },
    });
    const updateSessionMs = Date.now() - updateSessionStartedAtMs;
    recordTimingProbe("ensureActiveSession", {
      path: "update_existing_session",
      close_stale_session_ms: closeStaleMs,
      last_user_message_lookup_ms: lastUserMessageMs,
      active_session_lookup_ms: activeSessionLookupMs,
      create_session_ms: 0,
      update_session_ms: updateSessionMs,
      reset_rolling_summary_ms: 0,
      total_ms: Date.now() - startedAtMs,
    });
    return updated;
  }

  const createSessionStartedAtMs = Date.now();
  const existingSessionStatePromise = prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true, rollingSummary: true },
  });
  const session = await prisma.session.create({
    data: {
      userId,
      personaId,
      startedAt: now,
      lastActivityAt: now,
      turnCount: 1,
    },
  });
  const createSessionMs = Date.now() - createSessionStartedAtMs;
  const resetSummaryStartedAtMs = Date.now();
  const resetSummaryResult = await resetRollingSummaryForSession({
    userId,
    personaId,
    sessionId: session.id,
    existingState: (await existingSessionStatePromise)?.state,
    existingRollingSummary: (await existingSessionStatePromise)?.rollingSummary ?? null,
  });
  const resetSummaryMs = Date.now() - resetSummaryStartedAtMs;
  recordTimingProbe("ensureActiveSession", {
    path: "create_session_after_lookup_miss",
    close_stale_session_ms: closeStaleMs,
    last_user_message_lookup_ms: lastUserMessageMs,
    active_session_lookup_ms: activeSessionLookupMs,
    create_session_ms: createSessionMs,
    update_session_ms: 0,
    reset_rolling_summary_ms: resetSummaryMs,
    reset_rolling_summary_skipped: resetSummaryResult.skipped,
    total_ms: Date.now() - startedAtMs,
  });
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
