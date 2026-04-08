import type { AISDKMessage } from "@/lib/llm/aiSdkCompletion";
import { createMastraRuntime } from "@/mastra";
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
  const { assistant } = createMastraRuntime({
    userId: params.userId,
    requestId: params.requestId,
    now: params.now,
    instructions: params.instructions,
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
  const lastUserMessage = extractLastUserMessage(params.messages);

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
    memoryToolUsed,
    memoryToolQuery,
    webToolUsed,
    webToolQuery,
  };
}
