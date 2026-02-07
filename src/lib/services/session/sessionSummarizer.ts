import { prisma } from "@/lib/prisma";
import { MODELS } from "@/lib/providers/models";
import { env } from "@/env";

const MAX_MESSAGE_CHARS = 800;
const DEFAULT_TIMEOUT_MS = 2500;
const TEST_STALL_MS = 5000;
const MAX_ONE_LINER_CHARS = 200;
const MAX_TONE_CHARS = 40;
const MAX_LIST_ITEMS = 5;
const MAX_LIST_ITEM_CHARS = 120;

interface SummarizeParams {
  sessionId: string;
  userId: string;
  personaId: string;
  startedAt: Date;
  lastActivityAt: Date;
}

interface SummaryPayload {
  one_liner: string;
  what_mattered: string[];
  open_loops: string[];
  commitments: string[];
  people: string[];
  tone: string;
  parse_error?: boolean;
}

function buildPrompt(messages: Array<{ role: string; content: string }>, previousSummary?: string) {
  const transcript = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  return `Return JSON:\n{\n  "one_liner": "...",\n  "what_mattered": ["..."],\n  "open_loops": ["..."],\n  "commitments": ["..."],\n  "people": ["..."],\n  "tone": "..."\n}\n\nRules:\n- Be concise.\n- Do NOT invent.\n- Prefer extracting user intent + decisions + emotional state.\n- If no meaningful content, return empty arrays and a short one_liner.\n- The assistant persona name is Sophie. Do NOT include Sophie in people[].\n- Do NOT write the one_liner from Sophie's perspective; it should describe the user.\n\n${previousSummary ? `previous_summary: ${previousSummary}\n\n` : ""}Transcript:\n${transcript}`;
}

function stripJsonFence(content: string) {
  return content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function capList(values: string[]) {
  return values
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.slice(0, MAX_LIST_ITEM_CHARS))
    .slice(0, MAX_LIST_ITEMS);
}

function sanitizePeople(values: string[]) {
  return capList(values).filter((value) => !/^sophie\b/i.test(value));
}

function sanitizeOneLiner(value: string) {
  const trimmed = value.trim().slice(0, MAX_ONE_LINER_CHARS);
  if (/^sophie\b/i.test(trimmed)) {
    return trimmed.replace(/^sophie\b/i, "User").trim();
  }
  return trimmed;
}

function fallbackOneLiner(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "Summary unavailable.";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "Summary unavailable.";
  }
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? "";
  return sanitizeOneLiner(firstSentence || trimmed || "Summary unavailable.");
}

function normalizeSummary(content: string): SummaryPayload {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as SummaryPayload;
    if (parsed && typeof parsed.one_liner === "string") {
      return {
        one_liner: sanitizeOneLiner(parsed.one_liner),
        what_mattered: capList(Array.isArray(parsed.what_mattered) ? parsed.what_mattered : []),
        open_loops: capList(Array.isArray(parsed.open_loops) ? parsed.open_loops : []),
        commitments: capList(Array.isArray(parsed.commitments) ? parsed.commitments : []),
        people: sanitizePeople(Array.isArray(parsed.people) ? parsed.people : []),
        tone: typeof parsed.tone === "string" ? parsed.tone.trim().slice(0, MAX_TONE_CHARS) : "unknown",
      };
    }
  } catch {
    // Fall through.
  }

  return {
    one_liner: fallbackOneLiner(cleaned),
    what_mattered: [],
    open_loops: [],
    commitments: [],
    people: [],
    tone: "unknown",
    parse_error: true,
  };
}

function buildFallbackSummary(raw?: string): SummaryPayload {
  return {
    one_liner: fallbackOneLiner(raw ?? ""),
    what_mattered: [],
    open_loops: [],
    commitments: [],
    people: [],
    tone: "unknown",
    parse_error: true,
  };
}

