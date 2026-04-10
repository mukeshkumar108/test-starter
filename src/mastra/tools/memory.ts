import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { env } from "@/env";
import type { SynapseUserModelResponse } from "@/lib/services/synapseClient";
import { SYNAPSE_CANONICAL_TENANT_ID } from "@/lib/services/synapseTenant";

type MemoryQueryResponse = {
  facts?: Array<
    | string
    | {
        text?: string;
        relevance?: number | null;
        source?: string;
        relevance_tier?: string | null;
      }
  >;
  factItems?: Array<{
    text?: string;
    relevance?: number | null;
    source?: string;
    relevance_tier?: string | null;
    domain?: string | null;
    sourceTenant?: string | null;
  }>;
  entities?: Array<{ summary?: string; type?: string; uuid?: string }>;
  episodes?: Array<{
    episodeId?: string | null;
    sessionId?: string | null;
    referenceTime?: string | null;
    score?: number | null;
    summary?: string;
    evidence?: string[];
    linkedEntities?: string[];
    sourceTenant?: string | null;
  }>;
  metadata?: {
    query?: string;
    memoryIntent?: "exact" | "episodic" | "hybrid";
    responseMode?: "recall" | "context";
    facts?: number;
    entities?: number;
    episodes?: number;
    episodicWeakRecall?: boolean;
  };
};

type RecallFactRelevanceTier = "recent" | "persistent" | "stale";

type NormalizedRecallFact = {
  text: string;
  relevanceTier: RecallFactRelevanceTier | null;
};

type MemoryIntent = "exact" | "episodic" | "hybrid";

type NormalizedEpisode = {
  summary: string;
  evidence: string[];
  linkedEntities: string[];
};

type LoopsResponse = {
  items?: Array<{ text?: string | null } | string> | null;
};

type MemoryLookupPayload = {
  facts?: Array<
    | string
    | {
        text?: string;
        relevance_tier?: string | null;
      }
  >;
  factItems?: Array<{
    text?: string;
    relevance_tier?: string | null;
  }>;
  entities?: Array<{ summary?: string; type?: string; uuid?: string }>;
  episodes?: Array<{
    summary?: string;
    evidence?: string[];
    linkedEntities?: string[];
  }>;
  metadata?: {
    episodicWeakRecall?: boolean;
  };
};

function parseRecallFactRelevanceTier(value: unknown): RecallFactRelevanceTier | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "recent" || normalized === "persistent" || normalized === "stale") {
    return normalized;
  }
  return null;
}

function recallFactTierSortRank(tier: RecallFactRelevanceTier | null): number {
  if (tier === "recent") return 0;
  if (tier === "persistent") return 1;
  if (tier === "stale") return 3;
  return 2;
}

function normalizeMemoryQueryResponse(data: MemoryQueryResponse | null | undefined) {
  const normalizedFactRowsFromFacts: NormalizedRecallFact[] = Array.isArray(data?.facts)
    ? data.facts
        .map((fact): NormalizedRecallFact | null => {
          if (typeof fact === "string") {
            const text = fact.trim();
            return text ? { text, relevanceTier: null } : null;
          }
          if (fact && typeof fact.text === "string") {
            const text = fact.text.trim();
            if (!text) return null;
            return {
              text,
              relevanceTier: parseRecallFactRelevanceTier(fact.relevance_tier),
            };
          }
          return null;
        })
        .filter((fact): fact is NormalizedRecallFact => Boolean(fact))
    : [];

  const normalizedFactRowsFromFactItems: NormalizedRecallFact[] = Array.isArray(data?.factItems)
    ? data.factItems
        .map((fact): NormalizedRecallFact | null => {
          if (!fact || typeof fact.text !== "string") return null;
          const text = fact.text.trim();
          if (!text) return null;
          return {
            text,
            relevanceTier: parseRecallFactRelevanceTier(fact.relevance_tier),
          };
        })
        .filter((fact): fact is NormalizedRecallFact => Boolean(fact))
    : [];

  const dedupedFactRows: NormalizedRecallFact[] = [];
  const seenFacts = new Set<string>();
  for (const row of [...normalizedFactRowsFromFactItems, ...normalizedFactRowsFromFacts]) {
    const key = row.text.toLowerCase();
    if (seenFacts.has(key)) continue;
    seenFacts.add(key);
    dedupedFactRows.push(row);
  }
  const factRows = dedupedFactRows.sort(
    (a, b) => recallFactTierSortRank(a.relevanceTier) - recallFactTierSortRank(b.relevanceTier)
  );

  const facts = factRows.map((fact) => fact.text);
  const entities = Array.isArray(data?.entities)
    ? data.entities
        .map((entity) => (typeof entity?.summary === "string" ? entity.summary.trim() : ""))
        .filter(Boolean)
    : [];
  const episodes: NormalizedEpisode[] = Array.isArray(data?.episodes)
    ? data.episodes
        .map((episode): NormalizedEpisode | null => {
          const summary = typeof episode?.summary === "string" ? episode.summary.trim() : "";
          if (!summary) return null;
          const evidence = Array.isArray(episode.evidence)
            ? episode.evidence
                .map((item) => (typeof item === "string" ? item.trim() : ""))
                .filter(Boolean)
                .slice(0, 2)
            : [];
          const linkedEntities = Array.isArray(episode.linkedEntities)
            ? episode.linkedEntities
                .map((item) => (typeof item === "string" ? item.trim() : ""))
                .filter(Boolean)
                .slice(0, 3)
            : [];
          return { summary, evidence, linkedEntities };
        })
        .filter((episode): episode is NormalizedEpisode => Boolean(episode))
    : [];
  const episodicWeakRecall = Boolean(data?.metadata?.episodicWeakRecall);

  return { facts, entities, factRows, episodes, episodicWeakRecall };
}

