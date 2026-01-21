import { prisma } from "@/lib/prisma";
import { MODELS } from "@/lib/providers/models";
import { env } from "@/env";

const MAX_MESSAGE_CHARS = 800;
const DEFAULT_TIMEOUT_MS = 2500;
const TEST_STALL_MS = 5000;

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
}

function buildPrompt(messages: Array<{ role: string; content: string }>, previousSummary?: string) {
  const transcript = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  return `Return JSON:\n{\n  "one_liner": "...",\n  "what_mattered": ["..."],\n  "open_loops": ["..."],\n  "commitments": ["..."],\n  "people": ["..."],\n  "tone": "..."\n}\n\nRules:\n- Be concise.\n- Do NOT invent.\n- Prefer extracting user intent + decisions + emotional state.\n- If no meaningful content, return empty arrays and a short one_liner.\n\n${previousSummary ? `previous_summary: ${previousSummary}\n\n` : ""}Transcript:\n${transcript}`;
}

function normalizeSummary(content: string): SummaryPayload {
  try {
    const parsed = JSON.parse(content) as SummaryPayload;
    if (parsed && typeof parsed.one_liner === "string") {
      return {
        one_liner: parsed.one_liner.trim(),
        what_mattered: Array.isArray(parsed.what_mattered) ? parsed.what_mattered : [],
        open_loops: Array.isArray(parsed.open_loops) ? parsed.open_loops : [],
        commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
        people: Array.isArray(parsed.people) ? parsed.people : [],
        tone: typeof parsed.tone === "string" ? parsed.tone.trim() : "",
      };
    }
  } catch {
    // Fall through.
  }

  const trimmed = content.trim();
  return {
    one_liner: trimmed.slice(0, 200) || "No meaningful content.",
    what_mattered: [],
    open_loops: [],
    commitments: [],
    people: [],
    tone: "",
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
      return null;
    }
    console.warn("Session summary request failed:", error);
    return null;
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
    return null;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  const normalized = normalizeSummary(content);

  return {
    summaryJson: JSON.stringify(normalized),
    model,
  };
}
