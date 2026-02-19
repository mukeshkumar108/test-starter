import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import * as synapseClient from "@/lib/services/synapseClient";
import type {
  SynapseBriefResponse,
  SynapseDailyAnalysisResponse,
  SynapseMemoryLoopItem,
  SynapseMemoryLoopsResponse,
  SynapseStartBriefResponse,
  SynapseUserModelResponse,
} from "@/lib/services/synapseClient";
import { queryRouter, type QueryRouterResult } from "@/lib/services/queryRouter";
import { loadPersonaPrompt } from "@/lib/prompts/personaPromptLoader";

export interface ConversationContext {
  persona: string;
  situationalContext?: string;
  rollingSummary?: string;
  startBrief?: {
    used: boolean;
    fallback: "session/brief" | null;
    itemsCount: number;
    bridgeTextChars: number;
  };
  overlayContext?: {
    openLoops?: string[];
    commitments?: string[];
    currentFocus?: string;
    weeklyNorthStar?: string;
    hasHighPriorityLoop?: boolean;
  };
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }>;
  /** True if this is the first turn of a new session (for conditional SessionSummary injection) */
  isSessionStart: boolean;
}

const MAX_RECENT_MESSAGE_CHARS = 800;
const BRIEF_CACHE_TTL_MS = 3 * 60 * 1000;
const OVERLAY_CONTEXT_CAP = 3;
const OVERLAY_ITEM_MAX_WORDS = 12;
const ROLLING_SUMMARY_SESSION_KEY = "rollingSummarySessionId";
const START_BRIEF_SESSION_KEY = "startBriefSessionId";
const START_BRIEF_DATA_KEY = "startBriefData";
const USER_MODEL_SESSION_KEY = "userModelSessionId";
const USER_MODEL_DATA_KEY = "userModelData";
const DAILY_ANALYSIS_SESSION_KEY = "dailyAnalysisSessionId";
const DAILY_ANALYSIS_DATA_KEY = "dailyAnalysisData";
const briefCache = new Map<
  string,
  { fetchedAt: number; brief: SynapseBriefResponse }
>();

type SessionWindow = { startedAt: Date; endedAt: Date | null };

function limitWords(input: string, maxWords: number) {
  return input.trim().split(/\s+/).slice(0, maxWords).join(" ");
}

function heuristicQuery(transcript: string) {
  const lowered = transcript.toLowerCase();
  const triggers = [
    "remember",
    "remind",
    "what did we",
    "did i tell you",
    "last time",
  ];
  if (triggers.some((phrase) => lowered.includes(phrase))) {
    return limitWords(transcript, 8);
  }

  return null;
}

function getQueryRouter() {
  const override = (globalThis as { __queryRouterOverride?: typeof queryRouter })
    .__queryRouterOverride;
  return typeof override === "function" ? override : queryRouter;
}

function buildSessionWindowWhere(window?: SessionWindow | null) {
  if (!window) return {};
  return {
    createdAt: {
      gte: window.startedAt,
      ...(window.endedAt ? { lte: window.endedAt } : {}),
    },
  };
}

async function getSessionWindow(sessionId: string): Promise<SessionWindow | null> {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { startedAt: true, endedAt: true },
  });
  if (!session) return null;
  return {
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}

async function getRecentSessionMessages(userId: string, personaId: string, sessionId: string) {
  const window = await getSessionWindow(sessionId);
  return prisma.message.findMany({
    where: {
      userId,
      personaId,
      ...buildSessionWindowWhere(window),
    },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      role: true,
      content: true,
      createdAt: true,
    },
  });
}

function getLastAssistantTurn(
  messages: Array<{ role: "user" | "assistant"; content: string }>
) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return messages[i].content;
  }
  return null;
}

function getRecentTurns(
  messages: Array<{ role: "user" | "assistant"; content: string }>
) {
  const turns: Array<{ user?: string; assistant?: string }> = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant") {
      turns.push({ assistant: message.content });
      continue;
    }
    if (turns.length === 0 || turns[turns.length - 1].user) {
      turns.push({ user: message.content });
    } else {
      turns[turns.length - 1].user = message.content;
    }
  }
  return turns
    .filter((turn) => Boolean(turn.user || turn.assistant))
    .slice(0, 2)
    .reverse();
}

