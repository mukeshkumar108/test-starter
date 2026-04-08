import type { AISDKMessage } from "@/lib/llm/aiSdkCompletion";
import { createMastraRuntime } from "@/mastra";
import { env } from "@/env";
import { runMemoryLookup } from "@/mastra/tools/memory";
import { runWebSearch } from "@/mastra/tools/web";
import type { MessageInput } from "@mastra/core/agent/message-list";

function extractMemoryToolQuery(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if ("args" in value && value.args && typeof value.args === "object" && "query" in value.args) {
    const query = (value.args as { query?: unknown }).query;
    return typeof query === "string" && query.trim() ? query.trim() : null;
  }
  if ("input" in value && value.input && typeof value.input === "object" && "query" in value.input) {
    const query = (value.input as { query?: unknown }).query;
    return typeof query === "string" && query.trim() ? query.trim() : null;
  }
  if ("output" in value && value.output && typeof value.output === "object" && "query" in value.output) {
    const query = (value.output as { query?: unknown }).query;
    return typeof query === "string" && query.trim() ? query.trim() : null;
  }
  return null;
}

function extractWebToolQuery(value: unknown): string | null {
  return extractMemoryToolQuery(value);
}

function looksLikeCurrentInfoQuestion(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("weather") ||
    normalized.includes("news") ||
    normalized.includes("headline") ||
    normalized.includes("headlines") ||
    normalized.includes("today") ||
    normalized.includes("latest") ||
    normalized.includes("right now") ||
    normalized.includes("current") ||
    normalized.includes("price") ||
    normalized.includes("released") ||
    normalized.includes("events in") ||
    normalized.includes("what's happening in") ||
    normalized.includes("what is happening in")
  );
}

async function buildPrefetchedSupplementalContext(params: {
  userId: string;
  requestId: string;
  now: Date;
  lastUserMessage: string;
}) {
  const startedAt = Date.now();
  const sections: string[] = [];
  let memoryPrefetchUsed = false;
  let webPrefetchUsed = false;
  let memoryPrefetchQuery: string | null = null;
  let webPrefetchQuery: string | null = null;
  let memoryLookupAttempted = false;
  let webLookupAttempted = false;
  let memoryLookupReason: string | null = null;
  let webLookupReason: string | null = null;
  let memoryPrefetchMs = 0;
  let webPrefetchMs = 0;

  if (looksLikeRecallQuestion(params.lastUserMessage)) {
    memoryLookupAttempted = true;
    const memoryStartedAt = Date.now();
    const memoryResult = await runMemoryLookup({
      userId: params.userId,
      requestId: params.requestId,
      now: params.now,
      query: params.lastUserMessage,
    });
    memoryPrefetchMs = Math.max(0, Date.now() - memoryStartedAt);
    if (memoryResult.used && memoryResult.supplementalContext) {
      memoryPrefetchUsed = true;
      memoryPrefetchQuery = memoryResult.query;
      sections.push(`[VERIFIED_MEMORY]\n${memoryResult.supplementalContext}`);
    } else {
      memoryLookupReason = memoryResult.reason;
    }
  }

  if (looksLikeCurrentInfoQuestion(params.lastUserMessage)) {
    webLookupAttempted = true;
    const webStartedAt = Date.now();
    const webResult = await runWebSearch({
      requestId: params.requestId,
      query: params.lastUserMessage,
    });
    webPrefetchMs = Math.max(0, Date.now() - webStartedAt);
    if (webResult.used && webResult.supplementalContext) {
      webPrefetchUsed = true;
      webPrefetchQuery = webResult.query;
      sections.push(`[VERIFIED_WEB]\n${webResult.supplementalContext}`);
    } else {
      webLookupReason = webResult.reason;
    }
  }

  return {
    supplementalContext: sections.length > 0 ? sections.join("\n\n") : null,
    memoryPrefetchUsed,
    memoryPrefetchQuery,
    webPrefetchUsed,
    webPrefetchQuery,
    memoryLookupAttempted,
    webLookupAttempted,
    memoryLookupReason,
    webLookupReason,
    prefetch_ms: Math.max(0, Date.now() - startedAt),
    memory_prefetch_ms: memoryPrefetchMs,
    web_prefetch_ms: webPrefetchMs,
  };
}

function extractLastUserMessage(messages: AISDKMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string") {
      return message.content.trim();
    }
  }
  return "";
}

