import type { OverlayType } from "@/lib/services/memory/overlayLoader";

export type OverlayDecision = {
  overlayType: OverlayType | "none";
  triggerReason: string;
  topicKey?: string;
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

const directRequestMarkers = [
  "help me",
  "can you",
  "write",
  "draft",
  "plan",
  "fix",
  "code",
  "summarize",
  "summarise",
];

const urgentMarkers = ["urgent", "emergency", "can't cope", "cant cope", "now", "help"];

const dismissMarkers = ["not now", "later", "stop", "leave it", "anyway"];

const casualOpeners = ["hey", "hi", "yo", "sup", "what's up", "whats up"];

export function normalizeTopicKey(value: string) {
  return value.trim().toLowerCase();
}

export function isDirectTaskRequest(text: string) {
  const lowered = text.toLowerCase();
  return directRequestMarkers.some((marker) => lowered.includes(marker));
}

export function isUrgent(text: string) {
  const lowered = text.toLowerCase();
  return urgentMarkers.some((marker) => lowered.includes(marker));
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

export function isCasualOpener(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length >= 12) return false;
  const lowered = text.toLowerCase();
  return casualOpeners.some((marker) => lowered.includes(marker));
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
  openLoops?: string[];
  commitments?: string[];
  overlayUsed?: { curiositySpiral?: boolean; accountabilityTug?: boolean };
  userLastTugAt?: string | null;
  tugBackoff?: Record<string, string>;
  now?: Date;
}): OverlayDecision {
  const { transcript, openLoops, commitments, overlayUsed, userLastTugAt, tugBackoff, now } =
    params;
  if (!transcript.trim()) return { overlayType: "none", triggerReason: "empty" };

  if (!overlayUsed?.curiositySpiral) {
    const curiosityEligible =
      hasCuriosityTrigger(transcript) && !isDirectTaskRequest(transcript);
    if (curiosityEligible) {
      return { overlayType: "curiosity_spiral", triggerReason: "curiosity_trigger" };
    }
  }

  if (!overlayUsed?.accountabilityTug) {
    const topicKey = resolveAccountabilityTopic(openLoops, commitments);
    const eligible =
      Boolean(topicKey) &&
      isCasualOpener(transcript) &&
      !isDirectTaskRequest(transcript) &&
      !isUrgent(transcript) &&
      !isWithinOneDay(userLastTugAt, now) &&
      !isBackoffActive(topicKey ?? "", tugBackoff, now);

    if (eligible && topicKey) {
      return {
        overlayType: "accountability_tug",
        triggerReason: "accountability_tug",
        topicKey,
      };
    }
  }

  return { overlayType: "none", triggerReason: "none" };
}
