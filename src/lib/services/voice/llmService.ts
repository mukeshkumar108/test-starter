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
    const model = getChatModelForPersona(personaSlug);
    
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
        max_tokens: 1000,
        temperature: 0.7,
        stream: false, // For v0.1, use non-streaming
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter LLM failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      content: data.choices?.[0]?.message?.content || "I'm having trouble responding right now.",
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error("LLM Service Error:", error);
    throw new Error("Language model response failed");
  }
}