function looksLikeRecallQuestion(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("remember") ||
    normalized.includes("earlier") ||
    normalized.includes("previous") ||
    normalized.includes("what did i") ||
    normalized.includes("who is") ||
    normalized.includes("who was") ||
    normalized.includes("told you") ||
    normalized.includes("mentioned") ||
    normalized.includes("my friend") ||
    normalized.includes("my ex") ||
    normalized.includes("my partner")
  );
}

export async function runMastraTurn(params: {
  userId: string;
  requestId: string;
  now: Date;
  chosenModel: string;
  instructions: string;
  messages: AISDKMessage[];
}) {
  const startedAt = Date.now();
  const orchestrationModel = env.MASTRA_ORCHESTRATION_MODEL?.trim() || params.chosenModel;
  const lastUserMessage = extractLastUserMessage(params.messages);
  const prefetchedContext = await buildPrefetchedSupplementalContext({
    userId: params.userId,
    requestId: params.requestId,
    now: params.now,
    lastUserMessage,
  });
  const { assistant } = createMastraRuntime({
    userId: params.userId,
    requestId: params.requestId,
    now: params.now,
    instructions:
      `${params.instructions}

This is a real-time push-to-talk voice turn. Do not expose tool-call markup, XML-like tags, or internal reasoning. Give one clean spoken answer only.

If verified retrieval context is provided below, treat it as authoritative for this turn. Use it directly and naturally. Do not say you are checking or looking things up if the answer is already present here.

If the user asks for live or current external information and no verified web result is provided, be honest that you do not have verified live data for this turn. Do not guess.

If the user asks about prior conversations, relationships, or earlier events and no verified memory result is provided, be honest that you cannot verify that memory right now. Do not guess.

${prefetchedContext.supplementalContext ?? ""}`.trim(),
    model: orchestrationModel,
  });

  const generationStartedAt = Date.now();
  const result = await assistant.generate(params.messages as unknown as MessageInput[], {
    maxSteps: 1,
    toolChoice: "none",
    model: {
      id: orchestrationModel as `${string}/${string}`,
      url: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      headers: {
        ...(process.env.OPENROUTER_APP_URL
          ? { "HTTP-Referer": process.env.OPENROUTER_APP_URL }
          : {}),
        ...(process.env.OPENROUTER_APP_NAME
          ? { "X-Title": process.env.OPENROUTER_APP_NAME }
          : {}),
      },
    },
  });

  const memoryToolUsed =
    result.toolCalls?.some((toolCall) =>
      typeof toolCall === "object" &&
      toolCall !== null &&
      "toolName" in toolCall &&
      toolCall.toolName === "memoryTool"
    ) ?? false;
  const webToolUsed =
    result.toolCalls?.some((toolCall) =>
      typeof toolCall === "object" &&
      toolCall !== null &&
      "toolName" in toolCall &&
      toolCall.toolName === "searchWeb"
    ) ?? false;
  const memoryToolQuery =
    result.toolCalls?.map(extractMemoryToolQuery).find((query) => Boolean(query)) ?? null;
  const webToolQuery =
    result.toolCalls?.map(extractWebToolQuery).find((query) => Boolean(query)) ?? null;
  if (!memoryToolUsed && looksLikeRecallQuestion(lastUserMessage)) {
    console.log(
      "[mastra.memory.decision]",
      JSON.stringify({
        requestId: params.requestId,
        used_memory_tool: false,
        chosenModel: orchestrationModel,
        user_message: lastUserMessage,
      })
    );
  }

  const finalGenerationMs = Math.max(0, Date.now() - generationStartedAt);
  const totalMs = Math.max(0, Date.now() - startedAt);

  return {
    assistantText: result.text,
    llm_ms: finalGenerationMs,
    timings: {
      mastra_total_ms: totalMs,
      prefetch_ms: prefetchedContext.prefetch_ms,
      memory_prefetch_ms: prefetchedContext.memory_prefetch_ms,
      web_prefetch_ms: prefetchedContext.web_prefetch_ms,
      final_generation_ms: finalGenerationMs,
    },
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    modelUsed: orchestrationModel,
    memoryToolUsed: memoryToolUsed || prefetchedContext.memoryPrefetchUsed,
    memoryToolQuery: memoryToolQuery ?? prefetchedContext.memoryPrefetchQuery,
    webToolUsed: webToolUsed || prefetchedContext.webPrefetchUsed,
    webToolQuery: webToolQuery ?? prefetchedContext.webPrefetchQuery,
  };
}
