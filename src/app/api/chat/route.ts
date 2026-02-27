import { NextRequest, NextResponse } from "next/server";
import { auth, verifyToken } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { transcribeAudio } from "@/lib/services/voice/sttService";
import { generateResponse } from "@/lib/services/voice/llmService";
import { synthesizeSpeech } from "@/lib/services/voice/ttsService";
import {
  buildContext,
  type DeferredProfileContext,
  type SessionStartHandoff,
} from "@/lib/services/memory/contextBuilder";
import {
  loadOverlay,
  type OverlayType,
  type StanceOverlayType,
  type TacticOverlayType,
} from "@/lib/services/memory/overlayLoader";
import {
  isDismissal,
  isShortReply,
  isTopicShift,
  type OverlayPolicyDecision,
  type OverlayIntent,
  normalizeTopicKey,
  selectOverlay,
  shouldSkipOverlaySelection,
} from "@/lib/services/memory/overlaySelector";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { autoCurateMaybe } from "@/lib/services/memory/memoryCurator";
import { ensureUserByClerkId } from "@/lib/user";
import { env } from "@/env";
import {
  applyT3BurstRouting,
  getChatModelForGate,
  getChatModelForTurn,
  getTurnTierForSignals,
  type TierBurstState,
  type TurnTier,
  type RoutingMoment,
} from "@/lib/providers/models";
import { ensureActiveSession, maybeUpdateRollingSummary } from "@/lib/services/session/sessionService";
import * as synapseClient from "@/lib/services/synapseClient";
import type { SynapseStartBriefResponse } from "@/lib/services/synapseClient";

export const runtime = "nodejs";

interface ChatRequestBody {
  personaId: string;
  audioBlob: File;
}

const DEFAULT_LIBRARIAN_TIMEOUT_MS = 5000;
const MIN_OPTIONAL_LIBRARIAN_STEP_MS = 300;
const DEFAULT_POSTURE_RESET_GAP_MINUTES = 180;
const DEFAULT_USER_STATE_RESET_GAP_MINUTES = 180;
const CONTEXT_GOVERNOR_MAX_CHARS = 1000;

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function extractLocalTurnSignalLine(transcript: string) {
  const normalized = normalizeWhitespace(transcript);
  if (!normalized) return null;
  const lowered = normalized.toLowerCase();
  const signals: string[] = [];
  const pushSignal = (value: string) => {
    if (signals.includes(value)) return;
    signals.push(value);
  };

  if (/\b(stress|stressed|overwhelm|anxious|panic|burnt out|burned out)\b/i.test(lowered)) {
    pushSignal("stressed lately");
  } else if (/\b(frustrated|angry|irritated)\b/i.test(lowered)) {
    pushSignal("feeling frustrated");
  } else if (/\b(tired|exhausted|drained)\b/i.test(lowered)) {
    pushSignal("running low on energy");
  }

  if (/\b(go(?:ing)?\s+for\s+a\s+walk|walk(?:ing)?)\b/i.test(lowered)) {
    pushSignal("going for a walk");
  }
  if (/\b(just\s+)?shipp(?:ed|ing)\b/i.test(lowered) || /\b(push|deploy|release|pr)\b/i.test(lowered)) {
    pushSignal("just shipped a push");
  }
  if (/\b(gym|work(?:ing)?\s*out|run(?:ning)?)\b/i.test(lowered)) {
    pushSignal("moving the body");
  }

  if (/\b(need help|help me|what should i|can you help)\b/i.test(lowered)) {
    pushSignal("asking for guidance");
  } else if (/\b(check[- ]?in|catch[- ]?up)\b/i.test(lowered)) {
    pushSignal("checking in");
  }

  if (signals.length === 0) {
    const firstClause = normalized.split(/[.!?;]+/).at(0) ?? normalized;
    const fallback = firstClause.split(/\s+/).slice(0, 10).join(" ");
    if (!fallback) return null;
    pushSignal(fallback.toLowerCase());
  }

  return `Local (now): ${signals.slice(0, 3).join(", ")}.`;
}

type UserContextCandidate = {
  line: string;
  key: string;
};

const CONTEXT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "got",
  "had", "has", "have", "he", "her", "here", "him", "his", "i", "if", "in", "into", "is",
  "it", "its", "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their",
  "them", "there", "they", "this", "to", "too", "us", "was", "we", "were", "with", "you", "your",
]);

const BANNED_CONTEXT_SUBSTRINGS = [
  " got and was",
  "include got",
  "include was",
  "people currently in focus include got",
  "people currently in focus include was",
];

const BANNED_TRAILING_PATTERNS = [" and.", " and", " or.", " but.", " with."];

function tokenizeForQuality(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardOverlap(a: string[], b: string[]) {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  const intersection = [...aSet].filter((token) => bSet.has(token)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function hasDuplicateTrajectorySegments(line: string) {
  if (!line.toLowerCase().startsWith("trajectory:")) return false;
  const payload = line.split(":").slice(1).join(":");
  const segments = payload
    .split("->")
    .map((segment) => stripSentenceEnding(segment).toLowerCase())
    .filter(Boolean);
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i] === segments[i - 1]) return true;
  }
  return false;
}

function isGoodContextLine(params: { line: string; userText: string; key: string }) {
  const line = params.line.trim();
  const isLocalCandidate = params.key.startsWith("local:");
  const minLength = isLocalCandidate ? 40 : 18;
  if (line.length < minLength) return { ok: false as const, reason: "too_short" };
  const lowered = line.toLowerCase();
  if (BANNED_CONTEXT_SUBSTRINGS.some((part) => lowered.includes(part))) {
    return { ok: false as const, reason: "banned_substring" };
  }
  if (BANNED_TRAILING_PATTERNS.some((suffix) => lowered.endsWith(suffix))) {
    return { ok: false as const, reason: "truncated_suffix" };
  }
  if (/\b(maybe|likely|might)\b/i.test(lowered) && params.key.startsWith("synapse:")) {
    return { ok: false as const, reason: "hedged_fact" };
  }
  if (hasDuplicateTrajectorySegments(line)) {
    return { ok: false as const, reason: "duplicate_trajectory" };
  }

  const lineTokens = tokenizeForQuality(line);
  const userTokens = tokenizeForQuality(params.userText);
  const nonStopwords = lineTokens.filter((token) => !CONTEXT_STOPWORDS.has(token));
  if (nonStopwords.length < 4) return { ok: false as const, reason: "low_content_words" };
  const stopwordRatio = lineTokens.length === 0 ? 1 : (lineTokens.length - nonStopwords.length) / lineTokens.length;
  if (stopwordRatio >= 0.55) return { ok: false as const, reason: "high_stopword_ratio" };
  const overlap = jaccardOverlap(lineTokens, userTokens);
  const overlapThreshold = isLocalCandidate ? 0.45 : 0.6;
  if (overlap >= overlapThreshold) return { ok: false as const, reason: "echo_overlap" };

  return { ok: true as const };
}

type TrajectoryCandidateInput = {
  longTermDirectionLine?: string;
  workContextLine?: string;
  dailyAnchorsLine?: string;
  currentFocus?: string | null;
  topLoopText?: string | null;
  topLoopFetchedAt?: string | null;
  now: Date;
};

function stripSentenceEnding(value: string) {
  return value.trim().replace(/[.!?]+$/, "").trim();
}

function parseLongTermDirection(line?: string) {
  if (!line) return null;
  const match = line.match(/^Long-term direction is\s+(.+?)\.?$/i);
  if (!match) return null;
  const value = stripSentenceEnding(match[1] ?? "");
  return value || null;
}

function parseWorkFocus(line?: string) {
  if (!line) return null;
  const match = line.match(/^Current work focus is\s+(.+?)(?:, and work context is .+)?\.?$/i);
  if (!match) return null;
  const value = stripSentenceEnding(match[1] ?? "");
  return value || null;
}

function parseDailyAnchors(line?: string) {
  if (!line) return null;
  const match = line.match(/^Daily anchors:\s+(.+?)\.?$/i);
  if (!match) return null;
  const value = stripSentenceEnding(match[1] ?? "");
  return value || null;
}

function isLowConfidenceText(value: string) {
  return /\b(likely|maybe|might|possibly|inferred)\b/i.test(value);
}

function isStaleTimestamp(value: string | null | undefined, now: Date, maxHours: number) {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return true;
  return now.getTime() - parsed > maxHours * 60 * 60 * 1000;
}

function buildTrajectoryCandidate(input?: TrajectoryCandidateInput | null): UserContextCandidate | null {
  if (!input) return null;
  const vision = parseLongTermDirection(input.longTermDirectionLine);
  const focus = stripSentenceEnding(input.currentFocus ?? "") || parseWorkFocus(input.workContextLine);
  const dailyAnchor = parseDailyAnchors(input.dailyAnchorsLine);
  const topLoop = stripSentenceEnding(input.topLoopText ?? "");
  const topLoopStale = isStaleTimestamp(input.topLoopFetchedAt, input.now, 24);
  const anchor = dailyAnchor || (!topLoopStale ? topLoop : null);

  const components = [
    { label: "vision", value: vision },
    { label: "focus", value: focus },
    { label: "anchor", value: anchor },
  ].filter((entry) => Boolean(entry.value));

  if (components.length < 2) return null;
  if (components.some((entry) => isLowConfidenceText(entry.value ?? ""))) return null;
  if (!dailyAnchor && topLoop && topLoopStale) return null;
  for (let i = 1; i < components.length; i += 1) {
    const current = (components[i].value ?? "").toLowerCase();
    const previous = (components[i - 1].value ?? "").toLowerCase();
    if (current === previous) return null;
  }

  const line = `Trajectory: ${components.map((entry) => entry.value).join(" -> ")}.`;
  return { key: "synapse:trajectory", line };
}

function extractLocalTurnSignalKey(transcript: string) {
  const lowered = normalizeWhitespace(transcript).toLowerCase();
  if (!lowered) return null;
  if (/\b(stress|stressed|overwhelm|anxious|panic|burnt out|burned out)\b/i.test(lowered)) {
    return "local:emotion_stress";
  }
  if (/\b(frustrated|angry|irritated)\b/i.test(lowered)) {
    return "local:emotion_frustrated";
  }
  if (/\b(tired|exhausted|drained)\b/i.test(lowered)) {
    return "local:energy_low";
  }
  if (/\b(go(?:ing)?\s+for\s+a\s+walk|walk(?:ing)?)\b/i.test(lowered)) {
    return "local:activity_walk";
  }
  if (/\b(just\s+)?shipp(?:ed|ing)\b/i.test(lowered) || /\b(push|deploy|release|pr)\b/i.test(lowered)) {
    return "local:activity_ship";
  }
  if (/\b(need help|help me|what should i|can you help)\b/i.test(lowered)) {
    return "local:intent_guidance";
  }
  return "local:now";
}

function extractMagicMomentLine(transcript: string) {
  const lowered = normalizeWhitespace(transcript).toLowerCase();
  if (!lowered) return null;
  if (/\b(just\s+)?shipp(?:ed|ing)\b/i.test(lowered) || /\b(finished|wrapped up|got it done)\b/i.test(lowered)) {
    return {
      key: "moment:win",
      line: "Moment (salient): user just landed a meaningful win.",
    };
  }
  if (/\b(stress|stressed|overwhelm|overwhelmed|rough day|burnt out|burned out)\b/i.test(lowered)) {
    return {
      key: "moment:strain",
      line: "Moment (salient): user is under strain and needs lower-pressure support.",
    };
  }
  if (/\b(argued|argument|fallout|fight|upset with|rupture)\b/i.test(lowered)) {
    return {
      key: "moment:relationship_rupture",
      line: "Moment (salient): a relationship rupture is active right now.",
    };
  }
  if (/\b(back on track|trying again|restart|comeback)\b/i.test(lowered)) {
    return {
      key: "moment:comeback",
      line: "Moment (salient): user is making a comeback attempt.",
    };
  }
  return null;
}

