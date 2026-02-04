import { env } from "@/env";

const ROUTER_MODEL = "meta-llama/llama-3.2-3b-instruct";
const DEFAULT_TIMEOUT_MS = 1200;

export type QueryRouterResult = {
  should_query: boolean;
  query: string | null;
  confidence: number;
};

function stripJsonFence(content: string) {
  return content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function normalizeResult(value: any): QueryRouterResult | null {
  if (!value || typeof value !== "object") return null;
  const should_query = Boolean(value.should_query);
  const query = typeof value.query === "string" ? value.query.trim() : null;
  const confidence =
    typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? value.confidence
      : 0;
  return { should_query, query: query || null, confidence };
}

export async function queryRouter(
  userText: string,
  lastAssistantTurn?: string | null
): Promise<QueryRouterResult | null> {
  if (!env.OPENROUTER_API_KEY) {
    console.warn("[query.router] missing OPENROUTER_API_KEY");
    return null;
  }

  const prompt = `Decide whether to issue a memory search query for the user's message.

Return ONLY valid JSON:
{"should_query": true|false, "query": "short query or null", "confidence": 0-1}

Rules:
- Use a short query (1-6 words).
- Prefer named entities or salient nouns.
- If it's small talk or generic, return should_query=false.

User: ${userText}
Last assistant: ${lastAssistantTurn ?? ""}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/your-repo",
        "X-Title": "Walkie-Talkie Voice Companion",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ROUTER_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 80,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn("[query.router] request failed", { status: response.status });
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    const cleaned = stripJsonFence(content);
    try {
      return normalizeResult(JSON.parse(cleaned));
    } catch {
      return null;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("[query.router] timeout");
      return null;
    }
    console.warn("[query.router] error", { error });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
