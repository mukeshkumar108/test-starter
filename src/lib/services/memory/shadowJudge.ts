import { prisma } from "@/lib/prisma";
import { MODELS } from "@/lib/providers/models";
import { env } from "@/env";

interface ShadowProcessingParams {
  userId: string;
  personaId: string;
  userMessage: string;
  assistantResponse: string;
  currentSessionState?: any;
}

export async function processShadowPath(params: ShadowProcessingParams): Promise<void> {
  try {
    const { userId, personaId, userMessage, assistantResponse, currentSessionState } = params;

    // Extract memories using judge model
    const memories = await extractMemories(userMessage, assistantResponse);

    // Store memories if any
    if (memories.length > 0) {
      await Promise.all(
        memories.map(memory =>
          prisma.memory.create({
            data: {
              userId,
              type: memory.type,
              content: memory.content,
              metadata: { source: "shadow_extraction", confidence: memory.confidence },
            },
          })
        )
      );
    }

    // Update session state
    const updatedSessionState = await updateSessionState(
      userId,
      personaId,
      userMessage,
      assistantResponse,
      currentSessionState
    );

    await prisma.sessionState.upsert({
      where: { userId_personaId: { userId, personaId } },
      update: { 
        state: updatedSessionState,
        updatedAt: new Date(),
      },
      create: {
        userId,
        personaId,
        state: updatedSessionState,
      },
    });

    // Update summary spine
    await updateSummarySpine(userId, userMessage, assistantResponse);

  } catch (error) {
    console.error("Shadow Judge Error:", error);
    // Don't throw - shadow processing should never block user
  }
}

async function extractMemories(userMessage: string, assistantResponse: string) {
  try {
    const prompt = `Analyze this conversation exchange and extract any memories that should be stored.

User: ${userMessage}
Assistant: ${assistantResponse}

Extract memories in JSON format:
{
  "memories": [
    {
      "type": "PROFILE|PEOPLE|PROJECT|OPEN_LOOP", 
      "content": "factual statement about the user",
      "confidence": 0.8
    }
  ]
}

Only extract clear, factual information. Return empty array if nothing significant.`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/your-repo",
        "X-Title": "Walkie-Talkie Voice Companion",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELS.JUDGE,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });

    if (!response.ok) return [];

    const data = await response.json();
    const result = JSON.parse(data.choices?.[0]?.message?.content || '{"memories": []}');
    
    return result.memories || [];
  } catch (error) {
    console.error("Memory extraction failed:", error);
    return [];
  }
}

async function updateSessionState(
  userId: string,
  personaId: string, 
  userMessage: string,
  assistantResponse: string,
  currentState: any
) {
  // Simple session state tracking for v0.1
  const newState = {
    ...currentState,
    lastInteraction: new Date().toISOString(),
    messageCount: (currentState?.messageCount || 0) + 1,
    lastUserMessage: userMessage.substring(0, 100), // Keep summary
  };

  return newState;
}

async function updateSummarySpine(
  userId: string,
  userMessage: string, 
  assistantResponse: string
) {
  try {
    // Get current summary
    const currentSummary = await prisma.summarySpine.findFirst({
      where: { userId, conversationId: "default" },
      orderBy: { version: "desc" },
    });

    const messageCount = (currentSummary?.messageCount || 0) + 2; // user + assistant

    // If no current summary or getting long, create new version
    if (!currentSummary || messageCount > 20) {
      const summaryPrompt = `Create a concise summary of this conversation context:

Previous summary: ${currentSummary?.content || "None"}

Recent exchange:
User: ${userMessage}
Assistant: ${assistantResponse}

Provide a compressed narrative summary focusing on key topics, user interests, and conversation flow.`;

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://github.com/your-repo",
          "X-Title": "Walkie-Talkie Voice Companion",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODELS.JUDGE,
          messages: [{ role: "user", content: summaryPrompt }],
          max_tokens: 300,
          temperature: 0.3,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const summaryContent = data.choices?.[0]?.message?.content || "";

        await prisma.summarySpine.create({
          data: {
            userId,
            conversationId: "default",
            version: (currentSummary?.version || 0) + 1,
            content: summaryContent,
            messageCount,
          },
        });
      }
    }
  } catch (error) {
    console.error("Summary spine update failed:", error);
  }
}