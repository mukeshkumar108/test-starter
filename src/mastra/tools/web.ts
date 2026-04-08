import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { env } from "@/env";

type TavilySearchResponse = {
  answer?: string;
  query?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
};

type WebSearchMode = "voice_fast" | "deep_research";

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildWebResultSheet(params: {
  query: string;
  answer: string | null;
  results: Array<{ title: string | null; url: string | null; content: string | null }>;
}) {
  const lines: string[] = [];
  lines.push(`Web Results (query: ${params.query})`);
  if (params.answer) {
    lines.push(`Summary: ${params.answer}`);
  }
  if (params.results.length > 0) {
    lines.push("Sources:");
    for (const result of params.results.slice(0, 3)) {
      const label = result.title ?? result.url ?? "Untitled result";
      const suffix = result.url ? ` (${result.url})` : "";
      lines.push(`- ${label}${suffix}`);
      if (result.content) {
        const excerpt =
          result.content.length > 240
            ? `${result.content.slice(0, 237).trim()}...`
            : result.content;
        lines.push(`  ${excerpt}`);
      }
    }
  }
  return lines.join("\n");
}

export async function runWebSearch(params: {
  requestId: string;
  query: string;
  mode?: WebSearchMode;
}) {
  if (!env.TAVILY_API_KEY) {
    return {
      used: false,
      query: params.query,
      supplementalContext: null,
      reason: "tavily_unconfigured",
    };
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query: params.query,
      search_depth: params.mode === "deep_research" ? "advanced" : "basic",
      include_answer: true,
      max_results: params.mode === "deep_research" ? 5 : 3,
    }),
  });

  if (!response.ok) {
    console.warn("[mastra.web.search.failed]", {
      requestId: params.requestId,
      status: response.status,
    });
    return {
      used: false,
      query: params.query,
      supplementalContext: null,
      reason: `http_${response.status}`,
    };
  }

  const data = (await response.json()) as TavilySearchResponse;
  const answer = cleanString(data.answer);
  const results = Array.isArray(data.results)
    ? data.results
        .map((result) => ({
          title: cleanString(result.title),
          url: cleanString(result.url),
          content: cleanString(result.content),
        }))
        .filter((result) => Boolean(result.title || result.url || result.content))
    : [];

  if (!answer && results.length === 0) {
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
    supplementalContext: buildWebResultSheet({
      query: params.query,
      answer,
      results,
    }),
    reason: null,
  };
}

export function createWebSearchTool(params: {
  requestId: string;
}) {
  return createTool({
    id: "search-web",
    description:
      "Searches the live web for current external information. Use this tool when the user asks about current events, recent facts, products, recommendations, websites, or anything that may have changed since training. Prefer this over guessing when external reality matters.",
    inputSchema: z.object({
      query: z.string().min(2).max(200).describe("A concise web search query."),
    }),
    outputSchema: z.object({
      used: z.boolean(),
      query: z.string().nullable(),
      supplementalContext: z.string().nullable(),
      reason: z.string().nullable(),
    }),
    inputExamples: [
      { input: { query: "weather in Cambridge today" } },
      { input: { query: "latest OpenAI model release" } },
    ],
    execute: async ({ query }) =>
      runWebSearch({
        requestId: params.requestId,
        query,
        mode: "voice_fast",
      }),
  });
}
