import { prisma } from "@/lib/prisma";
import { searchMemories } from "@/lib/services/memory/memoryStore";
import { readFile } from "fs/promises";
import { join } from "path";

export interface ConversationContext {
  persona: string;
  userSeed?: string;
  sessionState?: any;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  relevantMemories: string[];
  activeTodos: string[];
  summarySpine?: string;
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

    const relevantMemories = await searchMemories(userId, userMessage);
    const memoryStrings = relevantMemories.map((memory) => {
      const source = memory.metadata?.source;
      const sourceLabel =
        source === "seeded_profile" ? "GOSPEL" : "OBSERVATION";
      const sourceTag = source ? `${sourceLabel}:${source}` : `${sourceLabel}:unknown`;
      return `[${sourceTag}] ${memory.content}`;
    });

    const todos = await prisma.todo.findMany({
      where: {
        userId,
        personaId,
        status: "PENDING",
      },
      orderBy: { createdAt: "asc" },
      select: { content: true },
    });

    return {
      persona: personaPrompt,
      userSeed: userSeed?.content,
      sessionState: sessionState?.state,
      recentMessages: messages.reverse(), // Chronological order
      relevantMemories: memoryStrings,
      activeTodos: todos.map((todo) => todo.content),
      summarySpine: summarySpine?.content,
    };
  } catch (error) {
    console.error("Context Builder Error:", error);
    throw new Error("Failed to build conversation context");
  }
}
