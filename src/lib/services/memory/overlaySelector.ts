import type {
  StanceOverlayType,
  TacticOverlayType,
} from "@/lib/services/memory/overlayLoader";

export type OverlaySelectionDecision = {
  stanceOverlay: StanceOverlayType | "none";
  tacticOverlay: TacticOverlayType | "none";
  triggerReason: string;
  suppressionReason?: string;
  topicKey?: string;
};

export type OverlayIntent = "companion" | "momentum" | "output_task" | "learning";

export type OverlayPolicyDecision = {
  skip: boolean;
  reason:
    | "allowed"
    | "urgent"
    | "output_task"
    | "direct_request_guard"
    | "friction_correction"
    | "session_warmup"
    | "conversation_runway";
};

const narrativeMarkers = [
  "and then",
  "so basically",
  "you won’t believe",
  "you won't believe",
  "guess what",
  "after that",
  "then",
];

const relationshipCues = [
  "girlfriend",
  "boyfriend",
  "wife",
  "husband",
  "partner",
  "daughter",
  "son",
  "mum",
  "mom",
  "dad",
  "boss",
  "colleague",
];

const emotionalMarkers = [
  "argued",
  "argument",
  "fight",
  "panic",
  "scared",
  "excited",
  "amazing",
  "furious",
  "heartbroken",
];
const angerMarkers = ["argued", "argument", "fight", "furious", "angry", "rage", "blame"];

const dismissMarkers = ["not now", "later", "stop", "leave it", "anyway"];

export function normalizeTopicKey(value: string) {
  return value.trim().toLowerCase();
}

export function isDismissal(text: string) {
  const lowered = text.toLowerCase();
  return dismissMarkers.some((marker) => lowered.includes(marker));
}

export function isTopicShift(text: string) {
  return text.toLowerCase().includes("anyway");
}

export function isShortReply(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length < 8;
}

// Overlay gate policy is driven by bouncer intent/urgency signals, not transcript substrings.
export function shouldSkipOverlaySelection(params: {
  intent?: OverlayIntent | null;
  isUrgent?: boolean;
  isDirectRequest?: boolean;
}): OverlayPolicyDecision {
  const intent = params.intent ?? "companion";
  if (params.isUrgent) {
    return { skip: true, reason: "urgent" };
  }
  if (intent === "output_task") {
    return { skip: true, reason: "output_task" };
  }
  if (params.isDirectRequest && intent !== "momentum" && intent !== "learning") {
    return { skip: true, reason: "direct_request_guard" };
  }
  return { skip: false, reason: "allowed" };
}

function hasCuriosityTrigger(text: string) {
  const lowered = text.toLowerCase();
  if (narrativeMarkers.some((marker) => lowered.includes(marker))) return true;
  if (relationshipCues.some((marker) => lowered.includes(marker))) return true;
  if (emotionalMarkers.some((marker) => lowered.includes(marker))) return true;
  return false;
}

function resolveAccountabilityTopic(openLoops?: string[], commitments?: string[]) {
  const candidate = openLoops?.[0] ?? commitments?.[0];
  if (!candidate) return null;
  const normalized = normalizeTopicKey(candidate);
  return normalized.length > 0 ? normalized : null;
}

function isBackoffActive(
  topicKey: string,
  backoff?: Record<string, string>,
  now?: Date
) {
  if (!backoff) return false;
  const until = backoff[topicKey];
  if (!until) return false;
  const untilMs = Date.parse(until);
  if (!Number.isFinite(untilMs)) return false;
  return (now?.getTime() ?? Date.now()) < untilMs;
}

function isWithinOneDay(lastTugAt?: string | null, now?: Date) {
  if (!lastTugAt) return false;
  const last = Date.parse(lastTugAt);
  if (!Number.isFinite(last)) return false;
  const diff = (now?.getTime() ?? Date.now()) - last;
  return diff < 24 * 60 * 60 * 1000;
}

