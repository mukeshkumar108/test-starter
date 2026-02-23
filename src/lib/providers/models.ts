// Central model configuration
// All model names must be defined here to avoid hardcoding across services

export const MODELS = {
  // Chat models per persona
  CHAT: {
    MENTOR: "bytedance-seed/seed-1.6-flash",
    SUPPORTIVE: "bytedance-seed/seed-1.6-flash", 
    COACH: "bytedance-seed/seed-1.6-flash",
    CREATIVE: "bytedance-seed/seed-1.6",
    ANALYTICAL: "bytedance-seed/seed-1.6-flash",
    SAFETY: "bytedance-seed/seed-1.6",
  },
  
  // Cheap model for shadow processing/judging
  JUDGE: "xiaomi/mimo-v2-flash",

  // Session summaries
  SUMMARY: "amazon/nova-micro-v1",
  
  // Embeddings model
  EMBEDDINGS: "text-embedding-3-small",
} as const;

export const MODEL_TIERS = {
  T1: "meta-llama/llama-4-maverick",
  T2: "google/gemini-2.5-flash",
  T3: "anthropic/claude-sonnet-4.6",
} as const;

export type TurnTier = keyof typeof MODEL_TIERS;
export type TierBurstState = {
  activeId: string | null;
  remaining: number;
  lastUsedAt: number;
};
export type RoutingMoment =
  | "grief"
  | "relationship_rupture"
  | "deep_strain"
  | "shame"
  | "strain"
  | "win"
  | "comeback";

// Type helpers
export type ChatModel =
  | typeof MODELS.CHAT[keyof typeof MODELS.CHAT]
  | typeof MODEL_TIERS[keyof typeof MODEL_TIERS];
export type JudgeModel = typeof MODELS.JUDGE;
export type SummaryModel = typeof MODELS.SUMMARY;
export type EmbeddingsModel = typeof MODELS.EMBEDDINGS;

// Get chat model for persona
export function getChatModelForPersona(personaSlug: string): ChatModel {
  const slug = personaSlug.toUpperCase() as keyof typeof MODELS.CHAT;
  return MODELS.CHAT[slug] || MODELS.CHAT.MENTOR;
}

export function getChatModelForGate(params: {
  personaId: string;
  gate?: { risk_level?: "LOW" | "MED" | "HIGH" | "CRISIS" | null };
}): ChatModel {
  const riskLevel = params.gate?.risk_level;
  if (riskLevel === "HIGH" || riskLevel === "CRISIS") {
    return MODELS.CHAT.SAFETY;
  }
  return getChatModelForPersona(params.personaId);
}

export function getTurnTierForSignals(params: {
  riskLevel?: "LOW" | "MED" | "HIGH" | "CRISIS" | null;
  posture?: "COMPANION" | "MOMENTUM" | "REFLECTION" | "RELATIONSHIP" | "IDEATION" | "RECOVERY" | "PRACTICAL" | null;
  pressure?: "LOW" | "MED" | "HIGH" | null;
  stanceSelected?: "witness" | "excavator" | "repair_and_forward" | "high_standards_friend" | "none" | null;
  moment?: RoutingMoment | null;
  intent?: "companion" | "momentum" | "output_task" | "learning" | null;
  isDirectRequest?: boolean;
  isUrgent?: boolean;
}): { tier: TurnTier; reason: string } {
  // Precedence: risk > stance > moment > pressure > intent.
  if (params.riskLevel === "HIGH" || params.riskLevel === "CRISIS") {
    return { tier: "T3", reason: "risk_high_or_crisis" };
  }

  const stance = params.stanceSelected ?? "none";
  const pressure = params.pressure ?? "MED";
  const moment = params.moment ?? null;

  if (stance === "repair_and_forward") {
    return { tier: "T3", reason: "stance_repair_and_forward" };
  }
  if (stance === "witness") {
    if (pressure === "HIGH" || moment === "grief" || moment === "relationship_rupture") {
      return { tier: "T3", reason: "stance_witness_high_pressure_or_grief_rupture" };
    }
    return { tier: "T2", reason: "stance_witness" };
  }
  if (stance === "excavator") {
    return { tier: "T2", reason: "stance_excavator" };
  }
  if (stance === "high_standards_friend") {
    return { tier: "T2", reason: "stance_high_standards_friend" };
  }

  if (
    moment === "grief" ||
    moment === "relationship_rupture" ||
    moment === "deep_strain" ||
    moment === "shame"
  ) {
    return { tier: "T3", reason: `moment_${moment}` };
  }
  if (moment === "strain" || moment === "win" || moment === "comeback") {
    return { tier: "T2", reason: `moment_${moment}` };
  }

  if ((params.posture ?? "COMPANION") === "COMPANION" && pressure === "HIGH") {
    return { tier: "T2", reason: "companion_high_pressure" };
  }

  if (params.intent === "output_task" || params.intent === "momentum") {
    return { tier: "T1", reason: `intent_${params.intent}` };
  }

  if (params.isDirectRequest || params.isUrgent) {
    return { tier: "T2", reason: "direct_or_urgent_support" };
  }

  return { tier: "T2", reason: "default_balanced" };
}