function deriveRoutingMoment(params: {
  transcript: string;
  selectedUserContext: UserContextCandidate[];
}): RoutingMoment | null {
  const selectedMomentKey = params.selectedUserContext.find((item) => item.key.startsWith("moment:"))?.key;
  if (selectedMomentKey === "moment:relationship_rupture") return "relationship_rupture";
  if (selectedMomentKey === "moment:strain") return "strain";
  if (selectedMomentKey === "moment:win") return "win";
  if (selectedMomentKey === "moment:comeback") return "comeback";

  const lowered = normalizeWhitespace(params.transcript).toLowerCase();
  if (!lowered) return null;
  if (/\b(grief|funeral|died|lost my|miss her|miss him|miss them|bereave|mourning)\b/i.test(lowered)) {
    return "grief";
  }
  if (/\b(estranged|falling out|rupture|fight|fallout|argued)\b/i.test(lowered)) {
    return "relationship_rupture";
  }
  if (/\b(shame|guilt|embarrass|regret)\b/i.test(lowered)) {
    return "shame";
  }
  if (/\b(burnt out|burned out|overwhelmed|can't cope|breaking down)\b/i.test(lowered)) {
    return "deep_strain";
  }
  return null;
}

function deriveBurstTopicHint(params: {
  transcript: string;
  overlayTopicKey?: string | null;
}) {
  if (params.overlayTopicKey) {
    return normalizeTopicKey(params.overlayTopicKey);
  }
  const lowered = normalizeWhitespace(params.transcript).toLowerCase();
  if (!lowered) return "general";
  if (/\b(partner|girlfriend|boyfriend|wife|husband|friend|mom|mum|dad|daughter|son)\b/i.test(lowered)) {
    return "relationship";
  }
  if (/\b(work|project|ship|deploy|release|task|deadline|focus)\b/i.test(lowered)) {
    return "work";
  }
  if (/\b(health|sleep|steps|walk|gym|run|tired|exhausted)\b/i.test(lowered)) {
    return "health";
  }
  if (/\b(stress|anxious|overwhelm|frustrated|angry|sad|grief|shame)\b/i.test(lowered)) {
    return "emotion";
  }
  return "general";
}

function keyFromDeferredProfileLine(line: string) {
  const lowered = line.toLowerCase();
  if (lowered.startsWith("daily anchors:")) return "synapse:daily_anchors";
  if (lowered.startsWith("recent signals:")) return "synapse:recent_signals";
  if (lowered.startsWith("long-term direction")) return "synapse:goal";
  if (lowered.startsWith("people currently in focus")) return "synapse:relationship";
  if (lowered.startsWith("current work")) return "synapse:work";
  if (lowered.startsWith("pattern to watch")) return "synapse:pattern";
  if (lowered.startsWith("communication preference")) return "synapse:preferences";
  return "synapse:profile";
}

function transcriptReMentionsKey(transcript: string, key: string) {
  const lowered = normalizeWhitespace(transcript).toLowerCase();
  if (!lowered) return false;
  if (key === "synapse:daily_anchors") {
    return /\b(steps|sleep|wake|bed|hydration|goal)\b/i.test(lowered);
  }
  if (key === "synapse:recent_signals") {
    return /\b(recent|lately|trend)\b/i.test(lowered);
  }
  if (key === "synapse:goal" || key === "synapse:work") {
    return /\b(goal|plan|ship|work|project|focus)\b/i.test(lowered);
  }
  if (key === "synapse:trajectory") {
    return /\b(goal|plan|focus|today|next|steps|loop|track|trajectory)\b/i.test(lowered);
  }
  if (key === "synapse:relationship" || key === "moment:relationship_rupture") {
    return /\b(partner|girlfriend|boyfriend|wife|husband|friend|mom|mum|dad|argued|fight)\b/i.test(lowered);
  }
  if (key.startsWith("local:emotion") || key === "moment:strain") {
    return /\b(stress|stressed|anxious|overwhelm|frustrated|angry|tired)\b/i.test(lowered);
  }
  if (key.startsWith("local:activity") || key === "moment:win" || key === "moment:comeback") {
    return /\b(walk|shipp|push|deploy|release|finished|again|restart)\b/i.test(lowered);
  }
  return false;
}

function selectUserContextCandidates(params: {
  transcript: string;
  deferredProfileLines: string[];
  recentInjectedContextKeys: string[];
  trajectory?: TrajectoryCandidateInput | null;
}) {
  const candidates: UserContextCandidate[] = [];
  const magic = extractMagicMomentLine(params.transcript);
  if (magic) {
    candidates.push({ line: magic.line, key: magic.key });
  }
  const localLine = extractLocalTurnSignalLine(params.transcript);
  if (localLine) {
    candidates.push({
      line: localLine,
      key: extractLocalTurnSignalKey(params.transcript) ?? "local:now",
    });
  }
  const trajectory = buildTrajectoryCandidate(params.trajectory);
  if (trajectory) {
    candidates.push(trajectory);
  }
  for (const line of params.deferredProfileLines) {
    candidates.push({
      line: `Synapse (recent): ${line}`,
      key: keyFromDeferredProfileLine(line),
    });
  }

  const selected: UserContextCandidate[] = [];
  const recentSet = new Set(params.recentInjectedContextKeys);
  for (const candidate of candidates) {
    if (selected.length >= 3) break;
    const quality = isGoodContextLine({
      line: candidate.line,
      userText: params.transcript,
      key: candidate.key,
    });
    if (!quality.ok) {
      if (env.FEATURE_CONTEXT_DEBUG === "true") {
        console.debug("[context.line.drop]", {
          key: candidate.key,
          reason: quality.reason,
        });
      }
      continue;
    }
    const repeated = recentSet.has(candidate.key);
    const allowRepeat = transcriptReMentionsKey(params.transcript, candidate.key);
    if (repeated && !allowRepeat) continue;
    if (selected.some((entry) => entry.key === candidate.key)) continue;
    selected.push(candidate);
  }
  return selected;
}

function updateRecentInjectedContextKeys(previous: string[], injected: string[]) {
  const next = [...previous];
  for (const key of injected) {
    const idx = next.indexOf(key);
    if (idx >= 0) next.splice(idx, 1);
    next.push(key);
  }
  return next.slice(-6);
}

function getLibrarianTimeoutMs() {
  const raw = env.LIBRARIAN_TIMEOUT_MS;
  if (!raw) return DEFAULT_LIBRARIAN_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIBRARIAN_TIMEOUT_MS;
  return parsed;
}
function getActiveWindowMs() {
  const raw = env.SESSION_ACTIVE_WINDOW_MS;
  if (!raw) return 5 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5 * 60 * 1000;
  return parsed;
}

function getPostureResetGapMinutes() {
  const raw = env.POSTURE_RESET_GAP_MINUTES;
  if (!raw) return DEFAULT_POSTURE_RESET_GAP_MINUTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POSTURE_RESET_GAP_MINUTES;
  return parsed;
}

function getUserStateResetGapMinutes() {
  const raw = env.USER_STATE_RESET_GAP_MINUTES;
  if (!raw) return DEFAULT_USER_STATE_RESET_GAP_MINUTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_USER_STATE_RESET_GAP_MINUTES;
  return parsed;
}

function getSessionContext(sessionState?: any) {
  if (!sessionState) return null;

  const lastInteractionIso = sessionState.lastInteraction as string | undefined;
  let timeSince = "unknown";
  if (lastInteractionIso) {
    const last = new Date(lastInteractionIso);
    if (!Number.isNaN(last.getTime())) {
      const diffMs = Date.now() - last.getTime();
      const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
      if (diffMinutes < 60) {
        timeSince = `${diffMinutes} minutes`;
      } else if (diffMinutes < 1440) {
        const diffHours = Math.floor(diffMinutes / 60);
        timeSince = `${diffHours} hours`;
      } else {
        const diffDays = Math.floor(diffMinutes / 1440);
        timeSince = `${diffDays} days`;
      }
    }
  }

  const messageCount =
    typeof sessionState.messageCount === "number"
      ? sessionState.messageCount
      : "unknown";

  return `[SESSION STATE] Time Since Last Interaction: ${timeSince} Message Count: ${messageCount}`;
}

type TriageRiskLevel = "LOW" | "MED" | "HIGH" | "CRISIS";
type TriagePressure = "LOW" | "MED" | "HIGH";
type TriageCapacity = "LOW" | "MED" | "HIGH";
type TriagePermission = "NONE" | "IMPLICIT" | "EXPLICIT";
type TriageTacticAppetite = "NONE" | "LOW" | "MED" | "HIGH";
type TriageRupture = "NONE" | "MILD" | "STRONG";
type TriageHarmIfWrong = "LOW" | "MED" | "HIGH";
type TriageSource = "model" | "fallback" | "failed_parse";
type PostureSource = "router" | "fallback";

type TriageGateResult = {
  risk_level: TriageRiskLevel;
  pressure: TriagePressure;
  capacity: TriageCapacity;
  permission: TriagePermission;
  tactic_appetite: TriageTacticAppetite;
  rupture: TriageRupture;
  rupture_confidence: number;
  should_run_router: boolean;
  memory_query_eligible: boolean;
  confidence: number;
  harm_if_wrong: TriageHarmIfWrong;
  reason?: string | null;
};

type RouterGateResult = {
  intent: OverlayIntent;
  posture: "COMPANION" | "MOMENTUM" | "REFLECTION" | "RELATIONSHIP" | "IDEATION" | "RECOVERY" | "PRACTICAL";
  posture_confidence: number;
  explicit_topic_shift: boolean;
  mood: "CALM" | "NEUTRAL" | "LOW" | "UPBEAT" | "FRUSTRATED" | "OVERWHELMED" | "ANXIOUS";
  energy: "LOW" | "MED" | "HIGH";
  state_confidence: number;
  reason?: string | null;
};

type MemoryQuerySpec = {
  entities?: string[];
  topics?: string[];
  time_hint?: string | null;
  intent?: string | null;
};

type RecallRelevanceResult = {
  use: boolean;
  confidence: number;
  reason?: string | null;
};

type RouterRunReason =
  | "ran_should_run_router"
  | "ran_harm_low_confidence"
  | "ran_sensitive_boundary"
  | "skipped_risk_high"
  | "skipped_capacity_low"
  | "skipped_time_budget"
  | "skipped_triage_false"
  | "triage_failed_parse";

type ConversationPosture = "COMPANION" | "MOMENTUM" | "REFLECTION" | "RELATIONSHIP" | "IDEATION" | "RECOVERY" | "PRACTICAL";
type ConversationPressure = "LOW" | "MED" | "HIGH";
type UserMood = "CALM" | "NEUTRAL" | "LOW" | "UPBEAT" | "FRUSTRATED" | "OVERWHELMED" | "ANXIOUS";
type UserEnergy = "LOW" | "MED" | "HIGH";
type UserTone = "PLAYFUL" | "SERIOUS" | "TENDER" | "DIRECT";
type RiskLevel = "LOW" | "MED" | "HIGH" | "CRISIS";

const DEFAULT_POSTURE: ConversationPosture = "COMPANION";
const DEFAULT_PRESSURE: ConversationPressure = "MED";
const DEFAULT_MOOD: UserMood = "NEUTRAL";
const DEFAULT_ENERGY: UserEnergy = "MED";
const DEFAULT_TONE: UserTone = "SERIOUS";
const DEFAULT_RISK: RiskLevel = "LOW";
const DEFAULT_GATE_INTENT: OverlayIntent = "companion";

const POSTURE_GUIDANCE: Record<ConversationPosture, string> = {
  COMPANION: "Friendly, present.",
  MOMENTUM: "Direct, action-first.",
  REFLECTION: "Slower, thoughtful.",
  RELATIONSHIP: "People + nuance.",
  IDEATION: "Playful, explore options.",
  RECOVERY: "Gentle, minimal pressure.",
  PRACTICAL: "Concrete, specific steps.",
};

type PostureState = {
  current: ConversationPosture;
  pressure: ConversationPressure;
  lastSuggestion?: ConversationPosture | null;
  streak?: number;
  lastConfidence?: number;
  lastSessionId?: string | null;
};

type OverlayUsed = {
  curiositySpiral?: boolean;
  accountabilityTug?: boolean;
  dailyFocus?: boolean;
  dailyReview?: boolean;
  weeklyCompass?: boolean;
};

type OverlayUserState = {
  lastTugAt?: string | null;
  tugBackoff?: Record<string, string>;
  todayFocus?: string | null;
  todayFocusDate?: string | null;
  lastDailyFocusAt?: string | null;
  lastDailyReviewDate?: string | null;
  lastDailyReviewSummary?: string | null;
  weeklyNorthStar?: string | null;
  weeklyNorthStarWeekStartDate?: string | null;
  weeklyPriorities?: string[];
  sessionFactCorrections?: string[];
};

type OverlayState = {
  overlayUsed?: OverlayUsed;
  overlayTypeActive?: TacticOverlayType | null;
  overlayTurnCount?: number;
  lastSessionId?: string | null;
  pendingDismissType?: TacticOverlayType | null;
  pendingTopicKey?: string | null;
  shortReplyStreak?: number;
  pendingFocusCapture?: boolean;
  pendingDailyReviewCapture?: boolean;
  pendingWeeklyCompassCapture?: boolean;
  correctionOverlayCooldownTurns?: number;
  startbriefV2UserTurnsSeen?: number;
  startbriefV2ReinjectedOnce?: boolean;
  startbriefV2FirstUserLowSignal?: boolean;
  loopsCache?: { fetchedAt?: string | null; items?: string[] };
  queryCache?: { fetchedAt?: string | null; facts?: string[] };
  recentInjectedContextKeys?: string[];
  recentOverlayKeys?: string[];
  stanceActive?: StanceOverlayType | null;
  stanceTurnsRemaining?: number;
  tierBurst?: TierBurstState;
  endearmentCooldownTurns?: number;
  cooldownTurnsRemaining?: number;
  cooldownLastReason?: "rupture_strong" | "rupture_mild" | null;
  lastProbingTacticFired?: boolean;
  user?: OverlayUserState;
  synapseSessionIngestOk?: boolean | null;
  synapseSessionIngestError?: string | null;
};

type ChatTimingSpans = {
  stt_ms: number;
  context_ms: number;
  librarian_ms: number;
  overlay_ms: number;
  llm_ms: number;
  tts_ms: number;
  db_write_ms: number;
  total_ms: number;
};

type ContextGovernorSource = "user_context" | "handover" | "bridge" | "signal_pack" | "ops";
type ContextGovernorDropReason = "budget" | "redundant" | "precedence" | "low_relevance";

type ContextGovernorRuntime = {
  used: true;
  budget_chars: number;
  candidates_total: number;
  selected_total: number;
  selected_by_source: Record<ContextGovernorSource, number>;
  dropped_by_reason: Record<ContextGovernorDropReason, number>;
  selected_keys: string[];
};

const postureStateCache = new Map<string, PostureState>();
const userStateCache = new Map<string, UserStateState>();
const overlayStateCache = new Map<string, OverlayState>();

function buildChatTrace(params: {
  traceId: string;
  requestId: string;
  userId: string;
  personaId: string;
  sessionId: string;
  chosenModel: string;
  riskLevel: RiskLevel;
  intent: OverlayIntent;
  stanceSelected: StanceOverlayType | "none";
  tacticSelected: TacticOverlayType | "none";
  suppressionReason: string | null;
  overlaySelected: OverlayType | "none";
  overlaySkipReason: string | null;
  startbrief: {
    used: boolean;
    fallback: "session/brief" | null;
    items_count: number;
    bridgeText_chars: number;
  };
  startbriefRuntime: {
    session_id: string;
    userTurnsSeen: number;
    handover_injected: boolean;
    bridge_injected: boolean;
    ops_injected: boolean;
    ops_source: "startbrief_ops" | "loops" | "query" | null;
    startbrief_fetch: "hit" | "miss";
    reinjection_used: boolean;
  };
  systemBlocks: string[];
  counts: {
    recentMessages: number;
    situationalContext: number;
    supplementalContext: number;
    rollingSummary: number;
  };
  synapseSessionIngestOk: boolean | null;
  synapseSessionIngestError: string | null;
  timings: ChatTimingSpans;
  contextGovernor?: ContextGovernorRuntime | null;
}) {
  return {
    trace_id: params.traceId,
    request_id: params.requestId,
    userId: params.userId,
    personaId: params.personaId,
    sessionId: params.sessionId,
    chosenModel: params.chosenModel,
    risk_level: params.riskLevel,
    intent: params.intent,
    stanceSelected: params.stanceSelected,
    tacticSelected: params.tacticSelected,
    suppressionReason: params.suppressionReason,
    overlaySelected: params.overlaySelected,
    overlaySkipReason: params.overlaySkipReason,
    startbrief_used: params.startbrief.used,
    startbrief_fallback: params.startbrief.fallback,
    startbrief_items_count: params.startbrief.items_count,
    bridgeText_chars: params.startbrief.bridgeText_chars,
    startbrief_runtime: params.startbriefRuntime,
    system_blocks: params.systemBlocks,
    synapse_session_ingest_ok: params.synapseSessionIngestOk,
    synapse_session_ingest_error: params.synapseSessionIngestError,
    token_usage: null,
    context_governor: params.contextGovernor ?? null,
    counts: params.counts,
    timings: params.timings,
  };
}

function normalizePosture(value?: string | null): ConversationPosture {
  if (value) {
    const candidate = value.split("|")[0]?.trim();
    if (candidate && candidate in POSTURE_GUIDANCE) {
      return candidate as ConversationPosture;
    }
  }
  return DEFAULT_POSTURE;
}

function normalizePressure(value?: string | null): ConversationPressure {
  if (value === "LOW" || value === "MED" || value === "HIGH") return value;
  return DEFAULT_PRESSURE;
}

function normalizeMood(value?: string | null): UserMood {
  if (
    value === "CALM" ||
    value === "NEUTRAL" ||
    value === "LOW" ||
    value === "UPBEAT" ||
    value === "FRUSTRATED" ||
    value === "OVERWHELMED" ||
    value === "ANXIOUS"
  ) {
    return value;
  }
  return DEFAULT_MOOD;
}

function normalizeEnergy(value?: string | null): UserEnergy {
  if (value === "LOW" || value === "MED" || value === "HIGH") return value;
  return DEFAULT_ENERGY;
}

function normalizeTone(value?: string | null): UserTone {
  if (value === "PLAYFUL" || value === "SERIOUS" || value === "TENDER" || value === "DIRECT") {
    return value;
  }
  return DEFAULT_TONE;
}

function normalizeRiskLevel(value?: string | null): RiskLevel {
  if (value === "LOW" || value === "MED" || value === "HIGH" || value === "CRISIS") {
    return value;
  }
  return DEFAULT_RISK;
}

function normalizeGateIntent(value?: string | null): OverlayIntent {
  if (
    value === "companion" ||
    value === "momentum" ||
    value === "output_task" ||
    value === "learning"
  ) {
    return value;
  }
  return DEFAULT_GATE_INTENT;
}

async function readPostureState(userId: string, personaId: string): Promise<PostureState | null> {
  if (process.env.NODE_ENV === "test") {
    return postureStateCache.get(`${userId}:${personaId}`) ?? null;
  }
  const sessionState = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const state = sessionState?.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const postureState = (state as Record<string, unknown>).postureState;
  if (!postureState || typeof postureState !== "object" || Array.isArray(postureState)) return null;
  const raw = postureState as Record<string, unknown>;
  return {
    current: normalizePosture(typeof raw.current === "string" ? raw.current : null),
    pressure: normalizePressure(typeof raw.pressure === "string" ? raw.pressure : null),
    lastSuggestion:
      typeof raw.lastSuggestion === "string" ? normalizePosture(raw.lastSuggestion) : null,
    streak: typeof raw.streak === "number" ? raw.streak : 0,
    lastConfidence: typeof raw.lastConfidence === "number" ? raw.lastConfidence : 0,
    lastSessionId: typeof raw.lastSessionId === "string" ? raw.lastSessionId : null,
  };
}

type UserStateState = {
  currentMood: UserMood;
  currentEnergy: UserEnergy;
  currentTone: UserTone;
  lastSuggestion?: UserMood | null;
  streak?: number;
  lastConfidence?: number;
  lastSessionId?: string | null;
  lastUpdatedAt?: string | null;
};

async function readUserState(userId: string, personaId: string): Promise<UserStateState | null> {
  if (process.env.NODE_ENV === "test") {
    return userStateCache.get(`${userId}:${personaId}`) ?? null;
  }
  const sessionState = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const state = sessionState?.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const userState = (state as Record<string, unknown>).userStateState;
  if (!userState || typeof userState !== "object" || Array.isArray(userState)) return null;
  const raw = userState as Record<string, unknown>;
  return {
    currentMood: normalizeMood(typeof raw.currentMood === "string" ? raw.currentMood : null),
    currentEnergy: normalizeEnergy(typeof raw.currentEnergy === "string" ? raw.currentEnergy : null),
    currentTone: normalizeTone(typeof raw.currentTone === "string" ? raw.currentTone : null),
    lastSuggestion:
      typeof raw.lastSuggestion === "string" ? normalizeMood(raw.lastSuggestion) : null,
    streak: typeof raw.streak === "number" ? raw.streak : 0,
    lastConfidence: typeof raw.lastConfidence === "number" ? raw.lastConfidence : 0,
    lastSessionId: typeof raw.lastSessionId === "string" ? raw.lastSessionId : null,
    lastUpdatedAt: typeof raw.lastUpdatedAt === "string" ? raw.lastUpdatedAt : null,
  };
}

async function readOverlayState(userId: string, personaId: string): Promise<OverlayState | null> {
  if (process.env.NODE_ENV === "test") {
    return overlayStateCache.get(`${userId}:${personaId}`) ?? null;
  }
  const sessionState = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const state = sessionState?.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const retryStateRaw = (state as Record<string, unknown>).synapseSessionIngestRetry;
  const retryState =
    retryStateRaw && typeof retryStateRaw === "object" && !Array.isArray(retryStateRaw)
      ? (retryStateRaw as Record<string, unknown>)
      : null;
  const overlayState = (state as Record<string, unknown>).overlayState;
  if (!overlayState || typeof overlayState !== "object" || Array.isArray(overlayState)) {
    return {
      synapseSessionIngestOk:
        typeof retryState?.lastOk === "boolean" ? retryState.lastOk : null,
      synapseSessionIngestError:
        typeof retryState?.lastError === "string" ? retryState.lastError : null,
    };
  }
  const raw = overlayState as Record<string, unknown>;
  return {
    overlayUsed: typeof raw.overlayUsed === "object" && raw.overlayUsed && !Array.isArray(raw.overlayUsed)
      ? (raw.overlayUsed as OverlayUsed)
      : undefined,
    overlayTypeActive:
      typeof raw.overlayTypeActive === "string" ? (raw.overlayTypeActive as TacticOverlayType) : null,
    overlayTurnCount: typeof raw.overlayTurnCount === "number" ? raw.overlayTurnCount : 0,
    lastSessionId: typeof raw.lastSessionId === "string" ? raw.lastSessionId : null,
    pendingDismissType:
      typeof raw.pendingDismissType === "string" ? (raw.pendingDismissType as TacticOverlayType) : null,
    pendingTopicKey: typeof raw.pendingTopicKey === "string" ? raw.pendingTopicKey : null,
    shortReplyStreak: typeof raw.shortReplyStreak === "number" ? raw.shortReplyStreak : 0,
    pendingFocusCapture: typeof raw.pendingFocusCapture === "boolean" ? raw.pendingFocusCapture : false,
    pendingDailyReviewCapture:
      typeof raw.pendingDailyReviewCapture === "boolean" ? raw.pendingDailyReviewCapture : false,
    pendingWeeklyCompassCapture:
      typeof raw.pendingWeeklyCompassCapture === "boolean" ? raw.pendingWeeklyCompassCapture : false,
    startbriefV2UserTurnsSeen:
      typeof raw.startbriefV2UserTurnsSeen === "number" ? raw.startbriefV2UserTurnsSeen : 0,
    startbriefV2ReinjectedOnce:
      typeof raw.startbriefV2ReinjectedOnce === "boolean" ? raw.startbriefV2ReinjectedOnce : false,
    startbriefV2FirstUserLowSignal:
      typeof raw.startbriefV2FirstUserLowSignal === "boolean"
        ? raw.startbriefV2FirstUserLowSignal
        : false,
    loopsCache:
      typeof raw.loopsCache === "object" && raw.loopsCache && !Array.isArray(raw.loopsCache)
        ? {
            fetchedAt:
              typeof (raw.loopsCache as Record<string, unknown>).fetchedAt === "string"
                ? ((raw.loopsCache as Record<string, unknown>).fetchedAt as string)
                : null,
            items: Array.isArray((raw.loopsCache as Record<string, unknown>).items)
              ? ((raw.loopsCache as Record<string, unknown>).items as unknown[])
                  .filter((entry): entry is string => typeof entry === "string")
                  .slice(0, 3)
              : [],
          }
        : undefined,
    queryCache:
      typeof raw.queryCache === "object" && raw.queryCache && !Array.isArray(raw.queryCache)
        ? {
            fetchedAt:
              typeof (raw.queryCache as Record<string, unknown>).fetchedAt === "string"
                ? ((raw.queryCache as Record<string, unknown>).fetchedAt as string)
                : null,
            facts: Array.isArray((raw.queryCache as Record<string, unknown>).facts)
              ? ((raw.queryCache as Record<string, unknown>).facts as unknown[])
                  .filter((entry): entry is string => typeof entry === "string")
                  .slice(0, 3)
              : [],
          }
        : undefined,
    recentInjectedContextKeys: Array.isArray(raw.recentInjectedContextKeys)
      ? (raw.recentInjectedContextKeys as unknown[])
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(-6)
      : [],
    recentOverlayKeys: Array.isArray(raw.recentOverlayKeys)
      ? (raw.recentOverlayKeys as unknown[])
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(-6)
      : [],
    stanceActive: typeof raw.stanceActive === "string" ? (raw.stanceActive as StanceOverlayType) : null,
    stanceTurnsRemaining:
      typeof raw.stanceTurnsRemaining === "number" && Number.isFinite(raw.stanceTurnsRemaining)
        ? Math.max(0, raw.stanceTurnsRemaining)
        : 0,
    endearmentCooldownTurns:
      typeof raw.endearmentCooldownTurns === "number" && Number.isFinite(raw.endearmentCooldownTurns)
        ? Math.max(0, raw.endearmentCooldownTurns)
        : 0,
    cooldownTurnsRemaining:
      typeof raw.cooldownTurnsRemaining === "number" && Number.isFinite(raw.cooldownTurnsRemaining)
        ? Math.max(0, raw.cooldownTurnsRemaining)
        : 0,
    cooldownLastReason:
      raw.cooldownLastReason === "rupture_strong" || raw.cooldownLastReason === "rupture_mild"
        ? raw.cooldownLastReason
        : null,
    lastProbingTacticFired: raw.lastProbingTacticFired === true,
    user: typeof raw.user === "object" && raw.user && !Array.isArray(raw.user)
      ? {
          ...(raw.user as OverlayUserState),
          weeklyPriorities: Array.isArray((raw.user as OverlayUserState).weeklyPriorities)
            ? ((raw.user as OverlayUserState).weeklyPriorities as unknown[])
                .filter((entry): entry is string => typeof entry === "string")
                .slice(0, 3)
            : undefined,
        }
      : undefined,
    synapseSessionIngestOk:
      typeof retryState?.lastOk === "boolean" ? retryState.lastOk : null,
    synapseSessionIngestError:
      typeof retryState?.lastError === "string" ? retryState.lastError : null,
  };
}

async function writeOverlayState(userId: string, personaId: string, next: OverlayState) {
  if (process.env.NODE_ENV === "test") {
    overlayStateCache.set(`${userId}:${personaId}`, next);
    return;
  }
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const baseState =
    existing?.state && typeof existing.state === "object" && !Array.isArray(existing.state)
      ? (existing.state as Record<string, unknown>)
      : {};
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId, personaId } },
    update: {
      state: {
        ...baseState,
        overlayState: next,
      },
    },
    create: {
      userId,
      personaId,
      state: { overlayState: next },
    },
  });
}

async function writeUserState(userId: string, personaId: string, next: UserStateState) {
  if (process.env.NODE_ENV === "test") {
    userStateCache.set(`${userId}:${personaId}`, next);
    return;
  }
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const baseState =
    existing?.state && typeof existing.state === "object" && !Array.isArray(existing.state)
      ? (existing.state as Record<string, unknown>)
      : {};
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId, personaId } },
    update: {
      state: {
        ...baseState,
        userStateState: next,
      },
    },
    create: {
      userId,
      personaId,
      state: { userStateState: next },
    },
  });
}

function isExplicitUserStateReset(transcript: string) {
  const lowered = transcript.toLowerCase();
  const phrases = ["i'm fine", "im fine", "i'm okay", "im okay", "not upset"];
  return phrases.some((phrase) => lowered.includes(phrase));
}

async function resolveUserStateWithHysteresis(params: {
  userId: string;
  personaId: string;
  sessionId: string;
  timeGapMinutes: number | null;
  suggestionMood: UserMood;
  suggestionEnergy: UserEnergy;
  suggestionTone: UserTone;
  confidence: number;
  explicitStateShift: boolean;
  transcript: string;
}) {
  const previous = await readUserState(params.userId, params.personaId);
  const currentMood = previous?.currentMood ?? DEFAULT_MOOD;
  const currentEnergy = previous?.currentEnergy ?? DEFAULT_ENERGY;
  const currentTone = previous?.currentTone ?? DEFAULT_TONE;
  const lastSuggestion = previous?.lastSuggestion ?? null;
  const streak = previous?.streak ?? 0;
  const lastSessionId = previous?.lastSessionId ?? null;
  const gapMinutes = params.timeGapMinutes ?? 0;

  if (
    lastSessionId &&
    lastSessionId !== params.sessionId &&
    gapMinutes >= getUserStateResetGapMinutes()
  ) {
    const resetState: UserStateState = {
      currentMood: DEFAULT_MOOD,
      currentEnergy: DEFAULT_ENERGY,
      currentTone: DEFAULT_TONE,
      lastSuggestion: null,
      streak: 0,
      lastConfidence: 0,
      lastSessionId: params.sessionId,
      lastUpdatedAt: new Date().toISOString(),
    };
    await writeUserState(params.userId, params.personaId, resetState);
    return { mood: DEFAULT_MOOD, energy: DEFAULT_ENERGY, tone: DEFAULT_TONE };
  }

  if (isExplicitUserStateReset(params.transcript)) {
    const resetState: UserStateState = {
      currentMood: DEFAULT_MOOD,
      currentEnergy: DEFAULT_ENERGY,
      currentTone: DEFAULT_TONE,
      lastSuggestion: null,
      streak: 0,
      lastConfidence: 0,
      lastSessionId: params.sessionId,
      lastUpdatedAt: new Date().toISOString(),
    };
    await writeUserState(params.userId, params.personaId, resetState);
    return { mood: DEFAULT_MOOD, energy: DEFAULT_ENERGY, tone: DEFAULT_TONE };
  }

  const suggestionMood = params.suggestionMood;
  const nextStreak = suggestionMood === lastSuggestion ? streak + 1 : 1;
  const shouldSwitch =
    params.confidence >= 0.75 ||
    params.explicitStateShift ||
    (nextStreak >= 2 && suggestionMood !== currentMood);

  const nextMood = shouldSwitch ? suggestionMood : currentMood;
  const nextEnergy = shouldSwitch ? params.suggestionEnergy : currentEnergy;
  const nextTone = shouldSwitch ? params.suggestionTone : currentTone;

  const nextState: UserStateState = {
    currentMood: nextMood,
    currentEnergy: nextEnergy,
    currentTone: nextTone,
    lastSuggestion: suggestionMood,
    streak: nextStreak,
    lastConfidence: params.confidence,
    lastSessionId: params.sessionId,
    lastUpdatedAt: new Date().toISOString(),
  };

  await writeUserState(params.userId, params.personaId, nextState);
  return { mood: nextMood, energy: nextEnergy, tone: nextTone };
}

async function writePostureState(
  userId: string,
  personaId: string,
  next: PostureState
) {
  if (process.env.NODE_ENV === "test") {
    postureStateCache.set(`${userId}:${personaId}`, next);
    return;
  }
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const baseState =
    existing?.state && typeof existing.state === "object" && !Array.isArray(existing.state)
      ? (existing.state as Record<string, unknown>)
      : {};
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId, personaId } },
    update: {
      state: {
        ...baseState,
        postureState: next,
      },
    },
    create: {
      userId,
      personaId,
      state: { postureState: next },
    },
  });
}

async function resolvePostureWithHysteresis(params: {
  userId: string;
  personaId: string;
  sessionId: string;
  timeGapMinutes: number | null;
  suggestion: ConversationPosture;
  pressure: ConversationPressure;
  confidence: number;
  explicitTopicShift: boolean;
}) {
  const previous = await readPostureState(params.userId, params.personaId);
  const current = previous?.current ?? DEFAULT_POSTURE;
  const lastSuggestion = previous?.lastSuggestion ?? null;
  const streak = previous?.streak ?? 0;
  const lastSessionId = previous?.lastSessionId ?? null;
  const gapMinutes = params.timeGapMinutes ?? 0;
  if (
    lastSessionId &&
    lastSessionId !== params.sessionId &&
    gapMinutes >= getPostureResetGapMinutes()
  ) {
    const resetState: PostureState = {
      current: DEFAULT_POSTURE,
      pressure: DEFAULT_PRESSURE,
      lastSuggestion: null,
      streak: 0,
      lastConfidence: 0,
      lastSessionId: params.sessionId,
    };
    await writePostureState(params.userId, params.personaId, resetState);
    return { posture: DEFAULT_POSTURE, pressure: DEFAULT_PRESSURE };
  }
  const suggestion = params.suggestion;

  const nextStreak = suggestion === lastSuggestion ? streak + 1 : 1;
  const shouldSwitch =
    params.confidence >= 0.75 ||
    params.explicitTopicShift ||
    (nextStreak >= 2 && suggestion !== current);

  const nextPosture = shouldSwitch ? suggestion : current;
  const nextPressure = shouldSwitch ? params.pressure : previous?.pressure ?? params.pressure;

  const nextState: PostureState = {
    current: nextPosture,
    pressure: nextPressure,
    lastSuggestion: suggestion,
    streak: nextStreak,
    lastConfidence: params.confidence,
    lastSessionId: params.sessionId,
  };

  await writePostureState(params.userId, params.personaId, nextState);
  return { posture: nextPosture, pressure: nextPressure };
}

type MemoryQueryResponse = {
  facts?: Array<string | { text?: string; relevance?: number | null; source?: string }>;
  entities?: Array<{ summary?: string; type?: string; uuid?: string }>;
  metadata?: { query?: string; facts?: number; entities?: number };
};

function normalizeMemoryQueryResponse(data: MemoryQueryResponse | null | undefined) {
  const facts = Array.isArray(data?.facts)
    ? data!.facts
        .map((fact) => {
          if (typeof fact === "string") return fact.trim();
          if (fact && typeof fact.text === "string") return fact.text.trim();
          return "";
        })
        .filter(Boolean)
    : [];
  const entities = Array.isArray(data?.entities)
    ? data!.entities
        .map((entity) =>
          typeof entity?.summary === "string" ? entity.summary.trim() : ""
        )
        .filter(Boolean)
    : [];
  return { facts, entities };
}

function buildRecallSheet(params: {
  query: string;
  facts: string[];
  entities: string[];
}) {
  const lines: string[] = [];
  lines.push(`Recall Sheet (query: ${params.query})`);
  if (params.facts.length > 0) {
    lines.push("Facts:");
    for (const fact of params.facts.slice(0, 3)) {
      lines.push(`- ${fact}`);
    }
  }
  if (params.entities.length > 0) {
    lines.push("Entities:");
    for (const entity of params.entities.slice(0, 3)) {
      lines.push(`- ${entity}`);
    }
  }
  return lines.join("\n");
}

