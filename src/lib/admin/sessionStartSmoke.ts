import crypto from "node:crypto";

import { prisma } from "@/lib/prisma";
import { clearTimingProbes, getLatestTimingProbe } from "@/lib/debug/timingProbe";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { getResumePacketFromState, refreshResumePacket, type ResumePacket } from "@/lib/services/session/resumePacket";
import { ensureActiveSession } from "@/lib/services/session/sessionService";
import { closeCurrentSessionForClerkUser } from "@/lib/services/session/closeCurrentSession";
import { env } from "@/env";

type SmokeScenario = "session-start" | "repair";

function summarizePacket(packet: ResumePacket | null) {
  if (!packet) return null;
  return {
    usable: packet.usable,
    quality: packet.quality,
    source: packet.source,
    source_session_id: packet.source_session_id,
    has_bridge_text: Boolean(packet.bridge_text),
    has_handover_text: Boolean(packet.handover_text),
    has_narrative: Boolean(packet.narrative),
    items_count: packet.items.length,
    entity_profiles_count: packet.entity_profiles.length,
    updated_at: packet.updated_at,
  };
}

async function createQaUser(prefix = "qa_remote_smoke_") {
  const suffix = crypto.randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      clerkUserId: `${prefix}${suffix}`,
      email: `${prefix}${suffix}@example.test`,
    },
    select: { id: true, email: true, clerkUserId: true },
  });
}

async function getPersonaIdBySlug(slug: string) {
  const persona = await prisma.personaProfile.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!persona) throw new Error(`Persona not found for slug: ${slug}`);
  return persona.id;
}

async function seedSessionConversation(params: {
  userId: string;
  personaId: string;
  sessionStartedAt: Date;
  now: Date;
  messages: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }>;
}) {
  const session = await prisma.session.create({
    data: {
      userId: params.userId,
      personaId: params.personaId,
      startedAt: params.sessionStartedAt,
      lastActivityAt: params.now,
      turnCount: Math.max(1, params.messages.length),
    },
    select: { id: true, startedAt: true, lastActivityAt: true, endedAt: true },
  });

  for (const message of params.messages) {
    await prisma.message.create({
      data: {
        userId: params.userId,
        personaId: params.personaId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt ?? params.now,
        metadata: { sessionId: session.id } as any,
      },
    });
  }

  return session;
}

async function readResumePacket(userId: string, personaId: string) {
  const stateRow = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  return getResumePacketFromState(stateRow?.state);
}

async function clearResumePacket(userId: string, personaId: string) {
  const stateRow = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const base =
    stateRow?.state && typeof stateRow.state === "object" && !Array.isArray(stateRow.state)
      ? { ...(stateRow.state as Record<string, unknown>) }
      : {};
  delete base.resumePacketData;
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId, personaId } },
    update: { state: base as any, updatedAt: new Date() },
    create: { userId, personaId, state: base as any },
  });
}

