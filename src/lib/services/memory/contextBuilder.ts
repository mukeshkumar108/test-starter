import { prisma } from "@/lib/prisma";
import { searchMemories } from "@/lib/services/memory/memoryStore";
import { readFile } from "fs/promises";
import { join } from "path";
import { env } from "@/env";
import { getLatestSessionSummary } from "@/lib/services/session/sessionService";

export interface ConversationContext {
  persona: string;
  userSeed?: string;
  sessionState?: any;
  rollingSummary?: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }>;
  foundationMemories: string[];
  relevantMemories: string[];
  commitments: string[];
  threads: string[];
  frictions: string[];
  recentWins: string[];
  summarySpine?: string;
  sessionSummary?: string;
}

const MAX_COMMITMENTS = 5;
const MAX_THREADS = 3;
const MAX_FRICTIONS = 3;
const MAX_FOUNDATION_MEMORIES = 20;
const MAX_USER_SEED_CHARS = 800;
const MAX_SUMMARY_SPINE_CHARS = 1200;
const MAX_RECENT_MESSAGE_CHARS = 800;
const MAX_ROLLING_SUMMARY_CHARS = 600;
const MAX_SESSION_SUMMARY_CHARS = 600;

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:]+$/g, "");
}

function selectRelevantMemories(memories: Array<{ type: string; content: string }>) {
  const allowedTypes = new Set(["PROFILE", "PEOPLE", "PROJECT"]);
  const perTypeCaps: Record<string, number> = {
    PROFILE: 2,
    PEOPLE: 3,
    PROJECT: 3,
  };
  const counts: Record<string, number> = {
    PROFILE: 0,
    PEOPLE: 0,
    PROJECT: 0,
  };
  const seen = new Set<string>();
  const selected: Array<{ type: string; content: string }> = [];

  for (const memory of memories) {
    if (!allowedTypes.has(memory.type)) continue;
    const normalizedContent = normalizeText(memory.content);
    if (seen.has(normalizedContent)) continue;
    if (counts[memory.type] >= perTypeCaps[memory.type]) continue;
    if (selected.length >= 8) break;

    selected.push(memory);
    seen.add(normalizedContent);
    counts[memory.type] += 1;
  }

  return selected;
}

function dedupeTodos(
  todos: Array<{ id: string; content: string; createdAt: Date }>
) {
  const sorted = [...todos].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
  const seen = new Set<string>();
  const deduped: Array<{ id: string; content: string; createdAt: Date }> = [];

  for (const todo of sorted) {
    const normalized = normalizeText(todo.content);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(todo);
  }

  return deduped;
}

function formatSessionSummary(summary?: string | null) {
  if (!summary) return undefined;
  try {
    const parsed = JSON.parse(summary) as {
      one_liner?: string;
      what_mattered?: string[];
      open_loops?: string[];
      commitments?: string[];
      people?: string[];
      tone?: string;
    };
    const parts = [
      parsed.one_liner ? `One-liner: ${parsed.one_liner}` : null,
      parsed.what_mattered?.length ? `What mattered: ${parsed.what_mattered.join("; ")}` : null,
      parsed.open_loops?.length ? `Open loops: ${parsed.open_loops.join("; ")}` : null,
      parsed.commitments?.length ? `Commitments: ${parsed.commitments.join("; ")}` : null,
      parsed.people?.length ? `People: ${parsed.people.join("; ")}` : null,
      parsed.tone ? `Tone: ${parsed.tone}` : null,
    ].filter(Boolean);
    return parts.join(" | ").slice(0, MAX_SESSION_SUMMARY_CHARS);
  } catch {
    return summary.slice(0, MAX_SESSION_SUMMARY_CHARS);
  }
}

