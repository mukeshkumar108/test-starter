import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import * as synapseClient from "@/lib/services/synapseClient";
import type {
  SynapseDailyAnalysisResponse,
  SynapseSignalPackClassName,
  SynapseSignalPackItem,
  SynapseSignalsPackResponse,
  SynapseStartBriefResponse,
  SynapseUserModelResponse,
} from "@/lib/services/synapseClient";
import { SYNAPSE_CANONICAL_TENANT_ID } from "@/lib/services/synapseTenant";

const RESUME_PACKET_DATA_KEY = "resumePacketData";
const RESUME_PACKET_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export type ResumePacket = {
  version: 1;
  updated_at: string;
  user_id: string;
  persona_id: string;
  source_session_id: string | null;
  last_session_ended_at: string | null;
  usable: boolean;
  quality: "usable" | "weak" | "missing";
  source: "synapse_startbrief" | "cached_fallback";
  handover_text: string | null;
  narrative: string | null;
  bridge_text: string | null;
  entity_hints: Array<{
    entity_id: string | null;
    name: string;
    type: string | null;
    role: string | null;
    importance: string | null;
    salience: number | null;
    last_seen_at: string | null;
  }>;
  entity_profiles: Array<{
    name: string;
    profile_text: string;
  }>;
  ops_context: {
    top_loops_today: Array<{
      text: string;
      type: string | null;
      time_horizon: string | null;
      salience: number | null;
    }>;
    waiting_on: Array<{ text: string }>;
    steering_note: string | null;
  };
  items: Array<{
    kind: string;
    text: string;
    type: string | null;
    time_horizon: string | null;
    due_date: string | null;
    salience: number | null;
    last_seen_at: string | null;
  }>;
  profile_snapshot: {
    relationships_line: string | null;
    pattern_line: string | null;
    work_context_line: string | null;
    long_term_direction_line: string | null;
    communication_preference_line: string | null;
    daily_anchors_line: string | null;
    recent_signals_line: string | null;
  } | null;
  daily_analysis_snapshot: {
    steering_note: string | null;
  } | null;
  signal_pack_snapshot: {
    block: string | null;
  } | null;
  freshness: {
    generated_at: string;
    stale_after_ms: number;
  };
};

export type HandshakeView = {
  user_name: string | null;
  time_since_last_session_human: string | null;
  sessions_today: number | null;
  first_session_today: boolean | null;
  time_of_day_label: string | null;
  bridge_hint: string | null;
};

function asStateRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getSynapseStartBrief() {
  const override = (globalThis as { __synapseStartBriefOverride?: typeof synapseClient.sessionStartBrief })
    .__synapseStartBriefOverride;
  return typeof override === "function" ? override : synapseClient.sessionStartBrief;
}

function getSynapseUserModel() {
  const override = (globalThis as { __synapseUserModelOverride?: typeof synapseClient.userModel })
    .__synapseUserModelOverride;
  return typeof override === "function" ? override : synapseClient.userModel;
}

function getSynapseDailyAnalysis() {
  const override = (globalThis as { __synapseDailyAnalysisOverride?: typeof synapseClient.dailyAnalysis })
    .__synapseDailyAnalysisOverride;
  return typeof override === "function" ? override : synapseClient.dailyAnalysis;
}

function getSynapseSignalsPack() {
  const override = (globalThis as { __synapseSignalsPackOverride?: typeof synapseClient.signalsPack })
    .__synapseSignalsPackOverride;
  return typeof override === "function" ? override : synapseClient.signalsPack;
}

