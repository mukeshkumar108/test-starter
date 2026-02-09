import { NextRequest, NextResponse } from "next/server";
import { auth, verifyToken } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { transcribeAudio } from "@/lib/services/voice/sttService";
import { generateResponse } from "@/lib/services/voice/llmService";
import { synthesizeSpeech } from "@/lib/services/voice/ttsService";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { autoCurateMaybe } from "@/lib/services/memory/memoryCurator";
import { ensureUserByClerkId } from "@/lib/user";
import { env } from "@/env";
import { getChatModelForPersona } from "@/lib/providers/models";
import { closeSessionOnExplicitEnd, closeStaleSessionIfAny, ensureActiveSession, maybeUpdateRollingSummary } from "@/lib/services/session/sessionService";
import * as synapseClient from "@/lib/services/synapseClient";

export const runtime = "nodejs";

interface ChatRequestBody {
  personaId: string;
  audioBlob: File;
}

const DEFAULT_LIBRARIAN_TIMEOUT_MS = 5000;
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

const DEFAULT_POSTURE: ConversationPosture = "COMPANION";
const DEFAULT_PRESSURE: ConversationPressure = "MED";
const DEFAULT_MOOD: UserMood = "NEUTRAL";
const DEFAULT_ENERGY: UserEnergy = "MED";
const DEFAULT_TONE: UserTone = "SERIOUS";

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

const postureStateCache = new Map<string, PostureState>();
const userStateCache = new Map<string, UserStateState>();

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
    "trust",
    "support",
    "help",
    "partner",
    "someone",
    "anyone",
    "something",
    "anything",
    "everything",
  ]);
  const stopwords = new Set(["you", "me", "we", "us", "our", "your", "i", "my"]);
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
  const hasConcrete = filtered.some((token) => !genericTokens.has(token.toLowerCase()));
  if (!hasConcrete) return null;
  return filtered.slice(0, 4).join(" ").slice(0, 48).trim();
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
"state_reason":"optional"}

Rules:
- explicit=true if the user directly asks to recall past info.
- action=memory_query if recall is needed.
- action=none if the user is only chatting about present/future.
- posture must be exactly one of the allowed enums (never multiple values or pipes).

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
  return {
    action,
    confidence,
    explicit,
    reason,
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
  if (remaining() <= 0) {
    return {
      supplementalContext: null,
      posture: DEFAULT_POSTURE,
      pressure: DEFAULT_PRESSURE,
      userState: null,
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
    };
  }

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
    };
  }

  if (shouldTrace) {
    try {
      await prisma.librarianTrace.create({
        data: {
          userId,
          personaId,
          sessionId,
          requestId,
          kind: "gate",
          transcript,
          bouncer: gateResult,
        },
      });
    } catch (error) {
      console.warn("[librarian.trace] failed to log gate", { error });
    }
  }

  if (remaining() <= 0) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
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
    };
  }
  if (remaining() <= 0) {
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
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
      };
    }

    if (remaining() <= 0) {
      return {
        supplementalContext: explicit ? `No matching memories found for "${sanitized}".` : null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
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
      };
    }

    const supplemental = buildRecallSheet({ query: sanitized, facts, entities });

    if (shouldTrace) {
      try {
        await prisma.librarianTrace.create({
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
        });
      } catch (error) {
        console.warn("[librarian.trace] failed to log librarian", { error });
      }
    }

    return {
      supplementalContext: supplemental,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("[librarian.query] timeout", { requestId });
      return {
        supplementalContext: null,
        posture: postureResult.posture,
        pressure: postureResult.pressure,
        userState: userStateResult,
      };
    }
    console.warn("[librarian.query] error", { requestId, error });
    return {
      supplementalContext: null,
      posture: postureResult.posture,
      pressure: postureResult.pressure,
      userState: userStateResult,
    };
  } finally {
    clearTimeout(queryTimeout);
  }
}

function buildChatMessages(params: {
  persona: string;
  situationalContext?: string;
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
    { role: "system" as const, content: styleGuard },
    { role: "system" as const, content: postureBlock },
    ...(situationalContext
      ? [{ role: "system" as const, content: `SITUATIONAL_CONTEXT:\n${situationalContext}` }]
      : []),
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
    let stt_ms = 0;
    let llm_ms = 0; 
    let tts_ms = 0;

    // Step 1: Speech-to-Text
    const sttResult = await transcribeAudio(audioFile, preferredLanguage || undefined);
    stt_ms = sttResult.duration_ms;

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
    const context = await buildContext(user.id, personaId, sttResult.transcript);

    // Step 3: Generate LLM response
    const rollingSummary = context.rollingSummary ?? "";
    const situationalContext = context.situationalContext ?? "";
    const shouldTraceLibrarian =
      env.FEATURE_LIBRARIAN_TRACE === "true" ||
      request.headers.get("x-debug-librarian") === "1";
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
    const supplementalContext = librarianResult?.supplementalContext ?? null;
    const posture = librarianResult?.posture ?? DEFAULT_POSTURE;
    const pressure = librarianResult?.pressure ?? DEFAULT_PRESSURE;
    const userState = librarianResult?.userState ?? null;
    const model = getChatModelForPersona(persona.slug);

    const messages = buildChatMessages({
      persona: context.persona,
      situationalContext,
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
          model,
        })
      );
    }

    console.log(
      "[chat.trace]",
      JSON.stringify({
        trace_id: traceId,
        userId: user.id,
        personaId,
        model,
        token_usage: null,
        counts: {
          recentMessages: context.recentMessages.length,
          situationalContext: situationalContext ? 1 : 0,
          supplementalContext: supplementalContext ? 1 : 0,
          rollingSummary: rollingSummary ? 1 : 0,
        },
      })
    );

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

    const llmResponse = await generateResponse(messages, persona.slug);
    llm_ms = llmResponse.duration_ms;

    // Step 4: Text-to-Speech
    const ttsResult = await synthesizeSpeech(llmResponse.content, persona.ttsVoiceId);
    tts_ms = ttsResult.duration_ms;

    const total_ms = Date.now() - totalStartTime;

    // Step 5: Store message with timing metadata
    await prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "user",
        content: sttResult.transcript,
        metadata: {
          stt_confidence: sttResult.confidence,
          stt_ms,
          total_ms,
          request_id: requestId,
        },
      },
    });

    await prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "assistant", 
        content: llmResponse.content,
        audioUrl: ttsResult.audioUrl,
        metadata: {
          llm_ms,
          tts_ms,
          total_ms,
          request_id: requestId,
        },
      },
    });

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

    if (isEndOfSessionIntent(sttResult.transcript)) {
      await closeSessionOnExplicitEnd(user.id, personaId, new Date());
    }

    // Return fast response
    return NextResponse.json({
      transcript: sttResult.transcript,
      response: llmResponse.content,
      audioUrl: ttsResult.audioUrl,
      timing: {
        stt_ms,
        llm_ms,
        tts_ms,
        total_ms,
      },
      requestId,
      ...(debugPayload ? { debug: debugPayload } : {}),
    });

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
export const __test__resetPostureStateCache = () => {
  postureStateCache.clear();
};
export const __test__resetUserStateCache = () => {
  userStateCache.clear();
};
