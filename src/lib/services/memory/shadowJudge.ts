import { prisma } from "@/lib/prisma";
import { MemoryType } from "@prisma/client";
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
    const requestId = crypto.randomUUID();
    const { userId, personaId, userMessage, assistantResponse, currentSessionState } = params;
    const allowedTypes = new Set(Object.values(MemoryType));

    // Extract memories using judge model
    const memories = await extractMemories(userMessage);

    // Store memories if any
    if (memories.length > 0) {
      const normalizedMemories = memories
        .map((memory) => {
          const rawType = memory.type ?? "";
          const normalized = rawType.split("|")[0].trim().toUpperCase();
          if (!allowedTypes.has(normalized as MemoryType)) {
            if (process.env.NODE_ENV !== "production") {
              console.warn("Shadow memory skipped (invalid type):", {
                requestId,
                rawType,
                normalized,
              });
            }
            return null;
          }
          return { ...memory, type: normalized as MemoryType };
        })
        .filter((memory) => memory !== null);

      const filteredMemories = normalizedMemories
        .filter((memory) => (memory.confidence ?? 0) >= 0.85)
        .slice(0, 2)
        .filter(
          (memory) =>
            !/testing|frustrat|grateful|supportive|assistant|conversation|ready to help/i.test(
              memory.content
            )
        );

      await Promise.all(
        filteredMemories.map(memory =>
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

async function extractMemories(userMessage: string) {
  try {
    const requestId = crypto.randomUUID();
    const prompt = `You are a strict memory extractor for a personal assistant.

RULES (MUST FOLLOW):
- Only extract memories that are explicitly stated by the USER in their message.
- Do NOT infer, guess, generalize, or interpret.
- Do NOT store temporary states (testing, mood, emotions, “working late”, “frustrated”, etc.).
- Do NOT store meta commentary about the conversation or assistant
  (e.g. “user is testing”, “assistant is supportive”, “user said thanks”).
- Do NOT store safety, policy, or consent statements.
- Only store durable facts that will remain true in 30+ days OR long-running projects/goals.
- If the USER corrects a fact (e.g. “my name is Mukesh, not Bella”), store ONLY the corrected fact.
- If the user explicitly states their name (e.g., “my name is X” / “call me X”) you MUST store it as PROFILE.
- If the user explicitly asks for daily accountability / steps / workout commitments, you MUST store it as OPEN_LOOP.

ALLOWED TYPES:
- PROFILE: stable identity or preferences
- PEOPLE: stable relationships explicitly stated by the user
- PROJECT: ongoing products, companies, or systems the user is building
- OPEN_LOOP: durable commitments the user explicitly intends to revisit

OUTPUT REQUIREMENTS:
- Return ONLY valid JSON.
- No markdown, no explanations, no extra text.
- If nothing qualifies, return {"memories": []}.

USER MESSAGE:
${userMessage}

JSON SCHEMA:
{
  "memories": [
    {
      "type": "PROFILE|PEOPLE|PROJECT|OPEN_LOOP",
      "content": "short factual memory",
      "confidence": 0.0
    }
  ]
}`;

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
    const content = data.choices?.[0]?.message?.content ?? "";
    let result: { memories?: any[] } | null = null;

    try {
      result = JSON.parse(content);
    } catch {
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        const slice = content.slice(start, end + 1);
        try {
          result = JSON.parse(slice);
        } catch {
          const truncated = content.length > 500 ? `${content.slice(0, 500)}…` : content;
          console.error("Shadow Judge JSON parse failed:", { requestId, content: truncated });
          return [];
        }
      } else {
        const truncated = content.length > 500 ? `${content.slice(0, 500)}…` : content;
        console.error("Shadow Judge JSON parse failed:", { requestId, content: truncated });
        return [];
      }
    }
    
    if (!result) return [];
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
      const summaryPrompt = `Summarize only durable, user-stated facts from this exchange.

BANNED CONTENT (DO NOT INCLUDE):
- emotions, moods, or temporary states
- meta commentary about the conversation or assistant
- testing, prompts, model, or system talk
- safety/policy/consent statements
- generic encouragement or filler

Previous summary (may be empty):
${currentSummary?.content || "None"}

Recent exchange:
User: ${userMessage}
Assistant: ${assistantResponse}

OUTPUT FORMAT (exactly 4 sections, even if empty):
PROFILE:
- ...
PROJECTS:
- ...
PEOPLE:
- ...
OPEN_LOOPS:
- ...`;

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