function sanitizeQuery(value: string) {
  let cleaned = value.trim();
  cleaned = cleaned.replace(/^["']+|["']+$/g, "");
  cleaned = cleaned.replace(/[^\w\s]+/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const words = cleaned.split(" ").slice(0, 8).join(" ");
  if (!words) return null;
  return words.slice(0, 48).trim() || null;
}

function extractQueryCandidates(transcript: string) {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const tokens = transcript.match(/\b[A-Za-z][A-Za-z'-]*\b/g) || [];
  const stopTokens = new Set(["I", "Ok", "OK"]);
  const relationshipNouns = new Set([
    "girlfriend",
    "wife",
    "partner",
    "kids",
    "children",
    "brother",
    "sister",
    "mom",
    "dad",
  ]);

  const capitalized: string[] = [];
  const relationships: string[] = [];
  for (const token of tokens) {
    if (stopTokens.has(token)) continue;
    if (relationshipNouns.has(token.toLowerCase())) {
      relationships.push(token.toLowerCase());
    }
    if (/^[A-Z][a-zA-Z'-]+$/.test(token) && token.length >= 3) {
      capitalized.push(token);
    }
  }

  const primaryPerson = capitalized[0];
  const primaryLocation = capitalized[1];
  const relationshipPriority = ["kids", "children"];
  const primaryRelationship =
    relationships.find((rel) => relationshipPriority.includes(rel)) ?? relationships[0];

  const pushCandidate = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  if (primaryPerson && primaryRelationship) {
    pushCandidate(`${primaryPerson} ${primaryRelationship}`);
  }
  if (primaryPerson && primaryLocation) {
    pushCandidate(`${primaryPerson} ${primaryLocation}`);
  }
  if (primaryPerson) {
    pushCandidate(primaryPerson);
  }

  return candidates.slice(0, 3);
}

function isValidQuery(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length > 48) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 1 || words.length > 6) return false;

  const lowered = trimmed.toLowerCase();
  const rejectedPhrases = [
    "i want you to",
    "can you",
    "please",
    "a few other things",
  ];
  if (rejectedPhrases.some((phrase) => lowered.includes(phrase))) return false;

  const endStop = new Set(["to", "you"]);
  if (endStop.has(words[words.length - 1].toLowerCase())) return false;

  const stopwords = new Set([
    "i",
    "you",
    "to",
    "a",
    "an",
    "the",
    "and",
    "or",
    "of",
    "in",
    "on",
    "for",
    "with",
    "my",
    "your",
    "we",
    "us",
  ]);
  const hasNonStopword = words.some((word) => !stopwords.has(word.toLowerCase()));
  if (!hasNonStopword) return false;

  return true;
}

type ActiveLoopEntry = { text?: string; label?: string } | string;

function normalizeLoopText(loop: ActiveLoopEntry) {
  if (typeof loop === "string") return loop.trim();
  if (!loop || typeof loop !== "object") return null;
  const text = typeof loop.text === "string" ? loop.text.trim() : "";
  const label = typeof loop.label === "string" ? loop.label.trim() : "";
  return text || label || null;
}

function normalizeFact(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function formatTimeNowUTC() {
  const now = new Date();
  const hours = now.getUTCHours();
  const minutes = now.getUTCMinutes();
  const padded = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  let label: string;
  if (hours >= 5 && hours < 10) {
    label = "MORNING";
  } else if (hours >= 10 && hours < 12) {
    label = "LATE MORNING";
  } else if (hours >= 12 && hours < 14) {
    label = "LUNCHTIME";
  } else if (hours >= 14 && hours < 18) {
    label = "AFTERNOON";
  } else if (hours >= 18 && hours < 22) {
    label = "EVENING";
  } else if (hours >= 22 || hours < 2) {
    label = "LATE NIGHT";
  } else {
    label = "NIGHT";
  }
  return `Time Now: ${padded} UTC — ${label}`;
}

function uniqueLimited(values: Array<string | null | undefined>, limit: number) {
  const cleaned = values
    .map((value) => (typeof value === "string" ? normalizeFact(value) : null))
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(cleaned)).slice(0, limit);
}

function toOverlayItem(value: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const words = trimmed.split(" ").slice(0, OVERLAY_ITEM_MAX_WORDS);
  return words.join(" ");
}

function buildOverlayItems(
  values: Array<string | null | undefined>,
  recentMessages: Array<{ content: string }>
) {
  const items = values
    .map((value, index) => {
      if (typeof value !== "string") return null;
      const normalized = toOverlayItem(value);
      if (!normalized) return null;
      return {
        value: normalized,
        lowered: normalized.toLowerCase(),
        index,
      };
    })
    .filter((item): item is { value: string; lowered: string; index: number } => Boolean(item));

  const deduped: Array<{ value: string; lowered: string; index: number }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.lowered)) continue;
    seen.add(item.lowered);
    deduped.push(item);
  }

  const loweredMessages = recentMessages.map((message) => message.content.toLowerCase());

  const ranked = deduped
    .map((item) => {
      let mentionIndex: number | null = null;
      for (let i = 0; i < loweredMessages.length; i += 1) {
        if (loweredMessages[i].includes(item.lowered)) {
          mentionIndex = i;
          break;
        }
      }
      return { ...item, mentionIndex };
    })
    .sort((a, b) => {
      const aMentioned = a.mentionIndex !== null;
      const bMentioned = b.mentionIndex !== null;
      if (aMentioned !== bMentioned) return aMentioned ? -1 : 1;
      if (aMentioned && bMentioned && a.mentionIndex !== b.mentionIndex) {
        return (a.mentionIndex ?? 0) - (b.mentionIndex ?? 0);
      }
      return a.index - b.index;
    });

  return ranked.slice(0, OVERLAY_CONTEXT_CAP).map((item) => item.value);
}

function buildSituationalContext(brief: SynapseBriefResponse) {
  const parts: string[] = [];
  const facts = uniqueLimited(brief.facts ?? [], 2);
  if (facts.length > 0) {
    parts.push(`FACTS:\n- ${facts.join("\n- ")}`);
  }
  const openLoops = uniqueLimited(brief.openLoops ?? [], 1);
  if (openLoops.length > 0) {
    parts.push(`OPEN_LOOPS:\n- ${openLoops.join("\n- ")}`);
  }
  const commitments = uniqueLimited(brief.commitments ?? [], 1);
  if (commitments.length > 0) {
    parts.push(`COMMITMENTS:\n- ${commitments.join("\n- ")}`);
  }
  const timeGap =
    brief.contextAnchors?.timeGapDescription ??
    (brief.timeGapDescription && brief.timeGapDescription.trim()
      ? brief.timeGapDescription.trim()
      : null);
  if (timeGap) {
    parts.push(`Time Gap: ${timeGap}`);
  }
  const timeLabel =
    brief.contextAnchors?.timeOfDayLabel ??
    (brief.timeOfDayLabel && brief.timeOfDayLabel.trim()
      ? brief.timeOfDayLabel.trim()
      : null);
  if (timeLabel) {
    parts.push(`Time: ${timeLabel}`);
  }
  const loops = Array.isArray(brief.activeLoops) ? brief.activeLoops : [];
  const loopTexts = loops
    .map((loop) => normalizeLoopText(loop))
    .filter((value): value is string => Boolean(value));
  if (loopTexts.length > 0) {
    const uniqueLoops = Array.from(new Set(loopTexts));
    parts.push(`Tensions:\n- ${uniqueLoops.join("\n- ")}`);
  }
  if (brief.currentFocus && brief.currentFocus.trim()) {
    parts.push(`CURRENT_FOCUS:\n- ${brief.currentFocus.trim()}`);
  }
  parts.push(formatTimeNowUTC());
  const uniqueParts = Array.from(new Set(parts));
  return uniqueParts.length > 0 ? uniqueParts.join("\n") : null;
}

function buildSessionStartContext(
  brief: SynapseStartBriefResponse,
  trajectory?: { todayFocus?: string | null; weeklyNorthStar?: string | null } | null,
  userModelLines?: string[],
  dailyAnalysis?: SynapseDailyAnalysisResponse | null
) {
  const lines: string[] = [];
  const timeLabel = typeof brief.timeOfDayLabel === "string" ? brief.timeOfDayLabel.trim() : "";
  const timeGap = typeof brief.timeGapHuman === "string" ? brief.timeGapHuman.trim() : "";
  const timeLineParts: string[] = [];
  if (timeLabel) timeLineParts.push(timeLabel);
  if (timeGap) timeLineParts.push(timeGap);
  if (timeLineParts.length > 0) {
    lines.push(`Session start context: ${timeLineParts.join(" • ")}.`);
  }

  const bridgeText = typeof brief.bridgeText === "string" ? brief.bridgeText.trim() : "";
  if (bridgeText) lines.push(bridgeText);

  const dailyLines = buildDailyAnalysisLines(bridgeText, dailyAnalysis);
  if (dailyLines.length > 0) {
    lines.push(...dailyLines);
  }

  if (Array.isArray(userModelLines) && userModelLines.length > 0) {
    lines.push(...userModelLines);
  }

  const items = Array.isArray(brief.items) ? brief.items : [];
  const loops = items
    .filter((item) => (item?.kind ?? "").toLowerCase() === "loop")
    .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
    .filter(Boolean)
    .slice(0, 5);
  if (loops.length > 0) {
    lines.push(`Active threads: ${loops.join(" | ")}`);
  }

  const tensions = items
    .filter((item) => (item?.kind ?? "").toLowerCase() === "tension")
    .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
    .filter(Boolean)
    .slice(0, 2);
  if (tensions.length > 0) {
    lines.push(`Durable tensions: ${tensions.join(" | ")}`);
  }

  const focus = trajectory?.todayFocus?.trim();
  if (focus) {
    lines.push(`CURRENT_FOCUS:\n- ${focus}`);
  }
  const weekly = trajectory?.weeklyNorthStar?.trim();
  if (weekly) {
    lines.push(`WEEKLY_NORTH_STAR:\n- ${weekly}`);
  }

  const compact = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
  return compact.length > 0 ? compact.join("\n") : null;
}

function getOverlayContextFromStartBrief(
  brief: SynapseStartBriefResponse,
  recentMessages: Array<{ content: string }>,
  trajectory?: { todayFocus?: string | null; weeklyNorthStar?: string | null } | null
) {
  const items = Array.isArray(brief.items) ? brief.items : [];
  const loopItems = items
    .filter((item) => (item?.kind ?? "").toLowerCase() === "loop")
    .map((item) => (typeof item?.text === "string" ? item.text.trim() : null))
    .filter((item): item is string => Boolean(item));
  const commitmentItems = items
    .filter(
      (item) =>
        (item?.kind ?? "").toLowerCase() === "loop" &&
        typeof item?.type === "string" &&
        item.type.toLowerCase().includes("commit")
    )
    .map((item) => (typeof item?.text === "string" ? item.text.trim() : null))
    .filter((item): item is string => Boolean(item));

  return {
    openLoops: buildOverlayItems(loopItems, recentMessages),
    commitments: buildOverlayItems(commitmentItems, recentMessages),
    currentFocus: trajectory?.todayFocus ?? undefined,
    weeklyNorthStar: trajectory?.weeklyNorthStar ?? undefined,
    hasHighPriorityLoop: false,
  };
}

function getOverlayContextFromMemoryLoops(
  loops: SynapseMemoryLoopItem[],
  recentMessages: Array<{ content: string }>,
  trajectory?: { todayFocus?: string | null; weeklyNorthStar?: string | null } | null
) {
  const openLoopItems = loops
    .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
    .filter(Boolean);
  const commitmentItems = loops
    .filter((item) => (item.type ?? "").toLowerCase() === "commitment")
    .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
    .filter(Boolean);
  const hasHighPriorityLoop = loops.some(
    (item) => (item.urgency ?? 0) >= 4 && (item.importance ?? 0) >= 4
  );
  return {
    openLoops: buildOverlayItems(openLoopItems, recentMessages),
    commitments: buildOverlayItems(commitmentItems, recentMessages),
    currentFocus: trajectory?.todayFocus ?? undefined,
    weeklyNorthStar: trajectory?.weeklyNorthStar ?? undefined,
    hasHighPriorityLoop,
  };
}

function getZonedParts(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  });
  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = Number.parseInt(get("year"), 10);
  const month = Number.parseInt(get("month"), 10);
  const day = Number.parseInt(get("day"), 10);
  return {
    dayKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    weekday: get("weekday").toLowerCase(),
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

function getTrajectoryStateFromSession(state: unknown, now: Date, timeZone: string) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const overlayState = (state as Record<string, unknown>).overlayState;
  if (!overlayState || typeof overlayState !== "object" || Array.isArray(overlayState)) return null;
  const user = (overlayState as Record<string, unknown>).user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const values = user as Record<string, unknown>;
  const zoned = getZonedParts(now, timeZone);
  const weekStart = getWeekStartKey(zoned.dayKey, zoned.weekday);

  const todayFocus =
    typeof values.todayFocus === "string" &&
    values.todayFocus.trim() &&
    values.todayFocusDate === zoned.dayKey
      ? values.todayFocus.trim()
      : null;
  const weeklyNorthStar =
    typeof values.weeklyNorthStar === "string" &&
    values.weeklyNorthStar.trim() &&
    values.weeklyNorthStarWeekStartDate === weekStart
      ? values.weeklyNorthStar.trim()
      : null;

  if (!todayFocus && !weeklyNorthStar) return null;
  return { todayFocus, weeklyNorthStar };
}

function asStateRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getRollingSummaryForSession(
  sessionState: { rollingSummary?: string | null; state?: unknown } | null | undefined,
  sessionId: string
) {
  if (!sessionState?.rollingSummary) return undefined;
  if (!sessionId) return undefined;
  const scopedSessionId = asStateRecord(sessionState.state)[ROLLING_SUMMARY_SESSION_KEY];
  if (typeof scopedSessionId !== "string" || !scopedSessionId.trim()) return undefined;
  if (scopedSessionId !== sessionId) return undefined;
  return sessionState.rollingSummary;
}

function getStartBriefForSession(state: unknown, sessionId: string) {
  if (!sessionId) return null;
  const scoped = asStateRecord(state)[START_BRIEF_SESSION_KEY];
  if (typeof scoped !== "string" || scoped !== sessionId) return null;
  const raw = asStateRecord(state)[START_BRIEF_DATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as SynapseStartBriefResponse;
}

function withStartBriefForSession(
  state: unknown,
  sessionId: string,
  brief: SynapseStartBriefResponse
) {
  const base = asStateRecord(state);
  return {
    ...base,
    [START_BRIEF_SESSION_KEY]: sessionId,
    [START_BRIEF_DATA_KEY]: brief,
  };
}

function getSynapseBrief() {
  const override = (globalThis as { __synapseBriefOverride?: typeof synapseClient.sessionBrief })
    .__synapseBriefOverride;
  return typeof override === "function" ? override : synapseClient.sessionBrief;
}

function getSynapseStartBrief() {
  const override = (globalThis as { __synapseStartBriefOverride?: typeof synapseClient.sessionStartBrief })
    .__synapseStartBriefOverride;
  return typeof override === "function" ? override : synapseClient.sessionStartBrief;
}

function getSynapseMemoryLoops() {
  const override = (globalThis as { __synapseMemoryLoopsOverride?: typeof synapseClient.memoryLoops })
    .__synapseMemoryLoopsOverride;
  return typeof override === "function" ? override : synapseClient.memoryLoops;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toScoreValue(
  score: Record<string, number> | null | undefined,
  key: "relationships" | "work" | "north_star" | "health" | "spirituality" | "general"
) {
  const value = score?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = value.text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const fallbacks = ["summary", "focus", "goal", "description", "notes"];
  for (const key of fallbacks) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function sourceRank(source: unknown) {
  if (source === "user_stated") return 2;
  if (source === "manual") return 1;
  return 0;
}

function confidenceValue(value: unknown) {
  if (!isRecord(value)) return 0;
  const confidence = value.confidence;
  return typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0;
}

function asQualityFlag(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "needs_review") return "needs_review";
  if (normalized === "insufficient_data") return "insufficient_data";
  return normalized;
}

function toScore1to5(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1 || value > 5) return null;
  return Math.round(value * 10) / 10;
}

function isDailyAnalysisLowConfidence(analysis: SynapseDailyAnalysisResponse) {
  const qualityFlag = asQualityFlag(analysis.metadata?.quality_flag);
  return qualityFlag === "needs_review" || qualityFlag === "insufficient_data";
}

function hasTruncatedBridgeText(text: string) {
  return text.endsWith("...") || text.length < 40;
}

function shouldInjectDailyAnalysis(bridgeText: string, analysis: SynapseDailyAnalysisResponse) {
  const hasBridge = Boolean(bridgeText);
  if (!hasBridge) return true;
  if (hasTruncatedBridgeText(bridgeText)) return true;
  return isDailyAnalysisLowConfidence(analysis);
}

function buildDailyAnalysisLines(
  bridgeText: string,
  analysis?: SynapseDailyAnalysisResponse | null
) {
  if (!analysis || analysis.exists === false) return [] as string[];
  if (!shouldInjectDailyAnalysis(bridgeText, analysis)) return [] as string[];

  const steering =
    typeof analysis.steeringNote === "string" && analysis.steeringNote.trim()
      ? analysis.steeringNote.trim()
      : null;
  const themes = Array.isArray(analysis.themes)
    ? analysis.themes
        .map((theme) => (typeof theme === "string" ? theme.trim() : ""))
        .filter(Boolean)
        .slice(0, 2)
    : [];
  // Keep score + quality fields parsed for telemetry, but do not surface
  // numeric or quality labels in model-facing prompt context.
  void toScore1to5(analysis.scores?.curiosity);
  void toScore1to5(analysis.scores?.warmth);
  void toScore1to5(analysis.scores?.usefulness);
  void toScore1to5(analysis.scores?.forward_motion);
  void asQualityFlag(analysis.metadata?.quality_flag);
  const lowConfidence = isDailyAnalysisLowConfidence(analysis);

  const lines: string[] = [];
  if (steering) {
    lines.push(
      lowConfidence ? `Daily steering (low confidence): ${steering}` : `Daily steering: ${steering}`
    );
  }
  if (themes.length > 0) {
    lines.push(`Today's patterns: ${themes.join("; ")}`);
  }
  return lines.slice(0, 2);
}

type NorthStarDomain = "relationships" | "work" | "health" | "spirituality" | "general";

type NorthStarEntry = {
  domain: NorthStarDomain;
  vision: string | null;
  goal: string | null;
  status: "active" | "inactive" | "unknown";
  vision_source: string | null;
  goal_source: string | null;
  vision_confidence: number;
  goal_confidence: number;
};

function normalizeNorthStarModel(value: unknown) {
  if (!isRecord(value)) return null;
  const domains: NorthStarDomain[] = ["relationships", "work", "health", "spirituality", "general"];
  const entries: NorthStarEntry[] = domains
    .map((domain) => {
      const raw = value[domain];
      if (!isRecord(raw)) return null;
      const vision = typeof raw.vision === "string" && raw.vision.trim() ? raw.vision.trim() : null;
      const goal = typeof raw.goal === "string" && raw.goal.trim() ? raw.goal.trim() : null;
      const statusRaw = typeof raw.status === "string" ? raw.status.toLowerCase() : "unknown";
      const status =
        statusRaw === "active" || statusRaw === "inactive" || statusRaw === "unknown"
          ? statusRaw
          : "unknown";
      const visionSource = typeof raw.vision_source === "string" ? raw.vision_source : null;
      const goalSource = typeof raw.goal_source === "string" ? raw.goal_source : null;
      const visionConfidence =
        typeof raw.vision_confidence === "number" && Number.isFinite(raw.vision_confidence)
          ? raw.vision_confidence
          : 0;
      const goalConfidence =
        typeof raw.goal_confidence === "number" && Number.isFinite(raw.goal_confidence)
          ? raw.goal_confidence
          : 0;
      if (!vision && !goal) return null;
      return {
        domain,
        vision,
        goal,
        status,
        vision_source: visionSource,
        goal_source: goalSource,
        vision_confidence: visionConfidence,
        goal_confidence: goalConfidence,
      } satisfies NorthStarEntry;
    })
    .filter((item): item is NorthStarEntry => Boolean(item));

  // Backward compatibility: legacy payload may have north_star.text
  if (entries.length === 0) {
    const legacyText = typeof value.text === "string" && value.text.trim() ? value.text.trim() : null;
    if (legacyText) {
      entries.push({
        domain: "general",
        vision: null,
        goal: legacyText,
        status: "active",
        vision_source: null,
        goal_source: "inferred",
        vision_confidence: 0,
        goal_confidence: 0.6,
      });
    }
  }

  return entries.length > 0 ? entries : null;
}

function chooseNorthStarLine(params: {
  northStar: unknown;
  completenessScore: Record<string, number> | null | undefined;
}) {
  const entries = normalizeNorthStarModel(params.northStar);
  if (!entries) return null;

  const strongUnknownThreshold = 0.85;
  const eligible = entries.filter((entry) => {
    const domainScore = toScoreValue(params.completenessScore, entry.domain);
    if (domainScore < 40) return false;
    if (entry.status === "unknown") {
      return (
        entry.vision_confidence >= strongUnknownThreshold ||
        entry.goal_confidence >= strongUnknownThreshold
      );
    }
    return true;
  });
  if (eligible.length === 0) return null;

  const ranked = eligible
    .map((entry) => {
      const hasUserStatedVision =
        Boolean(entry.vision) && entry.vision_source === "user_stated";
      const hasVision = Boolean(entry.vision);
      const hasGoal = Boolean(entry.goal);
      const sourcePriority = hasUserStatedVision ? 2 : hasVision ? 1 : 0;
      const confidence = hasUserStatedVision
        ? entry.vision_confidence
        : hasVision
          ? entry.vision_confidence
          : entry.goal_confidence;
      const score = toScoreValue(params.completenessScore, entry.domain);
      return { entry, hasUserStatedVision, hasVision, hasGoal, sourcePriority, confidence, score };
    })
    .sort((a, b) => {
      if (b.sourcePriority !== a.sourcePriority) return b.sourcePriority - a.sourcePriority;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.score - a.score;
    });

  const selected = ranked[0];
  if (selected.hasUserStatedVision && selected.entry.vision) {
    return `Long-term direction (${selected.entry.domain}): ${selected.entry.vision}`;
  }
  if (selected.hasVision && selected.entry.vision) {
    return `Likely direction (${selected.entry.domain}): ${selected.entry.vision}`;
  }
  if (selected.hasGoal && selected.entry.goal) {
    const source = selected.entry.goal_source ?? "inferred";
    if (source === "user_stated" || source === "manual") {
      return `Long-term goal (${selected.entry.domain}): ${selected.entry.goal}`;
    }
    return `Likely goal (${selected.entry.domain}): ${selected.entry.goal}`;
  }
  return null;
}

function toUserModelLines(userModel: SynapseUserModelResponse | null) {
  if (!userModel || !userModel.exists || !isRecord(userModel.model)) return [] as string[];
  const score = userModel.completenessScore ?? {};
  const model = userModel.model;
  const lines: string[] = [];

  if (toScoreValue(score, "north_star") >= 40) {
    const northStarLine = chooseNorthStarLine({
      northStar: model.north_star,
      completenessScore: score,
    });
    if (northStarLine) lines.push(northStarLine);
  }

  if (toScoreValue(score, "work") >= 40) {
    const currentFocus = extractText(model.current_focus);
    const workContext = extractText(model.work_context);
    if (currentFocus && workContext) {
      lines.push(`Current focus: ${currentFocus}. Work context: ${workContext}`);
    } else if (currentFocus) {
      lines.push(`Current focus: ${currentFocus}`);
    } else if (workContext) {
      lines.push(`Work context: ${workContext}`);
    }
  }

  if (toScoreValue(score, "relationships") >= 40 && Array.isArray(model.key_relationships)) {
    const topRelationships = model.key_relationships
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .sort((a, b) => {
        const sourceDiff = sourceRank(b.source) - sourceRank(a.source);
        if (sourceDiff !== 0) return sourceDiff;
        return confidenceValue(b) - confidenceValue(a);
      })
      .slice(0, 2)
      .map((item) => {
        const name = typeof item.name === "string" ? item.name.trim() : "";
        const who = typeof item.who === "string" ? item.who.trim() : "";
        return name || who;
      })
      .filter(Boolean);
    if (topRelationships.length > 0) {
      lines.push(`Important relationships: ${topRelationships.join(", ")}`);
    }
  }

  if (toScoreValue(score, "general") >= 40) {
    const patternLine = Array.isArray(model.patterns)
      ? model.patterns
          .filter((item): item is Record<string, unknown> => isRecord(item))
          .sort((a, b) => {
            const sourceDiff = sourceRank(b.source) - sourceRank(a.source);
            if (sourceDiff !== 0) return sourceDiff;
            return confidenceValue(b) - confidenceValue(a);
          })
          .map((item) => extractText(item))
          .filter((item): item is string => Boolean(item))
          .at(0)
      : null;
    if (patternLine) {
      lines.push(`Pattern to watch: ${patternLine}`);
    }
    if (isRecord(model.preferences)) {
      const tone = typeof model.preferences.tone === "string" ? model.preferences.tone.trim() : "";
      const avoid = Array.isArray(model.preferences.avoid)
        ? model.preferences.avoid
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .slice(0, 2)
        : [];
      if (tone || avoid.length > 0) {
        const parts: string[] = [];
        if (tone) parts.push(`prefers ${tone} tone`);
        if (avoid.length > 0) parts.push(`avoid ${avoid.join(", ")}`);
        lines.push(`Communication preference: ${parts.join("; ")}`);
      }
    }
  }

  if (toScoreValue(score, "health") >= 40) {
    const health = extractText(model.health);
    if (health) lines.push(`Health thread: ${health}`);
  }

  if (toScoreValue(score, "spirituality") >= 40) {
    const spirituality = extractText(model.spirituality);
    if (spirituality) lines.push(`Spiritual thread: ${spirituality}`);
  }

  return lines.map((line) => limitWords(line, 24)).slice(0, 5);
}

function getUserModelForSession(state: unknown, sessionId: string) {
  if (!sessionId) return null;
  const scoped = asStateRecord(state)[USER_MODEL_SESSION_KEY];
  if (typeof scoped !== "string" || scoped !== sessionId) return null;
  const raw = asStateRecord(state)[USER_MODEL_DATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as SynapseUserModelResponse;
}

function withUserModelForSession(state: unknown, sessionId: string, model: SynapseUserModelResponse) {
  const base = asStateRecord(state);
  return {
    ...base,
    [USER_MODEL_SESSION_KEY]: sessionId,
    [USER_MODEL_DATA_KEY]: model,
  };
}

function getDailyAnalysisForSession(state: unknown, sessionId: string) {
  if (!sessionId) return null;
  const scoped = asStateRecord(state)[DAILY_ANALYSIS_SESSION_KEY];
  if (typeof scoped !== "string" || scoped !== sessionId) return null;
  const raw = asStateRecord(state)[DAILY_ANALYSIS_DATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as SynapseDailyAnalysisResponse;
}

function withDailyAnalysisForSession(
  state: unknown,
  sessionId: string,
  analysis: SynapseDailyAnalysisResponse
) {
  const base = asStateRecord(state);
  return {
    ...base,
    [DAILY_ANALYSIS_SESSION_KEY]: sessionId,
    [DAILY_ANALYSIS_DATA_KEY]: analysis,
  };
}

async function maybeFetchOverlayLoops(params: {
  userId: string;
}) {
  try {
    const response = await getSynapseMemoryLoops()<{
      tenantId?: string;
      userId: string;
      limit: number;
    }, SynapseMemoryLoopsResponse>({
      tenantId: env.SYNAPSE_TENANT_ID,
      userId: params.userId,
      limit: 5,
    });
    if (!response || !Array.isArray(response.items)) return null;
    return response.items;
  } catch {
    return null;
  }
}

export async function buildContextFromSynapse(
  userId: string,
  personaId: string,
  transcript: string,
  sessionId: string,
  isSessionStart: boolean
): Promise<ConversationContext | null> {
  const persona = await prisma.personaProfile.findUnique({
    where: { id: personaId },
  });

  if (!persona) {
    throw new Error("Persona not found");
  }

  const personaPrompt = await loadPersonaPrompt({
    slug: (persona as { slug?: string | null }).slug ?? null,
    promptPath: persona.promptPath,
  });

  const messages = await getRecentSessionMessages(userId, personaId, sessionId);

  const sessionState = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { rollingSummary: true, state: true },
  });
  const rollingSummary = getRollingSummaryForSession(sessionState, sessionId);
  const localTrajectory = getTrajectoryStateFromSession(sessionState?.state, new Date(), "Europe/Zagreb");
  const cachedStartBrief = getStartBriefForSession(sessionState?.state, sessionId);
  const cachedUserModel = getUserModelForSession(sessionState?.state, sessionId);
  const cachedDailyAnalysis = getDailyAnalysisForSession(sessionState?.state, sessionId);
  const userModelLines = toUserModelLines(cachedUserModel);

  if (cachedStartBrief) {
    const cachedItemsCount = Array.isArray(cachedStartBrief.items) ? cachedStartBrief.items.length : 0;
    const cachedBridgeTextChars =
      typeof cachedStartBrief.bridgeText === "string" ? cachedStartBrief.bridgeText.trim().length : 0;
    if (env.FEATURE_LIBRARIAN_TRACE === "true") {
      void prisma.librarianTrace.create({
        data: {
          userId,
          personaId,
          sessionId: sessionId || null,
          kind: "startbrief",
          transcript,
          memoryQuery: {
            startbrief_used: true,
            startbrief_fallback: null,
            startbrief_items_count: cachedItemsCount,
            bridgeText_chars: cachedBridgeTextChars,
            source: "session_cache",
          },
          brief: cachedStartBrief as any,
        },
      }).catch((error) => {
        console.warn("[librarian.trace] failed to log startbrief(cache)", { error });
      });
    }
    const loopItems = isSessionStart ? await maybeFetchOverlayLoops({ userId }) : null;
    const overlayContext = loopItems
      ? getOverlayContextFromMemoryLoops(loopItems, messages, localTrajectory)
      : getOverlayContextFromStartBrief(cachedStartBrief, messages, localTrajectory);
    return {
      persona: personaPrompt,
      situationalContext:
        buildSessionStartContext(
          cachedStartBrief,
          localTrajectory,
          userModelLines,
          cachedDailyAnalysis
        ) ?? undefined,
      rollingSummary,
      startBrief: {
        used: true,
        fallback: null,
        itemsCount: cachedItemsCount,
        bridgeTextChars: cachedBridgeTextChars,
      },
      overlayContext,
      recentMessages: messages
        .map((message) => ({
          ...message,
          content: message.content.slice(0, MAX_RECENT_MESSAGE_CHARS),
        }))
        .reverse(),
      isSessionStart,
    };
  }

  if (isSessionStart) {
    const startBrief = await getSynapseStartBrief()<{
      tenantId?: string;
      userId: string;
      sessionId: string;
      timezone?: string;
      now: string;
    }, SynapseStartBriefResponse>({
      tenantId: env.SYNAPSE_TENANT_ID,
      userId,
      sessionId,
      timezone: "Europe/Zagreb",
      now: new Date().toISOString(),
    });

    if (startBrief) {
      const [userModelResult, dailyAnalysisResult] = await Promise.all([
        getSynapseUserModel()<{
          tenantId?: string;
          userId: string;
        }, SynapseUserModelResponse>({
          tenantId: env.SYNAPSE_TENANT_ID,
          userId,
        }).catch(() => null),
        getSynapseDailyAnalysis()<{
          tenantId?: string;
          userId: string;
        }, SynapseDailyAnalysisResponse>({
          tenantId: env.SYNAPSE_TENANT_ID,
          userId,
        }).catch(() => null),
      ]);
      const userModel = userModelResult ?? { exists: false };
      const dailyAnalysis =
        dailyAnalysisResult && dailyAnalysisResult.exists !== false ? dailyAnalysisResult : null;
      const stateWithStartBrief = withStartBriefForSession(sessionState?.state, sessionId, startBrief);
      const stateWithUserModel = withUserModelForSession(stateWithStartBrief, sessionId, userModel);
      const nextState = dailyAnalysis
        ? withDailyAnalysisForSession(stateWithUserModel, sessionId, dailyAnalysis)
        : stateWithUserModel;
      await prisma.sessionState.upsert({
        where: { userId_personaId: { userId, personaId } },
        update: { state: nextState as any, updatedAt: new Date() },
        create: { userId, personaId, state: nextState as any },
      });
      const startItemsCount = Array.isArray(startBrief.items) ? startBrief.items.length : 0;
      const startBridgeTextChars =
        typeof startBrief.bridgeText === "string" ? startBrief.bridgeText.trim().length : 0;
      if (env.FEATURE_LIBRARIAN_TRACE === "true") {
        void prisma.librarianTrace.create({
          data: {
            userId,
            personaId,
            sessionId: sessionId || null,
            kind: "startbrief",
            transcript,
            memoryQuery: {
              startbrief_used: true,
              startbrief_fallback: null,
              startbrief_items_count: startItemsCount,
              bridgeText_chars: startBridgeTextChars,
              source: "synapse_startbrief",
            },
            brief: startBrief as any,
          },
        }).catch((error) => {
          console.warn("[librarian.trace] failed to log startbrief(fetch)", { error });
        });
      }
      const loopItems = await maybeFetchOverlayLoops({ userId });
      const overlayContext = loopItems
        ? getOverlayContextFromMemoryLoops(loopItems, messages, localTrajectory)
        : getOverlayContextFromStartBrief(startBrief, messages, localTrajectory);
      const fetchedUserModelLines = toUserModelLines(userModel);
      return {
        persona: personaPrompt,
        situationalContext:
          buildSessionStartContext(startBrief, localTrajectory, fetchedUserModelLines, dailyAnalysis) ??
          undefined,
        rollingSummary,
        startBrief: {
          used: true,
          fallback: null,
          itemsCount: startItemsCount,
          bridgeTextChars: startBridgeTextChars,
        },
        overlayContext,
        recentMessages: messages
          .map((message) => ({
            ...message,
            content: message.content.slice(0, MAX_RECENT_MESSAGE_CHARS),
          }))
          .reverse(),
        isSessionStart,
      };
    }
  }

  const heuristic = heuristicQuery(transcript);
  let selectedQuery = heuristic;
  if (!selectedQuery && env.FEATURE_QUERY_ROUTER === "true") {
    const recentTurns = getRecentTurns(messages);
    const lastAssistantTurn = getLastAssistantTurn(messages);
    const contextHint =
      recentTurns.length > 0
        ? recentTurns
            .map((turn) => {
              const parts = [];
              if (turn.user) parts.push(`User: ${turn.user}`);
              if (turn.assistant) parts.push(`Assistant: ${turn.assistant}`);
              return parts.join("\n");
            })
            .join("\n\n")
        : lastAssistantTurn ?? null;

    const routerResult: QueryRouterResult | null = await getQueryRouter()(
      transcript,
      contextHint
    );
    if (routerResult?.should_query) {
      const candidate = routerResult.query ? sanitizeQuery(routerResult.query) : null;
      if (
        typeof routerResult.confidence === "number" &&
        routerResult.confidence >= 0.6 &&
        candidate &&
        isValidQuery(candidate)
      ) {
        selectedQuery = candidate;
      }
    }
    if (!selectedQuery) {
      const candidates = extractQueryCandidates(transcript);
      for (const candidate of candidates) {
        const sanitized = sanitizeQuery(candidate);
        if (sanitized && isValidQuery(sanitized)) {
          selectedQuery = sanitized;
          break;
        }
      }
    }
  }

  if (!isSessionStart) {
    return {
      persona: personaPrompt,
      situationalContext: undefined,
      rollingSummary,
      startBrief: {
        used: false,
        fallback: null,
        itemsCount: 0,
        bridgeTextChars: 0,
      },
      overlayContext: {
        openLoops: [],
        commitments: [],
        currentFocus: localTrajectory?.todayFocus ?? undefined,
        weeklyNorthStar: localTrajectory?.weeklyNorthStar ?? undefined,
        hasHighPriorityLoop: false,
      },
      recentMessages: messages
        .map((message) => ({
          ...message,
          content: message.content.slice(0, MAX_RECENT_MESSAGE_CHARS),
        }))
        .reverse(),
      isSessionStart,
    };
  }

  const cacheKey = `${userId}:${sessionId}`;
  const cached = briefCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < BRIEF_CACHE_TTL_MS) {
    const situationalContext = buildSituationalContext(cached.brief);
    const effectiveFocus = cached.brief.currentFocus?.trim() || localTrajectory?.todayFocus || undefined;
    const effectiveWeeklyNorthStar = localTrajectory?.weeklyNorthStar || undefined;
    const situationalWithFocus =
      effectiveFocus && !(situationalContext ?? "").includes("CURRENT_FOCUS:")
        ? [situationalContext, `CURRENT_FOCUS:\n- ${effectiveFocus}`].filter(Boolean).join("\n")
        : situationalContext;
    const situationalWithTrajectory =
      effectiveWeeklyNorthStar && !(situationalWithFocus ?? "").includes("WEEKLY_NORTH_STAR:")
        ? [situationalWithFocus, `WEEKLY_NORTH_STAR:\n- ${effectiveWeeklyNorthStar}`]
            .filter(Boolean)
            .join("\n")
        : situationalWithFocus;
    const overlayContext = {
      openLoops: buildOverlayItems(cached.brief.openLoops ?? [], messages),
      commitments: buildOverlayItems(cached.brief.commitments ?? [], messages),
      currentFocus: effectiveFocus,
      weeklyNorthStar: effectiveWeeklyNorthStar,
      hasHighPriorityLoop: false,
    };
    if (env.FEATURE_LIBRARIAN_TRACE === "true") {
      void prisma.librarianTrace.create({
        data: {
          userId,
          personaId,
          sessionId: sessionId || null,
          kind: "startbrief",
          transcript,
          memoryQuery: {
            startbrief_used: false,
            startbrief_fallback: "session/brief",
            startbrief_items_count: 0,
            bridgeText_chars: 0,
            source: "session_brief_cache",
          },
        },
      }).catch((error) => {
        console.warn("[librarian.trace] failed to log startbrief(fallback-cache)", { error });
      });
    }
    return {
      persona: personaPrompt,
      situationalContext: situationalWithTrajectory ?? undefined,
      rollingSummary,
      startBrief: {
        used: false,
        fallback: "session/brief",
        itemsCount: 0,
        bridgeTextChars: 0,
      },
      overlayContext,
      recentMessages: messages
        .map((message) => ({
          ...message,
          content: message.content.slice(0, MAX_RECENT_MESSAGE_CHARS),
        }))
        .reverse(),
      isSessionStart,
    };
  }

  const brief = await getSynapseBrief()<{
    tenantId?: string;
    userId: string;
    personaId: string;
    sessionId: string;
    now: string;
    query: string | null;
  }, SynapseBriefResponse>({
    tenantId: env.SYNAPSE_TENANT_ID,
    userId,
    personaId,
    sessionId,
    now: new Date().toISOString(),
    query: selectedQuery ?? null,
  });

  if (!brief) return null;
  briefCache.set(cacheKey, { fetchedAt: Date.now(), brief });
  const situationalContext = buildSituationalContext(brief);
  const effectiveFocus = brief.currentFocus?.trim() || localTrajectory?.todayFocus || undefined;
  const effectiveWeeklyNorthStar = localTrajectory?.weeklyNorthStar || undefined;
  const situationalWithFocus =
    effectiveFocus && !(situationalContext ?? "").includes("CURRENT_FOCUS:")
      ? [situationalContext, `CURRENT_FOCUS:\n- ${effectiveFocus}`].filter(Boolean).join("\n")
      : situationalContext;
  const situationalWithTrajectory =
    effectiveWeeklyNorthStar && !(situationalWithFocus ?? "").includes("WEEKLY_NORTH_STAR:")
      ? [situationalWithFocus, `WEEKLY_NORTH_STAR:\n- ${effectiveWeeklyNorthStar}`]
          .filter(Boolean)
          .join("\n")
      : situationalWithFocus;
  const overlayContext = {
    openLoops: buildOverlayItems(brief.openLoops ?? [], messages),
    commitments: buildOverlayItems(brief.commitments ?? [], messages),
    currentFocus: effectiveFocus,
    weeklyNorthStar: effectiveWeeklyNorthStar,
    hasHighPriorityLoop: false,
  };

  if (env.FEATURE_LIBRARIAN_TRACE === "true") {
    void prisma.librarianTrace.create({
      data: {
        userId,
        personaId,
        sessionId: sessionId || null,
        kind: "startbrief",
        transcript,
        memoryQuery: {
          startbrief_used: false,
          startbrief_fallback: "session/brief",
          startbrief_items_count: 0,
          bridgeText_chars: 0,
          source: "session_brief_fetch",
        },
      },
    }).catch((error) => {
      console.warn("[librarian.trace] failed to log startbrief(fallback-fetch)", { error });
    });
    void prisma.librarianTrace.create({
      data: {
        userId,
        personaId,
        sessionId: sessionId || null,
        kind: "brief",
        memoryQuery: selectedQuery ? { query: selectedQuery } : undefined,
        brief,
        supplementalContext: situationalWithTrajectory ?? null,
      },
    }).catch((error) => {
      console.warn("[librarian.trace] failed to log brief", { error });
    });
  }

  return {
    persona: personaPrompt,
    situationalContext: situationalWithTrajectory ?? undefined,
    rollingSummary,
    startBrief: {
      used: false,
      fallback: "session/brief",
      itemsCount: 0,
      bridgeTextChars: 0,
    },
    overlayContext,
    recentMessages: messages
      .map((message) => ({
        ...message,
        content: message.content.slice(0, MAX_RECENT_MESSAGE_CHARS),
      }))
      .reverse(),
    isSessionStart,
  };
}

