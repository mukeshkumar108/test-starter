import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { env } from "@/env";
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
  return lines.join("\n");
}

export function createMemoryTool(params: {
  userId: string;
  requestId: string;
  now: Date;
}) {
  return createTool({
    id: "get-memory-context",
    description:
      "Retrieve relevant long-term memory context from Synapse when prior conversation context would help answer well.",
    inputSchema: z.object({
      query: z.string().min(1).max(120).describe("A short semantic memory retrieval query."),
    }),
    outputSchema: z.object({
      used: z.boolean(),
      query: z.string().nullable(),
      supplementalContext: z.string().nullable(),
      reason: z.string().nullable(),
    }),
    execute: async ({ query }) => {
      if (!env.SYNAPSE_BASE_URL) {
        return {
          used: false,
          query,
          supplementalContext: null,
          reason: "synapse_unconfigured",
        };
      }

      const response = await fetch(`${env.SYNAPSE_BASE_URL}/memory/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: SYNAPSE_CANONICAL_TENANT_ID,
          userId: params.userId,
          query,
          limit: 10,
          referenceTime: params.now.toISOString(),
          includeContext: false,
        }),
      });

      if (!response.ok) {
        console.warn("[mastra.memory.query.failed]", {
          requestId: params.requestId,
          status: response.status,
        });
        return {
          used: false,
          query,
          supplementalContext: null,
          reason: `http_${response.status}`,
        };
      }

      const data = (await response.json()) as MemoryQueryResponse;
      const { facts, entities, factRows } = normalizeMemoryQueryResponse(data);
      const recallFacts = factRows
        .filter((fact) => fact.relevanceTier !== "stale")
        .map((fact) => fact.text);

      if (recallFacts.length === 0 && entities.length === 0) {
        return {
          used: false,
          query,
          supplementalContext: null,
          reason: "no_results",
        };
      }

      return {
        used: true,
        query,
        supplementalContext: buildRecallSheet({
          query,
          facts,
          factRows,
          entities,
          includeStaleFacts: false,
        }),
        reason: null,
      };
    },
  });
}