export function buildMemoryContext(params: {
  query: string;
  facts: string[];
  factRows?: NormalizedRecallFact[];
  entities: string[];
  episodes?: NormalizedEpisode[];
  loops?: string[];
  profileMatches?: string[];
  includeStaleFacts?: boolean;
  memoryIntent?: MemoryIntent;
  episodicWeakRecall?: boolean;
}) {
  const includeStaleFacts = params.includeStaleFacts === true;
  const orderedFacts =
    params.factRows?.map((fact) => fact) ??
    params.facts.map((text) => ({ text, relevanceTier: null } satisfies NormalizedRecallFact));
  const facts = orderedFacts
    .filter((fact) => includeStaleFacts || fact.relevanceTier !== "stale")
    .map((fact) => fact.text);

  const lines: string[] = [];
  lines.push(`Recall Sheet (query: ${params.query})`);
  if (facts.length > 0) {
    lines.push("Facts:");
    for (const fact of facts.slice(0, 3)) {
      lines.push(`- ${fact}`);
    }
  }
  if (params.entities.length > 0) {
    lines.push("Entities:");
    for (const entity of params.entities.slice(0, 3)) {
      lines.push(`- ${entity}`);
    }
  }
  if ((params.episodes?.length ?? 0) > 0) {
    lines.push("Episodes:");
    for (const episode of (params.episodes ?? []).slice(0, 2)) {
      lines.push(`- ${episode.summary}`);
      for (const snippet of episode.evidence.slice(0, 1)) {
        lines.push(`  evidence: ${snippet}`);
      }
      if (episode.linkedEntities.length > 0) {
        lines.push(`  linked entities: ${episode.linkedEntities.join(", ")}`);
      }
    }
  }
  if ((params.profileMatches?.length ?? 0) > 0) {
    lines.push("Profile:");
    for (const line of (params.profileMatches ?? []).slice(0, 3)) {
      lines.push(`- ${line}`);
    }
  }
  if ((params.loops?.length ?? 0) > 0) {
    lines.push("Open Loops:");
    for (const loop of (params.loops ?? []).slice(0, 3)) {
      lines.push(`- ${loop}`);
    }
  }
  if (params.memoryIntent === "episodic" && params.episodicWeakRecall) {
    lines.push("Episodic confidence is weak; avoid making definitive claims.");
  }
  return lines.join("\n");
}

function dedupeStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

function collectUserModelStrings(value: unknown, acc: string[]) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) acc.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUserModelStrings(item, acc);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectUserModelStrings(nested, acc);
  }
}

function sentenceScore(sentence: string, tokens: string[]) {
  const lowered = sentence.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (lowered.includes(token)) score += 1;
  }
  return score;
}

export function routeMemoryIntent(params: { query: string }): MemoryIntent {
  const query = params.query.toLowerCase();
  const strongEpisodicSignals = [
    "remember that conversation",
    "continue that thread",
    "we were exploring",
    "thread from before",
    "that idea i had",
  ];
  const episodicSignals = [
    "remember",
    "thread",
    "conversation",
    "that time",
    "when we",
    "last time",
    "earlier",
    "before",
    "what happened",
    "walk me through",
  ];
  const exactSignals = [
    "who",
    "what is",
    "what's",
    "preference",
    "name",
    "goal",
    "fact",
    "detail",
  ];

  const episodicScore = episodicSignals.reduce(
    (score, signal) => (query.includes(signal) ? score + 1 : score),
    0
  );
  const exactScore = exactSignals.reduce(
    (score, signal) => (query.includes(signal) ? score + 1 : score),
    0
  );
  const hasStrongEpisodicSignal = strongEpisodicSignals.some((signal) => query.includes(signal));
  const hasEntityAnchor = /\b(about|with|and)\s+[A-Z][A-Za-z0-9_-]{2,}\b/.test(params.query);

  if (hasStrongEpisodicSignal && exactScore === 0) return "episodic";
  if (episodicScore > exactScore) return hasEntityAnchor ? "hybrid" : "episodic";
  if (exactScore > episodicScore) return "exact";
  return "hybrid";
}