async function buildContextLocal(
  userId: string,
  personaId: string,
  sessionId?: string,
  isSessionStartOverride?: boolean
): Promise<ConversationContext> {
  try {
    const persona = await prisma.personaProfile.findUnique({
      where: { id: personaId },
    });

    if (!persona) {
      throw new Error("Persona not found");
    }

    const personaPrompt = await loadPersonaPrompt({
      slug: (persona as { slug?: string | null }).slug ?? null,
      promptPath: persona.promptPath,
    });

    const messages = await getRecentSessionMessages(userId, personaId, sessionId ?? "");

    const sessionState = await prisma.sessionState.findUnique({
      where: { userId_personaId: { userId, personaId } },
      select: { rollingSummary: true, state: true },
    });

    const isSessionStart =
      typeof isSessionStartOverride === "boolean" ? isSessionStartOverride : messages.length === 0;
    const rollingSummary = getRollingSummaryForSession(sessionState, sessionId ?? "");

    return {
      persona: personaPrompt,
      situationalContext: undefined,
      rollingSummary,
      startBrief: {
        used: false,
        fallback: null,
        itemsCount: 0,
        bridgeTextChars: 0,
      },
      overlayContext: undefined,
      recentMessages: messages
        .map((message) => ({
          ...message,
          content: message.content.slice(0, MAX_RECENT_MESSAGE_CHARS),
        }))
        .reverse(),
      isSessionStart,
    };
  } catch (error) {
    console.error("Context Builder Error:", error);
    throw new Error("Failed to build conversation context");
  }
}