function detectDepthSignals(text: string, recentUserMessages: string[]) {
  const lowered = text.toLowerCase();
  const griefWeight =
    /\b(death|estranged|regret|cancer|funeral|miss her|miss him|i can'?t)\b/i.test(lowered);
  const repairIntent =
    /\b(how do i fix|what do i say|reconcile|apolog(?:y|ize|ise)|make it right|repair)\b/i.test(lowered);
  const circlingOrUnsaid =
    /\b(idk|i don't know|part of me|on one hand|but also|again and again)\b/i.test(lowered) ||
    recentUserMessages
      .slice(-2)
      .some((msg) => {
        const msgLower = msg.toLowerCase();
        const seed = msgLower.split(/\s+/).slice(0, 5).join(" ");
        return seed.length >= 12 && lowered.includes(seed);
      });
  const standardsAsk =
    /\b(push me|hold me accountable|be strict|be harder on me|don't let me off)\b/i.test(lowered);
  const momentumTask =
    /\b(write|draft|ship|deploy|plan|todo|to-do|task|deliverable|ticket|pr|bug)\b/i.test(lowered);
  const relationshipContext = relationshipCues.some((marker) => lowered.includes(marker));
  const pickedNextStep =
    /\b(i will|i'll|next step is|i can do now|i'll do|i will do|i'll text|i will text)\b/i.test(lowered);

  return {
    griefWeight,
    repairIntent,
    circlingOrUnsaid,
    standardsAsk,
    momentumTask,
    relationshipContext,
    pickedNextStep,
  };
}

function selectStance(params: {
  transcript: string;
  posture?: "COMPANION" | "MOMENTUM" | "REFLECTION" | "RELATIONSHIP" | "IDEATION" | "RECOVERY" | "PRACTICAL";
  intent?: OverlayIntent;
  pressure?: "LOW" | "MED" | "HIGH";
  riskLevel?: "LOW" | "MED" | "HIGH" | "CRISIS";
  explicitTopicShift?: boolean;
  avoidanceOrDrift?: boolean;
  hasOpenLoops?: boolean;
  recentUserMessages?: string[];
}) {
  const signals = detectDepthSignals(params.transcript, params.recentUserMessages ?? []);

  // Safety/risk always wins.
  if (params.riskLevel === "CRISIS" || params.riskLevel === "HIGH") {
    return { stanceOverlay: "witness" as const, reason: "safety_risk_override" as const };
  }

  if (signals.griefWeight || params.pressure === "HIGH") {
    return { stanceOverlay: "witness" as const, reason: signals.griefWeight ? "grief_weight" : "high_pressure" };
  }

  if (params.explicitTopicShift) {
    return { stanceOverlay: "none" as const, reason: "explicit_topic_shift" as const };
  }

  if (signals.repairIntent && signals.relationshipContext) {
    return { stanceOverlay: "repair_and_forward" as const, reason: "repair_intent" as const };
  }

  const allowExploratoryStance = !signals.momentumTask && params.intent !== "output_task";
  if (signals.circlingOrUnsaid && allowExploratoryStance) {
    return { stanceOverlay: "excavator" as const, reason: "circling_unsaid" as const };
  }

  const driftWithRunway = Boolean(params.avoidanceOrDrift) && params.hasOpenLoops;
  if (signals.standardsAsk || driftWithRunway) {
    return {
      stanceOverlay: "high_standards_friend" as const,
      reason: signals.standardsAsk ? "standards_explicit" : "drift_with_loops",
    };
  }

  return { stanceOverlay: "none" as const, reason: "no_stance_trigger" as const };
}

function selectBaseTactic(params: {
  transcript: string;
  posture?: "COMPANION" | "MOMENTUM" | "REFLECTION" | "RELATIONSHIP" | "IDEATION" | "RECOVERY" | "PRACTICAL";
  openLoops?: string[];
  commitments?: string[];
  overlayUsed?: {
    curiositySpiral?: boolean;
    accountabilityTug?: boolean;
    dailyFocus?: boolean;
    dailyReview?: boolean;
    weeklyCompass?: boolean;
  };
  dailyFocusEligible?: boolean;
  dailyReviewEligible?: boolean;
  weeklyCompassEligible?: boolean;
  hasTodayFocus?: boolean;
  hasDailyReviewToday?: boolean;
  hasWeeklyCompass?: boolean;
  conflictSignals?: {
    pressure?: "LOW" | "MED" | "HIGH";
    riskLevel?: "LOW" | "MED" | "HIGH" | "CRISIS";
    mood?: "CALM" | "NEUTRAL" | "LOW" | "UPBEAT" | "FRUSTRATED" | "OVERWHELMED" | "ANXIOUS";
    tone?: "PLAYFUL" | "SERIOUS" | "TENDER" | "DIRECT";
  };
  userLastTugAt?: string | null;
  tugBackoff?: Record<string, string>;
  hasHighPriorityLoop?: boolean;
  now?: Date;
}) {
  const {
    transcript,
    posture,
    openLoops,
    commitments,
    overlayUsed,
    dailyFocusEligible,
    dailyReviewEligible,
    weeklyCompassEligible,
    hasTodayFocus,
    hasDailyReviewToday,
    hasWeeklyCompass,
    conflictSignals,
    userLastTugAt,
    tugBackoff,
    hasHighPriorityLoop,
    now,
  } = params;

  const suppressNonEssentialOverlays =
    posture === "COMPANION" &&
    (conflictSignals?.pressure === "MED" || conflictSignals?.pressure === "HIGH");

  if (!suppressNonEssentialOverlays && dailyFocusEligible && !hasTodayFocus && !overlayUsed?.dailyFocus) {
    return { tacticOverlay: "daily_focus" as const, triggerReason: "daily_focus_morning" as const };
  }
  if (!suppressNonEssentialOverlays && dailyReviewEligible && !hasDailyReviewToday && !overlayUsed?.dailyReview) {
    return { tacticOverlay: "daily_review" as const, triggerReason: "daily_review_evening" as const };
  }
  if (!suppressNonEssentialOverlays && weeklyCompassEligible && !hasWeeklyCompass && !overlayUsed?.weeklyCompass) {
    return { tacticOverlay: "weekly_compass" as const, triggerReason: "weekly_compass_window" as const };
  }

  const lowered = transcript.toLowerCase();
  const hasRelationshipCue = relationshipCues.some((marker) => lowered.includes(marker));
  const hasAngerCue = angerMarkers.some((marker) => lowered.includes(marker));
  const hasPressureSignal =
    conflictSignals?.pressure === "HIGH" ||
    conflictSignals?.riskLevel === "HIGH" ||
    conflictSignals?.riskLevel === "CRISIS";
  const hasStateSignal =
    conflictSignals?.mood === "FRUSTRATED" ||
    conflictSignals?.mood === "OVERWHELMED" ||
    conflictSignals?.mood === "ANXIOUS" ||
    conflictSignals?.tone === "DIRECT";

  if (hasRelationshipCue && hasAngerCue && (hasPressureSignal || hasStateSignal)) {
    return { tacticOverlay: "conflict_regulation" as const, triggerReason: "conflict_regulation" as const };
  }

  if (!suppressNonEssentialOverlays && !overlayUsed?.curiositySpiral) {
    const curiosityEligible = hasCuriosityTrigger(transcript);
    if (curiosityEligible) {
      return { tacticOverlay: "curiosity_spiral" as const, triggerReason: "curiosity_trigger" as const };
    }
  }

  if (!suppressNonEssentialOverlays && !overlayUsed?.accountabilityTug) {
    const topicKey = resolveAccountabilityTopic(openLoops, commitments);
    const eligible =
      Boolean(topicKey) &&
      !isWithinOneDay(userLastTugAt, now) &&
      !isBackoffActive(topicKey ?? "", tugBackoff, now);

    if (eligible && topicKey) {
      return {
        tacticOverlay: "accountability_tug" as const,
        triggerReason: hasHighPriorityLoop ? "accountability_tug_priority" : "accountability_tug",
        topicKey,
      };
    }
  }

  return { tacticOverlay: "none" as const, triggerReason: "none" as const };
}

export function selectOverlay(params: {
  transcript: string;
  posture?: "COMPANION" | "MOMENTUM" | "REFLECTION" | "RELATIONSHIP" | "IDEATION" | "RECOVERY" | "PRACTICAL";
  intent?: OverlayIntent;
  explicitTopicShift?: boolean;
  avoidanceOrDrift?: boolean;
  openLoops?: string[];
  commitments?: string[];
  recentUserMessages?: string[];
  overlayUsed?: {
    curiositySpiral?: boolean;
    accountabilityTug?: boolean;
    dailyFocus?: boolean;
    dailyReview?: boolean;
    weeklyCompass?: boolean;
  };
  dailyFocusEligible?: boolean;
  dailyReviewEligible?: boolean;
  weeklyCompassEligible?: boolean;
  hasTodayFocus?: boolean;
  hasDailyReviewToday?: boolean;
  hasWeeklyCompass?: boolean;
  conflictSignals?: {
    pressure?: "LOW" | "MED" | "HIGH";
    riskLevel?: "LOW" | "MED" | "HIGH" | "CRISIS";
    mood?: "CALM" | "NEUTRAL" | "LOW" | "UPBEAT" | "FRUSTRATED" | "OVERWHELMED" | "ANXIOUS";
    tone?: "PLAYFUL" | "SERIOUS" | "TENDER" | "DIRECT";
  };
  userLastTugAt?: string | null;
  tugBackoff?: Record<string, string>;
  hasHighPriorityLoop?: boolean;
  now?: Date;
}): OverlaySelectionDecision {
  if (!params.transcript.trim()) {
    return { stanceOverlay: "none", tacticOverlay: "none", triggerReason: "empty" };
  }

  const stanceDecision = selectStance({
    transcript: params.transcript,
    posture: params.posture,
    intent: params.intent,
    pressure: params.conflictSignals?.pressure,
    riskLevel: params.conflictSignals?.riskLevel,
    explicitTopicShift: params.explicitTopicShift,
    avoidanceOrDrift: params.avoidanceOrDrift,
    hasOpenLoops: Boolean(params.openLoops?.length),
    recentUserMessages: params.recentUserMessages,
  });

  const baseTactic = selectBaseTactic(params);

  if (stanceDecision.stanceOverlay === "witness") {
    if (params.posture === "COMPANION" && params.conflictSignals?.pressure === "HIGH") {
      return {
        stanceOverlay: "witness",
        tacticOverlay: "none",
        triggerReason: `${stanceDecision.reason}:tactics_suppressed`,
        suppressionReason: "witness_high_pressure",
      };
    }
    if (
      baseTactic.tacticOverlay === "accountability_tug" ||
      baseTactic.tacticOverlay === "curiosity_spiral"
    ) {
      return {
        stanceOverlay: "witness",
        tacticOverlay: "none",
        triggerReason: `${stanceDecision.reason}:witness_suppresses_tactic`,
        suppressionReason: "witness_suppresses_nonessential",
      };
    }
    return {
      stanceOverlay: "witness",
      tacticOverlay: "none",
      triggerReason: `${stanceDecision.reason}:stance_only`,
      suppressionReason: "witness_prefers_presence",
    };
  }

  if (stanceDecision.stanceOverlay === "excavator") {
    if (baseTactic.tacticOverlay === "curiosity_spiral") {
      return {
        stanceOverlay: "excavator",
        tacticOverlay: "curiosity_spiral",
        triggerReason: `${stanceDecision.reason}:paired_curiosity`,
      };
    }
    return {
      stanceOverlay: "excavator",
      tacticOverlay: "none",
      triggerReason: `${stanceDecision.reason}:stance_only`,
      suppressionReason: baseTactic.tacticOverlay === "accountability_tug" ? "excavator_blocks_accountability" : undefined,
    };
  }

  if (stanceDecision.stanceOverlay === "repair_and_forward") {
    const pickedNextStep = /\b(i will|i'll|next step is|i can do now|i'll do|i will do|i'll text|i will text)\b/i.test(
      params.transcript.toLowerCase()
    );
    if (baseTactic.tacticOverlay === "accountability_tug" && pickedNextStep) {
      return {
        stanceOverlay: "repair_and_forward",
        tacticOverlay: "accountability_tug",
        triggerReason: `${stanceDecision.reason}:paired_accountability`,
        topicKey: baseTactic.topicKey,
      };
    }
    return {
      stanceOverlay: "repair_and_forward",
      tacticOverlay: "none",
      triggerReason: `${stanceDecision.reason}:stance_only`,
      suppressionReason: baseTactic.tacticOverlay === "accountability_tug" ? "repair_waiting_next_step" : undefined,
    };
  }

  if (stanceDecision.stanceOverlay === "high_standards_friend") {
    if (baseTactic.tacticOverlay === "accountability_tug") {
      return {
        stanceOverlay: "high_standards_friend",
        tacticOverlay: "accountability_tug",
        triggerReason: `${stanceDecision.reason}:paired_accountability`,
        topicKey: baseTactic.topicKey,
      };
    }
    return {
      stanceOverlay: "high_standards_friend",
      tacticOverlay: "none",
      triggerReason: `${stanceDecision.reason}:stance_only`,
    };
  }

  return {
    stanceOverlay: "none",
    tacticOverlay: baseTactic.tacticOverlay,
    triggerReason: baseTactic.triggerReason,
    topicKey: baseTactic.topicKey,
  };
}
