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
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }>;
  /** True if this is the first turn of a new session (for conditional SessionSummary injection) */
  isSessionStart: boolean;
}

const MAX_RECENT_MESSAGE_CHARS = 800;
const BRIEF_CACHE_TTL_MS = 3 * 60 * 1000;
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

function buildSituationalContext(brief: SynapseBriefResponse) {
  const parts: string[] = [];
  if (brief.briefContext && brief.briefContext.trim()) {
    parts.push(`Brief: ${brief.briefContext.trim()}`);
  }
  if (brief.narrativeSummary && Array.isArray(brief.narrativeSummary)) {
    const summaries = brief.narrativeSummary
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (!item || typeof item !== "object") return "";
        return typeof item.summary === "string" ? item.summary.trim() : "";
      })
      .filter(Boolean);
    if (summaries.length > 0) {
      parts.push(`Brief: ${summaries[0]}`);
    }
  }
  if (brief.timeGapDescription && brief.timeGapDescription.trim()) {
    parts.push(`Time Gap: ${brief.timeGapDescription.trim()}`);
  }
  if (brief.timeOfDayLabel && brief.timeOfDayLabel.trim()) {
    parts.push(`Time: ${brief.timeOfDayLabel.trim()}`);
  }
  const loops = Array.isArray(brief.activeLoops) ? brief.activeLoops : [];
  const loopTexts = loops
    .map((loop) => normalizeLoopText(loop))
    .filter((value): value is string => Boolean(value));
  if (loopTexts.length > 0) {
    parts.push(`Tensions:\n- ${loopTexts.join("\n- ")}`);
  }
  if (brief.currentFocus && brief.currentFocus.trim()) {
    parts.push(`CURRENT_FOCUS:\n- ${brief.currentFocus.trim()}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
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
    select: { rollingSummary: true },
  });

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
    return {
      persona: personaPrompt,
      situationalContext: situationalContext ?? undefined,
      rollingSummary: sessionState?.rollingSummary ?? undefined,
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
          supplementalContext: situationalContext ?? null,
        },
      });
    } catch (error) {
      console.warn("[librarian.trace] failed to log brief", { error });
    }
  }

  return {
    persona: personaPrompt,
    situationalContext: situationalContext ?? undefined,
    rollingSummary: sessionState?.rollingSummary ?? undefined,
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