async function waitForResumePacket(params: {
  userId: string;
  personaId: string;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 15_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const packet = await readResumePacket(params.userId, params.personaId);
    if (packet) {
      return {
        packet,
        wait_ms: Date.now() - started,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return {
    packet: null,
    wait_ms: Date.now() - started,
  };
}

async function waitForSessionIngestTrace(params: {
  sessionId: string;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 15_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const trace = await prisma.synapseIngestTrace.findFirst({
      where: {
        sessionId: params.sessionId,
        role: "session",
      },
      orderBy: { createdAt: "desc" },
      select: {
        ok: true,
        status: true,
        ms: true,
        error: true,
        createdAt: true,
      },
    });
    if (trace) {
      return {
        trace: {
          ok: trace.ok,
          status: trace.status,
          ms: trace.ms,
          error: trace.error,
          createdAt: trace.createdAt.toISOString(),
        },
        wait_ms: Date.now() - started,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    trace: null,
    wait_ms: Date.now() - started,
  };
}

async function timeBuildContext(userId: string, personaId: string, transcript: string) {
  clearTimingProbes("buildContext");
  clearTimingProbes("buildContextFromSynapse");
  const started = Date.now();
  const context = await buildContext(userId, personaId, transcript);
  return {
    duration_ms: Date.now() - started,
    context,
    probes: {
      buildContext: getLatestTimingProbe("buildContext"),
      buildContextFromSynapse: getLatestTimingProbe("buildContextFromSynapse"),
    },
  };
}

async function runSessionStartScenario(userId: string, personaId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { clerkUserId: true },
  });
  if (!user?.clerkUserId) {
    throw new Error("QA user missing clerkUserId for session-start smoke");
  }
  const sessionCloseTime = new Date(Date.now() - 2 * 60_000);
  const seeded = await seedSessionConversation({
    userId,
    personaId,
    sessionStartedAt: new Date(sessionCloseTime.getTime() - 10 * 60_000),
    now: sessionCloseTime,
    messages: [
      {
        role: "user",
        content: "We need fast session-start continuity without live Synapse waits.",
        createdAt: new Date(sessionCloseTime.getTime() - 9 * 60_000),
      },
      {
        role: "assistant",
        content: "Cache one resume packet and derive the handshake view at request time.",
        createdAt: new Date(sessionCloseTime.getTime() - 8 * 60_000),
      },
    ],
  });

  const closeStarted = Date.now();
  const closeResult = await closeCurrentSessionForClerkUser({
    clerkUserId: user.clerkUserId,
    personaId,
    now: sessionCloseTime,
  });
  const closeSessionMs = Date.now() - closeStarted;
  if (!closeResult.closed) {
    throw new Error(`Expected explicit session close to close a session, got ${closeResult.reason ?? "unknown"}`);
  }

  const packetWait = await waitForResumePacket({ userId, personaId, timeoutMs: 20_000 });
  const ingestWait =
    env.FEATURE_SYNAPSE_SESSION_INGEST === "true"
      ? await waitForSessionIngestTrace({ sessionId: seeded.id, timeoutMs: 20_000 })
      : { trace: null, wait_ms: 0 };

  clearTimingProbes("ensureActiveSession");
  const ensureStarted = Date.now();
  await ensureActiveSession(userId, personaId, new Date());
  const ensureActiveSessionMs = Date.now() - ensureStarted;
  const ensureProbe = getLatestTimingProbe("ensureActiveSession");

  const lightweight = await timeBuildContext(userId, personaId, "hi");
  const substantive = await timeBuildContext(
    userId,
    personaId,
    "Can we continue with the roadmap and continuity plan?"
  );
  const refreshedPacket = await readResumePacket(userId, personaId);

  return {
    seeded_session_id: seeded.id,
    timings: {
      close_session_ms: closeSessionMs,
      wait_for_packet_ms: packetWait.wait_ms,
      wait_for_ingest_trace_ms: ingestWait.wait_ms,
      ensure_active_session_ms: ensureActiveSessionMs,
    },
    ensure_active_session_probe: ensureProbe,
    packet: summarizePacket(refreshedPacket),
    ingest_trace: ingestWait.trace,
    lightweight: {
      duration_ms: lightweight.duration_ms,
      probes: lightweight.probes,
      is_session_start: lightweight.context.isSessionStart,
      startbrief_used: lightweight.context.startBrief?.used ?? null,
      startbrief_fetch: lightweight.context.startbriefFetch ?? null,
      bridge_text: lightweight.context.startbriefPacket?.resume?.bridge_text ?? null,
      handover_text: lightweight.context.startbriefPacket?.handover_text ?? null,
    },
    substantive: {
      duration_ms: substantive.duration_ms,
      probes: substantive.probes,
      is_session_start: substantive.context.isSessionStart,
      startbrief_used: substantive.context.startBrief?.used ?? null,
      startbrief_fetch: substantive.context.startbriefFetch ?? null,
      bridge_text: substantive.context.startbriefPacket?.resume?.bridge_text ?? null,
      handover_text: substantive.context.startbriefPacket?.handover_text ?? null,
      deferred_profile_work_context:
        substantive.context.deferredProfileContext?.workContextLine ?? null,
    },
  };
}

async function runRepairScenario(userId: string, personaId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { clerkUserId: true },
  });
  if (!user?.clerkUserId) {
    throw new Error("QA user missing clerkUserId for repair smoke");
  }
  const sessionCloseTime = new Date(Date.now() - 2 * 60_000);
  const sourceSession = await seedSessionConversation({
    userId,
    personaId,
    sessionStartedAt: new Date(sessionCloseTime.getTime() - 10 * 60_000),
    now: sessionCloseTime,
    messages: [
      {
        role: "user",
        content: "We need a reliable session-start repair path if the cached packet is missing.",
        createdAt: new Date(sessionCloseTime.getTime() - 9 * 60_000),
      },
      {
        role: "assistant",
        content: "The first hi should stay fast, then the packet can be repaired and reused.",
        createdAt: new Date(sessionCloseTime.getTime() - 8 * 60_000),
      },
    ],
  });

  const initialClose = await closeCurrentSessionForClerkUser({
    clerkUserId: user.clerkUserId,
    personaId,
    now: sessionCloseTime,
  });
  if (!initialClose.closed) {
    throw new Error(`Expected initial explicit session close, got ${initialClose.reason ?? "unknown"}`);
  }
  const initialWait = await waitForResumePacket({ userId, personaId, timeoutMs: 20_000 });

  await clearResumePacket(userId, personaId);

  clearTimingProbes("ensureActiveSession");
  const ensureFirstStarted = Date.now();
  await ensureActiveSession(userId, personaId, new Date());
  const ensureFirstSessionMs = Date.now() - ensureFirstStarted;
  const ensureFirstProbe = getLatestTimingProbe("ensureActiveSession");
  const lightweight = await timeBuildContext(userId, personaId, "hi");

  const repairStarted = Date.now();
  await refreshResumePacket({
    userId,
    personaId,
    sourceSessionId: sourceSession.id,
    lastSessionEndedAt: sessionCloseTime.toISOString(),
  });
  const repairMs = Date.now() - repairStarted;
  const repairedPacket = await readResumePacket(userId, personaId);

  const closeRepairedStarted = Date.now();
  const repairedClose = await closeCurrentSessionForClerkUser({
    clerkUserId: user.clerkUserId,
    personaId,
    now: new Date(),
  });
  const closeRepairedSessionMs = Date.now() - closeRepairedStarted;
  if (!repairedClose.closed) {
    throw new Error(`Expected repaired explicit session close, got ${repairedClose.reason ?? "unknown"}`);
  }

  clearTimingProbes("ensureActiveSession");
  const ensureSecondStarted = Date.now();
  await ensureActiveSession(userId, personaId, new Date(Date.now() + 5_000));
  const ensureSecondSessionMs = Date.now() - ensureSecondStarted;
  const ensureSecondProbe = getLatestTimingProbe("ensureActiveSession");
  const substantive = await timeBuildContext(
    userId,
    personaId,
    "Can we continue with the cached continuity plan?"
  );

  return {
    initial_packet: summarizePacket(initialWait.packet),
    repaired_packet: summarizePacket(repairedPacket),
    timings: {
      initial_wait_ms: initialWait.wait_ms,
      ensure_first_session_ms: ensureFirstSessionMs,
      repair_ms: repairMs,
      close_repaired_session_ms: closeRepairedSessionMs,
      ensure_second_session_ms: ensureSecondSessionMs,
    },
    ensure_first_session_probe: ensureFirstProbe,
    ensure_second_session_probe: ensureSecondProbe,
    lightweight: {
      duration_ms: lightweight.duration_ms,
      probes: lightweight.probes,
      is_session_start: lightweight.context.isSessionStart,
      startbrief_used: lightweight.context.startBrief?.used ?? null,
      startbrief_fetch: lightweight.context.startbriefFetch ?? null,
      bridge_text: lightweight.context.startbriefPacket?.resume?.bridge_text ?? null,
      handover_text: lightweight.context.startbriefPacket?.handover_text ?? null,
    },
    substantive: {
      duration_ms: substantive.duration_ms,
      probes: substantive.probes,
      is_session_start: substantive.context.isSessionStart,
      startbrief_used: substantive.context.startBrief?.used ?? null,
      startbrief_fetch: substantive.context.startbriefFetch ?? null,
      bridge_text: substantive.context.startbriefPacket?.resume?.bridge_text ?? null,
      handover_text: substantive.context.startbriefPacket?.handover_text ?? null,
    },
  };
}

export async function runRemoteSessionStartSmoke(params?: {
  personaSlug?: string;
  scenario?: SmokeScenario;
}) {
  const personaSlug = params?.personaSlug ?? "creative";
  const scenario = params?.scenario ?? "session-start";
  const personaId = await getPersonaIdBySlug(personaSlug);
  const user = await createQaUser("qa_remote_smoke_");

  const result =
    scenario === "repair"
      ? await runRepairScenario(user.id, personaId)
      : await runSessionStartScenario(user.id, personaId);

  return {
    ok: true,
    scenario,
    maintenance_mode: env.INNGEST_EVENT_KEY || env.INNGEST_DEV === "1" ? "inngest" : "fallback",
    inngest_configured: Boolean(env.INNGEST_EVENT_KEY || env.INNGEST_DEV === "1"),
    synapse_session_ingest_enabled: env.FEATURE_SYNAPSE_SESSION_INGEST === "true",
    user: {
      id: user.id,
      email: user.email,
      clerkUserId: user.clerkUserId,
    },
    persona_slug: personaSlug,
    ...result,
  };
}
