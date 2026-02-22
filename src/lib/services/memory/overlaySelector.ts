import type { OverlayType } from "@/lib/services/memory/overlayLoader";

export type OverlayDecision = {
  overlayType: OverlayType | "none";
  triggerReason: string;
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

const relationshipCues = ["girlfriend", "boyfriend", "mum", "mom", "dad", "boss", "colleague"];

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

export function selectOverlay(params: {
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
}): OverlayDecision {
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
  } =
    params;
  if (!transcript.trim()) return { overlayType: "none", triggerReason: "empty" };

  const suppressNonEssentialOverlays =
    posture === "COMPANION" &&
    (conflictSignals?.pressure === "MED" || conflictSignals?.pressure === "HIGH");

  // Daily focus has first pass in morning start-of-day windows, before other overlays.
  // Ritual precedence: daily/weekly trajectory overlays run before conversational overlays.
  if (!suppressNonEssentialOverlays && dailyFocusEligible && !hasTodayFocus && !overlayUsed?.dailyFocus) {
    return { overlayType: "daily_focus", triggerReason: "daily_focus_morning" };
  }
  if (!suppressNonEssentialOverlays && dailyReviewEligible && !hasDailyReviewToday && !overlayUsed?.dailyReview) {
    return { overlayType: "daily_review", triggerReason: "daily_review_evening" };
  }
  if (!suppressNonEssentialOverlays && weeklyCompassEligible && !hasWeeklyCompass && !overlayUsed?.weeklyCompass) {
    return { overlayType: "weekly_compass", triggerReason: "weekly_compass_window" };
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

  // Conflict regulation takes precedence over curiosity when relational conflict is heated.
  if (hasRelationshipCue && hasAngerCue && (hasPressureSignal || hasStateSignal)) {
    return { overlayType: "conflict_regulation", triggerReason: "conflict_regulation" };
  }

  if (!suppressNonEssentialOverlays && !overlayUsed?.curiositySpiral) {
    const curiosityEligible = hasCuriosityTrigger(transcript);
    if (curiosityEligible) {
      return { overlayType: "curiosity_spiral", triggerReason: "curiosity_trigger" };
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
        overlayType: "accountability_tug",
        triggerReason: hasHighPriorityLoop ? "accountability_tug_priority" : "accountability_tug",
        topicKey,
      };
    }
  }

  return { overlayType: "none", triggerReason: "none" };
}