function formatList(values: string[]) {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function normalizeUserModelLines(userModel: SynapseUserModelResponse | null) {
  if (!userModel || userModel.exists === false || !userModel.model) {
    return null;
  }

  const model = userModel.model as Record<string, unknown>;
  const relationships = Array.isArray(model.key_relationships)
    ? (model.key_relationships as Array<Record<string, unknown>>)
        .map((entry) => cleanString(entry?.name))
        .filter((value): value is string => Boolean(value))
    : [];
  const patterns = Array.isArray(model.patterns)
    ? (model.patterns as Array<Record<string, unknown>>)
        .map((entry) => cleanString(entry?.text))
        .filter((value): value is string => Boolean(value))
    : [];
  const recentSignals = Array.isArray(model.recent_signals)
    ? (model.recent_signals as Array<Record<string, unknown>>)
        .map((entry) => cleanString(entry?.text))
        .filter((value): value is string => Boolean(value))
    : [];

  const currentFocus = cleanString((model.current_focus as Record<string, unknown> | null)?.text);
  const workContext = cleanString((model.work_context as Record<string, unknown> | null)?.text);
  const dailyAnchors =
    model.daily_anchors && typeof model.daily_anchors === "object"
      ? Object.entries(model.daily_anchors as Record<string, unknown>)
          .map(([key, value]) => {
            const normalized = cleanString(
              typeof value === "number" || typeof value === "boolean" ? String(value) : value
            );
            return normalized ? `${key.replaceAll("_", " ")} ${normalized}` : null;
          })
          .filter((value): value is string => Boolean(value))
      : [];
  const preferences =
    model.preferences && typeof model.preferences === "object"
      ? Object.entries(model.preferences as Record<string, unknown>)
          .map(([key, value]) => {
            const normalized = Array.isArray(value)
              ? formatList(
                  value
                    .map((entry) => cleanString(entry))
                    .filter((entry): entry is string => Boolean(entry))
                )
              : cleanString(typeof value === "boolean" || typeof value === "number" ? String(value) : value);
            return normalized ? `${key.replaceAll("_", " ")}: ${normalized}` : null;
          })
          .filter((value): value is string => Boolean(value))
      : [];

  const northStar = model.north_star && typeof model.north_star === "object"
    ? Object.values(model.north_star as Record<string, unknown>)
        .flatMap((entry) =>
          entry && typeof entry === "object"
            ? [
                cleanString((entry as Record<string, unknown>).vision),
                cleanString((entry as Record<string, unknown>).goal),
              ]
            : []
        )
        .filter((value): value is string => Boolean(value))[0] ?? null
    : null;

  return {
    relationships_line:
      relationships.length > 0 ? `Known relationships: ${relationships.slice(0, 3).join(", ")}.` : null,
    pattern_line: patterns[0] ? `Pattern: ${patterns[0]}.` : null,
    work_context_line: workContext ? `Current work focus: ${workContext}.` : null,
    long_term_direction_line: northStar ? `Long-term direction: ${northStar}.` : null,
    communication_preference_line:
      preferences[0] ? `Communication preference: ${preferences[0]}.` : null,
    daily_anchors_line:
      dailyAnchors.length > 0 ? `Daily anchors: ${dailyAnchors.slice(0, 2).join("; ")}.` : null,
    recent_signals_line:
      recentSignals[0] ? `Recent signal: ${recentSignals[0]}.` : null,
  };
}

function sanitizeSignalPackText(item: SynapseSignalPackItem) {
  if (!cleanString(item.text)) return null;
  if (item.surface_policy === "steer_only") return null;
  if (item.sensitivity && item.sensitivity.toUpperCase() === "HIGH") return null;
  return cleanString(item.text);
}

function buildSignalPackSnapshot(pack: SynapseSignalsPackResponse | null) {
  if (!pack?.classes) return { block: null };
  const classOrder: SynapseSignalPackClassName[] = [
    "identity",
    "trajectory",
    "habits",
    "momentum",
    "today",
    "open_loops",
    "state",
    "relationships",
  ];
  const lines: string[] = [];
  for (const className of classOrder) {
    const entries = Array.isArray(pack.classes[className]) ? pack.classes[className] : [];
    for (const entry of entries) {
      const text = sanitizeSignalPackText(entry);
      if (!text) continue;
      lines.push(`[${className}] ${text}`);
      if (lines.length >= 6) break;
    }
    if (lines.length >= 6) break;
  }
  return { block: lines.length > 0 ? lines.join("\n") : null };
}

function isUsableStartBrief(startBrief: SynapseStartBriefResponse | null | undefined) {
  if (!startBrief) return false;
  const handover = cleanString(startBrief.handover_text);
  const narrative = cleanString(startBrief.narrative);
  const bridgeText =
    cleanString(startBrief.bridgeText) ?? cleanString(startBrief.resume?.bridge_text);
  return Boolean(handover || narrative || bridgeText);
}

function normalizeEntityProfiles(startBrief: SynapseStartBriefResponse | null) {
  if (!startBrief?.entity_profiles) return [];
  return startBrief.entity_profiles
    .map((profile) => {
      const name = cleanString(profile?.name);
      const profileText = cleanString(profile?.profile_text);
      if (!name || !profileText) return null;
      return { name, profile_text: profileText };
    })
    .filter((entry): entry is { name: string; profile_text: string } => Boolean(entry))
    .slice(0, 6);
}

function normalizeEntityHints(startBrief: SynapseStartBriefResponse | null) {
  if (!Array.isArray(startBrief?.entity_hints)) return [];
  return startBrief.entity_hints
    .map((hint) => {
      const name = cleanString(hint?.name);
      if (!name) return null;
      return {
        entity_id: cleanString(hint?.entityId),
        name,
        type: cleanString(hint?.type),
        role: cleanString(hint?.role),
        importance: cleanString(hint?.importance),
        salience: cleanNumber(hint?.salience),
        last_seen_at: cleanString(hint?.lastSeenAt),
      };
    })
    .filter((entry): entry is ResumePacket["entity_hints"][number] => Boolean(entry))
    .slice(0, 8);
}

function normalizeOpsContext(startBrief: SynapseStartBriefResponse | null, dailyAnalysis: SynapseDailyAnalysisResponse | null) {
  const topLoops = Array.isArray(startBrief?.ops_context?.top_loops_today)
    ? startBrief!.ops_context!.top_loops_today!
        .map((item) => {
          const text = cleanString(item?.text);
          if (!text) return null;
          return {
            text,
            type: cleanString(item?.type),
            time_horizon: cleanString(item?.time_horizon),
            salience: cleanNumber(item?.salience),
          };
        })
        .filter((entry): entry is { text: string; type: string | null; time_horizon: string | null; salience: number | null } => Boolean(entry))
        .slice(0, 3)
    : [];
  const waitingOn = Array.isArray(startBrief?.ops_context?.waiting_on)
    ? startBrief!.ops_context!.waiting_on!
        .map((item) => {
          const text = cleanString(item?.text);
          return text ? { text } : null;
        })
        .filter((entry): entry is { text: string } => Boolean(entry))
        .slice(0, 3)
    : [];
  return {
    top_loops_today: topLoops,
    waiting_on: waitingOn,
    steering_note:
      cleanString(startBrief?.ops_context?.steering_note) ?? cleanString(dailyAnalysis?.steeringNote),
  };
}

function normalizeItems(startBrief: SynapseStartBriefResponse | null) {
  if (!Array.isArray(startBrief?.items)) return [];
  return startBrief!.items!
    .map((item) => {
      const text = cleanString(item?.text);
      const kind = cleanString(item?.kind);
      if (!text || !kind) return null;
      return {
        kind,
        text,
        type: cleanString(item?.type),
        time_horizon: cleanString(item?.timeHorizon),
        due_date: cleanString(item?.dueDate),
        salience: cleanNumber(item?.salience),
        last_seen_at: cleanString(item?.lastSeenAt),
      };
    })
    .filter((entry): entry is ResumePacket["items"][number] => Boolean(entry))
    .slice(0, 8);
}

export function getResumePacketFromState(state: unknown) {
  const raw = asStateRecord(state)[RESUME_PACKET_DATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const packet = raw as ResumePacket;
  return packet.version === 1 ? packet : null;
}

export function withResumePacketInState(state: unknown, packet: ResumePacket) {
  const base = asStateRecord(state);
  return {
    ...base,
    [RESUME_PACKET_DATA_KEY]: packet,
  };
}

export function clearResumePacketInState(state: unknown) {
  const base = { ...asStateRecord(state) };
  delete base[RESUME_PACKET_DATA_KEY];
  return base;
}

export function isResumePacketStale(packet: ResumePacket | null | undefined, now = new Date()) {
  if (!packet) return true;
  const generatedAt = Date.parse(packet.freshness.generated_at);
  if (!Number.isFinite(generatedAt)) return true;
  return generatedAt + packet.freshness.stale_after_ms <= now.getTime();
}

export function isUsableResumePacket(packet: ResumePacket | null | undefined) {
  return Boolean(packet?.usable && packet?.quality === "usable");
}

export function resumePacketToStartbriefPacket(packet: ResumePacket): SynapseStartBriefResponse {
  return {
    entity_hints: (packet.entity_hints ?? []).map((hint) => ({
      entityId: hint.entity_id,
      name: hint.name,
      type: hint.type,
      role: hint.role,
      importance: hint.importance,
      salience: hint.salience,
      lastSeenAt: hint.last_seen_at,
    })),
    entity_profiles: packet.entity_profiles.map((profile) => ({
      name: profile.name,
      profile_text: profile.profile_text,
    })),
    narrative: packet.narrative,
    handover_text: packet.handover_text,
    resume: {
      use_bridge: Boolean(packet.bridge_text),
      bridge_text: packet.bridge_text,
    },
    ops_context: {
      top_loops_today: packet.ops_context.top_loops_today.map((item) => ({
        text: item.text,
        type: item.type,
        time_horizon: item.time_horizon,
        salience: item.salience,
      })),
      waiting_on: packet.ops_context.waiting_on.map((item) => ({ text: item.text })),
      steering_note: packet.ops_context.steering_note,
    },
    bridgeText: packet.bridge_text,
    items: packet.items.map((item) => ({
      kind: item.kind,
      text: item.text,
      type: item.type,
      timeHorizon: item.time_horizon,
      dueDate: item.due_date,
      salience: item.salience,
      lastSeenAt: item.last_seen_at,
    })),
  };
}

function formatTimeOfDayLabel(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hourValue = parts.find((part) => part.type === "hour")?.value ?? "12";
  const hour = Number.parseInt(hourValue, 10);
  if (!Number.isFinite(hour)) return "day";
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

function formatTimeSinceLastSession(lastEndedAt: string | null, now: Date) {
  if (!lastEndedAt) return null;
  const lastMs = Date.parse(lastEndedAt);
  if (!Number.isFinite(lastMs)) return null;
  const diffMinutes = Math.max(0, Math.round((now.getTime() - lastMs) / 60_000));
  if (diffMinutes < 60) {
    return `${Math.max(1, diffMinutes)} minute${diffMinutes === 1 ? "" : "s"}`;
  }
  if (diffMinutes < 24 * 60) {
    const hours = Math.max(1, Math.round(diffMinutes / 60));
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.max(1, Math.round(diffMinutes / (24 * 60)));
  return `${days} day${days === 1 ? "" : "s"}`;
}

function trimBridgeHint(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const line = trimmed.split(/\n+/)[0]?.trim() ?? "";
  return line.length > 180 ? `${line.slice(0, 177).trim()}...` : line;
}

export function deriveHandshakeView(params: {
  resumePacket: ResumePacket | null;
  userName: string | null;
  sessionsToday: number | null;
  firstSessionToday: boolean | null;
  now: Date;
  timeZone: string;
}) : HandshakeView {
  const timeSince = formatTimeSinceLastSession(params.resumePacket?.last_session_ended_at ?? null, params.now);
  const timeOfDay = formatTimeOfDayLabel(params.now, params.timeZone);
  const packetBridge = trimBridgeHint(params.resumePacket?.bridge_text ?? null);
  const metaBits = [
    timeSince ? `Last talked ${timeSince} ago.` : null,
    typeof params.sessionsToday === "number" && Number.isFinite(params.sessionsToday)
      ? `This is conversation ${params.sessionsToday} today.`
      : params.firstSessionToday
        ? "This is the first conversation today."
        : null,
  ].filter((value): value is string => Boolean(value));
  const bridgeHint = [packetBridge, ...metaBits].join(" ").trim() || null;
  return {
    user_name: params.userName,
    time_since_last_session_human: timeSince,
    sessions_today: params.sessionsToday,
    first_session_today: params.firstSessionToday,
    time_of_day_label: timeOfDay,
    bridge_hint: bridgeHint,
  };
}

export function handshakeViewToStartbriefPacket(view: HandshakeView): SynapseStartBriefResponse | undefined {
  if (!view.bridge_hint) return undefined;
  return {
    resume: {
      use_bridge: true,
      bridge_text: view.bridge_hint,
    },
    bridgeText: view.bridge_hint,
  };
}

export async function buildResumePacket(params: {
  userId: string;
  personaId: string;
  sourceSessionId: string;
  lastSessionEndedAt: Date;
}) {
  const nowIso = new Date().toISOString();
  const [startBrief, userModel, dailyAnalysis, signalsPack] = await Promise.all([
    getSynapseStartBrief()<{
      tenantId?: string;
      userId: string;
      sessionId: string;
      timezone?: string;
      now: string;
    }, SynapseStartBriefResponse>({
      tenantId: SYNAPSE_CANONICAL_TENANT_ID,
      userId: params.userId,
      sessionId: params.sourceSessionId,
      timezone: "Europe/Zagreb",
      now: nowIso,
    }).catch(() => null),
    getSynapseUserModel()<{
      tenantId?: string;
      userId: string;
    }, SynapseUserModelResponse>({
      tenantId: SYNAPSE_CANONICAL_TENANT_ID,
      userId: params.userId,
    }).catch(() => null),
    getSynapseDailyAnalysis()<{
      tenantId?: string;
      userId: string;
    }, SynapseDailyAnalysisResponse>({
      tenantId: SYNAPSE_CANONICAL_TENANT_ID,
      userId: params.userId,
    }).catch(() => null),
    getSynapseSignalsPack()<{
      tenantId?: string;
      userId: string;
      sessionId: string;
      now: string;
    }, SynapseSignalsPackResponse>({
      tenantId: SYNAPSE_CANONICAL_TENANT_ID,
      userId: params.userId,
      sessionId: params.sourceSessionId,
      now: nowIso,
    }).catch(() => null),
  ]);

  const usable = isUsableStartBrief(startBrief);
  const packet: ResumePacket = {
    version: 1,
    updated_at: nowIso,
    user_id: params.userId,
    persona_id: params.personaId,
    source_session_id: params.sourceSessionId,
    last_session_ended_at: params.lastSessionEndedAt.toISOString(),
    usable,
    quality: usable ? "usable" : startBrief ? "weak" : "missing",
    source: usable ? "synapse_startbrief" : "cached_fallback",
    handover_text: cleanString(startBrief?.handover_text),
    narrative: cleanString(startBrief?.narrative),
    bridge_text: cleanString(startBrief?.bridgeText) ?? cleanString(startBrief?.resume?.bridge_text),
    entity_hints: normalizeEntityHints(startBrief),
    entity_profiles: normalizeEntityProfiles(startBrief),
    ops_context: normalizeOpsContext(startBrief, dailyAnalysis),
    items: normalizeItems(startBrief),
    profile_snapshot: normalizeUserModelLines(userModel),
    daily_analysis_snapshot:
      dailyAnalysis && dailyAnalysis.exists !== false
        ? { steering_note: cleanString(dailyAnalysis.steeringNote) }
        : null,
    signal_pack_snapshot: buildSignalPackSnapshot(signalsPack),
    freshness: {
      generated_at: nowIso,
      stale_after_ms: RESUME_PACKET_STALE_AFTER_MS,
    },
  };

  return {
    packet,
    userModel: userModel && userModel.exists !== false ? userModel : null,
    dailyAnalysis: dailyAnalysis && dailyAnalysis.exists !== false ? dailyAnalysis : null,
    signalsPack: signalsPack ?? null,
  };
}

export async function persistResumePacket(params: {
  userId: string;
  personaId: string;
  packet: ResumePacket;
  userModel?: SynapseUserModelResponse | null;
  dailyAnalysis?: SynapseDailyAnalysisResponse | null;
  signalsPack?: SynapseSignalsPackResponse | null;
}) {
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    select: { state: true },
  });
  let nextState: Record<string, unknown> = withResumePacketInState(existing?.state, params.packet);
  const sessionId = params.packet.source_session_id ?? "";
  if (sessionId && params.userModel) {
    nextState = {
      ...nextState,
      userModelSessionId: sessionId,
      userModelData: params.userModel,
    };
  }
  if (sessionId && params.dailyAnalysis) {
    nextState = {
      ...nextState,
      dailyAnalysisSessionId: sessionId,
      dailyAnalysisData: params.dailyAnalysis,
    };
  }
  if (sessionId && params.signalsPack) {
    nextState = {
      ...nextState,
      signalsPackSessionId: sessionId,
      signalsPackData: params.signalsPack,
    };
  }
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId: params.userId, personaId: params.personaId } },
    update: { state: nextState as any, updatedAt: new Date() },
    create: { userId: params.userId, personaId: params.personaId, state: nextState as any },
  });
  const readyMs = params.packet.last_session_ended_at
    ? Math.max(0, Date.now() - Date.parse(params.packet.last_session_ended_at))
    : null;
  console.log("[resume.packet.persisted]", {
    userId: params.userId,
    personaId: params.personaId,
    sourceSessionId: params.packet.source_session_id,
    usable: params.packet.usable,
    quality: params.packet.quality,
    source: params.packet.source,
    updated_at: params.packet.updated_at,
    ready_ms_from_session_close: Number.isFinite(readyMs) ? readyMs : null,
  });
}

