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
  const sections: string[] = [];
  let memoryPrefetchUsed = false;
  let webPrefetchUsed = false;
  let memoryPrefetchQuery: string | null = null;
  let webPrefetchQuery: string | null = null;

  if (looksLikeRecallQuestion(params.lastUserMessage)) {
    const memoryResult = await runMemoryLookup({
      userId: params.userId,
      requestId: params.requestId,
      now: params.now,
      query: params.lastUserMessage,
    });
    if (memoryResult.used && memoryResult.supplementalContext) {
      memoryPrefetchUsed = true;
      memoryPrefetchQuery = memoryResult.query;
      sections.push(memoryResult.supplementalContext);
    }
  }

  if (looksLikeCurrentInfoQuestion(params.lastUserMessage)) {
    const webResult = await runWebSearch({
      requestId: params.requestId,
      query: params.lastUserMessage,
    });
    if (webResult.used && webResult.supplementalContext) {
      webPrefetchUsed = true;
      webPrefetchQuery = webResult.query;
      sections.push(webResult.supplementalContext);
    }
  }

  return {
    supplementalContext: sections.length > 0 ? sections.join("\n\n") : null,
    memoryPrefetchUsed,
    memoryPrefetchQuery,
    webPrefetchUsed,
    webPrefetchQuery,
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
      prefetchedContext.supplementalContext
        ? `${params.instructions}

Verified supplemental context is provided below. Use it directly and naturally for this turn. Do not say you are checking or looking things up if the answer is already present here.

${prefetchedContext.supplementalContext}`
        : params.instructions,
    model: orchestrationModel,
  });

  const result = await assistant.generate(params.messages as unknown as MessageInput[], {
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

  return {
    assistantText: result.text,
    llm_ms: Math.max(0, Date.now() - startedAt),
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    modelUsed: orchestrationModel,
    memoryToolUsed: memoryToolUsed || prefetchedContext.memoryPrefetchUsed,
    memoryToolQuery: memoryToolQuery ?? prefetchedContext.memoryPrefetchQuery,
    webToolUsed: webToolUsed || prefetchedContext.webPrefetchUsed,
    webToolQuery: webToolQuery ?? prefetchedContext.webPrefetchQuery,
  };
}
