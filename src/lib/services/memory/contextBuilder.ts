import { prisma } from "@/lib/prisma";
import { readFile } from "fs/promises";
import { join } from "path";

export interface ConversationContext {
  persona: string;
  userSeed?: string;
  sessionState?: any;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  relevantMemories: string[];
  summarySpine?: string;
}

export async function buildContext(
  userId: string,
  personaId: string,
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

    // TODO: Get relevant memories via vector search
    // For v0.1, return empty array
    const relevantMemories: string[] = [];

    return {
      persona: personaPrompt,
      userSeed: userSeed?.content,
      sessionState: sessionState?.state,
      recentMessages: messages.reverse(), // Chronological order
      relevantMemories,
      summarySpine: summarySpine?.content,
    };
  } catch (error) {
    console.error("Context Builder Error:", error);
    throw new Error("Failed to build conversation context");
  }
}