async function refreshResumePacketDirect(params: {
  userId: string;
  personaId: string;
  sourceSessionId?: string | null;
  lastSessionEndedAt?: string | null;
  reason?: string | null;
}) {
  if (!env.SYNAPSE_BASE_URL) return;
  const startedAtMs = Date.now();
  let sourceSessionId = cleanString(params.sourceSessionId);
  let lastSessionEndedAt = cleanString(params.lastSessionEndedAt);
  console.log("[resume.packet.refresh.start]", {
    userId: params.userId,
    personaId: params.personaId,
    sourceSessionId,
    lastSessionEndedAt,
    reason: params.reason ?? null,
  });
  if (!sourceSessionId || !lastSessionEndedAt) {
    const latestEnded = await prisma.session.findFirst({
      where: {
        userId: params.userId,
        personaId: params.personaId,
        endedAt: { not: null },
      },
      orderBy: { endedAt: "desc" },
      select: { id: true, endedAt: true },
    });
    sourceSessionId = latestEnded?.id ?? null;
    lastSessionEndedAt = latestEnded?.endedAt?.toISOString() ?? null;
  }
  if (!sourceSessionId || !lastSessionEndedAt) {
    console.warn("[resume.packet.refresh.skip]", {
      userId: params.userId,
      personaId: params.personaId,
      sourceSessionId,
      lastSessionEndedAt,
      reason: params.reason ?? null,
      refresh_ms: Date.now() - startedAtMs,
    });
    return;
  }
  const { packet, userModel, dailyAnalysis, signalsPack } = await buildResumePacket({
    userId: params.userId,
    personaId: params.personaId,
    sourceSessionId,
    lastSessionEndedAt: new Date(lastSessionEndedAt),
  });
  await persistResumePacket({
    userId: params.userId,
    personaId: params.personaId,
    packet,
    userModel,
    dailyAnalysis,
    signalsPack,
  });
  console.log("[resume.packet.refresh.done]", {
    userId: params.userId,
    personaId: params.personaId,
    sourceSessionId,
    lastSessionEndedAt,
    reason: params.reason ?? null,
    usable: packet.usable,
    quality: packet.quality,
    refresh_ms: Date.now() - startedAtMs,
  });
}

