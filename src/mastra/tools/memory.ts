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
  entities?: Array<{ summary?: string; type?: string; uuid?: string }>;
  metadata?: { query?: string; facts?: number; entities?: number };
};

type RecallFactRelevanceTier = "recent" | "persistent" | "stale";

type NormalizedRecallFact = {
  text: string;
  relevanceTier: RecallFactRelevanceTier | null;
};

type MemoryLookupPayload = {
  facts?: Array<
    | string
    | {
        text?: string;
        relevance_tier?: string | null;
      }
  >;
  entities?: Array<{ summary?: string; type?: string; uuid?: string }>;
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
  const factRows: NormalizedRecallFact[] = Array.isArray(data?.facts)
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
        .sort((a, b) => recallFactTierSortRank(a.relevanceTier) - recallFactTierSortRank(b.relevanceTier))
    : [];

  const facts = factRows.map((fact) => fact.text);
  const entities = Array.isArray(data?.entities)
    ? data.entities
        .map((entity) => (typeof entity?.summary === "string" ? entity.summary.trim() : ""))
        .filter(Boolean)
    : [];

  return { facts, entities, factRows };
}

function buildRecallSheet(params: {
  query: string;
  facts: string[];
  factRows?: NormalizedRecallFact[];
  entities: string[];
  profileMatches?: string[];
  includeStaleFacts?: boolean;
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
  if ((params.profileMatches?.length ?? 0) > 0) {
    lines.push("Profile:");
    for (const line of (params.profileMatches ?? []).slice(0, 3)) {
      lines.push(`- ${line}`);
    }
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
}) {
  const response = await fetch(`${env.SYNAPSE_BASE_URL}/memory/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: SYNAPSE_CANONICAL_TENANT_ID,
      userId: params.userId,
      query: params.query,
      limit: 10,
      referenceTime: params.now.toISOString(),
      includeContext: false,
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

export async function runMemoryLookup(params: {
  userId: string;
  requestId: string;
  now: Date;
  query: string;
}) {
  if (!env.SYNAPSE_BASE_URL) {
    return {
      used: false,
      query: params.query,
      supplementalContext: null,
      reason: "synapse_unconfigured",
    };
  }

  const [userModel, queryResult] = await Promise.all([
    fetchUserModel({ userId: params.userId }).catch(() => null),
    querySynapseMemory({
      userId: params.userId,
      now: params.now,
      query: params.query,
    }),
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
      reason: "synapse_error",
    };
  }

  const { facts, entities, factRows } = normalizeMemoryQueryResponse(queryResult.data);
  const profileMatches = extractRelevantUserModelLines({
    query: params.query,
    candidates: [params.query],
    userModel,
  });

  const recallFacts = factRows
    .filter((fact) => fact.relevanceTier !== "stale")
    .map((fact) => fact.text);

  if (recallFacts.length === 0 && entities.length === 0 && profileMatches.length === 0) {
    return {
      used: false,
      query: params.query,
      supplementalContext: null,
      reason: "no_results",
    };
  }

  return {
    used: true,
    query: params.query,
    supplementalContext: buildRecallSheet({
      query: params.query,
      facts,
      factRows,
      entities,
      profileMatches,
      includeStaleFacts: false,
    }),
    reason: null,
  };
}

export function createMemoryTool(params: {
  userId: string;
  requestId: string;
  now: Date;
}) {
  return createTool({
    id: "get-memory-context",
    description:
      "Retrieves relevant past user information and conversation history. Use this tool when answering questions about people, relationships, past events, what the user said previously, or when you need to verify user-specific facts so the answer stays accurate and up to date.",
    inputSchema: z.object({
      query: z.string().min(1).max(120).describe("A short semantic memory retrieval query."),
    }),
    outputSchema: z.object({
      used: z.boolean(),
      query: z.string().nullable(),
      supplementalContext: z.string().nullable(),
      reason: z.string().nullable(),
    }),
    inputExamples: [
      { input: { query: "Ashley relationship status recent changes" } },
      { input: { query: "Jasmine text message yesterday" } },
    ],
    execute: async ({ query }) =>
      runMemoryLookup({
        userId: params.userId,
        requestId: params.requestId,
        now: params.now,
        query,
      }),
  });
}
