import { env } from "@/env";
import { getChatModelForPersona } from "@/lib/providers/models";

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
  
  try {
    const isSophie = personaSlug === "creative";
    const model = getChatModelForPersona(personaSlug);
    const maxTokens = isSophie ? 120 : 1000;
    const temperature = isSophie ? 0.55 : 0.7;
    
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/your-repo", // Required by OpenRouter
        "X-Title": "Walkie-Talkie Voice Companion",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(isSophie ? { top_p: 0.9, presence_penalty: 0.3 } : {}),
        stream: false, // For v0.1, use non-streaming
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter LLM failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    const content = data.choices?.[0]?.message?.content || "I'm having trouble responding right now.";
    const trimmed = isSophie ? applyBrevityGovernor(content, messages) : content;

    return {
      content: trimmed,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error("LLM Service Error:", error);
    throw new Error("Language model response failed");
  }
}

function applyBrevityGovernor(content: string, messages: LLMMessage[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const isExplain = /\b(explain|how|why)\b/i.test(lastUser);
  if (isExplain) return content;

  const minCut = 200;
  const maxCut = 380;
  const window = content.slice(minCut, maxCut + 1);
  const match = window.match(/[.!?](\s|$)/);
  const matchIndex = match?.index;
  const cutIndex = matchIndex !== undefined ? minCut + matchIndex + 1 : maxCut;
  return content.slice(0, cutIndex).trim();
}