export function buildFocusQuery(params: { query: string; memoryIntent: MemoryIntent }) {
  if (params.memoryIntent !== "episodic" && params.memoryIntent !== "hybrid") return null;
  const normalized = params.query.trim().replace(/\s+/g, " ");
  return normalized.length > 100 ? normalized.slice(0, 100).trim() : normalized;
}

export function normalizeMemoryToolQuery(params: {
  query: string | null | undefined;
  fallbackQuery: string | null | undefined;
}) {
  const primary = typeof params.query === "string" ? params.query.trim() : "";
  if (primary) return primary.slice(0, 120);
  const fallback = typeof params.fallbackQuery === "string" ? params.fallbackQuery.trim() : "";
  if (fallback) return fallback.slice(0, 120);
  return "recent user context";
}

export function shouldFetchMemoryLoops(params: { query: string; memoryIntent: MemoryIntent }) {
  const lowered = params.query.toLowerCase();
  const loopSignals = [
    "next step",
    "next steps",
    "follow up",
    "follow-up",
    "commitment",
    "commitments",
    "todo",
    "to-do",
    "open loop",
    "open loops",
    "what should we do next",
    "what should i do next",
  ];
  const hasLoopSignal = loopSignals.some((signal) => lowered.includes(signal));
  if (!hasLoopSignal) return false;
  return params.memoryIntent !== "episodic";
}

export function shouldSoftenMemoryClaims(params: {
  memoryIntent: MemoryIntent;
  episodicWeakRecall: boolean;
  hasStrongFacts: boolean;
}) {
  if (!params.episodicWeakRecall) return false;
  if (params.memoryIntent === "episodic") return true;
  return !params.hasStrongFacts;
}

