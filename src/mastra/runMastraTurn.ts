import type { AISDKMessage } from "@/lib/llm/aiSdkCompletion";
import { createMastraRuntime } from "@/mastra";
import type { MessageInput } from "@mastra/core/agent/message-list";

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

  return {
    assistantText: result.text,
    llm_ms: Math.max(0, Date.now() - startedAt),
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
  };
}
