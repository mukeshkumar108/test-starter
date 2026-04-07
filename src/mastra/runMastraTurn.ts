import type { AISDKMessage } from "@/lib/llm/aiSdkCompletion";
import { createMastraRuntime } from "@/mastra";
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

export async function runMastraTurn(params: {
  userId: string;
  requestId: string;
  now: Date;
  chosenModel: string;
  instructions: string;
  messages: AISDKMessage[];
}) {
  const startedAt = Date.now();
  const { assistant } = createMastraRuntime({
    userId: params.userId,
    requestId: params.requestId,
    now: params.now,
    instructions: params.instructions,
    model: params.chosenModel,
  });

  const result = await assistant.generate(params.messages as unknown as MessageInput[], {
    model: {
      id: params.chosenModel as `${string}/${string}`,
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
  const memoryToolQuery =
    result.toolCalls?.map(extractMemoryToolQuery).find((query) => Boolean(query)) ?? null;

  return {
    assistantText: result.text,
    llm_ms: Math.max(0, Date.now() - startedAt),
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    memoryToolUsed,
    memoryToolQuery,
  };
}