function sanitizeSearchString(input: string) {
  const cleaned = input.replace(/[^a-zA-Z0-9\s]+/g, " ").trim();
  const collapsed = cleaned.replace(/\s+/g, " ");
  if (!collapsed) return null;
  const words = collapsed.split(" ").slice(0, 4);
  if (words.length < 1) return null;
  const truncated = words.join(" ").slice(0, 48).trim();
  return truncated || null;
}

function extractLastTwoTurns(
  messages: Array<{ role: "user" | "assistant"; content: string }>
) {
  return messages.slice(-4);
}

function isExplicitRecall(text: string) {
  const lowered = text.toLowerCase();
  const patterns = [
    "what did i say",
    "remind me",
    "when did we",
    "you mentioned",
    "who was",
    "do you remember",
    "did i tell you",
    "last time",
    "remember when",
  ];
  return patterns.some((pattern) => lowered.includes(pattern));
}

function buildQueryFromSpec(spec: MemoryQuerySpec) {
  const tokens: string[] = [];
  const genericTokens = new Set([
    "support",
    "help",
    "someone",
    "anyone",
    "something",
    "anything",
    "everything",
  ]);
  const stopwords = new Set([
    "i",
    "me",
    "you",
    "we",
    "us",
    "our",
    "your",
    "my",
    "assistant",
    "ai",
    "prompt",
    "bot",
  ]);
  const pushTokens = (values: string[] | undefined) => {
    if (!values) return;
    for (const value of values) {
      const cleaned = sanitizeSearchString(String(value));
      if (!cleaned) continue;
      tokens.push(...cleaned.split(" "));
    }
  };
  pushTokens(spec.entities);
  pushTokens(spec.topics);
  if (spec.time_hint) {
    const cleaned = sanitizeSearchString(spec.time_hint);
    if (cleaned) tokens.push(...cleaned.split(" "));
  }
  const unique = Array.from(new Set(tokens.map((token) => token.trim()).filter(Boolean)));
  if (unique.length === 0) return null;
  const filtered = unique.filter((token) => !stopwords.has(token.toLowerCase()));
  if (filtered.length === 0) return null;
  const nounHeavy = filtered.filter((token) => !genericTokens.has(token.toLowerCase()));
  if (nounHeavy.length === 0) return null;
  const preferred = nounHeavy.length > 0 ? nounHeavy : filtered;
  return preferred.slice(0, 4).join(" ").slice(0, 48).trim();
}

async function callOpenRouterJson(
  prompt: string,
  model: string,
  timeoutMs: number
) {
  const detailed = await callOpenRouterJsonDetailed({ prompt, model, timeoutMs });
  return detailed.result;
}

