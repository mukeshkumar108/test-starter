import { env } from "@/env";

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SafeChatOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  model?: string;
}

const PRIMARY_MODEL = "bytedance-seed/seed-1.6-flash";
const FALLBACK_MODEL = "meta-llama/llama-3.1-8b-instruct";
const EMERGENCY_MODEL = "gpt-4o-mini";

const PRIMARY_TIMEOUT_MS = 25_000;
const FALLBACK_TIMEOUT_MS = 15_000;
const EMERGENCY_TIMEOUT_MS = 15_000;

export function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}

async function openRouterChat(
  messages: LLMMessage[],
  model: string,
  options: SafeChatOptions = {}
) {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("missing_openrouter_api_key");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (env.OPENROUTER_APP_URL) {
    headers["HTTP-Referer"] = env.OPENROUTER_APP_URL;
  }
  if (env.OPENROUTER_APP_NAME) {
    headers["X-Title"] = env.OPENROUTER_APP_NAME;
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      top_k: options.topK,
      presence_penalty: options.presencePenalty,
      repetition_penalty: options.repetitionPenalty,
      reasoning: { exclude: true },
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`openrouter_failed_${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    console.warn("[llm.response.html]", { provider: "openrouter", model });
  }
  const data = await response.json();
  const raw = String(data?.choices?.[0]?.message?.content ?? "").trim();
  const { cleaned, stripped } = stripReasoningLeak(raw);
  if (stripped) {
    console.warn("[llm.reasoning.strip]", { provider: "openrouter", model });
    if (env.FEATURE_CONTEXT_DEBUG === "true") {
      console.debug("[llm.reasoning.raw]", { provider: "openrouter", model, raw });
    }
  }
  return cleaned;
}

async function openAIChat(
  messages: LLMMessage[],
  options: SafeChatOptions = {}
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("missing_openai_api_key");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMERGENCY_MODEL,
      messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      presence_penalty: options.presencePenalty,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`openai_failed_${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    console.warn("[llm.response.html]", { provider: "openai", model: EMERGENCY_MODEL });
  }
  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

function isTimeout(error: unknown) {
  return error instanceof Error && error.message === "timeout";
}

const BREAKDOWN_REGEX = /\*\*Breakdown:\*\*[\s\S]*/i;

function stripReasoningLeak(text: string) {
  const cleaned = text.replace(BREAKDOWN_REGEX, "").trim();
  return { cleaned, stripped: cleaned !== text };
}

export async function safeChatCompletion(
  messages: LLMMessage[],
  options: SafeChatOptions = {}
) {
  const primaryModel = options.model ?? PRIMARY_MODEL;
  try {
    return await runWithTimeout(
      openRouterChat(messages, primaryModel, options),
      PRIMARY_TIMEOUT_MS
    );
  } catch (error) {
    if (isTimeout(error)) {
      console.warn("[llm.primary.timeout]");
    } else {
      console.warn("[llm.primary.error]", error);
    }
  }

  console.warn("[llm.fallback.used]");
  try {
    return await runWithTimeout(
      openRouterChat(messages, FALLBACK_MODEL, options),
      FALLBACK_TIMEOUT_MS
    );
  } catch (error) {
    if (isTimeout(error)) {
      console.warn("[llm.fallback.timeout]");
    } else {
      console.warn("[llm.fallback.error]", error);
    }
  }

  console.warn("[llm.emergency.used]");
  try {
    return await runWithTimeout(
      openAIChat(messages, options),
      EMERGENCY_TIMEOUT_MS
    );
  } catch (error) {
    if (isTimeout(error)) {
      console.warn("[llm.emergency.timeout]");
    } else {
      console.warn("[llm.emergency.error]", error);
    }
  }

  return "I'm having trouble responding right now.";
}