export function extractRelevantUserModelLines(params: {
  query: string;
  candidates: string[];
  userModel: SynapseUserModelResponse | null | undefined;
}) {
  if (!params.userModel?.model) return [];

  const rawStrings: string[] = [];
  collectUserModelStrings(params.userModel.model, rawStrings);

  const sentences = dedupeStrings(
    rawStrings.flatMap((value) =>
      value
        .split(/(?<=[.!?])\s+|\n+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean)
    )
  );

  const tokenSource = [
    params.query,
    ...params.candidates,
  ]
    .join(" ")
    .toLowerCase()
    .match(/\b[a-z][a-z0-9'-]*\b/g) || [];
  const stopwords = new Set([
    "what",
    "when",
    "where",
    "which",
    "just",
    "really",
    "want",
    "know",
    "remember",
    "talking",
    "about",
    "with",
    "that",
    "this",
    "from",
    "went",
    "into",
    "have",
    "dont",
    "don't",
    "able",
    "tell",
    "couple",
    "weeks",
    "ago",
    "reason",
  ]);
  const tokens = Array.from(new Set(tokenSource.filter((token) => !stopwords.has(token))));

  return sentences
    .map((sentence) => ({ sentence, score: sentenceScore(sentence, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.sentence)
    .slice(0, 3);
}

async function querySynapseMemory(params: {
  userId: string;
  now: Date;
  query: string;
  memoryIntent: MemoryIntent;
  focusQuery: string | null;
}) {
  const response = await fetch(`${env.SYNAPSE_BASE_URL}/memory/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: SYNAPSE_CANONICAL_TENANT_ID,
      userId: params.userId,
      query: params.query,
      limit: 10,
      memoryIntent: params.memoryIntent,
      referenceTime: params.now.toISOString(),
      includeContext: false,
      ...(params.focusQuery ? { focusQuery: params.focusQuery } : {}),
    }),
  });

  if (!response.ok) {
    return { ok: false as const, status: response.status, data: null };
  }

  const data = (await response.json()) as MemoryLookupPayload;
  return { ok: true as const, status: response.status, data };
}

async function fetchUserModel(params: { userId: string }) {
  const response = await fetch(
    `${env.SYNAPSE_BASE_URL}/user/model?tenantId=${encodeURIComponent(
      SYNAPSE_CANONICAL_TENANT_ID
    )}&userId=${encodeURIComponent(params.userId)}`
  );
  if (!response.ok) return null;
  return (await response.json()) as SynapseUserModelResponse;
}

async function querySynapseMemoryLoops(params: { userId: string }) {
  const url = new URL(`${env.SYNAPSE_BASE_URL}/memory/loops`);
  url.searchParams.set("tenantId", SYNAPSE_CANONICAL_TENANT_ID);
  url.searchParams.set("userId", params.userId);
  url.searchParams.set("limit", "3");

  const response = await fetch(url.toString(), { method: "GET" });
  if (!response.ok) return [];
  const data = (await response.json()) as LoopsResponse;
  if (!Array.isArray(data?.items)) return [];
  const loops = data.items
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item.text === "string") return item.text.trim();
      return "";
    })
    .filter(Boolean);
  return dedupeStrings(loops).slice(0, 3);
}

export async function runMemoryLookup(params: {
  userId: string;
  requestId: string;
  now: Date;
  query: string;
  memoryIntent?: MemoryIntent | null;
}) {
  if (!env.SYNAPSE_BASE_URL) {
    return {
      used: false,
      query: params.query,
      supplementalContext: null,
      softenClaims: false,
      reason: "synapse_unconfigured",
    };
  }

  const memoryIntent = params.memoryIntent ?? routeMemoryIntent({ query: params.query });
  const focusQuery = buildFocusQuery({ query: params.query, memoryIntent });
  const includeLoops = shouldFetchMemoryLoops({ query: params.query, memoryIntent });

  const [userModel, queryResult, loops] = await Promise.all([
    fetchUserModel({ userId: params.userId }).catch(() => null),
    querySynapseMemory({
      userId: params.userId,
      now: params.now,
      query: params.query,
      memoryIntent,
      focusQuery,
    }),
    includeLoops ? querySynapseMemoryLoops({ userId: params.userId }).catch(() => []) : Promise.resolve([]),
  ]);

  if (!queryResult.ok) {
    console.warn("[mastra.memory.query.failed]", {
      requestId: params.requestId,
      status: queryResult.status,
      query: params.query,
    });
    return {
      used: false,
      query: params.query,
      supplementalContext: null,
      softenClaims: false,
      reason: "synapse_error",
    };
  }

  const { facts, entities, factRows, episodes, episodicWeakRecall } =
    normalizeMemoryQueryResponse(queryResult.data);
  const profileMatches = extractRelevantUserModelLines({
    query: params.query,
    candidates: [params.query],
    userModel,
  });

  const recallFacts = factRows
    .filter((fact) => fact.relevanceTier !== "stale")
    .map((fact) => fact.text);

  const hasStrongFacts = recallFacts.length > 0 || entities.length > 0;
  const softenClaims = shouldSoftenMemoryClaims({
    memoryIntent,
    episodicWeakRecall,
    hasStrongFacts,
  });

  if (
    recallFacts.length === 0 &&
    entities.length === 0 &&
    episodes.length === 0 &&
    loops.length === 0 &&
    profileMatches.length === 0
  ) {
    return {
      used: false,
      query: params.query,
      supplementalContext: null,
      softenClaims,
      reason: "no_results",
    };
  }

  return {
    used: true,
    query: params.query,
    supplementalContext: buildMemoryContext({
      query: params.query,
      facts,
      factRows,
      entities,
      episodes,
      loops,
      profileMatches,
      includeStaleFacts: false,
      memoryIntent,
      episodicWeakRecall,
    }),
    softenClaims,
    reason: null,
  };
}

export function createMemoryTool(params: {
  userId: string;
  requestId: string;
  now: Date;
  fallbackQuery?: string | null;
}) {
  return createTool({
    id: "get-memory-context",
    description:
      "Retrieves relevant past user information and conversation history. Use this tool when answering questions about people, relationships, past events, what the user said previously, or when you need to verify user-specific facts so the answer stays accurate and up to date.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("A short semantic memory retrieval query."),
      memoryIntent: z
        .enum(["exact", "episodic", "hybrid"])
        .optional()
        .describe(
          "Optional retrieval strategy override. exact=facts, episodic=conversation threads, hybrid=both."
        ),
    }),
    outputSchema: z.object({
      used: z.boolean(),
      query: z.string().nullable(),
      supplementalContext: z.string().nullable(),
      softenClaims: z.boolean(),
      reason: z.string().nullable(),
    }),
    inputExamples: [
      { input: { query: "Ashley relationship status recent changes" } },
      { input: { query: "Jasmine text message yesterday" } },
    ],
    execute: async ({ query, memoryIntent }) =>
      runMemoryLookup({
        userId: params.userId,
        requestId: params.requestId,
        now: params.now,
        query: normalizeMemoryToolQuery({
          query,
          fallbackQuery: params.fallbackQuery,
        }),
        memoryIntent: memoryIntent ?? null,
      }),
  });
}
