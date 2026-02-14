import { prisma } from "@/lib/prisma";
import { readFile } from "fs/promises";
import { join } from "path";
import { env } from "@/env";
import * as synapseClient from "@/lib/services/synapseClient";
import type { SynapseBriefResponse } from "@/lib/services/synapseClient";
import { queryRouter, type QueryRouterResult } from "@/lib/services/queryRouter";

export interface ConversationContext {
  persona: string;
  situationalContext?: string;
  rollingSummary?: string;
  overlayContext?: {
    openLoops?: string[];
    commitments?: string[];
    currentFocus?: string;
  };
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }>;
  /** True if this is the first turn of a new session (for conditional SessionSummary injection) */
  isSessionStart: boolean;
}

const MAX_RECENT_MESSAGE_CHARS = 800;
const BRIEF_CACHE_TTL_MS = 3 * 60 * 1000;
const OVERLAY_CONTEXT_CAP = 3;
const OVERLAY_ITEM_MAX_WORDS = 12;
const briefCache = new Map<
  string,
  { fetchedAt: number; brief: SynapseBriefResponse }
>();

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

function toLocalDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTodayFocusFromState(state: unknown, now: Date) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const overlayState = (state as Record<string, unknown>).overlayState;
  if (!overlayState || typeof overlayState !== "object" || Array.isArray(overlayState)) return null;
  const user = (overlayState as Record<string, unknown>).user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const todayFocus = (user as Record<string, unknown>).todayFocus;
  const todayFocusDate = (user as Record<string, unknown>).todayFocusDate;
  if (typeof todayFocus !== "string" || !todayFocus.trim()) return null;
  if (typeof todayFocusDate !== "string") return null;
  if (todayFocusDate !== toLocalDateKey(now)) return null;
  return todayFocus.trim();
}

function getSynapseBrief() {
  const override = (globalThis as { __synapseBriefOverride?: typeof synapseClient.sessionBrief })
    .__synapseBriefOverride;
  return typeof override === "function" ? override : synapseClient.sessionBrief;
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

  const promptPath = join(process.cwd(), persona.promptPath);
  const personaPrompt = await readFile(promptPath, "utf-8");

  const messages = await prisma.message.findMany({
    where: { userId, personaId },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      role: true,
      content: true,
      createdAt: true,
    },
  });

  const sessionState = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { rollingSummary: true, state: true },
  });
  const localTodayFocus = getTodayFocusFromState(sessionState?.state, new Date());

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

  const cacheKey = `${userId}:${personaId}:${sessionId}`;
  const cached = briefCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < BRIEF_CACHE_TTL_MS) {
    const situationalContext = buildSituationalContext(cached.brief);
    const effectiveFocus = cached.brief.currentFocus?.trim() || localTodayFocus || undefined;
    const situationalWithFocus =
      effectiveFocus && !(situationalContext ?? "").includes("CURRENT_FOCUS:")
        ? [situationalContext, `CURRENT_FOCUS:\n- ${effectiveFocus}`].filter(Boolean).join("\n")
        : situationalContext;
    const overlayContext = {
      openLoops: buildOverlayItems(cached.brief.openLoops ?? [], messages),
      commitments: buildOverlayItems(cached.brief.commitments ?? [], messages),
      currentFocus: effectiveFocus,
    };
    return {
      persona: personaPrompt,
      situationalContext: situationalWithFocus ?? undefined,
      rollingSummary: sessionState?.rollingSummary ?? undefined,
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
  const effectiveFocus = brief.currentFocus?.trim() || localTodayFocus || undefined;
  const situationalWithFocus =
    effectiveFocus && !(situationalContext ?? "").includes("CURRENT_FOCUS:")
      ? [situationalContext, `CURRENT_FOCUS:\n- ${effectiveFocus}`].filter(Boolean).join("\n")
      : situationalContext;
  const overlayContext = {
    openLoops: buildOverlayItems(brief.openLoops ?? [], messages),
    commitments: buildOverlayItems(brief.commitments ?? [], messages),
    currentFocus: effectiveFocus,
  };

  if (env.FEATURE_LIBRARIAN_TRACE === "true") {
    try {
      await prisma.librarianTrace.create({
        data: {
          userId,
          personaId,
          sessionId: sessionId || null,
          kind: "brief",
          memoryQuery: selectedQuery ? { query: selectedQuery } : undefined,
          brief,
          supplementalContext: situationalWithFocus ?? null,
        },
      });
    } catch (error) {
      console.warn("[librarian.trace] failed to log brief", { error });
    }
  }

  return {
    persona: personaPrompt,
    situationalContext: situationalWithFocus ?? undefined,
    rollingSummary: sessionState?.rollingSummary ?? undefined,
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
  personaId: string
): Promise<ConversationContext> {
  try {
    const persona = await prisma.personaProfile.findUnique({
      where: { id: personaId },
    });

    if (!persona) {
      throw new Error("Persona not found");
    }

    const promptPath = join(process.cwd(), persona.promptPath);
    const personaPrompt = await readFile(promptPath, "utf-8");

    const messages = await prisma.message.findMany({
      where: { userId, personaId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        role: true,
        content: true,
        createdAt: true,
      },
    });

    const sessionState = await prisma.sessionState.findUnique({
      where: { userId_personaId: { userId, personaId } },
      select: { rollingSummary: true },
    });

    const isSessionStart = messages.length === 0;

    return {
      persona: personaPrompt,
      situationalContext: undefined,
      rollingSummary: sessionState?.rollingSummary ?? undefined,
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
  const shouldUseSynapse = env.FEATURE_SYNAPSE_BRIEF === "true";
  if (shouldUseSynapse) {
    try {
      const session = await prisma.session.findFirst({
        where: { userId, personaId, endedAt: null },
        orderBy: { lastActivityAt: "desc" },
        select: { id: true },
      });
      const lastMessage = await prisma.message.findFirst({
        where: { userId, personaId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const isSessionStart = !lastMessage;
      const sessionId = session?.id ?? "";

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

  return getLocalBuilder()(userId, personaId);
}