export async function refreshResumePacket(params: {
  userId: string;
  personaId: string;
  sourceSessionId?: string | null;
  lastSessionEndedAt?: string | null;
  reason?: string | null;
}) {
  await refreshResumePacketDirect(params);
}

export async function repairResumePackets(params?: { limit?: number }) {
  const candidateLimit =
    typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? Math.min(100, Math.floor(params.limit))
      : 25;
  const recentSessions = await prisma.session.findMany({
    where: { endedAt: { not: null } },
    orderBy: { endedAt: "desc" },
    take: candidateLimit * 4,
    select: {
      id: true,
      userId: true,
      personaId: true,
      endedAt: true,
    },
  });

  const dedupedTargets: Array<{
    userId: string;
    personaId: string;
    sourceSessionId: string;
    lastSessionEndedAt: string;
  }> = [];
  const seen = new Set<string>();
  for (const session of recentSessions) {
    if (!session.endedAt) continue;
    const key = `${session.userId}:${session.personaId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedTargets.push({
      userId: session.userId,
      personaId: session.personaId,
      sourceSessionId: session.id,
      lastSessionEndedAt: session.endedAt.toISOString(),
    });
    if (dedupedTargets.length >= candidateLimit) break;
  }

  let refreshed = 0;
  let skipped = 0;
  for (const target of dedupedTargets) {
    const sessionState = await prisma.sessionState.findUnique({
      where: {
        userId_personaId: {
          userId: target.userId,
          personaId: target.personaId,
        },
      },
      select: { state: true },
    });
    const packet = getResumePacketFromState(sessionState?.state);
    const matchesLatestSession = packet?.source_session_id === target.sourceSessionId;
    if (packet && matchesLatestSession && !isResumePacketStale(packet)) {
      skipped += 1;
      continue;
    }
    await refreshResumePacketDirect(target);
    refreshed += 1;
  }

  return {
    scanned: dedupedTargets.length,
    refreshed,
    skipped,
  };
}

async function sendResumePacketEvent(params: {
  userId: string;
  personaId: string;
  sourceSessionId?: string | null;
  lastSessionEndedAt?: string | null;
  reason: string;
}) {
  const { inngest } = await import("@/inngest/client");
  console.log("[resume.packet.enqueue.start]", {
    userId: params.userId,
    personaId: params.personaId,
    sourceSessionId: params.sourceSessionId ?? null,
    lastSessionEndedAt: params.lastSessionEndedAt ?? null,
    reason: params.reason,
  });
  await inngest.send({
    name: "app/resume-packet.refresh.requested",
    data: {
      userId: params.userId,
      personaId: params.personaId,
      sourceSessionId: params.sourceSessionId ?? null,
      lastSessionEndedAt: params.lastSessionEndedAt ?? null,
      reason: params.reason,
    },
  });
  console.log("[resume.packet.enqueue.ok]", {
    userId: params.userId,
    personaId: params.personaId,
    sourceSessionId: params.sourceSessionId ?? null,
    lastSessionEndedAt: params.lastSessionEndedAt ?? null,
    reason: params.reason,
  });
}

export function requestResumePacketRefresh(params: {
  userId: string;
  personaId: string;
  sourceSessionId?: string | null;
  lastSessionEndedAt?: string | null;
  reason: string;
}) {
  if (process.env.NODE_ENV === "test") return;
  void (async () => {
    try {
      if (env.INNGEST_EVENT_KEY || env.INNGEST_DEV === "1") {
        await sendResumePacketEvent(params);
        return;
      }
    } catch (error) {
      console.warn("[resume.packet.enqueue.error]", {
        userId: params.userId,
        personaId: params.personaId,
        sourceSessionId: params.sourceSessionId ?? null,
        reason: params.reason,
        error,
      });
    }

    try {
      await refreshResumePacketDirect(params);
    } catch (error) {
      console.warn("[resume.packet.refresh.error]", {
        userId: params.userId,
        personaId: params.personaId,
        sourceSessionId: params.sourceSessionId ?? null,
        reason: params.reason,
        error,
      });
    }
  })();
}
