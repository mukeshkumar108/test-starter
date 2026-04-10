import type { AISDKMessage } from "@/lib/llm/aiSdkCompletion";
import { createMastraRuntime } from "@/mastra";
import { runMemoryLookup } from "@/mastra/tools/memory";
import { env } from "@/env";
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

function extractLastUserMessage(messages: AISDKMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string") {
      return message.content.trim();
    }
  }
  return "";
}

function looksLikeRecallQuestion(message: string) {
  const lowered = message.toLowerCase();
  const signals = [
    "remember",
    "who is",
    "what do you remember",
    "what was i saying",
    "what did we decide",
    "continue that thread",
    "from before",
  ];
  return signals.some((signal) => lowered.includes(signal));
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

  let memoryPrefetchMs: number | undefined;
  let prefetchMs: number | undefined;
  let prefetchSupplementalContext: string | null = null;
  const shouldPrefetchMemory = looksLikeRecallQuestion(lastUserMessage);
  if (shouldPrefetchMemory) {
    const memoryPrefetchStartedAt = Date.now();
    const prefetch = await runMemoryLookup({
      userId: params.userId,
      requestId: params.requestId,
      now: params.now,
      query: lastUserMessage || "recent user context",
    }).catch(() => null);
    memoryPrefetchMs = Math.max(0, Date.now() - memoryPrefetchStartedAt);
    prefetchMs = memoryPrefetchMs;
    if (prefetch?.used && prefetch.supplementalContext) {
      prefetchSupplementalContext = prefetch.supplementalContext;
      console.log(
        "[mastra.memory.prefetch.used]",
        JSON.stringify({
          requestId: params.requestId,
          query: prefetch.query,
          chosenModel: orchestrationModel,
        })
      );
    } else {
      console.log(
        "[mastra.memory.prefetch.skipped]",
        JSON.stringify({
          requestId: params.requestId,
          query: lastUserMessage || null,
          reason: prefetch?.reason ?? "no_results",
          chosenModel: orchestrationModel,
        })
      );
    }
  }

  const { assistant } = createMastraRuntime({
    userId: params.userId,
    requestId: params.requestId,
    now: params.now,
    instructions: `${params.instructions}

This is a real-time push-to-talk voice turn. Do not expose tool-call markup, XML-like tags, or internal reasoning. Give one clean spoken answer only.

If a tool returns results, use them naturally without exposing tool names, internal structure, or raw data.`.trim(),
    model: orchestrationModel,
    fallbackMemoryQuery: lastUserMessage,
  });

  const messagesWithPrefetch = prefetchSupplementalContext
    ? ([
        {
          role: "system",
          content: `[PREFETCHED_MEMORY_CONTEXT]\n${prefetchSupplementalContext}`,
        },
        ...params.messages,
      ] as AISDKMessage[])
    : params.messages;

  const generationStartedAt = Date.now();
  const result = await assistant.generate(messagesWithPrefetch as unknown as MessageInput[], {
    maxSteps: 3,
    toolChoice: "auto",
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
    result.toolCalls?.some(
      (toolCall) =>
        typeof toolCall === "object" &&
        toolCall !== null &&
        "toolName" in toolCall &&
        toolCall.toolName === "memoryTool"
    ) ?? false;
  const webToolUsed =
    result.toolCalls?.some(
      (toolCall) =>
        typeof toolCall === "object" &&
        toolCall !== null &&
        "toolName" in toolCall &&
        toolCall.toolName === "searchWeb"
    ) ?? false;
  const memoryToolQuery =
    result.toolCalls?.map(extractMemoryToolQuery).find((query) => Boolean(query)) ?? null;
  const webToolQuery =
    result.toolCalls?.map(extractWebToolQuery).find((query) => Boolean(query)) ?? null;

  if (memoryToolUsed) {
    console.log(
      "[mastra.memory.tool.used]",
      JSON.stringify({
        requestId: params.requestId,
        query: memoryToolQuery,
        chosenModel: orchestrationModel,
      })
    );
  } else {
    console.log(
      "[mastra.memory.tool.skipped]",
      JSON.stringify({
        requestId: params.requestId,
        user_message: lastUserMessage,
        chosenModel: orchestrationModel,
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
      prefetch_ms: prefetchMs,
      memory_prefetch_ms: memoryPrefetchMs,
      web_prefetch_ms: undefined,
      final_generation_ms: finalGenerationMs,
    },
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    modelUsed: orchestrationModel,
    memoryToolUsed,
    memoryToolQuery,
    webToolUsed,
    webToolQuery,
  };
}