export async function summarizeSession(params: SummarizeParams) {
  if (!env.OPENROUTER_API_KEY) {
    console.warn("Session summarizer skipped: missing OPENROUTER_API_KEY");
    return null;
  }

  if (env.FEATURE_SUMMARY_TEST_STALL === "true") {
    await new Promise((resolve) => setTimeout(resolve, TEST_STALL_MS));
    return null;
  }

  const previous = await prisma.sessionSummary.findUnique({
    where: { sessionId: params.sessionId },
    select: { summary: true },
  });

  const userMessages = await prisma.message.findMany({
    where: {
      userId: params.userId,
      personaId: params.personaId,
      role: "user",
      createdAt: {
        gte: params.startedAt,
        lte: params.lastActivityAt,
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { role: true, content: true, createdAt: true },
  });

  const assistantMessages = await prisma.message.findMany({
    where: {
      userId: params.userId,
      personaId: params.personaId,
      role: "assistant",
      createdAt: {
        gte: params.startedAt,
        lte: params.lastActivityAt,
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { role: true, content: true, createdAt: true },
  });

  const messages = [...userMessages, ...assistantMessages]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_MESSAGE_CHARS),
    }));

  if (messages.length === 0) {
    return null;
  }

  const prompt = buildPrompt(messages, previous?.summary);
  const model = MODELS.SUMMARY || "openai/gpt-4o-mini";

  const timeoutMs = Number.parseInt(env.SUMMARY_TIMEOUT_MS ?? "", 10);
  const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/your-repo",
        "X-Title": "Walkie-Talkie Voice Companion",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("Session summary request timed out");
      return {
        summaryJson: JSON.stringify(buildFallbackSummary()),
        model,
        metadata: {
          parse_error: true,
          truncated: false,
          model,
          createdAt: new Date().toISOString(),
        },
      };
    }
    console.warn("Session summary request failed:", error);
    return {
      summaryJson: JSON.stringify(buildFallbackSummary()),
      model,
      metadata: {
        parse_error: true,
        truncated: false,
        model,
        createdAt: new Date().toISOString(),
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "<no body>");
    console.error("Session summary request failed:", {
      status: response.status,
      statusText: response.statusText,
      body: errText.slice(0, 500),
    });
    return {
      summaryJson: JSON.stringify(buildFallbackSummary(errText)),
      model,
      metadata: {
        parse_error: true,
        truncated: false,
        model,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  const cleaned = stripJsonFence(content);
  let payload: SummaryPayload;
  let parseError = false;

  try {
    JSON.parse(cleaned);
    payload = normalizeSummary(cleaned);
    parseError = Boolean(payload.parse_error);
  } catch {
    payload = buildFallbackSummary(cleaned);
    parseError = true;
  }

  return {
    summaryJson: JSON.stringify(payload),
    model,
    metadata: {
      parse_error: parseError,
      truncated: false,
      model,
      createdAt: new Date().toISOString(),
    },
  };
}

function buildRollingPrompt(
  messages: Array<{ role: string; content: string }>,
  previousSummary?: string
) {
  const transcript = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  return `Summarize the current active session in 1-5 short lines.\n- Include: what we are doing, decisions, open loops surfaced, and tone/state.\n- Be concise. Do NOT invent.\n- Do NOT write from Sophie's perspective.\n- If no meaningful content, return a short single line.\n\n${previousSummary ? `previous_summary: ${previousSummary}\n\n` : ""}Transcript:\n${transcript}`;
}

export async function summarizeRollingSession(params: {
  userId: string;
  personaId: string;
  previousSummary?: string | null;
}) {
  if (!env.OPENROUTER_API_KEY) {
    console.warn("Rolling session summarizer skipped: missing OPENROUTER_API_KEY");
    return params.previousSummary ?? null;
  }

  const userMessages = await prisma.message.findMany({
    where: {
      userId: params.userId,
      personaId: params.personaId,
      role: "user",
    },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { role: true, content: true, createdAt: true },
  });

  const assistantMessages = await prisma.message.findMany({
    where: {
      userId: params.userId,
      personaId: params.personaId,
      role: "assistant",
    },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { role: true, content: true, createdAt: true },
  });

  const messages = [...userMessages, ...assistantMessages]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_MESSAGE_CHARS),
    }));

  if (messages.length === 0) {
    return null;
  }

  const prompt = buildRollingPrompt(messages, params.previousSummary ?? undefined);
  const model = MODELS.SUMMARY || "openai/gpt-4o-mini";

  const timeoutMs = Number.parseInt(env.SUMMARY_TIMEOUT_MS ?? "", 10);
  const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/your-repo",
        "X-Title": "Walkie-Talkie Voice Companion",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("Rolling session summary request timed out");
      return params.previousSummary ?? null;
    }
    console.warn("Rolling session summary request failed:", error);
    return params.previousSummary ?? null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "<no body>");
    console.warn("Rolling session summary request failed:", {
      status: response.status,
      statusText: response.statusText,
      body: errText.slice(0, 500),
    });
    return params.previousSummary ?? null;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  const cleaned = stripJsonFence(content);
  const trimmed = cleaned.trim().slice(0, 600);
  return trimmed || params.previousSummary || null;
}

export async function summarizeRollingSessionFromMessages(params: {
  messages: Array<{ role: string; content: string }>;
  previousSummary?: string | null;
}) {
  if (!env.OPENROUTER_API_KEY) {
    console.warn("Rolling session summarizer skipped: missing OPENROUTER_API_KEY");
    return params.previousSummary ?? null;
  }

  if (params.messages.length === 0) return null;

  const prompt = buildRollingPrompt(params.messages, params.previousSummary ?? undefined);
  const model = MODELS.JUDGE || "xiaomi/mimo-v2-flash";

  const timeoutMs = Number.parseInt(env.SUMMARY_TIMEOUT_MS ?? "", 10);
  const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

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
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn("Rolling session summarizer failed:", response.status);
      return params.previousSummary ?? null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    const cleaned = stripJsonFence(content);
    const trimmed = cleaned.trim();
    return trimmed || params.previousSummary || null;
  } catch (error) {
    console.warn("Rolling session summarizer failed:", error);
    return params.previousSummary ?? null;
  } finally {
    clearTimeout(timeoutId);
  }
}
