import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { prisma } from "@/lib/prisma";
import type {
  SynapseDailyAnalysisResponse,
  SynapseSignalsPackResponse,
  SynapseStartBriefResponse,
  SynapseUserModelResponse,
} from "@/lib/services/synapseClient";
import { getResumePacketFromState, type ResumePacket } from "@/lib/services/session/resumePacket";

export function parseBooleanFlag(argv: string[], flag: string) {
  return argv.includes(flag);
}

export async function createQaUser(prefix = "qa_resume_packet_") {
  const suffix = crypto.randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      clerkUserId: `${prefix}${suffix}`,
      email: `${prefix}${suffix}@example.test`,
    },
  });
}

export async function cleanupQaUser(userId: string) {
  await prisma.user.delete({
    where: { id: userId },
  });
}

export async function getPersonaIdBySlug(slug: string) {
  const persona = await prisma.personaProfile.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!persona) {
    throw new Error(`Persona not found for slug: ${slug}`);
  }
  return persona.id;
}

export async function seedSessionConversation(params: {
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
  });

  for (const message of params.messages) {
    await prisma.message.create({
      data: {
        userId: params.userId,
        personaId: params.personaId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt ?? params.now,
      },
    });
  }

  return session;
}

export async function waitForResumePacket(params: {
  userId: string;
  personaId: string;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const stateRow = await prisma.sessionState.findUnique({
      where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
      select: { state: true },
    });
    const packet = getResumePacketFromState(stateRow?.state);
    if (packet) return packet;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

export async function waitForResumePacketWithTiming(params: {
  userId: string;
  personaId: string;
  timeoutMs?: number;
}) {
  const started = Date.now();
  const packet = await waitForResumePacket(params);
  return {
    packet,
    wait_ms: Date.now() - started,
  };
}

export async function readResumePacket(userId: string, personaId: string) {
  const stateRow = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  return getResumePacketFromState(stateRow?.state);
}

export async function clearResumePacket(userId: string, personaId: string) {
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

export async function timeStep<T>(label: string, fn: () => Promise<T>) {
  const started = Date.now();
  const value = await fn();
  return {
    label,
    ms: Date.now() - started,
    value,
  };
}

export function installMockResumePacketSynapse() {
  const counters = {
    startBrief: 0,
    userModel: 0,
    dailyAnalysis: 0,
    signalsPack: 0,
  };

  (globalThis as { __synapseStartBriefOverride?: unknown }).__synapseStartBriefOverride = async () => {
    counters.startBrief += 1;
    const payload: SynapseStartBriefResponse = {
      handover_text: "Continue the roadmap and continuity thread with concrete next steps.",
      narrative: "User is refining continuity, startup speed, and assistant feel.",
      bridgeText: "You were mid-thought on the continuity refactor.",
      resume: {
        use_bridge: true,
        bridge_text: "You were mid-thought on the continuity refactor.",
      },
      time_context: {
        gap_minutes: 45,
        sessions_today: 2,
        first_session_today: false,
        time_of_day: "afternoon",
        local_time: "14:15",
      },
      ops_context: {
        top_loops_today: [
          {
            text: "Ship the faster session-start continuity path",
            type: "OPEN_LOOP",
            time_horizon: "today",
            salience: 0.95,
          },
        ],
        waiting_on: [{ text: "Vercel verification after deploy" }],
        steering_note: "Stay concrete and verify latency improvements.",
      },
      entity_profiles: [
        {
          name: "Ashley",
          profile_text: "Important relationship reference in the user's continuity.",
        },
      ],
      items: [
        {
          kind: "loop",
          text: "Ship the faster session-start continuity path",
          type: "OPEN_LOOP",
          timeHorizon: "today",
          salience: 0.95,
        },
      ],
    };
    return payload;
  };

  (globalThis as { __synapseUserModelOverride?: unknown }).__synapseUserModelOverride = async () => {
    counters.userModel += 1;
    const payload: SynapseUserModelResponse = {
      exists: true,
      model: {
        key_relationships: [{ name: "Ashley" }],
        work_context: { text: "Shipping continuity improvements this week" },
        current_focus: { text: "Reduce request-time session-start latency" },
        north_star: {
          general: { vision: "Build a magical companion product with less maintenance burden" },
        },
        preferences: { tone: "direct, warm" },
        daily_anchors: { walk_goal: 1 },
        recent_signals: [{ text: "Testing infra is becoming more important" }],
      },
    };
    return payload;
  };

  (globalThis as { __synapseDailyAnalysisOverride?: unknown }).__synapseDailyAnalysisOverride = async () => {
    counters.dailyAnalysis += 1;
    const payload: SynapseDailyAnalysisResponse = {
      exists: true,
      steeringNote: "Lead with one concrete next step and avoid overexplaining.",
    };
    return payload;
  };

  (globalThis as { __synapseSignalsPackOverride?: unknown }).__synapseSignalsPackOverride = async () => {
    counters.signalsPack += 1;
    const payload: SynapseSignalsPackResponse = {
      generated_at: new Date().toISOString(),
      session_id: "mock-session",
      classes: {
        identity: [
          {
            id: "sig-1",
            class: "identity",
            text: "User prefers direct communication.",
            confidence: 0.9,
            salience: 0.8,
            sensitivity: "LOW",
            recency_ts: new Date().toISOString(),
            source: "memory",
            surface_policy: null,
          },
        ],
        trajectory: [],
        habits: [],
        momentum: [],
        stale_threads: [],
        today: [],
        open_loops: [],
        state: [],
        relationships: [],
      },
      debug: null,
    };
    return payload;
  };

  return {
    counters,
    reset() {
      counters.startBrief = 0;
      counters.userModel = 0;
      counters.dailyAnalysis = 0;
      counters.signalsPack = 0;
    },
    restore() {
      delete (globalThis as { __synapseStartBriefOverride?: unknown }).__synapseStartBriefOverride;
      delete (globalThis as { __synapseUserModelOverride?: unknown }).__synapseUserModelOverride;
      delete (globalThis as { __synapseDailyAnalysisOverride?: unknown }).__synapseDailyAnalysisOverride;
      delete (globalThis as { __synapseSignalsPackOverride?: unknown }).__synapseSignalsPackOverride;
    },
  };
}

export async function writeHarnessResult(name: string, payload: unknown) {
  const dir = path.join(process.cwd(), "tmp", "synth-results");
  await mkdir(dir, { recursive: true });
  const filename = `${name}-${new Date().toISOString().replaceAll(":", "-")}.json`;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, JSON.stringify(payload, null, 2), "utf8");
  return fullPath;
}

export function summarizePacket(packet: ResumePacket | null) {
  if (!packet) return null;
  return {
    usable: packet.usable,
    quality: packet.quality,
    source: packet.source,
    generated_at: packet.freshness.generated_at,
    bridge_text: packet.bridge_text,
    handover_present: Boolean(packet.handover_text),
    narrative_present: Boolean(packet.narrative),
    items_count: packet.items.length,
    entity_profiles_count: packet.entity_profiles.length,
  };
}