export function getChatModelForTurn(params: {
  tier: TurnTier;
}): ChatModel {
  return MODEL_TIERS[params.tier];
}

export function buildBurstEventId(params: {
  stanceSelected?: "witness" | "excavator" | "repair_and_forward" | "high_standards_friend" | "none" | null;
  moment?: RoutingMoment | null;
  intent?: "companion" | "momentum" | "output_task" | "learning" | null;
  topicHint?: string | null;
}) {
  const driver =
    params.stanceSelected && params.stanceSelected !== "none"
      ? `stance:${params.stanceSelected}`
      : `moment:${params.moment ?? "none"}`;
  const intentPart = `intent:${params.intent ?? "companion"}`;
  const topicPart = `topic:${params.topicHint ?? "general"}`;
  return `${driver}|${intentPart}|${topicPart}`;
}

export function applyT3BurstRouting(params: {
  baseTier: TurnTier;
  baseReason: string;
  burstState: TierBurstState;
  stanceSelected?: "witness" | "excavator" | "repair_and_forward" | "high_standards_friend" | "none" | null;
  moment?: RoutingMoment | null;
  intent?: "companion" | "momentum" | "output_task" | "learning" | null;
  topicHint?: string | null;
  nowMs: number;
}) {
  const peakStance =
    params.stanceSelected === "witness" ||
    params.stanceSelected === "excavator" ||
    params.stanceSelected === "repair_and_forward" ||
    params.stanceSelected === "high_standards_friend";
  const peakMoment =
    params.moment === "grief" ||
    params.moment === "relationship_rupture" ||
    params.moment === "comeback" ||
    params.moment === "strain";
  const isPeak = peakStance || peakMoment;
  const burstEventId = isPeak
    ? buildBurstEventId({
        stanceSelected: params.stanceSelected,
        moment: params.moment,
        intent: params.intent,
        topicHint: params.topicHint,
      })
    : null;
  const burstRemainingBefore = Math.max(0, params.burstState.remaining ?? 0);
  let nextState: TierBurstState = {
    activeId: params.burstState.activeId ?? null,
    remaining: burstRemainingBefore,
    lastUsedAt: params.burstState.lastUsedAt ?? 0,
  };
  let selectedTier = params.baseTier;
  let routingReason = params.baseReason;
  let burstWasStarted = false;

  if (isPeak && burstEventId) {
    if (!nextState.activeId || nextState.activeId !== burstEventId) {
      nextState = {
        activeId: burstEventId,
        remaining: 2,
        lastUsedAt: params.nowMs,
      };
      burstWasStarted = true;
    }

    if (nextState.remaining > 0) {
      selectedTier = "T3";
      nextState = {
        ...nextState,
        remaining: Math.max(0, nextState.remaining - 1),
        lastUsedAt: params.nowMs,
      };
      routingReason = burstWasStarted ? "burst_started_t3" : "burst_continued_t3";
    } else {
      selectedTier = "T2";
      nextState = {
        ...nextState,
        lastUsedAt: params.nowMs,
      };
      routingReason = "burst_capped_force_t2";
    }
  }

  // Relational stance floor: these stances should never run on T1.
  if (
    (params.stanceSelected === "witness" ||
      params.stanceSelected === "repair_and_forward" ||
      params.stanceSelected === "excavator") &&
    selectedTier === "T1"
  ) {
    selectedTier = "T2";
    routingReason = "stance_floor_t2";
  }

  return {
    tier: selectedTier,
    routingReason,
    burstEventId,
    burstWasStarted,
    burstRemainingBefore,
    burstRemainingAfter: nextState.remaining,
    burstState: nextState,
  };
}
