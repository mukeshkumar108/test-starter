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
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  foundationMemories: string[];
  relevantMemories: string[];
  activeTodos: string[];
  recentWins: string[];
  summarySpine?: string;
  sessionSummary?: string;
}

const MAX_OPEN_LOOPS = 5;

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
    const normalizedContent = memory.content.trim().toLowerCase();
    if (seen.has(normalizedContent)) continue;
    if (counts[memory.type] >= perTypeCaps[memory.type]) continue;
    if (selected.length >= 8) break;

    selected.push(memory);
    seen.add(normalizedContent);
    counts[memory.type] += 1;
  }

  return selected;
}

function dedupeOpenLoops(
  todos: Array<{ id: string; content: string; createdAt: Date }>
) {
  const sorted = [...todos].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
  const seen = new Set<string>();
  const deduped: Array<{ id: string; content: string; createdAt: Date }> = [];

  for (const todo of sorted) {
    const normalized = todo.content.trim().toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(todo);
  }

  return deduped.slice(0, MAX_OPEN_LOOPS);
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
      take: 10,
      select: {
        role: true,
        content: true,
      },
    });

    // Get latest summary spine
    const summarySpine = await prisma.summarySpine.findFirst({
      where: { 
        userId,
        conversationId: "default",
      },
      orderBy: { version: "desc" },
    });

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
      },
      orderBy: { createdAt: "asc" },
      take: 12,
      select: { content: true, metadata: true },
    });

    const relevantMemories = await searchMemories(userId, userMessage, 12);
    const selectedRelevant = selectRelevantMemories(relevantMemories);
    const relevantMemoryStrings = selectedRelevant.map(formatMemory);
    const foundationMemoryStrings = foundationMemories.map(formatMemory);

    const todos = await prisma.todo.findMany({
      where: {
        userId,
        personaId,
        status: "PENDING",
      },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, content: true, createdAt: true },
    });
    const openLoops = dedupeOpenLoops(todos);
    if (env.FEATURE_CONTEXT_DEBUG === "true") {
      console.log(
        "[context.debug]",
        JSON.stringify({
          openLoopsRaw: todos.map((todo) => ({ id: todo.id, content: todo.content })),
          openLoopsFinal: openLoops.map((todo) => todo.content),
        })
      );
    }

    const recentWins = await prisma.todo.findMany({
      where: {
        userId,
        personaId,
        status: "COMPLETED",
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
      userSeed: userSeed?.content,
      sessionState: sessionState?.state,
      recentMessages: messages.reverse(), // Chronological order
      foundationMemories: foundationMemoryStrings,
      relevantMemories: relevantMemoryStrings,
      activeTodos: openLoops.map((todo) => todo.content),
      recentWins: recentWins.map((todo) => todo.content),
      summarySpine: summarySpine?.content,
      sessionSummary: latestSessionSummary?.summary.slice(0, 600),
    };
  } catch (error) {
    console.error("Context Builder Error:", error);
    throw new Error("Failed to build conversation context");
  }
}
