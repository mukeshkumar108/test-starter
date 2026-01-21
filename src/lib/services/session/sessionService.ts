import { prisma } from "@/lib/prisma";
import { env } from "@/env";

const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

function isSummaryEnabled() {
  return env.FEATURE_SESSION_SUMMARY === "true";
}

async function createSessionSummary(session: {
  id: string;
  userId: string;
  personaId: string;
  startedAt: Date;
  lastActivityAt: Date;
}) {
  const messages = await prisma.message.findMany({
    where: {
      userId: session.userId,
      personaId: session.personaId,
      createdAt: {
        gte: session.startedAt,
        lte: session.lastActivityAt,
      },
    },
    orderBy: { createdAt: "asc" },
    take: 30,
    select: { role: true, content: true },
  });

  if (messages.length === 0) return null;

  const prompt = `Summarize this session in 1-2 short sentences. Return JSON only.\n\nJSON schema:\n{ "summary": "..." }\n\nTranscript:\n${messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")}`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://github.com/your-repo",
      "X-Title": "Walkie-Talkie Voice Companion",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.2,
    }),
  });

  if (!response.ok) return null;

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  let summary = content.trim();

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.summary === "string") {
      summary = parsed.summary.trim();
    }
  } catch {
    // Keep raw content if JSON parsing fails.
  }

  if (!summary) return null;

  return prisma.sessionSummary.create({
    data: {
      sessionId: session.id,
      userId: session.userId,
      personaId: session.personaId,
      summary: summary.slice(0, 600),
      model: "openai/gpt-4o-mini",
    },
  });
}

export async function closeStaleSessionIfAny(
  userId: string,
  personaId: string,
  now: Date
) {
  const cutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS);
  const staleSession = await prisma.session.findFirst({
    where: {
      userId,
      personaId,
      endedAt: null,
      lastActivityAt: { lt: cutoff },
    },
    orderBy: { lastActivityAt: "desc" },
  });

  if (!staleSession) return null;

  const endedAt = staleSession.lastActivityAt ?? now;
  const updated = await prisma.session.update({
    where: { id: staleSession.id },
    data: { endedAt },
  });

  if (isSummaryEnabled()) {
    await createSessionSummary({
      id: updated.id,
      userId: updated.userId,
      personaId: updated.personaId,
      startedAt: updated.startedAt,
      lastActivityAt: updated.lastActivityAt,
    });
  }

  return updated;
}

export async function ensureActiveSession(
  userId: string,
  personaId: string,
  now: Date
) {
  await closeStaleSessionIfAny(userId, personaId, now);
  const cutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS);
  const activeSession = await prisma.session.findFirst({
    where: {
      userId,
      personaId,
      endedAt: null,
      lastActivityAt: { gte: cutoff },
    },
    orderBy: { lastActivityAt: "desc" },
  });

  if (activeSession) {
    return prisma.session.update({
      where: { id: activeSession.id },
      data: {
        lastActivityAt: now,
        turnCount: { increment: 1 },
      },
    });
  }

  return prisma.session.create({
    data: {
      userId,
      personaId,
      startedAt: now,
      lastActivityAt: now,
      turnCount: 1,
    },
  });
}

export async function getLatestSessionSummary(userId: string, personaId: string) {
  return prisma.sessionSummary.findFirst({
    where: { userId, personaId },
    orderBy: { createdAt: "desc" },
  });
}
