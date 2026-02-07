import { safeChatCompletion } from "@/lib/llm/safeCompletion";

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMResponse {
  content: string;
  duration_ms: number;
}

export async function generateResponse(
  messages: LLMMessage[],
  personaSlug: string,
): Promise<LLMResponse> {
  const startTime = Date.now();
  
  const isSophie = personaSlug === "creative";
  const maxTokens = isSophie ? 350 : 1000;
  const temperature = 0.7;

  const content = await safeChatCompletion(messages, {
    maxTokens,
    temperature,
    ...(isSophie ? { topP: 0.9, presencePenalty: 0.1 } : {}),
  });

  return {
    content,
    duration_ms: Date.now() - startTime,
  };
}