export async function buildContext(
  userId: string,
  personaId: string,
  userMessage: string,
): Promise<ConversationContext> {
  try {
    // Get persona profile and prompt
    const persona = await prisma.personaProfile.findUnique({
      where: { id: personaId },
    });
    
    if (!persona) {
      throw new Error("Persona not found");
    }

    // Load persona prompt from file
    const promptPath = join(process.cwd(), persona.promptPath);
    const personaPrompt = await readFile(promptPath, "utf-8");

    // Get user seed (static context)
    const userSeed = await prisma.userSeed.findUnique({
      where: { userId },
    });

    // Get session state for this persona
    const sessionState = await prisma.sessionState.findUnique({
      where: { 
        userId_personaId: { userId, personaId }
      },
    });

    // Get recent messages (last 10)
    const messages = await prisma.message.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        role: true,
        content: true,
        createdAt: true,
      },
    });

    const summarySpineEnabled =
      env.FEATURE_SUMMARY_SPINE_GLOBAL !== "false" &&
      persona.enableSummarySpine !== false;

    // Get latest summary spine
    const summarySpine = summarySpineEnabled
      ? await prisma.summarySpine.findFirst({
          where: {
            userId,
            conversationId: "default",
          },
          orderBy: { version: "desc" },
        })
      : null;

    const latestSessionSummary = await getLatestSessionSummary(userId, personaId);

    const formatMemory = (memory: { content: string; metadata?: any }) => {
      const source = memory.metadata?.source;
      const sourceLabel =
        source === "seeded_profile" ? "GOSPEL" : "OBSERVATION";
      const sourceTag = source ? `${sourceLabel}:${source}` : `${sourceLabel}:unknown`;
      return `[${sourceTag}] ${memory.content}`;
    };

    const foundationMemories = await prisma.memory.findMany({
      where: {
        userId,
        type: { in: ["PROFILE", "PEOPLE", "PROJECT"] },
        pinned: true,
      },
      orderBy: { createdAt: "asc" },
      take: MAX_FOUNDATION_MEMORIES,
      select: { content: true, metadata: true },
    });

    const sortedFoundation = [...foundationMemories];

    const relevantMemories = await searchMemories(userId, userMessage, 12);
    const foundationSet = new Set(
      foundationMemories.map((memory) => normalizeText(memory.content))
    );
    const filteredRelevant = relevantMemories.filter(
      (memory) => !foundationSet.has(normalizeText(memory.content))
    );
    const selectedRelevant = selectRelevantMemories(filteredRelevant);
    const relevantMemoryStrings = selectedRelevant.map(formatMemory);
    const foundationMemoryStrings = sortedFoundation.map(formatMemory);

    const commitmentTodos = await prisma.todo.findMany({
      where: {
        userId,
        personaId,
        status: "PENDING",
        kind: "COMMITMENT",
      },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, content: true, createdAt: true },
    });

    const threadTodos = await prisma.todo.findMany({
      where: {
        userId,
        personaId,
        status: "PENDING",
        kind: "THREAD",
      },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, content: true, createdAt: true },
    });

    const frictionTodos = await prisma.todo.findMany({
      where: {
        userId,
        personaId,
        status: "PENDING",
        kind: "FRICTION",
      },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, content: true, createdAt: true },
    });

    const commitments = dedupeTodos(commitmentTodos).slice(0, MAX_COMMITMENTS);
    const threads = dedupeTodos(threadTodos).slice(0, MAX_THREADS);
    const frictions = dedupeTodos(frictionTodos).slice(0, MAX_FRICTIONS);

    if (env.FEATURE_CONTEXT_DEBUG === "true") {
      console.log(
        "[context.debug]",
        JSON.stringify({
          commitmentsRaw: commitmentTodos.map((todo) => ({ id: todo.id, content: todo.content })),
          commitmentsFinal: commitments.map((todo) => todo.content),
          threadsRaw: threadTodos.map((todo) => ({ id: todo.id, content: todo.content })),
          threadsFinal: threads.map((todo) => todo.content),
          frictionsRaw: frictionTodos.map((todo) => ({ id: todo.id, content: todo.content })),
          frictionsFinal: frictions.map((todo) => todo.content),
        })
      );
    }

    const recentWins = await prisma.todo.findMany({
      where: {
        userId,
        personaId,
        status: "COMPLETED",
        kind: "COMMITMENT",
        completedAt: {
          gte: new Date(Date.now() - 48 * 60 * 60 * 1000),
        },
      },
      orderBy: { completedAt: "desc" },
      take: 3,
      select: { content: true },
    });

    return {
      persona: personaPrompt,
      userSeed: userSeed?.content?.slice(0, MAX_USER_SEED_CHARS),
      sessionState: sessionState?.state,
      rollingSummary: sessionState?.rollingSummary?.slice(0, MAX_ROLLING_SUMMARY_CHARS),
      recentMessages: messages
        .map((message) => ({
          ...message,
          content: message.content.slice(0, MAX_RECENT_MESSAGE_CHARS),
        }))
        .reverse(), // Chronological order
      foundationMemories: foundationMemoryStrings,
      relevantMemories: relevantMemoryStrings,
      commitments: commitments.map((todo) => todo.content),
      threads: threads.map((todo) => todo.content),
      frictions: frictions.map((todo) => todo.content),
      recentWins: recentWins.map((todo) => todo.content),
      summarySpine: summarySpine?.content?.slice(0, MAX_SUMMARY_SPINE_CHARS),
      sessionSummary: formatSessionSummary(latestSessionSummary?.summary),
    };
  } catch (error) {
    console.error("Context Builder Error:", error);
    throw new Error("Failed to build conversation context");
  }
}