async function callOpenRouterJsonDetailed(params: {
  prompt: string;
  model: string;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    };
    if (env.OPENROUTER_APP_URL) {
      headers["HTTP-Referer"] = env.OPENROUTER_APP_URL;
    }
    if (env.OPENROUTER_APP_NAME) {
      headers["X-Title"] = env.OPENROUTER_APP_NAME;
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: "user", content: params.prompt }],
        max_tokens: 350,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        result: null as Record<string, unknown> | null,
        failureCause: `http_status_${response.status}`,
        latencyMs: Date.now() - startedAt,
        rawContent: null as string | null,
      };
    }
    let rawBody = "";
    try {
      rawBody = await response.text();
    } catch {
      return {
        result: null as Record<string, unknown> | null,
        failureCause: "response_read_error",
        latencyMs: Date.now() - startedAt,
        rawContent: null as string | null,
      };
    }

    let data: unknown = null;
    try {
      data = JSON.parse(rawBody);
    } catch {
      return {
        result: null as Record<string, unknown> | null,
        failureCause: "response_json_invalid",
        latencyMs: Date.now() - startedAt,
        rawContent: rawBody.trim().slice(0, 2000),
      };
    }
    const content = String((data as any)?.choices?.[0]?.message?.content ?? "").trim();
    if (!content) {
      return {
        result: null as Record<string, unknown> | null,
        failureCause: "empty_content",
        latencyMs: Date.now() - startedAt,
        rawContent: null as string | null,
      };
    }
    try {
      return {
        result: JSON.parse(content) as Record<string, unknown>,
        failureCause: null as string | null,
        latencyMs: Date.now() - startedAt,
        rawContent: content,
      };
    } catch {
      return {
        result: null as Record<string, unknown> | null,
        failureCause: "parse_error",
        latencyMs: Date.now() - startedAt,
        rawContent: content,
      };
    }
  } catch (error) {
    const failureCause =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "fetch_error";
    return {
      result: null as Record<string, unknown> | null,
      failureCause,
      latencyMs: Date.now() - startedAt,
      rawContent: null as string | null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

const TRIAGE_PRIMARY_MODEL = "meta-llama/llama-3.1-8b-instruct";
const ROUTER_PRIMARY_MODEL = "openai/gpt-oss-20b";
const GATE_FALLBACK_MODEL = "meta-llama/llama-3.1-8b-instruct";
const TRIAGE_MAX_TIMEOUT_MS = 400;
const ROUTER_MAX_TIMEOUT_MS = 550;
const ROUTER_MIN_BUDGET_MS = 350;

function parseTriageRisk(value: unknown): TriageRiskLevel | null {
  return value === "LOW" || value === "MED" || value === "HIGH" || value === "CRISIS"
    ? value
    : null;
}

function parseTriagePressure(value: unknown): TriagePressure | null {
  return value === "LOW" || value === "MED" || value === "HIGH" ? value : null;
}

function parseTriageCapacity(value: unknown): TriageCapacity | null {
  return value === "LOW" || value === "MED" || value === "HIGH" ? value : null;
}

function parseTriagePermission(value: unknown): TriagePermission | null {
  return value === "NONE" || value === "IMPLICIT" || value === "EXPLICIT" ? value : null;
}

function parseTriageTacticAppetite(value: unknown): TriageTacticAppetite | null {
  return value === "NONE" || value === "LOW" || value === "MED" || value === "HIGH"
    ? value
    : null;
}

function parseTriageRupture(value: unknown): TriageRupture | null {
  return value === "NONE" || value === "MILD" || value === "STRONG" ? value : null;
}

function parseTriageHarmIfWrong(value: unknown): TriageHarmIfWrong | null {
  return value === "LOW" || value === "MED" || value === "HIGH" ? value : null;
}

function parseConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function conservativeTriageFallback(): TriageGateResult {
  return {
    risk_level: "MED",
    pressure: "LOW",
    capacity: "LOW",
    permission: "NONE",
    tactic_appetite: "NONE",
    rupture: "NONE",
    rupture_confidence: 0,
    should_run_router: false,
    memory_query_eligible: false,
    confidence: 0,
    harm_if_wrong: "HIGH",
    reason: "triage_fallback_conservative",
  };
}

function parseTriageGateResponse(result: Record<string, unknown>): TriageGateResult | null {
  const risk_level = parseTriageRisk(result.risk_level);
  const pressure = parseTriagePressure(result.pressure);
  const capacity = parseTriageCapacity(result.capacity);
  const permission = parseTriagePermission(result.permission);
  const tactic_appetite = parseTriageTacticAppetite(result.tactic_appetite);
  const rupture = parseTriageRupture(result.rupture);
  const rupture_confidence = parseConfidence(result.rupture_confidence);
  const confidence = parseConfidence(result.confidence);
  const harm_if_wrong = parseTriageHarmIfWrong(result.harm_if_wrong);
  const should_run_router = typeof result.should_run_router === "boolean" ? result.should_run_router : null;
  const memory_query_eligible =
    typeof result.memory_query_eligible === "boolean" ? result.memory_query_eligible : null;
  const reason = typeof result.reason === "string" ? result.reason : null;

  if (
    !risk_level ||
    !pressure ||
    !capacity ||
    !permission ||
    !tactic_appetite ||
    !rupture ||
    rupture_confidence === null ||
    confidence === null ||
    !harm_if_wrong ||
    should_run_router === null ||
    memory_query_eligible === null
  ) {
    return null;
  }

  return {
    risk_level,
    pressure,
    capacity,
    permission,
    tactic_appetite,
    rupture,
    rupture_confidence,
    should_run_router,
    memory_query_eligible,
    confidence,
    harm_if_wrong,
    reason,
  };
}

function isAmbiguitySensitiveTurn(transcript: string): boolean {
  const lowered = normalizeWhitespace(transcript).toLowerCase();
  if (!lowered) return false;
  return (
    /\b(why|how|not sure|confused|mixed|stuck|unpack|figure out|work through)\b/i.test(lowered) ||
    /\b(feel|feeling|worried|anxious|overwhelmed|guilt|shame|relationship|argue|repair)\b/i.test(lowered)
  );
}

function normalizeTriageForRouting(params: {
  triage: TriageGateResult;
  transcript: string;
}): TriageGateResult {
  const { triage, transcript } = params;
  const normalized: TriageGateResult = { ...triage };

  // Explicit asks usually imply at least minimal receptiveness to guided structure.
  if (normalized.permission === "EXPLICIT" && normalized.tactic_appetite === "NONE") {
    normalized.tactic_appetite = "LOW";
  }

  // Allow router on clear high-runway turns only when the user's ask appears semantically ambiguous.
  if (
    normalized.capacity === "HIGH" &&
    normalized.pressure === "LOW" &&
    normalized.permission !== "NONE" &&
    normalized.confidence >= 0.7 &&
    !normalized.should_run_router &&
    isAmbiguitySensitiveTurn(transcript)
  ) {
    normalized.should_run_router = true;
  }

  return normalized;
}

function extractFirstJsonObjectBlock(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function shapePreview(text: string): string {
  return text
    .slice(0, 600)
    .replace(/[A-Za-z0-9]/g, "x");
}

function parseLegacyGateAsTriage(result: Record<string, unknown>): TriageGateResult | null {
  // Backward-compatible parser for old Memory Gate shape used in existing tests.
  if (!("action" in result) && !("posture" in result) && !("risk_level" in result)) return null;
  const risk_level = parseTriageRisk(result.risk_level) ?? "MED";
  const pressure = parseTriagePressure(result.pressure) ?? "MED";
  const confidence = parseConfidence(result.confidence) ?? 0;
  const capacity: TriageCapacity = pressure === "LOW" ? "MED" : "LOW";
  const permission: TriagePermission =
    result.is_direct_request === true ? "EXPLICIT" : "NONE";
  const memory_query_eligible = result.action === "memory_query";
  const reason = typeof result.reason === "string" ? result.reason : "legacy_gate_adapter";
  const harm_if_wrong: TriageHarmIfWrong =
    risk_level === "HIGH" || risk_level === "CRISIS" || pressure === "HIGH" ? "HIGH" : "MED";
  return {
    risk_level,
    pressure,
    capacity,
    permission,
    tactic_appetite: "LOW",
    rupture: "NONE",
    rupture_confidence: 0,
    should_run_router: false,
    memory_query_eligible,
    confidence,
    harm_if_wrong,
    reason,
  };
}

function parseRouterGateResponse(result: Record<string, unknown>): RouterGateResult | null {
  const intent = normalizeGateIntent(typeof result.intent === "string" ? result.intent : null);
  const posture = normalizePosture(typeof result.posture === "string" ? result.posture : null);
  const posture_confidence = parseConfidence(result.posture_confidence);
  const explicit_topic_shift =
    typeof result.explicit_topic_shift === "boolean" ? result.explicit_topic_shift : null;
  const mood = normalizeMood(typeof result.mood === "string" ? result.mood : null);
  const energy = normalizeEnergy(typeof result.energy === "string" ? result.energy : null);
  const state_confidence = parseConfidence(result.state_confidence);
  const reason = typeof result.reason === "string" ? result.reason : null;

  if (posture_confidence === null || explicit_topic_shift === null || state_confidence === null) {
    return null;
  }
  return {
    intent,
    posture,
    posture_confidence,
    explicit_topic_shift,
    mood,
    energy,
    state_confidence,
    reason,
  };
}

async function callOpenRouterJsonWithModelFallback(params: {
  prompt: string;
  primaryModel: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  const primaryCall = await callOpenRouterJsonDetailed({
    prompt: params.prompt,
    model: params.primaryModel,
    timeoutMs: params.timeoutMs,
  });
  if (primaryCall.result) {
    return {
      result: primaryCall.result,
      modelUsed: params.primaryModel,
      usedFallbackModel: false,
      primaryError: null as string | null,
      primaryFailureCause: null as string | null,
      fallbackFailureCause: null as string | null,
    };
  }
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, params.timeoutMs - elapsed);
  if (remaining < 80) {
    return {
      result: null,
      modelUsed: params.primaryModel,
      usedFallbackModel: false,
      primaryError: `primary_failed_no_budget_for_fallback:${primaryCall.failureCause ?? "unknown"}`,
      primaryFailureCause: primaryCall.failureCause ?? "unknown",
      fallbackFailureCause: "no_budget_for_fallback",
    };
  }
  const fallbackCall = await callOpenRouterJsonDetailed({
    prompt: params.prompt,
    model: GATE_FALLBACK_MODEL,
    timeoutMs: remaining,
  });
  if (!fallbackCall.result) {
    return {
      result: null,
      modelUsed: GATE_FALLBACK_MODEL,
      usedFallbackModel: true,
      primaryError: `primary_and_fallback_failed:${primaryCall.failureCause ?? "unknown"}`,
      primaryFailureCause: primaryCall.failureCause ?? "unknown",
      fallbackFailureCause: fallbackCall.failureCause ?? "unknown",
    };
  }
  return {
    result: fallbackCall.result,
    modelUsed: GATE_FALLBACK_MODEL,
    usedFallbackModel: true,
    primaryError: `primary_failed_fallback_succeeded:${primaryCall.failureCause ?? "unknown"}`,
    primaryFailureCause: primaryCall.failureCause ?? "unknown",
    fallbackFailureCause: null as string | null,
  };
}

async function runTriageGate(params: {
  transcript: string;
  lastTurns: string;
  timeoutMs: number;
}) {
  const { transcript, lastTurns, timeoutMs } = params;
  const prompt = `You are Memory Gate TRIAGE.
You must respond with ONLY a JSON object.
No explanation, no prose, no markdown, no code fences, no extra text.
If uncertain, still return a valid JSON object matching the schema exactly.

Schema:
{
  "risk_level":"LOW|MED|HIGH|CRISIS",
  "pressure":"LOW|MED|HIGH",
  "capacity":"LOW|MED|HIGH",
  "permission":"NONE|IMPLICIT|EXPLICIT",
  "tactic_appetite":"NONE|LOW|MED|HIGH",
  "rupture":"NONE|MILD|STRONG",
  "rupture_confidence":0-1,
  "should_run_router":true|false,
  "memory_query_eligible":true|false,
  "confidence":0-1,
  "harm_if_wrong":"LOW|MED|HIGH",
  "reason":"optional short"
}

Guidance:
- Conservative under uncertainty.
- If fragile, prefer capacity=LOW, permission=NONE, harm_if_wrong=HIGH.
- capacity LOW means the user is distressed, overloaded, or clearly low-runway; capacity MED means neutral or mixed runway; capacity HIGH means engaged, energized, or explicitly asking for guidance/planning.
- should_run_router=true when nuanced interpretation is likely to improve quality (mixed signals, relational context, implicit/emotional ambiguity, or unpacking requests). should_run_router=false for clear/simple operational turns.
- permission and tactic_appetite should be coherent: if permission=EXPLICIT then tactic_appetite is usually at least LOW unless the user is explicitly resisting guidance.
- rupture should capture semantic resistance/correction interaction quality, not exact phrase matching.
- Do not infer self-harm unless clearly present.

Example output (format only; do not copy values blindly):
{"risk_level":"MED","pressure":"LOW","capacity":"LOW","permission":"NONE","tactic_appetite":"NONE","rupture":"NONE","rupture_confidence":0.2,"should_run_router":false,"memory_query_eligible":false,"confidence":0.4,"harm_if_wrong":"HIGH","reason":"brief reason"}
Example output (neutral operational turn):
{"risk_level":"LOW","pressure":"LOW","capacity":"MED","permission":"IMPLICIT","tactic_appetite":"LOW","rupture":"NONE","rupture_confidence":0.0,"should_run_router":false,"memory_query_eligible":false,"confidence":0.8,"harm_if_wrong":"LOW","reason":"clear operational update"}
Example output (ambiguous emotional turn):
{"risk_level":"LOW","pressure":"MED","capacity":"MED","permission":"IMPLICIT","tactic_appetite":"LOW","rupture":"NONE","rupture_confidence":0.1,"should_run_router":true,"memory_query_eligible":true,"confidence":0.75,"harm_if_wrong":"MED","reason":"needs nuanced posture/intent"}
Example output (explicit unpack request):
{"risk_level":"LOW","pressure":"LOW","capacity":"HIGH","permission":"EXPLICIT","tactic_appetite":"MED","rupture":"NONE","rupture_confidence":0.0,"should_run_router":true,"memory_query_eligible":true,"confidence":0.9,"harm_if_wrong":"LOW","reason":"explicit request to unpack"}

Recent conversation:
${lastTurns}

Current user message:
${transcript}`;

  const triageTimeoutMs = Math.max(80, Math.min(timeoutMs, TRIAGE_MAX_TIMEOUT_MS));
  const call = await callOpenRouterJsonDetailed({
    prompt,
    model: TRIAGE_PRIMARY_MODEL,
    timeoutMs: triageTimeoutMs,
  });
  let triageRawResult: Record<string, unknown> | null = call.result;
  if (!triageRawResult && call.rawContent) {
    const extracted = extractFirstJsonObjectBlock(call.rawContent);
    if (!extracted) {
      console.warn("[triage] json extraction failed (no object block)", {
        failureCause: call.failureCause,
        model: TRIAGE_PRIMARY_MODEL,
        contentShape: shapePreview(call.rawContent),
      });
    } else {
      try {
        const extractedParsed = JSON.parse(extracted);
        if (
          extractedParsed &&
          typeof extractedParsed === "object" &&
          !Array.isArray(extractedParsed)
        ) {
          triageRawResult = extractedParsed as Record<string, unknown>;
        } else {
          console.warn("[triage] json extraction failed (non-object)", {
            failureCause: call.failureCause,
            model: TRIAGE_PRIMARY_MODEL,
            contentShape: shapePreview(call.rawContent),
          });
        }
      } catch {
        console.warn("[triage] json extraction failed (parse)", {
          failureCause: call.failureCause,
          model: TRIAGE_PRIMARY_MODEL,
          contentShape: shapePreview(call.rawContent),
        });
      }
    }
  }

  if (!triageRawResult) {
    return {
      triage: conservativeTriageFallback(),
      triageSource: "fallback" as TriageSource,
      modelUsed: TRIAGE_PRIMARY_MODEL,
      usedFallbackModel: false,
      modelFallbackReason: call.failureCause ? `primary_failed_no_fallback:${call.failureCause}` : null,
      primaryFailureCause: call.failureCause,
      fallbackFailureCause: "no_fallback_configured",
      rawResult: null,
    };
  }
  const parsed = parseTriageGateResponse(triageRawResult) ?? parseLegacyGateAsTriage(triageRawResult);
  if (!parsed) {
    return {
      triage: conservativeTriageFallback(),
      triageSource: "failed_parse" as TriageSource,
      modelUsed: TRIAGE_PRIMARY_MODEL,
      usedFallbackModel: false,
      modelFallbackReason: "parse_error_no_fallback",
      primaryFailureCause: "parse_error",
      fallbackFailureCause: "no_fallback_configured",
      rawResult: triageRawResult,
    };
  }
  return {
    triage: parsed,
    triageSource: "model" as TriageSource,
    modelUsed: TRIAGE_PRIMARY_MODEL,
    usedFallbackModel: false,
    modelFallbackReason: null,
    primaryFailureCause: null,
    fallbackFailureCause: "no_fallback_configured",
    rawResult: triageRawResult,
  };
}

async function runRouterGate(params: {
  transcript: string;
  lastTurns: string;
  timeoutMs: number;
}) {
  const { transcript, lastTurns, timeoutMs } = params;
  const prompt = `You are ROUTER. Return ONLY valid JSON.

Schema:
{
  "intent":"companion|momentum|output_task|learning",
  "posture":"COMPANION|MOMENTUM|REFLECTION|RELATIONSHIP|IDEATION|RECOVERY|PRACTICAL",
  "posture_confidence":0-1,
  "explicit_topic_shift":true|false,
  "mood":"CALM|NEUTRAL|LOW|UPBEAT|FRUSTRATED|OVERWHELMED|ANXIOUS",
  "energy":"LOW|MED|HIGH",
  "state_confidence":0-1,
  "reason":"optional short"
}

Guidance:
- Prefer RECOVERY when user appears strained, uncertain, or meaning-collapsed.
- Conservative under uncertainty.
- No extra keys.

Recent conversation:
${lastTurns}

Current user message:
${transcript}`;

  const call = await callOpenRouterJsonWithModelFallback({
    prompt,
    primaryModel: ROUTER_PRIMARY_MODEL,
    timeoutMs: Math.max(120, Math.min(timeoutMs, ROUTER_MAX_TIMEOUT_MS)),
  });
  if (!call.result) {
    return {
      router: null,
      modelUsed: call.modelUsed,
      usedFallbackModel: call.usedFallbackModel,
      modelFallbackReason: call.primaryError,
      primaryFailureCause: call.primaryFailureCause,
      fallbackFailureCause: call.fallbackFailureCause,
      rawResult: null,
    };
  }
  const parsed = parseRouterGateResponse(call.result);
  if (!parsed) {
    return {
      router: null,
      modelUsed: call.modelUsed,
      usedFallbackModel: call.usedFallbackModel,
      modelFallbackReason: call.primaryError,
      primaryFailureCause: call.primaryFailureCause,
      fallbackFailureCause: call.fallbackFailureCause,
      rawResult: call.result,
    };
  }
  return {
    router: parsed,
    modelUsed: call.modelUsed,
    usedFallbackModel: call.usedFallbackModel,
    modelFallbackReason: call.primaryError,
    primaryFailureCause: call.primaryFailureCause,
    fallbackFailureCause: call.fallbackFailureCause,
    rawResult: call.result,
  };
}

function detectAvoidanceOrDrift(params: {
  posture: ConversationPosture;
  pressure: ConversationPressure;
  isDirectRequest: boolean;
  triageReason?: string | null;
  routerReason?: string | null;
}) {
  const reasons = [params.triageReason, params.routerReason]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join(" ")
    .toLowerCase();
  if (/\b(avoid|avoidance|drift|rationaliz|stall|procrastin|deflect)\b/.test(reasons)) {
    return true;
  }
  return params.posture === "MOMENTUM" && params.pressure === "HIGH" && !params.isDirectRequest;
}

async function runMemoryQuerySpec(params: {
  transcript: string;
  lastTurns: string;
  timeoutMs: number;
}) {
  const { transcript, lastTurns, timeoutMs } = params;
  const specPrompt = `You are a Memory Query Specifier. Extract only entities/topics/time intent.

Return ONLY valid JSON:
{"entities":["..."],"topics":["..."],"time_hint":"optional","intent":"short reason"}

Rules:
- Entities are specific people/places/items.
- Topics are specialized concepts or projects.
- Keep entries short and concrete.
- No pronouns. Avoid generic abstract words unless paired with a concrete entity.

Recent conversation:
${lastTurns}

Current user message:
${transcript}`;

  const result = await callOpenRouterJson(specPrompt, "meta-llama/llama-3.1-8b-instruct", timeoutMs);
  if (!result) return null;
  return {
    entities: Array.isArray(result.entities) ? result.entities.filter((v) => typeof v === "string") : [],
    topics: Array.isArray(result.topics) ? result.topics.filter((v) => typeof v === "string") : [],
    time_hint: typeof result.time_hint === "string" ? result.time_hint : null,
    intent: typeof result.intent === "string" ? result.intent : null,
  } satisfies MemoryQuerySpec;
}

async function runRecallRelevanceCheck(params: {
  query: string;
  facts: string[];
  entities: string[];
  timeoutMs: number;
}) {
  const { query, facts, entities, timeoutMs } = params;
  const relevancePrompt = `You are a Recall Relevance Judge. Decide if retrieved memory is relevant.

Return ONLY valid JSON:
{"use":true|false,"confidence":0-1,"reason":"optional"}

Query: ${query}
Facts: ${facts.join(" | ")}
Entities: ${entities.join(" | ")}`;

  const result = await callOpenRouterJson(relevancePrompt, "meta-llama/llama-3.1-8b-instruct", timeoutMs);
  if (!result) return null;
  const use = Boolean(result.use);
  const confidence =
    typeof result.confidence === "number" && Number.isFinite(result.confidence)
      ? result.confidence
      : 0;
  const reason = typeof result.reason === "string" ? result.reason : null;
  return { use, confidence, reason } satisfies RecallRelevanceResult;
}

async function runLibrarianReflex(params: {
  requestId: string;
  userId: string;
  personaId: string;
  sessionId: string;
  transcript: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }>;
  now: Date;
  shouldTrace: boolean;
}): Promise<{
  supplementalContext: string | null;
  posture: ConversationPosture;
  pressure: ConversationPressure;
  userState: { mood: UserMood; energy: UserEnergy; tone: UserTone } | null;
  riskLevel: RiskLevel;
  intent: OverlayIntent;
  isUrgent: boolean;
  isDirectRequest: boolean;
  avoidanceOrDrift: boolean;
  gateAction: "memory_query" | "none";
  gateConfidence: number;
  gateExplicit: boolean;
  gateExplicitTopicShift: boolean;
  postureConfidence: number;
  stateConfidence: number;
  triage: TriageGateResult;
  triageSource: TriageSource;
  postureSource: PostureSource;
  routerRunReason: RouterRunReason;
  routerOutput: RouterGateResult | null;
  triageModel: string;
  triageUsedFallbackModel: boolean;
  triageModelFallbackReason: string | null;
  triagePrimaryFailureCause: string | null;
  triageFallbackFailureCause: string | null;
  routerModel: string | null;
  routerUsedFallbackModel: boolean;
  routerModelFallbackReason: string | null;
  routerPrimaryFailureCause: string | null;
  routerFallbackFailureCause: string | null;
} | null> {
  const { requestId, userId, personaId, sessionId, transcript, recentMessages, now, shouldTrace } =
    params;
  if (!env.OPENROUTER_API_KEY || !env.SYNAPSE_BASE_URL || !env.SYNAPSE_TENANT_ID) {
    return null;
  }

  const deadline = Date.now() + getLibrarianTimeoutMs();
  const remaining = () => Math.max(0, deadline - Date.now());

  const lastTurns = extractLastTwoTurns(recentMessages)
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n");
  const fallbackTriage = conservativeTriageFallback();
  const defaultGateSignals = {
    intent: DEFAULT_GATE_INTENT,
    isUrgent: false,
    isDirectRequest: false,
    avoidanceOrDrift: false,
    gateAction: "none" as const,
    gateConfidence: 0,
    gateExplicit: false,
    gateExplicitTopicShift: false,
    postureConfidence: 0,
    stateConfidence: 0,
    triage: fallbackTriage,
    triageSource: "fallback" as TriageSource,
    postureSource: "fallback" as PostureSource,
    routerRunReason: "triage_failed_parse" as RouterRunReason,
    routerOutput: null,
    triageModel: TRIAGE_PRIMARY_MODEL,
    triageUsedFallbackModel: false,
    triageModelFallbackReason: "triage_not_called",
    triagePrimaryFailureCause: null,
    triageFallbackFailureCause: null,
    routerModel: null,
    routerUsedFallbackModel: false,
    routerModelFallbackReason: null,
    routerPrimaryFailureCause: null,
    routerFallbackFailureCause: null,
  };
  if (remaining() <= 0) {
    return {
      supplementalContext: null,
      posture: DEFAULT_POSTURE,
      pressure: DEFAULT_PRESSURE,
      userState: null,
      riskLevel: DEFAULT_RISK,
      ...defaultGateSignals,
    };
  }
  const triageExecution = await runTriageGate({
    transcript,
    lastTurns,
    timeoutMs: Math.max(120, remaining()),
  });
  const triage = normalizeTriageForRouting({
    triage: triageExecution.triage,
    transcript,
  });
  const shouldRunRouterFromTriage =
    triage.should_run_router &&
    triage.risk_level !== "HIGH" &&
    triage.risk_level !== "CRISIS" &&
    triage.capacity !== "LOW";
  const shouldRunRouterFromHarm =
    triage.harm_if_wrong === "HIGH" &&
    triage.confidence < 0.7 &&
    triage.risk_level !== "HIGH" &&
    triage.risk_level !== "CRISIS" &&
    triage.capacity !== "LOW";
  const shouldRunRouterFromSensitiveBoundary =
    (triage.pressure === "MED" || triage.pressure === "HIGH" || triage.capacity === "MED") &&
    triage.permission !== "EXPLICIT" &&
    triage.confidence < 0.8 &&
    triage.risk_level !== "HIGH" &&
    triage.risk_level !== "CRISIS" &&
    triage.capacity !== "LOW";
  let routerRunReason: RouterRunReason = "skipped_triage_false";
  let routerOutput: RouterGateResult | null = null;
  let routerModel: string | null = null;
  let routerUsedFallbackModel = false;
  let routerModelFallbackReason: string | null = null;
  let routerPrimaryFailureCause: string | null = null;
  let routerFallbackFailureCause: string | null = null;
  if (triageExecution.triageSource === "failed_parse") {
    routerRunReason = "triage_failed_parse";
  } else if (triage.risk_level === "HIGH" || triage.risk_level === "CRISIS") {
    routerRunReason = "skipped_risk_high";
  } else if (triage.capacity === "LOW") {
    routerRunReason = "skipped_capacity_low";
  } else if (remaining() < ROUTER_MIN_BUDGET_MS) {
    routerRunReason = "skipped_time_budget";
  } else if (
    shouldRunRouterFromTriage ||
    shouldRunRouterFromHarm ||
    shouldRunRouterFromSensitiveBoundary
  ) {
    const routerExecution = await runRouterGate({
      transcript,
      lastTurns,
      timeoutMs: remaining(),
    });
    routerOutput = routerExecution.router;
    routerModel = routerExecution.modelUsed;
    routerUsedFallbackModel = routerExecution.usedFallbackModel;
    routerModelFallbackReason = routerExecution.modelFallbackReason;
    routerPrimaryFailureCause = routerExecution.primaryFailureCause ?? null;
    routerFallbackFailureCause = routerExecution.fallbackFailureCause ?? null;
    if (shouldRunRouterFromTriage) {
      routerRunReason = "ran_should_run_router";
    } else if (shouldRunRouterFromHarm) {
      routerRunReason = "ran_harm_low_confidence";
    } else {
      routerRunReason = "ran_sensitive_boundary";
    }
  }
  const postureSource: PostureSource = routerOutput ? "router" : "fallback";
  const legacyRawGate =
    triageExecution.rawResult &&
    typeof triageExecution.rawResult === "object" &&
    !Array.isArray(triageExecution.rawResult)
      ? (triageExecution.rawResult as Record<string, unknown>)
      : null;
  const legacyPosture =
    legacyRawGate && typeof legacyRawGate.posture === "string"
      ? normalizePosture(legacyRawGate.posture)
      : null;
  const legacyMood =
    legacyRawGate && typeof legacyRawGate.mood === "string"
      ? normalizeMood(legacyRawGate.mood)
      : null;
  const legacyEnergy =
    legacyRawGate && typeof legacyRawGate.energy === "string"
      ? normalizeEnergy(legacyRawGate.energy)
      : null;
  const legacyPostureConfidence =
    legacyRawGate && typeof legacyRawGate.posture_confidence === "number"
      ? parseConfidence(legacyRawGate.posture_confidence)
      : null;
  const legacyStateConfidence =
    legacyRawGate && typeof legacyRawGate.state_confidence === "number"
      ? parseConfidence(legacyRawGate.state_confidence)
      : null;
  const legacyExplicitTopicShift =
    legacyRawGate && typeof legacyRawGate.explicit_topic_shift === "boolean"
      ? legacyRawGate.explicit_topic_shift
      : false;
  const fallbackPosture: ConversationPosture =
    triage.capacity === "LOW" ? "RECOVERY" : triage.pressure === "HIGH" ? "RECOVERY" : "COMPANION";
  const postureSuggestion = normalizePosture(
    routerOutput?.posture ?? legacyPosture ?? fallbackPosture
  );
  const pressureSuggestion = normalizePressure(triage.pressure);
  const postureConfidence = routerOutput?.posture_confidence ?? legacyPostureConfidence ?? 0;
  const explicitTopicShift = Boolean(routerOutput?.explicit_topic_shift ?? legacyExplicitTopicShift);
  const moodSuggestion = normalizeMood(routerOutput?.mood ?? legacyMood ?? DEFAULT_MOOD);
  const energySuggestion = normalizeEnergy(routerOutput?.energy ?? legacyEnergy ?? DEFAULT_ENERGY);
  const toneSuggestion = DEFAULT_TONE;
  const stateConfidence = routerOutput?.state_confidence ?? legacyStateConfidence ?? 0;
  const explicitStateShift = false;
  const isDirectRequest = triage.permission === "EXPLICIT";
  const gateExplicit = triage.permission === "EXPLICIT";
  const gateAction: "memory_query" | "none" = triage.memory_query_eligible ? "memory_query" : "none";
  const isUrgent = triage.risk_level === "HIGH" || triage.risk_level === "CRISIS";
  const intentSuggestion = routerOutput?.intent ?? DEFAULT_GATE_INTENT;
  const gateSignals = {
    intent: intentSuggestion,
    isUrgent,
    isDirectRequest,
    avoidanceOrDrift: detectAvoidanceOrDrift({
      posture: postureSuggestion,
      pressure: pressureSuggestion,
      isDirectRequest,
      triageReason: triage.reason,
      routerReason: routerOutput?.reason ?? null,
    }),
    gateAction,
    gateConfidence: triage.confidence,
    gateExplicit,
    gateExplicitTopicShift: explicitTopicShift,
    postureConfidence,
    stateConfidence,
    triage,
    triageSource: triageExecution.triageSource,
    postureSource,
    routerRunReason,
    routerOutput,
    triageModel: triageExecution.modelUsed,
    triageUsedFallbackModel: triageExecution.usedFallbackModel,
    triageModelFallbackReason: triageExecution.modelFallbackReason,
    triagePrimaryFailureCause: triageExecution.primaryFailureCause ?? null,
    triageFallbackFailureCause: triageExecution.fallbackFailureCause ?? null,
    routerModel,
    routerUsedFallbackModel,
    routerModelFallbackReason,
    routerPrimaryFailureCause,
    routerFallbackFailureCause,
  };

  const postureResult = await resolvePostureWithHysteresis({
    userId,
    personaId,
    sessionId,
    timeGapMinutes: (() => {
      const lastAt = recentMessages.at(-1)?.createdAt;
      if (!lastAt) return null;
      const diffMs = now.getTime() - lastAt.getTime();
      return Math.max(0, Math.floor(diffMs / 60000));
    })(),
    suggestion: postureSuggestion,
    pressure: pressureSuggestion,
    confidence: postureConfidence,
    explicitTopicShift,
  });

  const userStateResult = await resolveUserStateWithHysteresis({
    userId,
    personaId,
    sessionId,
    timeGapMinutes: (() => {
      const lastAt = recentMessages.at(-1)?.createdAt;
      if (!lastAt) return null;
      const diffMs = now.getTime() - lastAt.getTime();
      return Math.max(0, Math.floor(diffMs / 60000));
    })(),
    suggestionMood: moodSuggestion,
    suggestionEnergy: energySuggestion,
    suggestionTone: toneSuggestion,
    confidence: stateConfidence,
    explicitStateShift,
    transcript,
  });

  const explicitSignal = isExplicitRecall(transcript);
  const explicit = gateExplicit || explicitSignal;
  const threshold = explicit ? 0.55 : 0.8;
  if (gateAction !== "memory_query" || triage.confidence < threshold) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }

  if (shouldTrace) {
    void prisma.librarianTrace.create({
      data: {
        userId,
        personaId,
        sessionId,
        requestId,
        kind: "gate",
        transcript,
        bouncer: {
          triage,
          triage_source: triageExecution.triageSource,
          router: routerOutput,
          router_run_reason: routerRunReason,
        },
      },
    }).catch((error) => {
      console.warn("[librarian.trace] failed to log gate", { error });
    });
  }

  if (remaining() <= 0) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }
  if (remaining() < MIN_OPTIONAL_LIBRARIAN_STEP_MS) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }
  const spec = await runMemoryQuerySpec({
    transcript,
    lastTurns,
    timeoutMs: remaining(),
  });
  if (!spec) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }

  const compiledQuery = buildQueryFromSpec(spec);
  const sanitized = compiledQuery ? sanitizeSearchString(compiledQuery) : null;
  if (!sanitized) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }
  if (remaining() <= 0) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }
  if (remaining() < MIN_OPTIONAL_LIBRARIAN_STEP_MS) {
    return {
      supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }

  const queryController = new AbortController();
  const queryTimeout = setTimeout(() => queryController.abort(), remaining());
  try {
    const response = await fetch(`${env.SYNAPSE_BASE_URL}/memory/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: env.SYNAPSE_TENANT_ID,
        userId,
        query: sanitized,
        limit: 10,
        referenceTime: now.toISOString(),
        includeContext: false,
      }),
      signal: queryController.signal,
    });
    if (!response.ok) {
      console.warn("[librarian.query] failed", {
        requestId,
        status: response.status,
      });
      return {
        supplementalContext: null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: triage.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }
    const data = (await response.json()) as MemoryQueryResponse;
    const { facts, entities } = normalizeMemoryQueryResponse(data);

    if (facts.length === 0 && entities.length === 0) {
      return {
        supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: triage.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }

    if (remaining() <= 0) {
      return {
        supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: triage.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }
    if (remaining() < MIN_OPTIONAL_LIBRARIAN_STEP_MS) {
      return {
        supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: triage.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }
    const relevance = await runRecallRelevanceCheck({
      query: sanitized,
      facts,
      entities,
      timeoutMs: remaining(),
    });
    if (!relevance || !relevance.use || relevance.confidence < 0.6) {
      return {
        supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: triage.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }

    const supplemental = buildRecallSheet({ query: sanitized, facts, entities });

    if (shouldTrace) {
      void prisma.librarianTrace.create({
        data: {
          userId,
          personaId,
          sessionId,
          requestId,
          kind: "librarian",
          transcript,
          bouncer: {
            triage,
            triage_source: triageExecution.triageSource,
            router: routerOutput,
            router_run_reason: routerRunReason,
          },
          memoryQuery: { query: sanitized, limit: 10, spec, relevance },
          memoryResponse: data,
          supplementalContext: supplemental,
        },
      }).catch((error) => {
        console.warn("[librarian.trace] failed to log librarian", { error });
      });
    }

    return {
      supplementalContext: supplemental,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("[librarian.query] timeout", { requestId });
      return {
        supplementalContext: null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: triage.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }
    console.warn("[librarian.query] error", { requestId, error });
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: triage.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  } finally {
    clearTimeout(queryTimeout);
  }
}

function buildChatMessages(params: {
  persona: string;
  momentumGuardBlock?: string | null;
  styleGuardBlock?: string | null;
  userContextBlock?: string | null;
  signalPackBlock?: string | null;
  stanceOverlayBlock?: string | null;
  tacticOverlayBlock?: string | null;
  overlayBlock?: string | null;
  bridgeBlock?: string | null;
  handoverBlock?: string | null;
  opsSnippetBlock?: string | null;
  supplementalContext?: string | null;
  rollingSummary?: string | null;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string;
  posture?: ConversationPosture;
  pressure?: ConversationPressure;
  userState?: { mood: UserMood; energy: UserEnergy; tone: UserTone } | null;
}) {
  const posture = params.posture ?? DEFAULT_POSTURE;
  const pressure = params.pressure ?? DEFAULT_PRESSURE;
  const postureLines = [`[CONVERSATION_POSTURE]`, `Mode: ${posture} (pressure: ${pressure})`];
  if (params.momentumGuardBlock) {
    postureLines.push("", params.momentumGuardBlock);
  }
  const postureBlock = postureLines.join("\n");
  const trimmedRollingSummary = (params.rollingSummary ?? "").trim();
  const cappedRollingSummary =
    trimmedRollingSummary.length > 800
      ? `${trimmedRollingSummary.slice(0, 800)}...`
      : trimmedRollingSummary;
  const historyTurns = params.recentMessages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const conversationHistoryBlock =
    cappedRollingSummary && historyTurns
      ? `[CONVERSATION_HISTORY]\n${cappedRollingSummary}\n---\n${historyTurns}`
      : cappedRollingSummary
        ? `[CONVERSATION_HISTORY]\n${cappedRollingSummary}`
        : null;

  return [
    { role: "system" as const, content: params.persona },
    { role: "system" as const, content: postureBlock },
    ...(params.styleGuardBlock ? [{ role: "system" as const, content: params.styleGuardBlock }] : []),
    ...(params.userContextBlock ? [{ role: "system" as const, content: params.userContextBlock }] : []),
    ...(params.signalPackBlock ? [{ role: "system" as const, content: params.signalPackBlock }] : []),
    ...(params.stanceOverlayBlock ? [{ role: "system" as const, content: params.stanceOverlayBlock }] : []),
    ...(params.tacticOverlayBlock ? [{ role: "system" as const, content: params.tacticOverlayBlock }] : []),
    ...(params.overlayBlock ? [{ role: "system" as const, content: params.overlayBlock }] : []),
    ...(params.bridgeBlock ? [{ role: "system" as const, content: params.bridgeBlock }] : []),
    ...(params.handoverBlock ? [{ role: "system" as const, content: params.handoverBlock }] : []),
    ...(params.opsSnippetBlock ? [{ role: "system" as const, content: params.opsSnippetBlock }] : []),
    ...(params.supplementalContext
      ? [
          {
            role: "system" as const,
            content: `[SUPPLEMENTAL_CONTEXT]\n${params.supplementalContext}`,
          },
        ]
      : []),
    ...(conversationHistoryBlock
      ? [{ role: "system" as const, content: conversationHistoryBlock }]
      : params.recentMessages),
    { role: "user" as const, content: params.transcript },
  ];
}

function getLastUserMessageAt(
  messages: Array<{ role: "user" | "assistant"; createdAt?: Date }>
) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" && messages[i].createdAt) {
      return messages[i].createdAt;
    }
  }
  return null;
}

function computeTimeGapMinutes(
  recentMessages: Array<{ role: "user" | "assistant"; createdAt?: Date }>,
  now: Date
) {
  const lastUserAt = getLastUserMessageAt(recentMessages);
  if (!lastUserAt) return null;
  const diffMs = now.getTime() - lastUserAt.getTime();
  return Math.max(0, Math.floor(diffMs / 60000));
}

function getZonedParts(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "long",
  });
  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = Number.parseInt(get("year"), 10);
  const month = Number.parseInt(get("month"), 10);
  const day = Number.parseInt(get("day"), 10);
  const hour = Number.parseInt(get("hour"), 10);
  const weekday = get("weekday").toLowerCase();
  return {
    dayKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    hour,
    weekday,
  };
}

function getWeekStartKey(dayKey: string, weekday: string) {
  const [yRaw, mRaw, dRaw] = dayKey.split("-");
  const year = Number.parseInt(yRaw, 10);
  const month = Number.parseInt(mRaw, 10);
  const day = Number.parseInt(dRaw, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return dayKey;
  const weekdayIndex = new Map<string, number>([
    ["monday", 0],
    ["tuesday", 1],
    ["wednesday", 2],
    ["thursday", 3],
    ["friday", 4],
    ["saturday", 5],
    ["sunday", 6],
  ]).get(weekday);
  if (weekdayIndex === undefined) return dayKey;
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - weekdayIndex);
  const startYear = utcMidnight.getUTCFullYear();
  const startMonth = String(utcMidnight.getUTCMonth() + 1).padStart(2, "0");
  const startDay = String(utcMidnight.getUTCDate()).padStart(2, "0");
  return `${startYear}-${startMonth}-${startDay}`;
}

function isMorningLocalWindow(hour: number) {
  return hour >= 5 && hour < 12;
}

function isEveningWindow(hour: number) {
  // Daily review should feel like bedtime wind-down, not early evening.
  return hour >= 20 || hour < 2;
}

function isLateNightMomentumWindow(hour: number) {
  return hour >= 0 && hour < 5;
}

function buildMomentumGuardBlock(params: {
  intent: OverlayIntent;
  posture: ConversationPosture;
  localHour: number;
}) {
  if (params.intent !== "momentum") return null;
  const postureAllows =
    params.posture === "MOMENTUM" ||
    params.posture === "IDEATION" ||
    params.posture === "PRACTICAL";
  if (!postureAllows) return null;
  const lines = [
    "[MOMENTUM_GUARD]",
    "- Stay action-oriented, but do not repeat the same setup/check question on consecutive turns.",
    "- If user confirms a step, acknowledge it and move to one next concrete step or close the loop.",
  ];
  if (isLateNightMomentumWindow(params.localHour)) {
    lines.push(
      "- Late-night mode (00:00-05:00 local): soften pressure, ask at most one check question, then step back."
    );
  }
  return lines.join("\n");
}

type ContextGovernorCandidate = {
  key: string;
  source: ContextGovernorSource;
  line: string;
  normalized: string;
  className?: string | null;
  score: number;
  charLen: number;
};

function normalizeGovernorText(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function parseLabeledLines(block: string, header: string) {
  const raw = block.trim();
  if (!raw) return [] as string[];
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const body = lines[0] === header ? lines.slice(1) : lines;
  return body
    .map((line) => line.replace(/^-+\s*/, "").trim())
    .filter(Boolean);
}

function createEmptyGovernorSourceCounts(): Record<ContextGovernorSource, number> {
  return {
    user_context: 0,
    handover: 0,
    bridge: 0,
    signal_pack: 0,
    ops: 0,
  };
}

function createEmptyGovernorDropCounts(): Record<ContextGovernorDropReason, number> {
  return {
    budget: 0,
    redundant: 0,
    precedence: 0,
    low_relevance: 0,
  };
}

function buildContextGovernorSelection(params: {
  userContextBlock?: string | null;
  signalPackBlock?: string | null;
  bridgeBlock?: string | null;
  handoverBlock?: string | null;
  opsSnippetBlock?: string | null;
  intent: OverlayIntent;
  posture: ConversationPosture;
  pressure: ConversationPressure;
  stance: StanceOverlayType | "none";
  riskLevel: RiskLevel;
}) {
  const candidates: ContextGovernorCandidate[] = [];
  const droppedByReason = createEmptyGovernorDropCounts();
  const hasHandover = Boolean(params.handoverBlock?.trim());
  const isTaskTurn =
    params.intent === "momentum" || params.intent === "output_task" || params.posture === "PRACTICAL";
  const isRelationalTurn =
    params.intent === "companion" ||
    params.posture === "COMPANION" ||
    params.posture === "RELATIONSHIP" ||
    params.posture === "REFLECTION";

  const pushCandidate = (candidate: Omit<ContextGovernorCandidate, "normalized" | "charLen">) => {
    const line = candidate.line.trim();
    if (!line) return;
    const normalized = normalizeGovernorText(line);
    if (!normalized) return;
    candidates.push({
      ...candidate,
      line,
      normalized,
      charLen: line.length,
    });
  };

  const userLines = params.userContextBlock
    ? parseLabeledLines(params.userContextBlock, "[USER_CONTEXT]")
    : [];
  userLines.forEach((line, index) => {
    pushCandidate({
      key: `user_context:${index}`,
      source: "user_context",
      className: null,
      line,
      score: 100,
    });
  });

  const handover = params.handoverBlock?.trim();
  if (handover) {
    pushCandidate({
      key: "handover:0",
      source: "handover",
      className: null,
      line: handover,
      score: 95,
    });
  }

  const bridge = params.bridgeBlock?.trim();
  if (bridge) {
    pushCandidate({
      key: "bridge:0",
      source: "bridge",
      className: null,
      line: bridge,
      score: 85,
    });
  }

  const ops = params.opsSnippetBlock?.trim();
  if (ops) {
    let score = 60;
    if (isTaskTurn) score += 20;
    if (isRelationalTurn) score -= 10;
    if (params.stance === "witness" && params.pressure === "HIGH") score -= 15;
    if (params.riskLevel === "HIGH" || params.riskLevel === "CRISIS") score -= 20;
    pushCandidate({
      key: "ops:0",
      source: "ops",
      className: null,
      line: ops,
      score,
    });
  }

  const signalLines = params.signalPackBlock
    ? parseLabeledLines(params.signalPackBlock, "Signal Pack (private):")
    : [];
  signalLines.forEach((line, index) => {
    const classMatch = line.match(/^\[([a-z_]+)\]\s+/i);
    const className = classMatch?.[1]?.toLowerCase() ?? null;
    if (hasHandover && (className === "open_loops" || className === "today")) {
      droppedByReason.precedence += 1;
      return;
    }
    let score = 70;
    if (isTaskTurn) {
      if (className === "open_loops" || className === "today" || className === "trajectory") score += 15;
      if (className === "state" || className === "relationships") score -= 5;
    }
    if (isRelationalTurn) {
      if (className === "state" || className === "relationships" || className === "identity") score += 15;
      if (className === "today") score -= 8;
    }
    if (params.stance === "witness" && params.pressure === "HIGH") {
      if (className === "open_loops" || className === "today") score -= 10;
    }
    pushCandidate({
      key: `signal_pack:${className ?? "unknown"}:${index}`,
      source: "signal_pack",
      className,
      line,
      score,
    });
  });

  const sorted = candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.source !== b.source) {
      const precedence: Record<ContextGovernorSource, number> = {
        user_context: 5,
        handover: 4,
        bridge: 3,
        signal_pack: 2,
        ops: 1,
      };
      return precedence[b.source] - precedence[a.source];
    }
    return a.key.localeCompare(b.key);
  });

  const selected: ContextGovernorCandidate[] = [];
  const seenNormalized = new Set<string>();
  let usedChars = 0;
  for (const candidate of sorted) {
    if (candidate.score < 40) {
      droppedByReason.low_relevance += 1;
      continue;
    }
    if (seenNormalized.has(candidate.normalized)) {
      droppedByReason.redundant += 1;
      continue;
    }
    const projected = usedChars + candidate.charLen;
    if (projected > CONTEXT_GOVERNOR_MAX_CHARS) {
      droppedByReason.budget += 1;
      continue;
    }
    selected.push(candidate);
    seenNormalized.add(candidate.normalized);
    usedChars = projected;
  }

  const selectedBySource = createEmptyGovernorSourceCounts();
  for (const candidate of selected) {
    selectedBySource[candidate.source] += 1;
  }

  const selectedUserLines = selected
    .filter((candidate) => candidate.source === "user_context")
    .map((candidate) => candidate.line);
  const selectedSignalLines = selected
    .filter((candidate) => candidate.source === "signal_pack")
    .map((candidate) => candidate.line);
  const selectedBridge = selected.find((candidate) => candidate.source === "bridge")?.line ?? null;
  const selectedHandover = selected.find((candidate) => candidate.source === "handover")?.line ?? null;
  const selectedOps = selected.find((candidate) => candidate.source === "ops")?.line ?? null;

  const runtime: ContextGovernorRuntime = {
    used: true,
    budget_chars: CONTEXT_GOVERNOR_MAX_CHARS,
    candidates_total: candidates.length,
    selected_total: selected.length,
    selected_by_source: selectedBySource,
    dropped_by_reason: droppedByReason,
    selected_keys: selected.map((candidate) => candidate.key),
  };

  return {
    userContextBlock:
      selectedUserLines.length > 0
        ? `[USER_CONTEXT]\n${selectedUserLines.map((line) => `- ${line}`).join("\n")}`
        : null,
    signalPackBlock:
      selectedSignalLines.length > 0
        ? `Signal Pack (private):\n${selectedSignalLines.map((line) => `- ${line}`).join("\n")}`
        : null,
    bridgeBlock: selectedBridge,
    handoverBlock: selectedHandover,
    opsSnippetBlock: selectedOps,
    runtime,
  };
}

function shouldInjectSignalPack(params: {
  signalPackBlock?: string | null;
  isSessionStart: boolean;
  intent: OverlayIntent;
  posture: ConversationPosture;
  pressure: ConversationPressure;
  stance: StanceOverlayType | "none";
  riskLevel: RiskLevel;
  isUrgent: boolean;
}) {
  if (!params.signalPackBlock) return false;
  if (params.isSessionStart) return false;
  if (params.isUrgent) return false;
  if (params.riskLevel === "HIGH" || params.riskLevel === "CRISIS") return false;
  if (params.stance === "witness" && params.pressure === "HIGH") return false;

  const isTaskingTurn =
    params.intent === "momentum" || params.intent === "output_task" || params.posture === "PRACTICAL";
  if (isTaskingTurn) return true;

  const isRelationalTurn =
    params.intent === "companion" ||
    params.posture === "COMPANION" ||
    params.posture === "RELATIONSHIP" ||
    params.posture === "REFLECTION";
  if (isRelationalTurn) return true;

  return params.posture === "IDEATION" || params.posture === "MOMENTUM";
}

function shouldTriggerDailyFocus(params: {
  isSessionStart: boolean;
  localHour: number;
  intent: OverlayIntent;
  posture: ConversationPosture;
  riskLevel: RiskLevel;
  energy: UserEnergy | null;
  hasTodayFocus: boolean;
}) {
  if (!params.isSessionStart) return false;
  if (!isMorningLocalWindow(params.localHour)) return false;
  if (params.hasTodayFocus) return false;
  if (params.riskLevel !== "LOW") return false;
  if (params.energy === "LOW") return false;
  const intentSupports = params.intent === "momentum";
  const postureSupports = params.posture === "MOMENTUM" || params.posture === "REFLECTION";
  return intentSupports || postureSupports;
}

function extractTodayFocus(transcript: string) {
  const normalized = normalizeWhitespace(transcript);
  if (!normalized) return null;
  if (/^hold[.!?]?$/i.test(normalized)) {
    return { status: "hold" as const, focus: null };
  }
  const focus = normalized.split(/\s+/).slice(0, 12).join(" ");
  return { status: "set" as const, focus };
}

function shouldTriggerDailyReview(params: {
  isSessionStart: boolean;
  localHour: number;
  riskLevel: RiskLevel;
  hasDailyReviewToday: boolean;
}) {
  if (!params.isSessionStart) return false;
  if (!isEveningWindow(params.localHour)) return false;
  if (params.riskLevel !== "LOW") return false;
  if (params.hasDailyReviewToday) return false;
  return true;
}

function extractDailyReviewSummary(transcript: string) {
  const normalized = normalizeWhitespace(transcript);
  if (!normalized) return null;
  if (/^hold[.!?]?$/i.test(normalized)) {
    return { status: "hold" as const, summary: null };
  }
  return {
    status: "set" as const,
    summary: normalized.split(/\s+/).slice(0, 24).join(" "),
  };
}

function shouldTriggerWeeklyCompass(params: {
  isSessionStart: boolean;
  weekday: string;
  localHour: number;
  weekStartKey: string;
  weeklyNorthStarWeekStartDate?: string | null;
}) {
  if (!params.isSessionStart) return false;
  const isSunday = params.weekday === "sunday";
  const isMondayMorning = params.weekday === "monday" && isMorningLocalWindow(params.localHour);
  if (!isSunday && !isMondayMorning) return false;
  return params.weeklyNorthStarWeekStartDate !== params.weekStartKey;
}

function toWeeklyPriority(input: string) {
  const normalized = input.trim().replace(/^[\-\d.)\s]+/, "").replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.split(" ").slice(0, 12).join(" ");
}

function extractWeeklyCompass(transcript: string) {
  const normalized = normalizeWhitespace(transcript);
  if (!normalized) return null;
  if (/^hold[.!?]?$/i.test(normalized)) {
    return {
      status: "hold" as const,
      weeklyNorthStar: null,
      weeklyPriorities: [] as string[],
    };
  }

  const segments = normalized.split(/[.;\n]/).map((segment) => segment.trim()).filter(Boolean);
  const weeklyNorthStarSource = segments[0] ?? normalized;
  const weeklyNorthStar = weeklyNorthStarSource.split(/\s+/).slice(0, 16).join(" ");
  const priorityCandidates =
    segments.length > 1 ? segments.slice(1) : normalized.split(/[,|]/).map((segment) => segment.trim());
  const weeklyPriorities = priorityCandidates
    .map((entry) => toWeeklyPriority(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 3);

  return {
    status: "set" as const,
    weeklyNorthStar,
    weeklyPriorities,
  };
}

function isUrgentOpener(text: string) {
  const lowered = text.toLowerCase();
  const urgentPhrases = [
    "urgent",
    "asap",
    "emergency",
    "panic",
    "help",
    "can't",
    "cant",
    "problem",
    "issue",
    "error",
    "broken",
    "stuck",
    "crash",
    "failing",
  ];
  return urgentPhrases.some((phrase) => lowered.includes(phrase));
}

const PROFANITY_TOKENS = ["fuck", "fucking", "shit", "bullshit", "wtf"];

function hasProfanityBurst(text: string) {
  const lowered = text.toLowerCase();
  let hits = 0;
  for (const token of PROFANITY_TOKENS) {
    if (lowered.includes(token)) hits += 1;
  }
  return hits >= 2;
}

function isExplicitAssistantCorrection(text: string) {
  const lowered = text.toLowerCase();
  const markers = [
    "what are you talking about",
    "what movie",
    "not movie time",
    "that's wrong",
    "thats wrong",
    "you're wrong",
    "you are wrong",
    "i didn't say",
    "i did not say",
    "stop making",
    "making shit up",
    "not what i said",
  ];
  return markers.some((marker) => lowered.includes(marker));
}

function hasCorrectionFrictionSignal(text: string) {
  return isExplicitAssistantCorrection(text) || hasProfanityBurst(text);
}

function extractCorrectionFactClaims(text: string) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) return [];
  const claims: string[] = [];
  if (normalized.includes("what movie") || normalized.includes("not movie time")) {
    claims.push("Do not assume user is watching a movie unless confirmed this session.");
  }
  if (normalized.includes("i didn't say") || normalized.includes("i did not say")) {
    claims.push("Do not attribute claims the user explicitly denies saying.");
  }
  if (
    normalized.includes("stop making") ||
    normalized.includes("making shit up") ||
    normalized.includes("that's wrong") ||
    normalized.includes("thats wrong")
  ) {
    claims.push("If uncertain, ask one clarifying question before asserting context.");
  }
  return claims;
}

function mergeCorrectionFacts(existing: string[] | undefined, next: string[]) {
  const merged = [...(existing ?? []), ...next];
  return Array.from(new Set(merged)).slice(-6);
}

function nextCorrectionOverlayCooldownTurns(current: number, correctionSignal: boolean) {
  if (correctionSignal) return Math.max(current, 2);
  if (current > 0) return current - 1;
  return 0;
}

function shouldForceSessionWarmupOverlaySkip(params: {
  isSessionStart: boolean;
  recentMessageCount: number;
  intent: OverlayIntent;
  isUrgent: boolean;
  isDirectRequest: boolean;
}) {
  if (!params.isSessionStart) return false;
  if (params.recentMessageCount !== 0) return false;
  if (params.isUrgent) return false;
  if (params.isDirectRequest) return false;
  return params.intent === "companion";
}

const RUNWAY_REQUIRED_OVERLAYS: Array<OverlayType> = [
  "accountability_tug",
  "daily_review",
  "weekly_compass",
];

function shouldHoldOverlayUntilRunway(params: {
  overlayType: OverlayType | "none";
  recentMessageCount: number;
  hasHighPriorityLoop?: boolean;
}) {
  if (params.overlayType === "none") return false;
  if (params.overlayType === "accountability_tug" && params.hasHighPriorityLoop) return false;
  if (!RUNWAY_REQUIRED_OVERLAYS.includes(params.overlayType)) return false;
  // Require one completed back-and-forth in-session before ritual nudges.
  return params.recentMessageCount < 2;
}

function buildCorrectionGuardBlock(corrections: string[] | undefined) {
  if (!corrections || corrections.length === 0) return null;
  const lines = corrections.map((item) => `- ${item}`).join("\n");
  return `[SESSION_FACT_CORRECTIONS]
Apply these corrections for this session:
${lines}
Do not reintroduce corrected assumptions unless user explicitly confirms them again.`;
}

async function clearStartBriefForSession(userId: string, personaId: string, sessionId: string) {
  if (!sessionId) return;
  if (process.env.NODE_ENV === "test") return;
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const baseState =
    existing?.state && typeof existing.state === "object" && !Array.isArray(existing.state)
      ? { ...(existing.state as Record<string, unknown>) }
      : {};
  if (baseState.startBriefSessionId !== sessionId) return;
  delete baseState.startBriefSessionId;
  delete baseState.startBriefData;
  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId, personaId } },
    update: { state: baseState as any, updatedAt: new Date() },
    create: { userId, personaId, state: baseState as any },
  });
}

function buildContinuityBlock(params: { timeGapMinutes: number | null; transcript: string }) {
  const gapMinutes = params.timeGapMinutes ?? 0;
  if (gapMinutes < 60) return null;
  const urgent = isUrgentOpener(params.transcript);
  if (gapMinutes >= 60) {
    if (urgent) return null;
  } else {
    return null;
  }
  const hours = Math.max(1, Math.round(gapMinutes / 60));
  return `[CONTINUITY]\nIt’s been ~${hours} hours since you last spoke. Open with a natural bridge that resumes the relationship and thread.\nBe low-assumption; don’t presume what the user is doing now.\nDo not force a question; it’s okay to let the moment land.`;
}

function normalizeContextSentence(input: string, maxWords = 24) {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const firstSentence = normalized.split(/(?<=[.!?])\s+/)[0]?.trim() ?? normalized;
  const clipped = firstSentence.split(/\s+/).slice(0, maxWords).join(" ");
  return clipped.replace(/[;:,]+$/, "").trim();
}

function shouldIncludeSessionStartThreads(params: {
  intent: OverlayIntent;
  isDirectRequest: boolean;
}) {
  return params.isDirectRequest || params.intent === "momentum" || params.intent === "output_task";
}

function buildSessionStartSituationalContext(params: {
  handoff?: SessionStartHandoff;
  intent: OverlayIntent;
  isDirectRequest: boolean;
}) {
  const handoff = params.handoff;
  if (!handoff) return "";
  const lines: string[] = [];
  if (handoff.opener) {
    lines.push(handoff.opener);
  }
  if (handoff.steeringNote && handoff.steeringConfidence === "high") {
    lines.push(`Steering note: ${normalizeContextSentence(handoff.steeringNote, 24)}`);
  }
  const activeThreads = Array.isArray(handoff.activeThreads)
    ? handoff.activeThreads.map((item) => normalizeContextSentence(item, 12)).filter(Boolean)
    : [];
  if (
    activeThreads.length > 0 &&
    shouldIncludeSessionStartThreads({
      intent: params.intent,
      isDirectRequest: params.isDirectRequest,
    })
  ) {
    lines.push(`Right now the active threads are ${activeThreads.slice(0, 2).join("; ")}.`);
  }
  return lines.filter(Boolean).join("\n");
}

function transcriptMentionsTrackedName(transcript: string, names: string[]) {
  if (!transcript || names.length === 0) return false;
  const lowered = transcript.toLowerCase();
  return names.some((name) => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return false;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(lowered);
  });
}

function isStyleRequest(transcript: string) {
  const lowered = transcript.toLowerCase();
  return (
    lowered.includes("tone") ||
    lowered.includes("style") ||
    lowered.includes("wording") ||
    lowered.includes("rewrite this") ||
    lowered.includes("how should i say")
  );
}

function buildDeferredProfileContextLines(params: {
  isSessionStart: boolean;
  profile?: DeferredProfileContext;
  posture: ConversationPosture;
  intent: OverlayIntent;
  isDirectRequest: boolean;
  transcript: string;
  avoidanceOrDrift: boolean;
}) {
  // Deterministic policy:
  // - relationships: posture=RELATIONSHIP OR user names a tracked person
  // - patterns: only when bouncer signals avoidance/drift
  // - work context: only for momentum/output_task intent
  // - long-term direction: only for momentum + direct request
  // - communication preference: only when user asks about style/tone
  // - daily anchors: only for momentum/practical posture
  // - recent signals: only for companion/recovery posture
  if (params.isSessionStart || !params.profile) return [] as string[];
  const lines: string[] = [];
  const profile = params.profile;
  const trackedNames = Array.isArray(profile.relationshipNames) ? profile.relationshipNames : [];

  const includeRelationships =
    params.posture === "RELATIONSHIP" ||
    transcriptMentionsTrackedName(params.transcript, trackedNames);
  if (includeRelationships && profile.relationshipsLine) {
    lines.push(profile.relationshipsLine);
  }

  const includePatterns = params.avoidanceOrDrift;
  if (includePatterns && profile.patternLine) {
    lines.push(profile.patternLine);
  }

  const includeWorkContext = params.intent === "momentum" || params.intent === "output_task";
  if (includeWorkContext && profile.workContextLine) {
    lines.push(profile.workContextLine);
  }

  const includeLongTermDirection = params.intent === "momentum" && params.isDirectRequest;
  if (includeLongTermDirection && profile.longTermDirectionLine) {
    lines.push(profile.longTermDirectionLine);
  }

  const includeCommunicationPreference = isStyleRequest(params.transcript);
  if (includeCommunicationPreference && profile.communicationPreferenceLine) {
    lines.push(profile.communicationPreferenceLine);
  }

  const includeDailyAnchors = params.posture === "MOMENTUM" || params.posture === "PRACTICAL";
  if (includeDailyAnchors && profile.dailyAnchorsLine) {
    lines.push(profile.dailyAnchorsLine);
  }

  const includeRecentSignals = params.posture === "COMPANION" || params.posture === "RECOVERY";
  if (includeRecentSignals && profile.recentSignalsLine) {
    lines.push(profile.recentSignalsLine);
  }

  return Array.from(new Set(lines)).slice(0, 2);
}

function isLowSignalFirstUserMessage(transcript: string) {
  const normalized = normalizeWhitespace(transcript).toLowerCase();
  if (!normalized) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return true;
  const lowSignalPatterns = [
    "hey",
    "hi",
    "hello",
    "are you there",
    "you there",
    "yo",
    "sup",
  ];
  return lowSignalPatterns.some((pattern) => normalized.includes(pattern));
}

function shouldInjectTurn2Handover(params: {
  packet: SynapseStartBriefResponse;
  firstUserMsgLowSignal: boolean;
}) {
  const depth = params.packet.handover_depth ?? null;
  const gap = params.packet.time_context?.gap_minutes ?? null;
  if (depth === "yesterday" || depth === "multi_day") return true;
  if (typeof gap === "number" && Number.isFinite(gap) && gap >= 120) return true;
  return params.firstUserMsgLowSignal;
}

function shouldAllowHandoverReinjection(params: {
  gateAction: "memory_query" | "none";
  gateConfidence: number;
  gateExplicit: boolean;
  gateExplicitTopicShift: boolean;
  isDirectRequest: boolean;
  reinjectedOnce: boolean;
}) {
  if (params.reinjectedOnce) return false;
  if (params.gateAction !== "memory_query") return false;
  if (params.gateConfidence < 0.75) return false;
  if (!params.isDirectRequest) return false;
  if (!params.gateExplicit) return false;
  if (params.gateExplicitTopicShift) return false;
  return true;
}

function buildStartbriefInjection(params: {
  packet?: SynapseStartBriefResponse;
  userTurnsSeen: number;
  firstUserMsgLowSignal: boolean;
  allowSemanticReinjection: boolean;
}) {
  const packet = params.packet;
  if (!packet) {
    return {
      bridgeBlock: null as string | null,
      handoverBlock: null as string | null,
      bridgeInjected: false,
      handoverInjected: false,
      reinjectionUsed: false,
    };
  }
  const handover =
    typeof packet.handover_text === "string" ? sanitizeHandoverText(packet.handover_text) : "";
  if (!handover) {
    return {
      bridgeBlock: null as string | null,
      handoverBlock: null as string | null,
      bridgeInjected: false,
      handoverInjected: false,
      reinjectionUsed: false,
    };
  }
  const bridgeText =
    packet.resume?.use_bridge && typeof packet.resume.bridge_text === "string"
      ? packet.resume.bridge_text.trim()
      : "";

  if (params.userTurnsSeen === 0) {
    return {
      bridgeBlock: bridgeText || null,
      handoverBlock: handover,
      bridgeInjected: Boolean(bridgeText),
      handoverInjected: true,
      reinjectionUsed: false,
    };
  }
  return {
    bridgeBlock: null as string | null,
    handoverBlock: handover,
    bridgeInjected: false,
    handoverInjected: true,
    reinjectionUsed: false,
  };
}

function shouldInjectOpsSnippet(params: {
  riskLevel: RiskLevel;
  posture: ConversationPosture;
  pressure: ConversationPressure;
  intent: OverlayIntent;
  gateAction: "memory_query" | "none";
  gateConfidence: number;
  isDirectRequest: boolean;
  isUrgent: boolean;
  postureConfidence: number;
}) {
  if (params.riskLevel === "CRISIS") return false;
  const momentumPath =
    (params.intent === "momentum" || params.intent === "output_task" || params.posture === "MOMENTUM" || params.posture === "PRACTICAL") &&
    params.gateAction === "memory_query" &&
    params.gateConfidence >= 0.65;
  const pressurePath =
    (params.pressure === "HIGH" || params.isDirectRequest || params.isUrgent) &&
    params.postureConfidence >= 0.7;
  return momentumPath || pressurePath;
}

function updateRecentOverlayKeys(previous: string[], nextKeys: string[]) {
  const next = [...previous];
  for (const key of nextKeys) {
    const idx = next.indexOf(key);
    if (idx >= 0) next.splice(idx, 1);
    next.push(key);
  }
  return next.slice(-6);
}

type DerivedTurnConstraints = {
  isUrgentDerived: boolean;
  isDirectRequestDerived: boolean;
  explicitTopicShiftDerived: boolean;
};

type EffectiveOverlaySignals = {
  isUrgent: boolean;
  isDirectRequest: boolean;
  explicitTopicShift: boolean;
  explicitTopicShiftFromHighConfidence: boolean;
  authorityMode: "raw" | "remap_v1";
};

function isBouncerAuthorityRemapEnabled() {
  return env.FEATURE_BOUNCER_AUTHORITY_REMAP_V1 === "true";
}

function isBouncerAuthorityShadowLogEnabled() {
  return env.FEATURE_BOUNCER_AUTHORITY_SHADOW_LOG !== "false";
}

function deriveTurnConstraintsFromTranscript(
  transcript: string,
  lastTurns?: string[]
): DerivedTurnConstraints {
  const normalized = normalizeWhitespace(transcript).toLowerCase();
  const recent = Array.isArray(lastTurns)
    ? lastTurns.map((item) => normalizeWhitespace(item).toLowerCase()).join(" ")
    : "";

  const isUrgentDerived = /\b(urgent|asap|right now|immediately|emergency|can't breathe|panic attack|help now)\b/i.test(
    normalized
  );
  const isDirectRequestDerived = /\b(help me|what should i do|give me|draft|write|fix|summari[sz]e|plan|steps?|todo|to-do)\b/i.test(
    normalized
  );
  const explicitTopicShiftDerived =
    /\b(anyway|new topic|switching gears|different thing|on another note|separate point)\b/i.test(
      normalized
    ) || (recent.length > 0 && /\bactually\b/i.test(normalized) && /\b(earlier|before)\b/i.test(recent));

  return {
    isUrgentDerived,
    isDirectRequestDerived,
    explicitTopicShiftDerived,
  };
}

function resolveEffectiveOverlaySignals(params: {
  authorityRemapEnabled: boolean;
  transcript: string;
  lastTurns?: string[];
  gateConfidence: number;
  postureConfidence: number;
  rawIsUrgent: boolean;
  rawIsDirectRequest: boolean;
  rawExplicitTopicShift: boolean;
}): EffectiveOverlaySignals {
  if (!params.authorityRemapEnabled) {
    return {
      isUrgent: params.rawIsUrgent,
      isDirectRequest: params.rawIsDirectRequest,
      explicitTopicShift: params.rawExplicitTopicShift,
      explicitTopicShiftFromHighConfidence: params.rawExplicitTopicShift,
      authorityMode: "raw",
    };
  }
  const derived = deriveTurnConstraintsFromTranscript(params.transcript, params.lastTurns);
  const useUrgentFromBouncer = params.gateConfidence >= 0.7;
  const useDirectFromBouncer = params.gateConfidence >= 0.7;
  const explicitTopicShiftFromHighConfidence =
    params.postureConfidence >= 0.8 ||
    (params.gateConfidence >= 0.8 && params.rawExplicitTopicShift);
  return {
    isUrgent: useUrgentFromBouncer ? params.rawIsUrgent : derived.isUrgentDerived,
    isDirectRequest: useDirectFromBouncer
      ? params.rawIsDirectRequest
      : derived.isDirectRequestDerived,
    explicitTopicShift: explicitTopicShiftFromHighConfidence
      ? params.rawExplicitTopicShift
      : derived.explicitTopicShiftDerived,
    explicitTopicShiftFromHighConfidence,
    authorityMode: "remap_v1",
  };
}

function buildBouncerAuthorityTraceFields(params: {
  shadowLogEnabled: boolean;
  authorityRemapEnabled: boolean;
  raw: {
    is_urgent: boolean;
    is_direct_request: boolean;
    explicit_topic_shift: boolean;
    confidence: number;
    posture_confidence: number;
    state_confidence: number;
  };
  effective: {
    isUrgent: boolean;
    isDirectRequest: boolean;
    explicitTopicShift: boolean;
  };
}) {
  if (!params.shadowLogEnabled) return {};
  return {
    gate_confidence: params.raw.confidence,
    posture_confidence: params.raw.posture_confidence,
    state_confidence: params.raw.state_confidence,
    is_urgent: params.raw.is_urgent,
    is_direct_request: params.raw.is_direct_request,
    explicit_topic_shift: params.raw.explicit_topic_shift,
    authority_mode: params.authorityRemapEnabled ? "remap_v1" : "raw",
    bouncer_raw: params.raw,
    effective_signals: params.effective,
  };
}

function userRequestedActionPlan(text: string) {
  const lowered = normalizeWhitespace(text).toLowerCase();
  return /\b(tell me what to do|give me a plan|draft message|draft a message|next steps|what should i do)\b/i.test(lowered);
}

function userRequestedPush(text: string) {
  const lowered = normalizeWhitespace(text).toLowerCase();
  return /\b(push me|hold me accountable|be strict)\b/i.test(lowered);
}

function nextWitnessHysteresisTurns(params: {
  previousStance: StanceOverlayType | "none";
  previousTurnsRemaining: number;
  selectedStance: StanceOverlayType | "none";
  transcript: string;
  pressure: ConversationPressure;
}) {
  const actionRequested = userRequestedActionPlan(params.transcript);
  const pushRequested = userRequestedPush(params.transcript);
  if (params.selectedStance === "witness") return 2;
  if (params.previousStance === "witness" && params.previousTurnsRemaining > 0) {
    if (actionRequested || pushRequested || params.pressure === "LOW") return 0;
    return Math.max(0, params.previousTurnsRemaining - 1);
  }
  return 0;
}

function shouldHoldWitnessOnContinuation(params: {
  enabled: boolean;
  previousStance: StanceOverlayType | "none";
  selectedStance: StanceOverlayType | "none";
  transcript: string;
  explicitTopicShiftFromHighConfidence: boolean;
  effectiveIsDirectRequest: boolean;
}) {
  if (!params.enabled) return false;
  if (params.previousStance !== "witness") return false;
  if (params.selectedStance !== "none") return false;
  const lowered = normalizeWhitespace(params.transcript).toLowerCase();
  const griefOrRepairContinuation = /\b(miss her|grief|guilt|shame|estranged|falling out|made me cry|i cried|tears|broke down|funeral|lost my|how do i fix|fix this|repair|apology|reconcile|daughter)\b/i.test(
    lowered
  );
  if (!griefOrRepairContinuation) return false;
  if (params.explicitTopicShiftFromHighConfidence) return false;
  if (userRequestedActionPlan(params.transcript) && params.effectiveIsDirectRequest) return false;
  return true;
}

type TacticEligibilityResult = {
  allowed: boolean;
  vetoReasons: string[];
};

type CooldownActivationReason = "rupture_strong" | "rupture_mild" | "soft_harm_capacity" | null;

function isProbingTactic(tactic: TacticOverlayType | "none") {
  return tactic === "curiosity_spiral" || tactic === "accountability_tug";
}

function evaluateTacticEligibility(params: {
  tactic: TacticOverlayType | "none";
  triage: TriageGateResult;
  cooldownTurnsRemaining: number;
}) {
  const { tactic, triage, cooldownTurnsRemaining } = params;
  const vetoReasons: string[] = [];
  if (tactic === "none") {
    return { allowed: true, vetoReasons } satisfies TacticEligibilityResult;
  }
  if (!isProbingTactic(tactic)) {
    return { allowed: true, vetoReasons } satisfies TacticEligibilityResult;
  }
  if (triage.capacity !== "HIGH") vetoReasons.push("capacity_not_high");
  if (triage.permission === "NONE") vetoReasons.push("permission_none");
  if (triage.tactic_appetite !== "HIGH") vetoReasons.push("appetite_not_high");
  if (triage.risk_level !== "LOW") vetoReasons.push("risk_not_low");
  if (triage.pressure === "HIGH") vetoReasons.push("pressure_high");
  if (cooldownTurnsRemaining > 0) vetoReasons.push("cooldown_active");
  return {
    allowed: vetoReasons.length === 0,
    vetoReasons,
  } satisfies TacticEligibilityResult;
}

function applyCooldownPolicy(params: {
  previousCooldownTurnsRemaining: number;
  previousCooldownLastReason: "rupture_strong" | "rupture_mild" | null;
  triage: TriageGateResult;
  routerRunReason: RouterRunReason;
  routerOutput: RouterGateResult | null;
}) {
  let cooldownTurnsRemaining = Math.max(0, params.previousCooldownTurnsRemaining);
  let cooldownLastReason = params.previousCooldownLastReason;
  let cooldownActivatedReason: CooldownActivationReason = null;
  if (params.triage.rupture === "STRONG" && params.triage.rupture_confidence >= 0.7) {
    cooldownTurnsRemaining = 3;
    cooldownLastReason = "rupture_strong";
    cooldownActivatedReason = "rupture_strong";
  } else if (params.triage.rupture === "MILD" && params.triage.rupture_confidence >= 0.7) {
    cooldownTurnsRemaining = Math.max(cooldownTurnsRemaining, 1);
    cooldownLastReason = "rupture_mild";
    cooldownActivatedReason = "rupture_mild";
  } else if (params.triage.harm_if_wrong === "HIGH" && params.triage.capacity !== "HIGH") {
    cooldownTurnsRemaining = Math.max(cooldownTurnsRemaining, 1);
    cooldownActivatedReason = "soft_harm_capacity";
  } else if (cooldownTurnsRemaining > 0) {
    cooldownTurnsRemaining = Math.max(0, cooldownTurnsRemaining - 1);
    if (cooldownTurnsRemaining === 0) {
      cooldownLastReason = null;
    }
  }
  const routerAttempted =
    params.routerRunReason === "ran_should_run_router" ||
    params.routerRunReason === "ran_harm_low_confidence" ||
    params.routerRunReason === "ran_sensitive_boundary";
  if (routerAttempted && !params.routerOutput) {
    cooldownTurnsRemaining = Math.max(cooldownTurnsRemaining, 1);
    if (!cooldownActivatedReason) {
      cooldownActivatedReason = "soft_harm_capacity";
    }
  }
  return {
    cooldownTurnsRemaining,
    cooldownLastReason,
    cooldownActivatedReason,
  };
}

function buildStyleGuardBlock(params: {
  stance: StanceOverlayType | "none";
  endearmentCooldownTurns: number;
  cooldownActive?: boolean;
}) {
  const lines = ["[STYLE_GUARD]"];
  lines.push('- Ban robotic phrases: "you shared that", "tentative glimmer", "want to name one small thing".');
  if (params.cooldownActive) {
    lines.push("- Keep this turn short, present, and non-probing unless safety requires a check-in.");
  }
  if (params.stance === "witness") {
    lines.push("- No endearments in this turn.");
    lines.push('- Ban phrases: "must feel", "that must feel", "that sounds", "all ears", "so heavy", "so jumbled", "you shared that", "tentative glimmer".');
    return lines.join("\n");
  }
  if (params.endearmentCooldownTurns > 0) {
    lines.push("- Do not use endearments in this turn.");
    return lines.join("\n");
  }
  lines.push("- If used, allow at most one endearment this turn.");
  return lines.join("\n");
}

function sanitizeHandoverText(input: string) {
  const normalized = normalizeWhitespace(input);
  if (!normalized) return "";
  let text = normalized
    .replace(/\bThe user massive\b/gi, "The user made massive")
    .replace(/\bpositiv\b/gi, "positive")
    .replace(/\s+([,.!?;:])/g, "$1");
  text = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !/\b(and|or|but|with)\.?$/i.test(sentence))
    .join(" ");
  return text.trim();
}

function nextEndearmentCooldownTurns(current: number, stance: StanceOverlayType | "none") {
  if (stance === "witness") {
    return Math.max(0, current - 1);
  }
  if (current > 0) {
    return current - 1;
  }
  return 10;
}

function shouldSuppressByOverlayRepetition(params: {
  key: string;
  recentOverlayKeys: string[];
  explicitTopicShift: boolean;
  pressure: ConversationPressure;
  riskLevel: RiskLevel;
}) {
  if (params.explicitTopicShift) return false;
  if (!params.recentOverlayKeys.includes(params.key)) return false;
  if (params.key === "stance:witness") {
    return !(params.pressure === "HIGH" || params.riskLevel === "HIGH" || params.riskLevel === "CRISIS");
  }
  return true;
}

function resolvePolicySkipSelection(params: {
  skipReason: OverlayPolicyDecision["reason"];
  transcript: string;
  posture: ConversationPosture;
  intent: OverlayIntent;
  explicitTopicShift: boolean;
  avoidanceOrDrift: boolean;
  openLoops?: string[];
  commitments?: string[];
  recentUserMessages: string[];
  overlayUsed: OverlayUsed;
  dailyFocusEligible: boolean;
  dailyReviewEligible: boolean;
  weeklyCompassEligible: boolean;
  hasTodayFocus: boolean;
  hasDailyReviewToday: boolean;
  hasWeeklyCompass: boolean;
  pressure: ConversationPressure;
  riskLevel: RiskLevel;
  mood: UserMood | null | undefined;
  tone: UserTone | null | undefined;
  userLastTugAt?: string | null;
  tugBackoff?: Record<string, string>;
  now: Date;
}) {
  const decision = selectOverlay({
    transcript: params.transcript,
    posture: params.posture,
    intent: params.intent,
    explicitTopicShift: params.explicitTopicShift,
    avoidanceOrDrift: params.avoidanceOrDrift,
    openLoops: params.openLoops,
    commitments: params.commitments,
    recentUserMessages: params.recentUserMessages,
    overlayUsed: params.overlayUsed,
    dailyFocusEligible: params.dailyFocusEligible,
    dailyReviewEligible: params.dailyReviewEligible,
    weeklyCompassEligible: params.weeklyCompassEligible,
    hasTodayFocus: params.hasTodayFocus,
    hasDailyReviewToday: params.hasDailyReviewToday,
    hasWeeklyCompass: params.hasWeeklyCompass,
    conflictSignals: {
      pressure: params.pressure,
      riskLevel: params.riskLevel,
      mood: params.mood ?? undefined,
      tone: params.tone ?? undefined,
    },
    userLastTugAt: params.userLastTugAt ?? null,
    tugBackoff: params.tugBackoff,
    now: params.now,
  });

  if (decision.stanceOverlay === "witness") {
    return {
      stanceSelected: "witness" as const,
      tacticSelected: "none" as const,
      triggerReason: "witness_force_during_policy_skip",
      suppressionReason: `policy_${params.skipReason}`,
    };
  }
  return {
    stanceSelected: "none" as const,
    tacticSelected: "none" as const,
    triggerReason: `policy_skip_${params.skipReason}`,
    suppressionReason: `policy_${params.skipReason}`,
  };
}

function validateOpsSnippet(input: string | null) {
  if (!input) return null;
  if (input.includes(":") || input.includes(";")) return null;
  const oneLine = input.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  const firstSentence = oneLine.split(/(?<=[.!?])\s+/)[0]?.trim() ?? oneLine;
  const words = firstSentence.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 22) return null;
  const sentence = words.join(" ").replace(/[!?]+$/, ".");
  return /[.]$/.test(sentence) ? sentence : `${sentence}.`;
}

function buildOpsSnippetFromLoops(loopTexts: string[]) {
  const top = loopTexts.filter(Boolean).slice(0, 2);
  if (top.length === 0) return null;
  if (top.length === 1) {
    return validateOpsSnippet(`A useful thread to anchor on is ${top[0]}`);
  }
  return validateOpsSnippet(`Useful threads to anchor on are ${top[0]} and ${top[1]}`);
}

function applyOpsSupplementalMutualExclusion(
  opsSnippetBlock: string | null,
  supplementalContext: string | null
) {
  if (supplementalContext) return null;
  return opsSnippetBlock;
}

function topLoopTextsFromPacket(packet?: SynapseStartBriefResponse) {
  const items = Array.isArray(packet?.ops_context?.top_loops_today)
    ? packet?.ops_context?.top_loops_today
    : [];
  return items
    .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
    .filter(Boolean)
    .slice(0, 2);
}

function extractFactsFromSupplementalContext(supplemental: string | null) {
  if (!supplemental) return [] as string[];
  const lines = supplemental
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
  return lines.slice(0, 2);
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const traceId = request.headers.get("x-trace-id") || crypto.randomUUID();
  const totalStartTime = Date.now();

  console.log(
    "[chat.entry]",
    JSON.stringify({
      trace_id: traceId,
      requestId,
      host: request.headers.get("host"),
      x_forwarded_host: request.headers.get("x-forwarded-host"),
      x_forwarded_proto: request.headers.get("x-forwarded-proto"),
      url: request.url,
      origin: request.headers.get("origin"),
      referer: request.headers.get("referer"),
      user_agent: request.headers.get("user-agent"),
    })
  );
  
  try {
    // Auth check
    const { userId: cookieUserId } = await auth();
    let clerkUserId = cookieUserId;

    if (!clerkUserId) {
      const authHeader =
        request.headers.get("authorization") || request.headers.get("Authorization");
      const bearerToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

      if (bearerToken) {
        try {
          const verified = await verifyToken(bearerToken, {
            secretKey: env.CLERK_SECRET_KEY,
          });
          clerkUserId = verified?.sub ?? null;
        } catch (error) {
          console.warn("Bearer token verification failed:", error);
        }
      }
    }

    if (!clerkUserId) {
      return NextResponse.json(
        { error: "Unauthorized", requestId },
        { status: 401 }
      );
    }

    // Get user from database
    let user;
    try {
      user = await ensureUserByClerkId(clerkUserId);
    } catch (error) {
      console.error("User upsert failed:", { requestId, error });
      return NextResponse.json(
        { error: "User upsert failed", requestId },
        { status: 500 }
      );
    }

    // Parse multipart form data
    const formData = await request.formData();
    const personaId = formData.get("personaId") as string;
    const audioFile = formData.get("audioBlob") as File;
    const preferredLanguage = formData.get("language") as string | null;

    if (!personaId || !audioFile) {
      return NextResponse.json(
        { error: "Missing personaId or audioBlob", requestId },
        { status: 400 }
      );
    }
    if (audioFile.size === 0) {
      return NextResponse.json(
        { error: "Empty audio", requestId },
        { status: 400 }
      );
    }
    const minAudioBytes = parseInt(process.env.MIN_AUDIO_BYTES ?? "8000", 10);
    if (audioFile.size < minAudioBytes) {
      return NextResponse.json(
        { error: "Audio too short", requestId },
        { status: 400 }
      );
    }

    // Verify persona exists
    const persona = await prisma.personaProfile.findUnique({
      where: { id: personaId },
    });
    if (!persona) {
      return NextResponse.json(
        { error: "Persona not found", requestId },
        { status: 404 }
      );
    }

    // FAST PATH: STT → Context → LLM → TTS
    const timings: ChatTimingSpans = {
      stt_ms: 0,
      context_ms: 0,
      librarian_ms: 0,
      overlay_ms: 0,
      llm_ms: 0,
      tts_ms: 0,
      db_write_ms: 0,
      total_ms: 0,
    };

    // Step 1: Speech-to-Text
    const sttResult = await transcribeAudio(audioFile, preferredLanguage || undefined);
    timings.stt_ms = sttResult.duration_ms;

    if (!sttResult.transcript || sttResult.transcript.trim().length < 2) {
      return NextResponse.json(
        { error: "No speech detected", requestId },
        { status: 400 }
      );
    }

    const now = new Date();
    const session = await ensureActiveSession(user.id, personaId, now);

    // Step 2: Build conversation context
    const contextStart = Date.now();
    const context = await buildContext(user.id, personaId, sttResult.transcript);
    timings.context_ms = Date.now() - contextStart;

    // Step 3: Generate LLM response
    const rollingSummary = context.rollingSummary ?? "";
    const shouldTraceLibrarian =
      env.FEATURE_LIBRARIAN_TRACE === "true" ||
      request.headers.get("x-debug-librarian") === "1";
    const librarianStart = Date.now();
    const librarianResult = await runLibrarianReflex({
      requestId,
      userId: user.id,
      personaId,
      sessionId: session.id,
      transcript: sttResult.transcript,
      recentMessages: context.recentMessages,
      now,
      shouldTrace: shouldTraceLibrarian,
    });
    timings.librarian_ms = Date.now() - librarianStart;
    const supplementalContext = librarianResult?.supplementalContext ?? null;
    const posture = librarianResult?.posture ?? DEFAULT_POSTURE;
    let pressure = librarianResult?.pressure ?? DEFAULT_PRESSURE;
    const userState = librarianResult?.userState ?? null;
    let riskLevel = librarianResult?.riskLevel ?? DEFAULT_RISK;
    const triage = librarianResult?.triage ?? conservativeTriageFallback();
    const triageSource = librarianResult?.triageSource ?? "fallback";
    const postureSource = librarianResult?.postureSource ?? "fallback";
    const routerRunReason = librarianResult?.routerRunReason ?? "triage_failed_parse";
    const routerOutput = librarianResult?.routerOutput ?? null;
    const triageModel = librarianResult?.triageModel ?? TRIAGE_PRIMARY_MODEL;
    const triageUsedFallbackModel = librarianResult?.triageUsedFallbackModel ?? false;
    const triageModelFallbackReason = librarianResult?.triageModelFallbackReason ?? null;
    const triagePrimaryFailureCause = librarianResult?.triagePrimaryFailureCause ?? null;
    const triageFallbackFailureCause = librarianResult?.triageFallbackFailureCause ?? null;
    const routerModel = librarianResult?.routerModel ?? null;
    const routerUsedFallbackModel = librarianResult?.routerUsedFallbackModel ?? false;
    const routerModelFallbackReason = librarianResult?.routerModelFallbackReason ?? null;
    const routerPrimaryFailureCause = librarianResult?.routerPrimaryFailureCause ?? null;
    const routerFallbackFailureCause = librarianResult?.routerFallbackFailureCause ?? null;
    const overlayIntent = librarianResult?.intent ?? DEFAULT_GATE_INTENT;
    const overlayIsUrgent = librarianResult?.isUrgent ?? false;
    const overlayIsDirectRequest = librarianResult?.isDirectRequest ?? false;
    const gateAction = librarianResult?.gateAction ?? "none";
    const gateConfidence = librarianResult?.gateConfidence ?? 0;
    const gateExplicit = librarianResult?.gateExplicit ?? false;
    const gateExplicitTopicShift = librarianResult?.gateExplicitTopicShift ?? false;
    const postureConfidence = librarianResult?.postureConfidence ?? 0;
    const stateConfidence = librarianResult?.stateConfidence ?? 0;
    const avoidanceOrDrift = librarianResult?.avoidanceOrDrift ?? false;
    const authorityRemapEnabled = isBouncerAuthorityRemapEnabled();
    const effectiveSignals = resolveEffectiveOverlaySignals({
      authorityRemapEnabled,
      transcript: sttResult.transcript,
      lastTurns: context.recentMessages
        .slice(-4)
        .map((entry) => entry.content)
        .filter((entry) => typeof entry === "string" && entry.trim().length > 0),
      gateConfidence,
      postureConfidence,
      rawIsUrgent: overlayIsUrgent,
      rawIsDirectRequest: overlayIsDirectRequest,
      rawExplicitTopicShift: gateExplicitTopicShift,
    });
    const correctionSignal = isExplicitAssistantCorrection(sttResult.transcript);
    const frictionSignal = hasCorrectionFrictionSignal(sttResult.transcript);
    if (frictionSignal) {
      pressure = "HIGH";
      if (riskLevel === "LOW") {
        riskLevel = "MED";
      }
    }
    if (correctionSignal && context.startBrief?.used) {
      void clearStartBriefForSession(user.id, personaId, session.id).catch((error) => {
        console.warn("[startbrief.invalidate.err]", { userId: user.id, personaId, sessionId: session.id, error });
      });
    }
    const overlayStart = Date.now();
    const overlayState = (await readOverlayState(user.id, personaId)) ?? {};
    let overlayUsed: OverlayUsed = overlayState.overlayUsed ?? {};
    let overlayTypeActive = overlayState.overlayTypeActive ?? null;
    let overlayTurnCount = overlayState.overlayTurnCount ?? 0;
    let pendingDismissType = overlayState.pendingDismissType ?? null;
    let pendingTopicKey = overlayState.pendingTopicKey ?? null;
    let shortReplyStreak = overlayState.shortReplyStreak ?? 0;
    let pendingFocusCapture = overlayState.pendingFocusCapture ?? false;
    let pendingDailyReviewCapture = overlayState.pendingDailyReviewCapture ?? false;
    let pendingWeeklyCompassCapture = overlayState.pendingWeeklyCompassCapture ?? false;
    let correctionOverlayCooldownTurns = overlayState.correctionOverlayCooldownTurns ?? 0;
    let startbriefV2UserTurnsSeen = overlayState.startbriefV2UserTurnsSeen ?? 0;
    let startbriefV2ReinjectedOnce = overlayState.startbriefV2ReinjectedOnce ?? false;
    let startbriefV2FirstUserLowSignal = overlayState.startbriefV2FirstUserLowSignal ?? false;
    let loopsCache = overlayState.loopsCache ?? { fetchedAt: null, items: [] as string[] };
    let queryCache = overlayState.queryCache ?? { fetchedAt: null, facts: [] as string[] };
    let recentInjectedContextKeys = overlayState.recentInjectedContextKeys ?? [];
    let recentOverlayKeys = overlayState.recentOverlayKeys ?? [];
    let stanceActive = overlayState.stanceActive ?? null;
    let stanceTurnsRemaining = overlayState.stanceTurnsRemaining ?? 0;
    let tierBurst: TierBurstState = overlayState.tierBurst ?? {
      activeId: null,
      remaining: 0,
      lastUsedAt: 0,
    };
    let endearmentCooldownTurns = overlayState.endearmentCooldownTurns ?? 0;
    let cooldownTurnsRemaining = overlayState.cooldownTurnsRemaining ?? 0;
    let cooldownLastReason = overlayState.cooldownLastReason ?? null;
    let lastProbingTacticFired = overlayState.lastProbingTacticFired ?? false;
    const synapseSessionIngestOk = overlayState.synapseSessionIngestOk ?? null;
    const synapseSessionIngestError = overlayState.synapseSessionIngestError ?? null;
    const overlayUser = overlayState.user ?? {};
    // Trajectory rituals are day/week scoped to the user's configured local zone.
    const timeZone = "Europe/Zagreb";
    const zoned = getZonedParts(now, timeZone);
    const dayKey = zoned.dayKey;
    const weekStartKey = getWeekStartKey(zoned.dayKey, zoned.weekday);

    if (overlayState.lastSessionId && overlayState.lastSessionId !== session.id) {
      overlayUsed = {};
      overlayTypeActive = null;
      overlayTurnCount = 0;
      pendingDismissType = null;
      pendingTopicKey = null;
      shortReplyStreak = 0;
      pendingFocusCapture = false;
      pendingDailyReviewCapture = false;
      pendingWeeklyCompassCapture = false;
      correctionOverlayCooldownTurns = 0;
      startbriefV2UserTurnsSeen = 0;
      startbriefV2ReinjectedOnce = false;
      startbriefV2FirstUserLowSignal = false;
      loopsCache = { fetchedAt: null, items: [] };
      queryCache = { fetchedAt: null, facts: [] };
      recentInjectedContextKeys = [];
      recentOverlayKeys = [];
      stanceActive = null;
      stanceTurnsRemaining = 0;
      tierBurst = { activeId: null, remaining: 0, lastUsedAt: 0 };
      endearmentCooldownTurns = 0;
      cooldownTurnsRemaining = 0;
      cooldownLastReason = null;
      lastProbingTacticFired = false;
    }
    if (context.isSessionStart && startbriefV2UserTurnsSeen === 0) {
      startbriefV2FirstUserLowSignal = isLowSignalFirstUserMessage(sttResult.transcript);
    }

    const allowSemanticReinjection = shouldAllowHandoverReinjection({
      gateAction,
      gateConfidence,
      gateExplicit,
      gateExplicitTopicShift,
      isDirectRequest: overlayIsDirectRequest,
      reinjectedOnce: startbriefV2ReinjectedOnce,
    });
    const startbriefInjection = buildStartbriefInjection({
      packet: context.startbriefPacket,
      userTurnsSeen: startbriefV2UserTurnsSeen,
      firstUserMsgLowSignal: startbriefV2FirstUserLowSignal,
      allowSemanticReinjection,
    });
    const bridgeBlock = startbriefInjection.bridgeBlock;
    const handoverBlock = startbriefInjection.handoverBlock;
    const bridgeInjected = startbriefInjection.bridgeInjected;
    const handoverInjected = startbriefInjection.handoverInjected;
    const reinjectionUsed = startbriefInjection.reinjectionUsed;
    if (reinjectionUsed) {
      startbriefV2ReinjectedOnce = true;
    }

    let opsSnippetBlock: string | null = null;
    let opsInjected = false;
    let opsSource: "startbrief_ops" | "loops" | "query" | null = null;
    if (
      shouldInjectOpsSnippet({
        riskLevel,
        posture,
        pressure,
        intent: overlayIntent,
        gateAction,
        gateConfidence,
        isDirectRequest: overlayIsDirectRequest,
        isUrgent: overlayIsUrgent,
        postureConfidence,
      })
    ) {
      const startbriefLoopTexts = topLoopTextsFromPacket(context.startbriefPacket);
      let snippet = buildOpsSnippetFromLoops(startbriefLoopTexts);
      if (snippet) {
        opsSnippetBlock = snippet;
        opsInjected = true;
        opsSource = "startbrief_ops";
      } else {
        const nowMs = now.getTime();
        const loopsFetchedAtMs = loopsCache.fetchedAt
          ? new Date(loopsCache.fetchedAt).getTime()
          : 0;
        const loopsCacheFresh =
          Number.isFinite(loopsFetchedAtMs) && nowMs - loopsFetchedAtMs <= 10 * 60 * 1000;
        let loopTexts = loopsCacheFresh ? loopsCache.items ?? [] : [];
        if (!loopsCacheFresh && env.SYNAPSE_BASE_URL && env.SYNAPSE_TENANT_ID) {
          const loopsResponse = await synapseClient.memoryLoops<{
            tenantId: string;
            userId: string;
            limit: number;
          }, { items?: Array<{ text?: string | null }> | null }>({
            tenantId: env.SYNAPSE_TENANT_ID,
            userId: user.id,
            limit: 2,
          });
          loopTexts = Array.isArray(loopsResponse?.items)
            ? loopsResponse.items
                .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
                .filter(Boolean)
                .slice(0, 2)
            : [];
          loopsCache = {
            fetchedAt: now.toISOString(),
            items: loopTexts,
          };
        }
        snippet = buildOpsSnippetFromLoops(loopTexts);
        if (snippet) {
          opsSnippetBlock = snippet;
          opsInjected = true;
          opsSource = "loops";
        } else {
          const facts = extractFactsFromSupplementalContext(supplementalContext);
          const queryFetchedAtMs = queryCache.fetchedAt
            ? new Date(queryCache.fetchedAt).getTime()
            : 0;
          const queryCacheFresh =
            Number.isFinite(queryFetchedAtMs) && nowMs - queryFetchedAtMs <= 15 * 60 * 1000;
          const queryFacts = facts.length > 0 ? facts : queryCacheFresh ? queryCache.facts ?? [] : [];
          if (facts.length > 0) {
            queryCache = { fetchedAt: now.toISOString(), facts: facts.slice(0, 2) };
          }
          const querySnippet = buildOpsSnippetFromLoops(queryFacts.slice(0, 2));
          if (querySnippet) {
            opsSnippetBlock = querySnippet;
            opsInjected = true;
            opsSource = "query";
          }
        }
      }
    }
    opsSnippetBlock = applyOpsSupplementalMutualExclusion(opsSnippetBlock, supplementalContext);
    if (!opsSnippetBlock) {
      opsInjected = false;
      opsSource = null;
    }

    const cooldownResult = applyCooldownPolicy({
      previousCooldownTurnsRemaining: cooldownTurnsRemaining,
      previousCooldownLastReason: cooldownLastReason,
      triage,
      routerRunReason,
      routerOutput,
    });
    cooldownTurnsRemaining = cooldownResult.cooldownTurnsRemaining;
    cooldownLastReason = cooldownResult.cooldownLastReason;
    const cooldownActivatedReason = cooldownResult.cooldownActivatedReason;

    let stanceOverlayType: StanceOverlayType | "none" = "none";
    let tacticOverlayType: TacticOverlayType | "none" = "none";
    let overlayTriggerReason = "none";
    let overlaySuppressionReason: string | null = null;
    let overlayExitReason: "cap" | "dismiss" | "topicShift" | "helpRequest" | "lowEnergy" | "policy" | "none" =
      "none";
    let overlayTopicKey: string | undefined;
    let tacticEligibility: TacticEligibilityResult = { allowed: true, vetoReasons: [] };
    let curiosityContinuationAttempted = false;
    let curiosityContinuationBlockedByEligibility = false;
    const baseOverlayPolicy = shouldSkipOverlaySelection({
      intent: overlayIntent,
      isUrgent: effectiveSignals.isUrgent,
      isDirectRequest: effectiveSignals.isDirectRequest,
    });
    correctionOverlayCooldownTurns = nextCorrectionOverlayCooldownTurns(
      correctionOverlayCooldownTurns,
      correctionSignal
    );
    if (correctionSignal) {
      overlayUser.sessionFactCorrections = mergeCorrectionFacts(
        overlayUser.sessionFactCorrections,
        extractCorrectionFactClaims(sttResult.transcript)
      );
    }

    const sessionWarmupSkip = shouldForceSessionWarmupOverlaySkip({
      isSessionStart: context.isSessionStart,
      recentMessageCount: context.recentMessages.length,
      intent: overlayIntent,
      isUrgent: effectiveSignals.isUrgent,
      isDirectRequest: effectiveSignals.isDirectRequest,
    });
    const overlayPolicy =
      frictionSignal || correctionOverlayCooldownTurns > 0
        ? { skip: true as const, reason: "friction_correction" as const }
        : sessionWarmupSkip
          ? { skip: true as const, reason: "session_warmup" as const }
          : baseOverlayPolicy;
    const overlaySkipReason = overlayPolicy.skip ? overlayPolicy.reason : null;
    const hasTodayFocus = overlayUser.todayFocusDate === dayKey;
    const hasDailyReviewToday = overlayUser.lastDailyReviewDate === dayKey;
    const hasWeeklyCompass = overlayUser.weeklyNorthStarWeekStartDate === weekStartKey;
    const dailyFocusEligible = shouldTriggerDailyFocus({
      isSessionStart: context.isSessionStart,
      localHour: zoned.hour,
      intent: overlayIntent,
      posture,
      riskLevel,
      energy: userState?.energy ?? null,
      hasTodayFocus,
    });
    const dailyReviewEligible = shouldTriggerDailyReview({
      isSessionStart: context.isSessionStart,
      localHour: zoned.hour,
      riskLevel,
      hasDailyReviewToday,
    });
    const weeklyCompassEligible = shouldTriggerWeeklyCompass({
      isSessionStart: context.isSessionStart,
      weekday: zoned.weekday,
      localHour: zoned.hour,
      weekStartKey,
      weeklyNorthStarWeekStartDate: overlayUser.weeklyNorthStarWeekStartDate,
    });

    if (pendingFocusCapture && overlayUser.todayFocusDate !== dayKey) {
      const parsed = extractTodayFocus(sttResult.transcript);
      if (parsed) {
        pendingFocusCapture = false;
        overlayUser.lastDailyFocusAt = now.toISOString();
        overlayUser.todayFocusDate = dayKey;
        if (parsed.status === "set") {
          overlayUser.todayFocus = parsed.focus;
        } else {
          overlayUser.todayFocus = null;
        }
      }
    }

    if (pendingDailyReviewCapture && overlayUser.lastDailyReviewDate !== dayKey) {
      const parsed = extractDailyReviewSummary(sttResult.transcript);
      if (parsed) {
        pendingDailyReviewCapture = false;
        overlayUser.lastDailyReviewDate = dayKey;
        overlayUser.lastDailyReviewSummary = parsed.status === "set" ? parsed.summary : null;
      }
    }

    if (pendingWeeklyCompassCapture && overlayUser.weeklyNorthStarWeekStartDate !== weekStartKey) {
      const parsed = extractWeeklyCompass(sttResult.transcript);
      if (parsed) {
        pendingWeeklyCompassCapture = false;
        overlayUser.weeklyNorthStarWeekStartDate = weekStartKey;
        if (parsed.status === "set") {
          overlayUser.weeklyNorthStar = parsed.weeklyNorthStar;
          overlayUser.weeklyPriorities = parsed.weeklyPriorities.slice(0, 3);
        } else {
          overlayUser.weeklyNorthStar = null;
          overlayUser.weeklyPriorities = [];
        }
      }
    }

    if (pendingDismissType) {
      if (isDismissal(sttResult.transcript)) {
        overlayExitReason = "dismiss";
        if (pendingDismissType === "accountability_tug" && pendingTopicKey) {
          const backoffUntil = new Date(now.getTime() + 48 * 60 * 60 * 1000);
          overlayUser.tugBackoff = {
            ...(overlayUser.tugBackoff ?? {}),
            [pendingTopicKey]: backoffUntil.toISOString(),
          };
          overlayUser.lastTugAt = now.toISOString();
          overlayUsed = { ...overlayUsed, accountabilityTug: true };
        }
      }
      pendingDismissType = null;
      pendingTopicKey = null;
      overlayTypeActive = null;
      overlayTurnCount = 0;
      shortReplyStreak = 0;
    }

    const safetyRiskOverride = riskLevel === "HIGH" || riskLevel === "CRISIS";
    if (safetyRiskOverride) {
      stanceOverlayType = "witness";
      tacticOverlayType = "none";
      overlayTriggerReason = "safety_risk_override";
      overlaySuppressionReason = "safety_risk_override";
      overlayTypeActive = null;
      overlayTurnCount = 0;
      shortReplyStreak = 0;
    } else if (overlayPolicy.skip) {
      const skipDecision = resolvePolicySkipSelection({
        skipReason: overlayPolicy.reason,
        transcript: sttResult.transcript,
        posture,
        intent: overlayIntent,
        explicitTopicShift: effectiveSignals.explicitTopicShift,
        avoidanceOrDrift,
        openLoops: context.overlayContext?.openLoops,
        commitments: context.overlayContext?.commitments,
        recentUserMessages: context.recentMessages
          .filter((entry) => entry.role === "user")
          .map((entry) => entry.content)
          .slice(-3),
        overlayUsed,
        dailyFocusEligible,
        dailyReviewEligible,
        weeklyCompassEligible,
        hasTodayFocus: overlayUser.todayFocusDate === dayKey,
        hasDailyReviewToday,
        hasWeeklyCompass,
        pressure,
        riskLevel,
        mood: userState?.mood,
        tone: userState?.tone,
        userLastTugAt: overlayUser.lastTugAt ?? null,
        tugBackoff: overlayUser.tugBackoff,
        now,
      });
      stanceOverlayType = skipDecision.stanceSelected;
      tacticOverlayType = skipDecision.tacticSelected;
      overlayTriggerReason = skipDecision.triggerReason;
      overlaySuppressionReason = skipDecision.suppressionReason;
      if (overlayTypeActive) {
        overlayExitReason = "policy";
      }
      overlayTypeActive = null;
      overlayTurnCount = 0;
      shortReplyStreak = 0;
    } else if (overlayTypeActive === "curiosity_spiral") {
      if (isDismissal(sttResult.transcript)) {
        overlayExitReason = "dismiss";
        overlayTypeActive = null;
        overlayTurnCount = 0;
        shortReplyStreak = 0;
      } else if (overlayIntent === "output_task") {
        overlayExitReason = "helpRequest";
        overlayTypeActive = null;
        overlayTurnCount = 0;
        shortReplyStreak = 0;
      } else if (isTopicShift(sttResult.transcript)) {
        overlayExitReason = "topicShift";
        overlayTypeActive = null;
        overlayTurnCount = 0;
        shortReplyStreak = 0;
      } else {
        if (isShortReply(sttResult.transcript)) {
          shortReplyStreak += 1;
        } else {
          shortReplyStreak = 0;
        }
        if (shortReplyStreak >= 2) {
          overlayExitReason = "lowEnergy";
          overlayTypeActive = null;
          overlayTurnCount = 0;
          shortReplyStreak = 0;
        }
      }
    }

    const previousStance = (stanceActive ?? "none") as StanceOverlayType | "none";
    const witnessCarryTurns = nextWitnessHysteresisTurns({
      previousStance,
      previousTurnsRemaining: stanceTurnsRemaining,
      selectedStance: stanceOverlayType,
      transcript: sttResult.transcript,
      pressure,
    });
    const holdWitnessContinuation = shouldHoldWitnessOnContinuation({
      enabled: authorityRemapEnabled,
      previousStance,
      selectedStance: stanceOverlayType,
      transcript: sttResult.transcript,
      explicitTopicShiftFromHighConfidence: effectiveSignals.explicitTopicShiftFromHighConfidence,
      effectiveIsDirectRequest: effectiveSignals.isDirectRequest,
    });
    if (holdWitnessContinuation) {
      stanceOverlayType = "witness";
      overlaySuppressionReason = overlaySuppressionReason ?? "witness_continuation_hold";
      overlayTriggerReason =
        overlayTriggerReason === "none" ? "witness_continuation_hold" : overlayTriggerReason;
    }
    if (stanceOverlayType === "none" && previousStance === "witness" && witnessCarryTurns > 0) {
      stanceOverlayType = "witness";
      overlaySuppressionReason = overlaySuppressionReason ?? "witness_hysteresis";
      overlayTriggerReason = overlayTriggerReason === "none" ? "witness_hysteresis_hold" : overlayTriggerReason;
    }
    if (stanceOverlayType === "witness") {
      stanceActive = "witness";
      stanceTurnsRemaining = witnessCarryTurns;
    } else {
      stanceActive = stanceOverlayType === "none" ? null : stanceOverlayType;
      stanceTurnsRemaining = 0;
    }

    if (!overlayPolicy.skip && overlayTypeActive === "curiosity_spiral") {
      curiosityContinuationAttempted = true;
      const continuationEligibility = evaluateTacticEligibility({
        tactic: "curiosity_spiral",
        triage,
        cooldownTurnsRemaining,
      });
      if (!continuationEligibility.allowed) {
        curiosityContinuationBlockedByEligibility = true;
        tacticEligibility = continuationEligibility;
        overlaySuppressionReason = continuationEligibility.vetoReasons.join(",");
        overlayExitReason = "policy";
        overlayTypeActive = null;
        overlayTurnCount = 0;
        shortReplyStreak = 0;
      }
    }

    if (!overlayPolicy.skip && overlayTypeActive === "curiosity_spiral") {
      if (overlayTurnCount < 4) {
        tacticOverlayType = "curiosity_spiral";
        overlayTriggerReason = "curiosity_active";
        overlayTurnCount += 1;
        if (overlayTurnCount >= 4) {
          overlayExitReason = "cap";
          overlayTypeActive = null;
        }
      } else {
        overlayExitReason = "cap";
        overlayTypeActive = null;
      }
    } else if (!overlayPolicy.skip) {
      const decision = selectOverlay({
        transcript: sttResult.transcript,
        posture,
        intent: overlayIntent,
        explicitTopicShift: effectiveSignals.explicitTopicShift,
        avoidanceOrDrift,
        openLoops: context.overlayContext?.openLoops,
        commitments: context.overlayContext?.commitments,
        recentUserMessages: context.recentMessages
          .filter((entry) => entry.role === "user")
          .map((entry) => entry.content)
          .slice(-3),
        hasHighPriorityLoop: context.overlayContext?.hasHighPriorityLoop,
        overlayUsed,
        dailyFocusEligible,
        dailyReviewEligible,
        weeklyCompassEligible,
        hasTodayFocus: overlayUser.todayFocusDate === dayKey,
        hasDailyReviewToday,
        hasWeeklyCompass,
        conflictSignals: {
          pressure,
          riskLevel,
          mood: userState?.mood,
          tone: userState?.tone,
        },
        userLastTugAt: overlayUser.lastTugAt ?? null,
        tugBackoff: overlayUser.tugBackoff,
        now,
      });
      stanceOverlayType = decision.stanceOverlay;
      tacticOverlayType = decision.tacticOverlay;
      overlayTriggerReason = decision.triggerReason;
      overlaySuppressionReason = decision.suppressionReason ?? null;
      overlayTopicKey = decision.topicKey;
      tacticEligibility = evaluateTacticEligibility({
        tactic: tacticOverlayType,
        triage,
        cooldownTurnsRemaining,
      });
      if (!tacticEligibility.allowed) {
        if (tacticOverlayType !== "none") {
          overlaySuppressionReason = tacticEligibility.vetoReasons.join(",");
        }
        tacticOverlayType = "none";
        overlayTopicKey = undefined;
      }

      const stanceKey = stanceOverlayType === "none" ? null : `stance:${stanceOverlayType}`;
      if (
        stanceKey &&
        shouldSuppressByOverlayRepetition({
          key: stanceKey,
          recentOverlayKeys,
          explicitTopicShift: effectiveSignals.explicitTopicShift,
          pressure,
          riskLevel,
        })
      ) {
        stanceOverlayType = "none";
        overlaySuppressionReason = overlaySuppressionReason ?? "repetition_suppressed";
      }

      const tacticKey = tacticOverlayType === "none" ? null : `tactic:${tacticOverlayType}`;
      if (
        tacticKey &&
        shouldSuppressByOverlayRepetition({
          key: tacticKey,
          recentOverlayKeys,
          explicitTopicShift: effectiveSignals.explicitTopicShift,
          pressure,
          riskLevel,
        })
      ) {
        tacticOverlayType = "none";
        overlaySuppressionReason = overlaySuppressionReason ?? "repetition_suppressed";
        overlayTopicKey = undefined;
      }

      if (
        shouldHoldOverlayUntilRunway({
          overlayType: tacticOverlayType,
          recentMessageCount: context.recentMessages.length,
          hasHighPriorityLoop: context.overlayContext?.hasHighPriorityLoop,
        })
      ) {
        tacticOverlayType = "none";
        overlayTriggerReason = "policy_skip_conversation_runway";
        overlaySuppressionReason = "conversation_runway";
        overlayTopicKey = undefined;
      }

      if (tacticOverlayType === "curiosity_spiral") {
        overlayTypeActive = "curiosity_spiral";
        overlayTurnCount = 1;
        shortReplyStreak = 0;
        overlayUsed = { ...overlayUsed, curiositySpiral: true };
      }
      if (tacticOverlayType === "accountability_tug" && overlayTopicKey) {
        const normalized = normalizeTopicKey(overlayTopicKey);
        overlayTopicKey = normalized;
        overlayUsed = { ...overlayUsed, accountabilityTug: true };
        overlayUser.lastTugAt = now.toISOString();
        pendingDismissType = "accountability_tug";
        pendingTopicKey = normalized;
      }
      if (tacticOverlayType === "daily_focus") {
        overlayUsed = { ...overlayUsed, dailyFocus: true };
        pendingFocusCapture = true;
        overlayUser.lastDailyFocusAt = now.toISOString();
      }
      if (tacticOverlayType === "daily_review") {
        overlayUsed = { ...overlayUsed, dailyReview: true };
        pendingDailyReviewCapture = true;
      }
      if (tacticOverlayType === "weekly_compass") {
        overlayUsed = { ...overlayUsed, weeklyCompass: true };
        pendingWeeklyCompassCapture = true;
      }
    }

    const probingTacticFired = isProbingTactic(tacticOverlayType);
    const tacticRegretCandidate =
      lastProbingTacticFired && (triage.rupture === "MILD" || triage.rupture === "STRONG");
    lastProbingTacticFired = probingTacticFired;

    recentOverlayKeys = updateRecentOverlayKeys(recentOverlayKeys, [
      ...(stanceOverlayType !== "none" ? [`stance:${stanceOverlayType}`] : []),
      ...(tacticOverlayType !== "none" ? [`tactic:${tacticOverlayType}`] : []),
    ]);

    let stanceOverlayBlock: string | null = null;
    if (stanceOverlayType !== "none") {
      const overlayText = await loadOverlay(stanceOverlayType);
      stanceOverlayBlock = `[STANCE_OVERLAY]\n${overlayText}`;
    }

    let tacticOverlayBlock: string | null = null;
    if (tacticOverlayType !== "none") {
      const overlayText = await loadOverlay(tacticOverlayType);
      tacticOverlayBlock = `[OVERLAY]\n${overlayText}`;
    }
    const styleGuardBlock = buildStyleGuardBlock({
      stance: stanceOverlayType,
      endearmentCooldownTurns,
      cooldownActive: cooldownTurnsRemaining > 0,
    });
    endearmentCooldownTurns = nextEndearmentCooldownTurns(endearmentCooldownTurns, stanceOverlayType);

    const deferredProfileLines = buildDeferredProfileContextLines({
      isSessionStart: context.isSessionStart,
      profile: context.deferredProfileContext,
      posture,
      intent: overlayIntent,
      isDirectRequest: overlayIsDirectRequest,
      transcript: sttResult.transcript,
      avoidanceOrDrift,
    });
    const selectedUserContext = selectUserContextCandidates({
      transcript: sttResult.transcript,
      deferredProfileLines,
      recentInjectedContextKeys,
      trajectory: {
        longTermDirectionLine: context.deferredProfileContext?.longTermDirectionLine,
        workContextLine: context.deferredProfileContext?.workContextLine,
        dailyAnchorsLine: context.deferredProfileContext?.dailyAnchorsLine,
        currentFocus: context.overlayContext?.currentFocus ?? null,
        topLoopText: context.overlayContext?.openLoops?.[0] ?? null,
        topLoopFetchedAt: loopsCache.fetchedAt ?? null,
        now,
      },
    });
    const userContextLines = selectedUserContext.map((item) => item.line);
    recentInjectedContextKeys = updateRecentInjectedContextKeys(
      recentInjectedContextKeys,
      selectedUserContext.map((item) => item.key)
    );
    const userContextBlock =
      userContextLines.length > 0
        ? `[USER_CONTEXT]\n${userContextLines.map((line) => `- ${line}`).join("\n")}`
        : null;
    const inferredRoutingMoment = deriveRoutingMoment({
      transcript: sttResult.transcript,
      selectedUserContext,
    });
    const routingMoment: RoutingMoment | null =
      inferredRoutingMoment ??
      (stanceOverlayType === "witness" && pressure === "HIGH" ? "grief" : null);
    const burstTopicHint = deriveBurstTopicHint({
      transcript: sttResult.transcript,
      overlayTopicKey: overlayTopicKey ?? null,
    });
    const tierDecision = getTurnTierForSignals({
      riskLevel,
      posture,
      pressure,
      stanceSelected: stanceOverlayType,
      moment: routingMoment,
      intent: overlayIntent,
      isDirectRequest: effectiveSignals.isDirectRequest,
      isUrgent: effectiveSignals.isUrgent,
    });
    const safetyModel = getChatModelForGate({
      personaId: persona.slug,
      gate: { risk_level: riskLevel },
    });
    const safetyModelOverride = riskLevel === "HIGH" || riskLevel === "CRISIS";
    const burstRemainingBefore = Math.max(0, tierBurst.remaining ?? 0);
    let burstEventId: string | null = null;
    let burstWasStarted = false;
    let burstRemainingAfter = burstRemainingBefore;
    let tierForModel: TurnTier = tierDecision.tier;
    let tierSelected: "SAFETY" | TurnTier = tierDecision.tier;
    let routingReason = tierDecision.reason;

    if (safetyModelOverride) {
      tierSelected = "SAFETY";
      routingReason = "risk_high_or_crisis";
    } else {
      const burstDecision = applyT3BurstRouting({
        baseTier: tierDecision.tier,
        baseReason: tierDecision.reason,
        burstState: tierBurst,
        stanceSelected: stanceOverlayType,
        moment: routingMoment,
        intent: overlayIntent,
        topicHint: burstTopicHint,
        nowMs: now.getTime(),
      });
      tierBurst = burstDecision.burstState;
      tierForModel = burstDecision.tier;
      tierSelected = burstDecision.tier;
      routingReason = burstDecision.routingReason;
      burstEventId = burstDecision.burstEventId;
      burstWasStarted = burstDecision.burstWasStarted;
      burstRemainingAfter = burstDecision.burstRemainingAfter;
    }

    const model = safetyModelOverride
      ? safetyModel
      : getChatModelForTurn({ tier: tierForModel });

    await writeOverlayState(user.id, personaId, {
      overlayUsed,
      overlayTypeActive,
      overlayTurnCount,
      pendingDismissType,
      pendingTopicKey,
      shortReplyStreak,
      pendingFocusCapture,
      pendingDailyReviewCapture,
      pendingWeeklyCompassCapture,
      correctionOverlayCooldownTurns,
      startbriefV2UserTurnsSeen: startbriefV2UserTurnsSeen + 1,
      startbriefV2ReinjectedOnce,
      startbriefV2FirstUserLowSignal,
      loopsCache,
      queryCache,
      recentInjectedContextKeys,
      recentOverlayKeys,
      stanceActive,
      stanceTurnsRemaining,
      tierBurst,
      endearmentCooldownTurns,
      cooldownTurnsRemaining,
      cooldownLastReason,
      lastProbingTacticFired,
      lastSessionId: session.id,
      user: overlayUser,
    });

    if (shouldTraceLibrarian) {
      void prisma.librarianTrace.create({
        data: {
          userId: user.id,
          personaId,
          sessionId: session.id,
          kind: "overlay",
          transcript: sttResult.transcript,
          memoryQuery: {
            stanceSelected: stanceOverlayType,
            tacticSelected: tacticOverlayType,
            triggerReason: overlayTriggerReason,
            suppressionReason: overlaySuppressionReason,
            overlayTurnCount,
            overlayExitReason,
            topicKey: overlayTopicKey ?? null,
            cooldown_turns_remaining: cooldownTurnsRemaining,
            cooldown_last_reason: cooldownLastReason,
            cooldown_activated_reason: cooldownActivatedReason,
            tactic_eligibility_allowed: tacticEligibility.allowed,
            tactic_eligibility_veto_reasons: tacticEligibility.vetoReasons,
            curiosity_continuation_attempted: curiosityContinuationAttempted,
            curiosity_continuation_blocked_by_eligibility:
              curiosityContinuationBlockedByEligibility,
          },
        },
      }).catch((error) => {
        console.warn("[librarian.trace] failed to log overlay", { error });
      });
    }
    timings.overlay_ms = Date.now() - overlayStart;

    const signalPackBlock = shouldInjectSignalPack({
      signalPackBlock: context.signalPackBlock ?? null,
      isSessionStart: context.isSessionStart,
      intent: overlayIntent,
      posture,
      pressure,
      stance: stanceOverlayType,
      riskLevel,
      isUrgent: effectiveSignals.isUrgent,
    })
      ? context.signalPackBlock ?? null
      : null;

    const governedContext = buildContextGovernorSelection({
      userContextBlock,
      signalPackBlock,
      bridgeBlock,
      handoverBlock,
      opsSnippetBlock,
      intent: overlayIntent,
      posture,
      pressure,
      stance: stanceOverlayType,
      riskLevel,
    });

    const messages = buildChatMessages({
      persona: context.persona,
      momentumGuardBlock: buildMomentumGuardBlock({
        intent: overlayIntent,
        posture,
        localHour: zoned.hour,
      }),
      styleGuardBlock,
      userContextBlock: governedContext.userContextBlock,
      signalPackBlock: governedContext.signalPackBlock,
      stanceOverlayBlock,
      tacticOverlayBlock,
      bridgeBlock: governedContext.bridgeBlock,
      handoverBlock: governedContext.handoverBlock,
      opsSnippetBlock: governedContext.opsSnippetBlock,
      supplementalContext,
      rollingSummary,
      recentMessages: context.recentMessages,
      transcript: sttResult.transcript,
      posture,
      pressure,
      userState,
    });

    const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (totalChars > 20000) {
      console.warn(
        "[chat.prompt.warn]",
        JSON.stringify({
          trace_id: traceId,
          userId: user.id,
          personaId,
          totalChars,
          messageCount: messages.length,
          counts: {
            recentMessages: context.recentMessages.length,
            situationalContext: 0,
            supplementalContext: supplementalContext ? 1 : 0,
            rollingSummary: rollingSummary ? 1 : 0,
          },
          chosenModel: model,
          risk_level: riskLevel,
          intent: overlayIntent,
          stanceSelected: stanceOverlayType,
          tacticSelected: tacticOverlayType,
          overlaySelected: tacticOverlayType,
          overlaySkipReason,
          suppressionReason: overlaySuppressionReason,
        })
      );
    }

    const debugEnabled =
      env.FEATURE_CONTEXT_DEBUG === "true" &&
      request.headers.get("x-debug-context") === "1";
    const promptDebugEnabled =
      env.FEATURE_CONTEXT_DEBUG === "true" &&
      request.headers.get("x-debug-prompt") === "1";
    const tracePromptPacket =
      env.FEATURE_LIBRARIAN_TRACE === "true" ||
      request.headers.get("x-debug-prompt") === "1";

    let debugPayload: Record<string, unknown> | undefined;
    if (debugEnabled) {
      debugPayload = {
        contextBlocks: {
          persona: context.persona,
          situationalContext: null,
          supplementalContext,
          rollingSummary,
        },
        startBrief: context.startBrief ?? null,
        composedPrompt: promptDebugEnabled
          ? {
              chosenModel: model,
              messages,
            }
          : undefined,
      };
    }

    const systemBlockOrder = [
      "persona",
      "posture",
      ...(styleGuardBlock ? ["style_guard"] : []),
      ...(governedContext.userContextBlock ? ["user_context"] : []),
      ...(governedContext.signalPackBlock ? ["signal_pack"] : []),
      ...(stanceOverlayBlock ? ["stance_overlay"] : []),
      ...(tacticOverlayBlock ? ["overlay"] : []),
      ...(governedContext.bridgeBlock ? ["bridge"] : []),
      ...(governedContext.handoverBlock ? ["handover"] : []),
      ...(governedContext.opsSnippetBlock ? ["ops"] : []),
      ...(supplementalContext ? ["supplemental"] : []),
      ...(rollingSummary ? ["conversation_history"] : []),
    ];

    const llmResponse = await generateResponse(messages, persona.slug, model);
    timings.llm_ms = llmResponse.duration_ms;

    if (tracePromptPacket) {
      void prisma.librarianTrace.create({
        data: {
          userId: user.id,
          personaId,
          sessionId: session.id,
          requestId,
          kind: "prompt_packet",
          transcript: sttResult.transcript,
          memoryQuery: {
            chosenModel: model,
            tierSelected,
            routingReason,
            burstActiveId: tierBurst.activeId,
            burstRemainingBefore,
            burstRemainingAfter,
            burstEventId,
            burstWasStarted,
            risk_level: riskLevel,
            intent: overlayIntent,
            stanceSelected: stanceOverlayType,
            tacticSelected: tacticOverlayType,
            overlaySelected: tacticOverlayType,
            overlaySkipReason,
            suppressionReason: overlaySuppressionReason,
            system_blocks: systemBlockOrder,
            startbrief_used: Boolean(context.startBrief?.used),
            startbrief_fallback: context.startBrief?.fallback ?? null,
            startbrief_items_count: context.startBrief?.itemsCount ?? 0,
            bridgeText_chars: context.startBrief?.bridgeTextChars ?? 0,
            context_governor_used: governedContext.runtime.used,
            context_governor_budget_chars: governedContext.runtime.budget_chars,
            context_governor_candidates_total: governedContext.runtime.candidates_total,
            context_governor_selected_total: governedContext.runtime.selected_total,
            context_governor_selected_by_source: governedContext.runtime.selected_by_source,
            context_governor_dropped_by_reason: governedContext.runtime.dropped_by_reason,
            context_governor_selected_keys: governedContext.runtime.selected_keys,
            triage_output: triage,
            triage_source: triageSource,
            posture_source: postureSource,
            router_output: routerOutput,
            router_run_reason: routerRunReason,
            triage_model: triageModel,
            triage_used_fallback_model: triageUsedFallbackModel,
            triage_model_fallback_reason: triageModelFallbackReason,
            triage_primary_failure_cause: triagePrimaryFailureCause,
            triage_fallback_failure_cause: triageFallbackFailureCause,
            router_model: routerModel,
            router_used_fallback_model: routerUsedFallbackModel,
            router_model_fallback_reason: routerModelFallbackReason,
            router_primary_failure_cause: routerPrimaryFailureCause,
            router_fallback_failure_cause: routerFallbackFailureCause,
            cooldown_turns_remaining: cooldownTurnsRemaining,
            cooldown_last_reason: cooldownLastReason,
            cooldown_activated_reason: cooldownActivatedReason,
            tactic_eligibility_allowed: tacticEligibility.allowed,
            tactic_eligibility_veto_reasons: tacticEligibility.vetoReasons,
            tactic_regret_candidate: tacticRegretCandidate,
            curiosity_continuation_attempted: curiosityContinuationAttempted,
            curiosity_continuation_blocked_by_eligibility:
              curiosityContinuationBlockedByEligibility,
            ...buildBouncerAuthorityTraceFields({
              shadowLogEnabled: isBouncerAuthorityShadowLogEnabled(),
              authorityRemapEnabled,
              raw: {
                is_urgent: overlayIsUrgent,
                is_direct_request: overlayIsDirectRequest,
                explicit_topic_shift: gateExplicitTopicShift,
                confidence: gateConfidence,
                posture_confidence: postureConfidence,
                state_confidence: stateConfidence,
              },
              effective: {
                isUrgent: effectiveSignals.isUrgent,
                isDirectRequest: effectiveSignals.isDirectRequest,
                explicitTopicShift: effectiveSignals.explicitTopicShift,
              },
            }),
          },
          memoryResponse: {
            messages,
          },
        },
      }).catch((error) => {
        console.warn("[librarian.trace] failed to log prompt_packet", { error });
      });
    }

    // Step 4: Text-to-Speech
    const ttsResult = await synthesizeSpeech(llmResponse.content, persona.ttsVoiceId, {
      localHour: zoned.hour,
    });
    timings.tts_ms = ttsResult.duration_ms;

    // Step 5: Store message with timing metadata
    const dbWriteStart = Date.now();
    const userWrite = prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "user",
        content: sttResult.transcript,
        metadata: {
          stt_confidence: sttResult.confidence,
          stt_ms: timings.stt_ms,
          total_ms: Date.now() - totalStartTime,
          request_id: requestId,
        },
      },
    });
    const assistantWrite = prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "assistant", 
        content: llmResponse.content,
        audioUrl: ttsResult.audioUrl,
        metadata: {
          llm_ms: timings.llm_ms,
          tts_ms: timings.tts_ms,
          total_ms: Date.now() - totalStartTime,
          request_id: requestId,
        },
      },
    });
    const writeResults = await Promise.allSettled([userWrite, assistantWrite]);
    if (writeResults[0].status === "rejected") {
      console.warn("[chat.db.write.user.failed]", { requestId, error: writeResults[0].reason });
    }
    if (writeResults[1].status === "rejected") {
      console.warn("[chat.db.write.assistant.failed]", { requestId, error: writeResults[1].reason });
    }
    timings.db_write_ms = Date.now() - dbWriteStart;
    timings.total_ms = Date.now() - totalStartTime;

    if (
      env.FEATURE_SYNAPSE_INGEST === "true" &&
      env.FEATURE_SYNAPSE_SESSION_INGEST !== "true"
    ) {
      fireAndForgetSynapseIngest({
        requestId,
        userId: user.id,
        personaId,
        sessionId: session.id,
        transcript: sttResult.transcript,
        assistantText: llmResponse.content,
      });
    }

    runShadowJudgeIfEnabled({
      userId: user.id,
      personaId,
      userMessage: sttResult.transcript,
      assistantResponse: llmResponse.content,
      currentSessionState: undefined,
    });

    autoCurateMaybe(user.id, personaId).catch((error) => {
      console.warn("[curator.auto.err]", { userId: user.id, personaId, error });
    });

    void maybeUpdateRollingSummary({
      sessionId: session.id,
      userId: user.id,
      personaId,
      turnCount: session.turnCount,
    }).catch((error) => {
      console.warn("[rolling.summary.err]", { userId: user.id, personaId, error });
    });


    const tracePayload = buildChatTrace({
      traceId,
      requestId,
      userId: user.id,
      personaId,
      sessionId: session.id,
      chosenModel: model,
      riskLevel,
      intent: overlayIntent,
      stanceSelected: stanceOverlayType,
      tacticSelected: tacticOverlayType,
      suppressionReason: overlaySuppressionReason,
      overlaySelected: tacticOverlayType,
      overlaySkipReason,
      startbrief: {
        used: Boolean(context.startBrief?.used),
        fallback: context.startBrief?.fallback ?? null,
        items_count: context.startBrief?.itemsCount ?? 0,
        bridgeText_chars: context.startBrief?.bridgeTextChars ?? 0,
      },
      startbriefRuntime: {
        session_id: session.id,
        userTurnsSeen: startbriefV2UserTurnsSeen,
        handover_injected: handoverInjected,
        bridge_injected: bridgeInjected,
        ops_injected: opsInjected,
        ops_source: opsSource,
        startbrief_fetch: context.startbriefFetch === "hit" ? "hit" : "miss",
        reinjection_used: reinjectionUsed,
      },
      systemBlocks: systemBlockOrder,
      counts: {
        recentMessages: context.recentMessages.length,
        situationalContext: 0,
        supplementalContext: supplementalContext ? 1 : 0,
        rollingSummary: rollingSummary ? 1 : 0,
      },
      contextGovernor: governedContext.runtime,
      synapseSessionIngestOk,
      synapseSessionIngestError,
      timings,
    });
    console.log(
      "[chat.startbrief.trace]",
      JSON.stringify(tracePayload.startbrief_runtime)
    );
    console.log("[chat.trace]", JSON.stringify(tracePayload));

    // Return fast response
    const payload = NextResponse.json({
      transcript: sttResult.transcript,
      response: llmResponse.content,
      audioUrl: ttsResult.audioUrl,
      timing: {
        stt_ms: timings.stt_ms,
        llm_ms: timings.llm_ms,
        tts_ms: timings.tts_ms,
        total_ms: timings.total_ms,
      },
      requestId,
      ...(debugPayload ? { debug: debugPayload } : {}),
    });

    return payload;

  } catch (error) {
    console.error("Chat API Error:", { requestId, traceId, error });
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Internal server error",
        requestId 
      },
      { status: 500 }
    );
  }
}

function fireAndForgetSynapseIngest(params: {
  requestId: string;
  userId: string;
  personaId: string;
  sessionId: string;
  transcript: string;
  assistantText: string;
}) {
  const { requestId, userId, personaId, sessionId, transcript, assistantText } = params;
  const basePayload = {
    tenantId: env.SYNAPSE_TENANT_ID,
    userId,
    personaId,
    sessionId,
    metadata: { sessionId },
  };

  const getIngest = () => {
    const override = (globalThis as { __synapseIngestOverride?: typeof synapseClient.ingest })
      .__synapseIngestOverride;
    return typeof override === "function" ? override : synapseClient.ingest;
  };

  const ingestOne = (
    role: "user" | "assistant",
    text: string
  ) => {
    const start = Date.now();
    getIngest()({
        ...basePayload,
        role,
        text,
        timestamp: new Date().toISOString(),
      })
      .then((result) => {
        const ms = Date.now() - start;
        const status =
          result && typeof (result as { status?: number }).status === "number"
            ? (result as { status?: number }).status
            : null;
        console.log("[synapse.ingest]", {
          requestId,
          role,
          ms,
          status,
        });
      })
      .catch((error) => {
        console.warn("[synapse.ingest.error]", {
          requestId,
          role,
          error,
        });
      });
  };

  ingestOne("user", transcript);
  ingestOne("assistant", assistantText);
}

export const __test__fireAndForgetSynapseIngest = fireAndForgetSynapseIngest;

function getShadowJudge() {
  const override = (globalThis as { __processShadowPathOverride?: typeof processShadowPath })
    .__processShadowPathOverride;
  return typeof override === "function" ? override : processShadowPath;
}

function runShadowJudgeIfEnabled(params: Parameters<typeof processShadowPath>[0]) {
  const override = (globalThis as { __shadowJudgeFlagOverride?: boolean })
    .__shadowJudgeFlagOverride;
  const enabled =
    typeof override === "boolean" ? override : env.FEATURE_SHADOW_JUDGE === "true";
  if (!enabled) return;
  // SHADOW PATH: Process memory updates asynchronously
  // Note: In production, use waitUntil() from @vercel/functions
  // For v0.1, using Promise without await to simulate non-blocking
  getShadowJudge()(params).catch((error) => {
    console.error("Shadow path failed (non-blocking):", error);
  });
}

export const __test__runShadowJudgeIfEnabled = runShadowJudgeIfEnabled;
export const __test__runLibrarianReflex = runLibrarianReflex;
export const __test__buildChatMessages = buildChatMessages;
export const __test__buildChatTrace = buildChatTrace;
export const __test__shouldTriggerDailyFocus = shouldTriggerDailyFocus;
export const __test__isMorningLocalWindow = isMorningLocalWindow;
export const __test__shouldTriggerDailyReview = shouldTriggerDailyReview;
export const __test__isEveningWindow = isEveningWindow;
export const __test__isLateNightMomentumWindow = isLateNightMomentumWindow;
export const __test__buildMomentumGuardBlock = buildMomentumGuardBlock;
export const __test__extractTodayFocus = extractTodayFocus;
export const __test__normalizeMemoryQueryResponse = normalizeMemoryQueryResponse;
export const __test__extractCorrectionFactClaims = extractCorrectionFactClaims;
export const __test__mergeCorrectionFacts = mergeCorrectionFacts;
export const __test__nextCorrectionOverlayCooldownTurns = nextCorrectionOverlayCooldownTurns;
export const __test__shouldForceSessionWarmupOverlaySkip = shouldForceSessionWarmupOverlaySkip;
export const __test__shouldHoldOverlayUntilRunway = shouldHoldOverlayUntilRunway;
export const __test__buildCorrectionGuardBlock = buildCorrectionGuardBlock;
export const __test__buildSessionStartSituationalContext = buildSessionStartSituationalContext;
export const __test__buildDeferredProfileContextLines = buildDeferredProfileContextLines;
export const __test__extractLocalTurnSignalLine = extractLocalTurnSignalLine;
export const __test__selectUserContextCandidates = selectUserContextCandidates;
export const __test__updateRecentInjectedContextKeys = updateRecentInjectedContextKeys;
export const __test__resolvePolicySkipSelection = resolvePolicySkipSelection;
export const __test__nextWitnessHysteresisTurns = nextWitnessHysteresisTurns;
export const __test__buildStyleGuardBlock = buildStyleGuardBlock;
export const __test__nextEndearmentCooldownTurns = nextEndearmentCooldownTurns;
export const __test__buildStartbriefInjection = buildStartbriefInjection;
export const __test__shouldInjectOpsSnippet = shouldInjectOpsSnippet;
export const __test__shouldInjectSignalPack = shouldInjectSignalPack;
export const __test__buildContextGovernorSelection = buildContextGovernorSelection;
export const __test__applyOpsSupplementalMutualExclusion = applyOpsSupplementalMutualExclusion;
export const __test__deriveTurnConstraintsFromTranscript = deriveTurnConstraintsFromTranscript;
export const __test__resolveEffectiveOverlaySignals = resolveEffectiveOverlaySignals;
export const __test__shouldHoldWitnessOnContinuation = shouldHoldWitnessOnContinuation;
export const __test__evaluateTacticEligibility = evaluateTacticEligibility;
export const __test__applyCooldownPolicy = applyCooldownPolicy;
export const __test__buildBouncerAuthorityTraceFields = buildBouncerAuthorityTraceFields;
export const __test__resetPostureStateCache = () => {
  postureStateCache.clear();
};
export const __test__resetUserStateCache = () => {
  userStateCache.clear();
};
export const __test__resetOverlayStateCache = () => {
  overlayStateCache.clear();
};
