import { NextRequest, NextResponse } from "next/server";
import { auth, verifyToken } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { transcribeAudio } from "@/lib/services/voice/sttService";
import { generateResponse } from "@/lib/services/voice/llmService";
import { synthesizeSpeech } from "@/lib/services/voice/ttsService";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { loadOverlay, type OverlayType } from "@/lib/services/memory/overlayLoader";
import {
  isDismissal,
  isShortReply,
  isTopicShift,
  type OverlayIntent,
  normalizeTopicKey,
  selectOverlay,
  shouldSkipOverlaySelection,
} from "@/lib/services/memory/overlaySelector";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { autoCurateMaybe } from "@/lib/services/memory/memoryCurator";
import { ensureUserByClerkId } from "@/lib/user";
import { env } from "@/env";
import { getChatModelForGate } from "@/lib/providers/models";
import { closeSessionOnExplicitEnd, closeStaleSessionIfAny, ensureActiveSession, maybeUpdateRollingSummary } from "@/lib/services/session/sessionService";
import * as synapseClient from "@/lib/services/synapseClient";
import { readFile } from "fs/promises";
import { join } from "path";

export const runtime = "nodejs";

interface ChatRequestBody {
  personaId: string;
  audioBlob: File;
}

const DEFAULT_LIBRARIAN_TIMEOUT_MS = 5000;
const MIN_OPTIONAL_LIBRARIAN_STEP_MS = 300;
const DEFAULT_POSTURE_RESET_GAP_MINUTES = 180;
const DEFAULT_USER_STATE_RESET_GAP_MINUTES = 180;

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
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

