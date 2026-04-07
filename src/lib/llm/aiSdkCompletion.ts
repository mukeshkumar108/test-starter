import { generateText } from "ai";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { env } from "@/env";

export interface AISDKMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AISDKCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  model: string;
}

export interface AISDKCompletionResult {
  content: string;
  llm_ms: number;
  providerUsed: "openrouter" | "openai" | "safe_text";
  modelUsed: string;
  fallbackUsed: boolean;
  emergencyUsed: boolean;
  finalSafeTextUsed: boolean;
}

const FALLBACK_MODEL = "meta-llama/llama-3.1-8b-instruct";
const EMERGENCY_MODEL = "gpt-4o-mini";
const FINAL_SAFE_TEXT = "I'm having trouble responding right now.";

const PRIMARY_TIMEOUT_MS = 25_000;
const FALLBACK_TIMEOUT_MS = 15_000;
const EMERGENCY_TIMEOUT_MS = 15_000;

function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]);
}

function isTimeout(error: unknown) {
  return error instanceof Error && error.message === "timeout";
}

const BREAKDOWN_REGEX = /\*\*Breakdown:\*\*[\s\S]*/i;

function stripReasoningLeak(text: string) {
  const cleaned = text.replace(BREAKDOWN_REGEX, "").trim();
  return { cleaned, stripped: cleaned !== text };
}

function getOpenRouterProvider() {
  return createOpenAI({
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    headers: {
      ...(env.OPENROUTER_APP_URL ? { "HTTP-Referer": env.OPENROUTER_APP_URL } : {}),
      ...(env.OPENROUTER_APP_NAME ? { "X-Title": env.OPENROUTER_APP_NAME } : {}),
    },
  });
}

async function openRouterChatViaAISDK(
  messages: AISDKMessage[],
  options: AISDKCompletionOptions
) {
  const provider = getOpenRouterProvider();
  const result = await generateText({
    model: provider.chat(options.model),
    messages,
    temperature: options.temperature,
    maxOutputTokens: options.maxTokens,
    topP: options.topP,
    presencePenalty: options.presencePenalty,
    providerOptions: {
      openai: {
        reasoning: { exclude: true },
        ...(typeof options.topK === "number" ? { top_k: options.topK } : {}),
        ...(typeof options.repetitionPenalty === "number"
          ? { repetition_penalty: options.repetitionPenalty }
          : {}),
      },
    },
  });
  const raw = result.text.trim();
  const { cleaned, stripped } = stripReasoningLeak(raw);
  if (stripped) {
    console.warn("[llm.reasoning.strip]", { provider: "openrouter", model: options.model });
  }
  return cleaned;
}

async function openRouterChatFallback(
  messages: AISDKMessage[],
  model: string,
  options: Omit<AISDKCompletionOptions, "model">
) {
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
  const data = await response.json();
  const raw = String(data?.choices?.[0]?.message?.content ?? "").trim();
  return stripReasoningLeak(raw).cleaned;
}

async function openAIChatFallback(
  messages: AISDKMessage[],
  options: Omit<AISDKCompletionOptions, "model">
) {
  const result = await generateText({
    model: openai.chat(EMERGENCY_MODEL),
    messages,
    temperature: options.temperature,
    maxOutputTokens: options.maxTokens,
    topP: options.topP,
    presencePenalty: options.presencePenalty,
  });
  return result.text.trim();
}

export async function aiSdkCompletion(
  messages: AISDKMessage[],
  options: AISDKCompletionOptions
): Promise<AISDKCompletionResult> {
  const startedAt = Date.now();
  try {
    const content = await runWithTimeout(
      openRouterChatViaAISDK(messages, options),
      PRIMARY_TIMEOUT_MS
    );
    return {
      content,
      llm_ms: Date.now() - startedAt,
      providerUsed: "openrouter",
      modelUsed: options.model,
      fallbackUsed: false,
      emergencyUsed: false,
      finalSafeTextUsed: false,
    };
  } catch (error) {
    if (isTimeout(error)) {
      console.warn("[llm.primary.timeout]");
    } else {
      console.warn("[llm.primary.error]", error);
    }
  }

  console.warn("[llm.fallback.used]");
  try {
    const content = await runWithTimeout(
      openRouterChatFallback(messages, FALLBACK_MODEL, options),
      FALLBACK_TIMEOUT_MS
    );
    return {
      content,
      llm_ms: Date.now() - startedAt,
      providerUsed: "openrouter",
      modelUsed: FALLBACK_MODEL,
      fallbackUsed: true,
      emergencyUsed: false,
      finalSafeTextUsed: false,
    };
  } catch (error) {
    if (isTimeout(error)) {
      console.warn("[llm.fallback.timeout]");
    } else {
      console.warn("[llm.fallback.error]", error);
    }
  }

  console.warn("[llm.emergency.used]");
  try {
    const content = await runWithTimeout(
      openAIChatFallback(messages, options),
      EMERGENCY_TIMEOUT_MS
    );
    return {
      content,
      llm_ms: Date.now() - startedAt,
      providerUsed: "openai",
      modelUsed: EMERGENCY_MODEL,
      fallbackUsed: true,
      emergencyUsed: true,
      finalSafeTextUsed: false,
    };
  } catch (error) {
    if (isTimeout(error)) {
      console.warn("[llm.emergency.timeout]");
    } else {
      console.warn("[llm.emergency.error]", error);
    }
  }

  return {
    content: FINAL_SAFE_TEXT,
    llm_ms: Date.now() - startedAt,
    providerUsed: "safe_text",
    modelUsed: FINAL_SAFE_TEXT,
    fallbackUsed: true,
    emergencyUsed: true,
    finalSafeTextUsed: true,
  };
}

export const __test__FINAL_SAFE_TEXT = FINAL_SAFE_TEXT;