function getLocalBuilder() {
  const override = (globalThis as { __buildContextLocalOverride?: typeof buildContextLocal })
    .__buildContextLocalOverride;
  return typeof override === "function" ? override : buildContextLocal;
}

export async function buildContext(
  userId: string,
  personaId: string,
  userMessage: string,
): Promise<ConversationContext> {
  const session = await prisma.session.findFirst({
    where: { userId, personaId, endedAt: null },
    orderBy: { lastActivityAt: "desc" },
    select: { id: true },
  });
  const sessionWindow = session?.id ? await getSessionWindow(session.id) : null;
  const firstSessionMessage = sessionWindow
    ? await prisma.message.findFirst({
        where: {
          userId,
          personaId,
          ...buildSessionWindowWhere(sessionWindow),
        },
        select: { id: true },
      })
    : null;
  const isSessionStart = !firstSessionMessage;
  const sessionId = session?.id ?? "";

  const shouldUseSynapse = env.FEATURE_SYNAPSE_BRIEF === "true";
  if (shouldUseSynapse) {
    try {
      const synapseContext = await buildContextFromSynapse(
        userId,
        personaId,
        userMessage,
        sessionId,
        isSessionStart
      );
      if (synapseContext) {
        return synapseContext;
      }
      console.warn("[context.synapse] brief unavailable, falling back");
    } catch (error) {
      console.warn("[context.synapse] brief failed, falling back", { error });
    }
  }

  return getLocalBuilder()(userId, personaId, sessionId, isSessionStart);
}