function clampSessionFacts(value: string) {
  const lines = value
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (lines.length === 0) return "";
  const joined = lines.join(" | ");
  return joined.slice(0, 240).trim();
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

function isEndOfSessionIntent(transcript: string) {
  const lowered = transcript.toLowerCase();
  const patterns = [
    "bye",
    "talk later",
    "see you",
    "goodnight",
    "catch you later",
  ];
  return patterns.some((pattern) => lowered.includes(pattern));
}

type MemoryGateResult = {
  action: "memory_query" | "none";
  confidence: number;
  explicit: boolean;
  reason?: string | null;
  intent?: OverlayIntent;
  is_urgent?: boolean;
  is_direct_request?: boolean;
  posture?: "COMPANION" | "MOMENTUM" | "REFLECTION" | "RELATIONSHIP" | "IDEATION" | "RECOVERY" | "PRACTICAL";
  pressure?: "LOW" | "MED" | "HIGH";
  posture_confidence?: number;
  explicit_topic_shift?: boolean;
  posture_reason?: string | null;
  mood?: "CALM" | "NEUTRAL" | "LOW" | "UPBEAT" | "FRUSTRATED" | "OVERWHELMED" | "ANXIOUS";
  energy?: "LOW" | "MED" | "HIGH";
  tone?: "PLAYFUL" | "SERIOUS" | "TENDER" | "DIRECT";
  state_confidence?: number;
  explicit_state_shift?: boolean;
  state_reason?: string | null;
  risk_level?: "LOW" | "MED" | "HIGH" | "CRISIS";
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
};

type OverlayState = {
  overlayUsed?: OverlayUsed;
  overlayTypeActive?: OverlayType | null;
  overlayTurnCount?: number;
  lastSessionId?: string | null;
  pendingDismissType?: OverlayType | null;
  pendingTopicKey?: string | null;
  shortReplyStreak?: number;
  pendingFocusCapture?: boolean;
  pendingDailyReviewCapture?: boolean;
  pendingWeeklyCompassCapture?: boolean;
  user?: OverlayUserState;
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

const postureStateCache = new Map<string, PostureState>();
const userStateCache = new Map<string, UserStateState>();
const overlayStateCache = new Map<string, OverlayState>();
const userProfileCache = new Map<string, string>();

const PRODUCT_KERNEL_TRAJECTORY_BLOCK = `[PRODUCT_KERNEL]
Maintain trajectory continuity over time:
- Ensure a North Star, weekly focus, and today focus exist and stay current.
- Use ritual overlays for collection and refresh, not ad hoc branching in core behavior.
- Keep rituals light: one prompt, grounded language, practical next motion.`;

function buildChatTrace(params: {
  traceId: string;
  requestId: string;
  userId: string;
  personaId: string;
  sessionId: string;
  chosenModel: string;
  riskLevel: RiskLevel;
  intent: OverlayIntent;
  overlaySelected: OverlayType | "none";
  overlaySkipReason: string | null;
  counts: {
    recentMessages: number;
    situationalContext: number;
    supplementalContext: number;
    rollingSummary: number;
  };
  timings: ChatTimingSpans;
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
    overlaySelected: params.overlaySelected,
    overlaySkipReason: params.overlaySkipReason,
    token_usage: null,
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
  const overlayState = (state as Record<string, unknown>).overlayState;
  if (!overlayState || typeof overlayState !== "object" || Array.isArray(overlayState)) {
    return null;
  }
  const raw = overlayState as Record<string, unknown>;
  return {
    overlayUsed: typeof raw.overlayUsed === "object" && raw.overlayUsed && !Array.isArray(raw.overlayUsed)
      ? (raw.overlayUsed as OverlayUsed)
      : undefined,
    overlayTypeActive: typeof raw.overlayTypeActive === "string" ? (raw.overlayTypeActive as OverlayType) : null,
    overlayTurnCount: typeof raw.overlayTurnCount === "number" ? raw.overlayTurnCount : 0,
    lastSessionId: typeof raw.lastSessionId === "string" ? raw.lastSessionId : null,
    pendingDismissType: typeof raw.pendingDismissType === "string" ? (raw.pendingDismissType as OverlayType) : null,
    pendingTopicKey: typeof raw.pendingTopicKey === "string" ? raw.pendingTopicKey : null,
    shortReplyStreak: typeof raw.shortReplyStreak === "number" ? raw.shortReplyStreak : 0,
    pendingFocusCapture: typeof raw.pendingFocusCapture === "boolean" ? raw.pendingFocusCapture : false,
    pendingDailyReviewCapture:
      typeof raw.pendingDailyReviewCapture === "boolean" ? raw.pendingDailyReviewCapture : false,
    pendingWeeklyCompassCapture:
      typeof raw.pendingWeeklyCompassCapture === "boolean" ? raw.pendingWeeklyCompassCapture : false,
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
  facts?: Array<{ text?: string; relevance?: number | null; source?: string }>;
  entities?: Array<{ summary?: string; type?: string; uuid?: string }>;
  metadata?: { query?: string; facts?: number; entities?: number };
};

function buildRecallSheet(params: {
  query: string;
  facts: string[];
  entities: string[];
}) {
  const lines: string[] = [];
  lines.push(`Recall Sheet (query: ${params.query})`);
  if (params.facts.length > 0) {
    lines.push("Facts:");
    for (const fact of params.facts.slice(0, 5)) {
      lines.push(`- ${fact}`);
    }
  }
  if (params.entities.length > 0) {
    lines.push("Entities:");
    for (const entity of params.entities.slice(0, 5)) {
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 120,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!content) return null;
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runMemoryGate(params: {
  transcript: string;
  lastTurns: string;
  timeoutMs: number;
}) {
  const { transcript, lastTurns, timeoutMs } = params;
  const gatePrompt = `You are a Memory Gate. Decide if we should query memory.

Return ONLY valid JSON:
{"action":"memory_query"|"none","confidence":0-1,"explicit":true|false,"reason":"optional",
"intent":"companion|momentum|output_task|learning",
"is_urgent":true|false,
"is_direct_request":true|false,
"posture":"COMPANION|MOMENTUM|REFLECTION|RELATIONSHIP|IDEATION|RECOVERY|PRACTICAL",
"pressure":"LOW|MED|HIGH",
"posture_confidence":0-1,
"explicit_topic_shift":true|false,
"posture_reason":"optional",
"mood":"CALM|NEUTRAL|LOW|UPBEAT|FRUSTRATED|OVERWHELMED|ANXIOUS",
"energy":"LOW|MED|HIGH",
"tone":"PLAYFUL|SERIOUS|TENDER|DIRECT",
"state_confidence":0-1,
"explicit_state_shift":true|false,
"state_reason":"optional",
"risk_level":"LOW|MED|HIGH|CRISIS"}

Rules:
- explicit=true if the user directly asks to recall past info.
- action=memory_query if recall is needed.
- action=none if the user is only chatting about present/future.
- intent=output_task for explicit asks to produce/edit/fix/summarize output.
- intent=momentum for planning/prioritizing/focus/next-step coaching.
- intent=learning for explain/teach/understand requests.
- intent=companion for personal processing, reflection, or relational conversation.
- is_direct_request=true only when user explicitly asks for concrete output/work.
- is_urgent=true only for immediate urgency/crisis/time-critical support needs.
- posture must be exactly one of the allowed enums (never multiple values or pipes).
- risk_level=LOW for routine chat, MED for meaningful personal topics, HIGH for intense conflict/grief/major decisions, CRISIS for self-harm/abuse/violence/emergency.

Recent conversation:
${lastTurns}

Current user message:
${transcript}`;

  const result = await callOpenRouterJson(gatePrompt, "meta-llama/llama-3.1-8b-instruct", timeoutMs);
  if (!result) return null;
  const action = result.action === "memory_query" ? "memory_query" : "none";
  const confidence =
    typeof result.confidence === "number" && Number.isFinite(result.confidence)
      ? result.confidence
      : 0;
  const explicit = Boolean(result.explicit);
  const reason = typeof result.reason === "string" ? result.reason : null;
  const intent = typeof result.intent === "string" ? result.intent : undefined;
  const is_urgent = Boolean(result.is_urgent);
  const is_direct_request = Boolean(result.is_direct_request);
  const posture = typeof result.posture === "string" ? result.posture : undefined;
  const pressure = typeof result.pressure === "string" ? result.pressure : undefined;
  const posture_confidence =
    typeof result.posture_confidence === "number" && Number.isFinite(result.posture_confidence)
      ? result.posture_confidence
      : 0;
  const explicit_topic_shift = Boolean(result.explicit_topic_shift);
  const posture_reason =
    typeof result.posture_reason === "string" ? result.posture_reason : null;
  const mood = typeof result.mood === "string" ? result.mood : undefined;
  const energy = typeof result.energy === "string" ? result.energy : undefined;
  const tone = typeof result.tone === "string" ? result.tone : undefined;
  const state_confidence =
    typeof result.state_confidence === "number" && Number.isFinite(result.state_confidence)
      ? result.state_confidence
      : 0;
  const explicit_state_shift = Boolean(result.explicit_state_shift);
  const state_reason = typeof result.state_reason === "string" ? result.state_reason : null;
  const risk_level = typeof result.risk_level === "string" ? result.risk_level : undefined;
  return {
    action,
    confidence,
    explicit,
    reason,
    intent: normalizeGateIntent(intent),
    is_urgent,
    is_direct_request,
    posture: posture as MemoryGateResult["posture"],
    pressure: pressure as MemoryGateResult["pressure"],
    posture_confidence,
    explicit_topic_shift,
    posture_reason,
    mood: mood as MemoryGateResult["mood"],
    energy: energy as MemoryGateResult["energy"],
    tone: tone as MemoryGateResult["tone"],
    state_confidence,
    explicit_state_shift,
    state_reason,
    risk_level: normalizeRiskLevel(risk_level),
  } satisfies MemoryGateResult;
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
  const defaultGateSignals = {
    intent: DEFAULT_GATE_INTENT,
    isUrgent: false,
    isDirectRequest: false,
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
  const gateResult = await runMemoryGate({
    transcript,
    lastTurns,
    timeoutMs: remaining(),
  });
  if (!gateResult) {
    return {
      supplementalContext: null,
      posture: DEFAULT_POSTURE,
      pressure: DEFAULT_PRESSURE,
      userState: null,
      riskLevel: DEFAULT_RISK,
      ...defaultGateSignals,
    };
  }
  const gateSignals = {
    intent: gateResult.intent ?? DEFAULT_GATE_INTENT,
    isUrgent: Boolean(gateResult.is_urgent),
    isDirectRequest: Boolean(gateResult.is_direct_request),
  };

  const postureSuggestion = normalizePosture(gateResult.posture);
  const pressureSuggestion = normalizePressure(gateResult.pressure);
  const postureConfidence =
    typeof gateResult.posture_confidence === "number" ? gateResult.posture_confidence : 0;
  const explicitTopicShift = Boolean(gateResult.explicit_topic_shift);
  const moodSuggestion = normalizeMood(gateResult.mood);
  const energySuggestion = normalizeEnergy(gateResult.energy);
  const toneSuggestion = normalizeTone(gateResult.tone);
  const stateConfidence =
    typeof gateResult.state_confidence === "number" ? gateResult.state_confidence : 0;
  const explicitStateShift = Boolean(gateResult.explicit_state_shift);

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
  const explicit = gateResult.explicit || explicitSignal;
  const threshold = explicit ? 0.55 : 0.8;
  if (gateResult.action !== "memory_query" || gateResult.confidence < threshold) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
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
        bouncer: gateResult,
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
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }
  if (remaining() < MIN_OPTIONAL_LIBRARIAN_STEP_MS) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
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
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
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
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }
  if (remaining() <= 0) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  }
  if (remaining() < MIN_OPTIONAL_LIBRARIAN_STEP_MS) {
    return {
      supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
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
        riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }
    const data = (await response.json()) as MemoryQueryResponse;
    const facts = Array.isArray(data.facts)
      ? data.facts
          .map((fact) =>
            typeof fact?.text === "string" ? fact.text.trim() : ""
          )
          .filter(Boolean)
      : [];
    const entities = Array.isArray(data.entities)
      ? data.entities
          .map((entity) =>
            typeof entity?.summary === "string" ? entity.summary.trim() : ""
          )
          .filter(Boolean)
      : [];

    if (facts.length === 0 && entities.length === 0) {
      return {
        supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }

    if (remaining() <= 0) {
      return {
        supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }
    if (remaining() < MIN_OPTIONAL_LIBRARIAN_STEP_MS) {
      return {
        supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
        riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
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
        riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
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
          bouncer: gateResult,
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
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
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
        riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
        ...gateSignals,
      };
    }
    console.warn("[librarian.query] error", { requestId, error });
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
      riskLevel: gateResult.risk_level ?? DEFAULT_RISK,
      ...gateSignals,
    };
  } finally {
    clearTimeout(queryTimeout);
  }
}

function buildChatMessages(params: {
  persona: string;
  productKernelBlock?: string | null;
  userProfileBlock?: string | null;
  situationalContext?: string;
  continuityBlock?: string | null;
  overlayBlock?: string | null;
  supplementalContext?: string | null;
  rollingSummary?: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string;
  posture?: ConversationPosture;
  pressure?: ConversationPressure;
  userState?: { mood: UserMood; energy: UserEnergy; tone: UserTone } | null;
}) {
  const situationalContext = params.situationalContext ?? "";
  const rollingSummary = params.rollingSummary ?? "";
  const posture = params.posture ?? DEFAULT_POSTURE;
  const pressure = params.pressure ?? DEFAULT_PRESSURE;
  const guidance = POSTURE_GUIDANCE[posture] ?? POSTURE_GUIDANCE[DEFAULT_POSTURE];
  const postureBlock = `[CONVERSATION_POSTURE]\nMode: ${posture} (pressure: ${pressure})\nLean: ${guidance}`;
  const styleGuard =
    "Avoid therapeutic mirroring; don’t restate the user’s feelings unless they explicitly asked for reflection.";
  const sessionFacts = rollingSummary ? clampSessionFacts(rollingSummary) : "";
  return [
    { role: "system" as const, content: params.persona },
    ...(params.productKernelBlock
      ? [{ role: "system" as const, content: params.productKernelBlock }]
      : []),
    ...(params.userProfileBlock ? [{ role: "system" as const, content: params.userProfileBlock }] : []),
    { role: "system" as const, content: styleGuard },
    { role: "system" as const, content: postureBlock },
    ...(situationalContext
      ? [{ role: "system" as const, content: `SITUATIONAL_CONTEXT:\n${situationalContext}` }]
      : []),
    ...(params.continuityBlock
      ? [{ role: "system" as const, content: params.continuityBlock }]
      : []),
    ...(params.overlayBlock ? [{ role: "system" as const, content: params.overlayBlock }] : []),
    ...(params.supplementalContext
      ? [
          {
            role: "system" as const,
            content: `[SUPPLEMENTAL_CONTEXT]\n${params.supplementalContext}`,
          },
        ]
      : []),
    ...(sessionFacts
      ? [{ role: "system" as const, content: `SESSION FACTS: ${sessionFacts}` }]
      : []),
    ...params.recentMessages,
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
  return hour >= 18 || hour < 2;
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

function isMukeshUser(user: { clerkUserId?: string | null; email?: string | null }) {
  const targets = [user.clerkUserId ?? "", user.email ?? ""].map((value) => value.toLowerCase());
  return targets.some((value) => value.includes("mukesh"));
}

async function loadUserProfileBlockIfEligible(params: {
  user: { clerkUserId?: string | null; email?: string | null };
  personaId: string;
  personaSlug: string;
}) {
  const personaLooksMukesh = params.personaId.toLowerCase().includes("mukesh");
  if (params.personaSlug !== "creative" && !personaLooksMukesh) return null;
  if (!personaLooksMukesh && !isMukeshUser(params.user)) return null;

  const cacheKey = "mukesh.config.md";
  const cached = userProfileCache.get(cacheKey);
  if (cached) return cached;

  const path = join(process.cwd(), "src/personas/config/mukesh.config.md");
  const file = (await readFile(path, "utf-8")).trim();
  const block = `[USER_PROFILE]\n${file}`;
  userProfileCache.set(cacheKey, block);
  return block;
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
    await closeStaleSessionIfAny(user.id, personaId, now);
    const session = await ensureActiveSession(user.id, personaId, now);

    // Step 2: Build conversation context
    const contextStart = Date.now();
    const context = await buildContext(user.id, personaId, sttResult.transcript);
    timings.context_ms = Date.now() - contextStart;

    // Step 3: Generate LLM response
    const rollingSummary = context.rollingSummary ?? "";
    const situationalContext = context.situationalContext ?? "";
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
    const pressure = librarianResult?.pressure ?? DEFAULT_PRESSURE;
    const userState = librarianResult?.userState ?? null;
    const riskLevel = librarianResult?.riskLevel ?? DEFAULT_RISK;
    const overlayIntent = librarianResult?.intent ?? DEFAULT_GATE_INTENT;
    const overlayIsUrgent = librarianResult?.isUrgent ?? false;
    const overlayIsDirectRequest = librarianResult?.isDirectRequest ?? false;
    const model = getChatModelForGate({
      personaId: persona.slug,
      gate: { risk_level: riskLevel },
    });
    const timeGapMinutes = computeTimeGapMinutes(context.recentMessages, now);
    const continuityBlock = buildContinuityBlock({
      timeGapMinutes,
      transcript: sttResult.transcript,
    });

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
    }

    let overlayType: OverlayType | "none" = "none";
    let overlayTriggerReason = "none";
    let overlayExitReason: "cap" | "dismiss" | "topicShift" | "helpRequest" | "lowEnergy" | "policy" | "none" =
      "none";
    let overlayTopicKey: string | undefined;
    const overlayPolicy = shouldSkipOverlaySelection({
      intent: overlayIntent,
      isUrgent: overlayIsUrgent,
      isDirectRequest: overlayIsDirectRequest,
    });
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

    if (overlayPolicy.skip) {
      overlayTriggerReason = `policy_skip_${overlayPolicy.reason}`;
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

    if (!overlayPolicy.skip && overlayTypeActive === "curiosity_spiral") {
      if (overlayTurnCount < 4) {
        overlayType = "curiosity_spiral";
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
        openLoops: context.overlayContext?.openLoops,
        commitments: context.overlayContext?.commitments,
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
      overlayType = decision.overlayType;
      overlayTriggerReason = decision.triggerReason;
      overlayTopicKey = decision.topicKey;

      if (overlayType === "curiosity_spiral") {
        overlayTypeActive = "curiosity_spiral";
        overlayTurnCount = 1;
        shortReplyStreak = 0;
        overlayUsed = { ...overlayUsed, curiositySpiral: true };
      }
      if (overlayType === "accountability_tug" && overlayTopicKey) {
        const normalized = normalizeTopicKey(overlayTopicKey);
        overlayTopicKey = normalized;
        overlayUsed = { ...overlayUsed, accountabilityTug: true };
        overlayUser.lastTugAt = now.toISOString();
        pendingDismissType = "accountability_tug";
        pendingTopicKey = normalized;
      }
      if (overlayType === "daily_focus") {
        overlayUsed = { ...overlayUsed, dailyFocus: true };
        pendingFocusCapture = true;
        overlayUser.lastDailyFocusAt = now.toISOString();
      }
      if (overlayType === "daily_review") {
        overlayUsed = { ...overlayUsed, dailyReview: true };
        pendingDailyReviewCapture = true;
      }
      if (overlayType === "weekly_compass") {
        overlayUsed = { ...overlayUsed, weeklyCompass: true };
        pendingWeeklyCompassCapture = true;
      }
    }

    let overlayBlock: string | null = null;
    if (overlayType !== "none") {
      const overlayText = await loadOverlay(overlayType);
      overlayBlock = `[OVERLAY]\n${overlayText}`;
    }

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
            overlayTriggered: overlayType,
            triggerReason: overlayTriggerReason,
            overlayTurnCount,
            overlayExitReason,
            topicKey: overlayTopicKey ?? null,
          },
        },
      }).catch((error) => {
        console.warn("[librarian.trace] failed to log overlay", { error });
      });
    }
    timings.overlay_ms = Date.now() - overlayStart;

    const messages = buildChatMessages({
      persona: context.persona,
      productKernelBlock: PRODUCT_KERNEL_TRAJECTORY_BLOCK,
      userProfileBlock: await loadUserProfileBlockIfEligible({
        user: { clerkUserId: user.clerkUserId, email: user.email },
        personaId,
        personaSlug: persona.slug,
      }),
      situationalContext,
      continuityBlock,
      overlayBlock,
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
            situationalContext: situationalContext ? 1 : 0,
            supplementalContext: supplementalContext ? 1 : 0,
            rollingSummary: rollingSummary ? 1 : 0,
          },
          chosenModel: model,
          risk_level: riskLevel,
          intent: overlayIntent,
          overlaySelected: overlayType,
          overlaySkipReason,
        })
      );
    }

    const debugEnabled =
      env.FEATURE_CONTEXT_DEBUG === "true" &&
      request.headers.get("x-debug-context") === "1";

    let debugPayload: Record<string, unknown> | undefined;
    if (debugEnabled) {
      debugPayload = {
        contextBlocks: {
          persona: context.persona,
          situationalContext,
          supplementalContext,
          rollingSummary,
        },
      };
    }

    const llmResponse = await generateResponse(messages, persona.slug, model);
    timings.llm_ms = llmResponse.duration_ms;

    // Step 4: Text-to-Speech
    const ttsResult = await synthesizeSpeech(llmResponse.content, persona.ttsVoiceId);
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

    const shouldCloseSession = isEndOfSessionIntent(sttResult.transcript);

    const tracePayload = buildChatTrace({
      traceId,
      requestId,
      userId: user.id,
      personaId,
      sessionId: session.id,
      chosenModel: model,
      riskLevel,
      intent: overlayIntent,
      overlaySelected: overlayType,
      overlaySkipReason,
      counts: {
        recentMessages: context.recentMessages.length,
        situationalContext: situationalContext ? 1 : 0,
        supplementalContext: supplementalContext ? 1 : 0,
        rollingSummary: rollingSummary ? 1 : 0,
      },
      timings,
    });
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

    if (shouldCloseSession) {
      void closeSessionOnExplicitEnd(user.id, personaId, new Date()).catch((error) => {
        console.warn("[session.close.err]", { userId: user.id, personaId, requestId, error });
      });
    }

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
export const __test__extractTodayFocus = extractTodayFocus;
export const __test__resetPostureStateCache = () => {
  postureStateCache.clear();
};
export const __test__resetUserStateCache = () => {
  userStateCache.clear();
};
