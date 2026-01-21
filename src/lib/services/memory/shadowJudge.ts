import { prisma } from "@/lib/prisma";
import { MemoryType, TodoKind } from "@prisma/client";
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

    // Extract memories using judge model (last 3-6 user-only turns)
    const recentUserMessages = await prisma.message.findMany({
      where: { userId, role: "user" },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { content: true, createdAt: true },
    });
    const cutoff = Date.now() - 60 * 60 * 1000;
    const recentWindow = recentUserMessages
      .filter((m) => m.createdAt.getTime() >= cutoff)
      .map((m) => m.content);
    const windowCandidates = [userMessage, ...recentWindow].filter(Boolean);
    const deduped = windowCandidates.filter((content, index, arr) => arr.indexOf(content) === index);
    const userWindow = deduped.slice(0, 4).reverse();
    const windowText = userWindow.join(" ").toLowerCase();
    console.log("Shadow Judge user messages:", { requestId, userWindow });
    const extracted = await extractMemories(userWindow);
    const memories = extracted.memories ?? [];
    const loops = extracted.loops ?? [];

    // Store memories if any
    if (memories.length > 0) {
      console.log("Shadow Judge parsed memories:", { requestId, memories });
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
        .slice(0, 5)
        .filter(
          (memory) =>
            !/testing|frustrat|grateful|supportive|assistant|conversation|ready to help/i.test(
              memory.content
            )
        );

      const profileStoplist = new Set([
        "sophie",
        "isabella",
        "william",
        "alexander",
      ]);
      const foundationMemories = filteredMemories.filter(
        (memory) => memory.type !== MemoryType.OPEN_LOOP
      );
      const sanitizedFoundation = foundationMemories.filter((memory) => {
        if (memory.type === MemoryType.PROFILE) {
          const normalized = memory.content.trim().toLowerCase();
          return !profileStoplist.has(normalized);
        }
        if (memory.type === MemoryType.PEOPLE) {
          return isPeopleRelationship(memory.content) && hasRelationshipInWindow(windowText);
        }
        return true;
      });

      await Promise.all(
        sanitizedFoundation.map(async (memory) => {
          try {
            console.log("Shadow Judge memory write attempt:", {
              requestId,
              type: memory.type,
              content: memory.content,
              confidence: memory.confidence,
            });
            await prisma.memory.create({
              data: {
                userId,
                type: memory.type,
                content: memory.content,
                metadata: { source: "shadow_extraction", confidence: memory.confidence },
              },
            });
            console.log("Shadow Judge memory write success:", { requestId, content: memory.content });
          } catch (error) {
            console.error("Shadow Judge memory write failed:", { requestId, error });
          }
        })
      );

    }

    const normalizedLoops = loops
      .map((loop) => {
        const rawKind = typeof loop.kind === "string" ? loop.kind : "";
        const normalizedKind = rawKind.trim().toUpperCase();
        const content = typeof loop.content === "string" ? loop.content.trim() : "";
        if (!content) return null;
        const allowedKinds = new Set(["COMMITMENT", "THREAD", "FRICTION"]);
        const safeKind = allowedKinds.has(normalizedKind) ? normalizedKind : "THREAD";
        const commitVeto = /\b(maybe|might|could|would|wish|hope|if i|if we|what if|just vent|venting|frustrat|angry|upset|tired|overwhelmed|stuck|can't|cannot|won't)\b/i.test(
          content
        );
        const finalKind =
          safeKind === "COMMITMENT" && commitVeto ? "THREAD" : safeKind;
        return { kind: finalKind as TodoKind, content, confidence: loop.confidence };
      })
      .filter((loop) => loop !== null)
      .slice(0, 8);

    const seenLoopKeys = new Set<string>();
    const dedupedLoops = normalizedLoops.filter((loop) => {
      if (!loop) return false;
      const signature = getLoopSignature(loop.kind, loop.content);
      const key = `${loop.kind}:${signature}`;
      if (seenLoopKeys.has(key)) return false;
      seenLoopKeys.add(key);
      return true;
    }) as Array<{ kind: TodoKind; content: string; confidence: number }>;

    const compressedLoops = compressLoopsByKind(dedupedLoops);

    if (compressedLoops.length > 0) {
      const existingTodos = await prisma.todo.findMany({
        where: {
          userId,
          personaId,
          status: "PENDING",
          kind: { in: [TodoKind.COMMITMENT, TodoKind.THREAD, TodoKind.FRICTION] },
        },
        select: { content: true, kind: true },
      });
      const existingSet = new Set(
        existingTodos.map((todo) => `${todo.kind}:${getLoopSignature(todo.kind, todo.content)}`)
      );
      await Promise.all(
        compressedLoops.map(async (loop) => {
          try {
            const signature = getLoopSignature(loop.kind, loop.content);
            const key = `${loop.kind}:${signature}`;
            const hasOverlap = Array.from(existingSet).some((existing) => {
              const [existingKind, existingSig] = existing.split(":");
              if (existingKind !== loop.kind) return false;
              const existingTokens = existingSig.split("|").filter(Boolean);
              const incomingTokens = signature.split("|").filter(Boolean);
              if (existingTokens.length === 0 || incomingTokens.length === 0) return false;
              const existingSetTokens = new Set(existingTokens);
              const incomingSetTokens = new Set(incomingTokens);
              const incomingSubset = incomingTokens.every((token) =>
                existingSetTokens.has(token)
              );
              const existingSubset = existingTokens.every((token) =>
                incomingSetTokens.has(token)
              );
              return incomingSubset || existingSubset;
            });
            if (existingSet.has(key) || hasOverlap) {
              return;
            }
            console.log("Shadow Judge todo write attempt:", {
              requestId,
              kind: loop.kind,
              content: loop.content,
            });
            await prisma.todo.create({
              data: {
                userId,
                personaId,
                content: loop.content,
                kind: loop.kind,
                status: "PENDING",
              },
            });
            console.log("Shadow Judge todo write success:", { requestId, content: loop.content });
          } catch (error) {
            console.error("Shadow Judge todo write failed:", { requestId, error });
          }
        })
      );
    }

    const activeTodos = await prisma.todo.findMany({
      where: { userId, personaId, status: "PENDING", kind: TodoKind.COMMITMENT },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (
      activeTodos.length === 1 &&
      /\b(done|finished|completed)\b/i.test(userMessage)
    ) {
      await prisma.todo.update({
        where: { id: activeTodos[0].id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
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

async function extractMemories(userMessages: string[]) {
  try {
    const requestId = crypto.randomUUID();
    if (env.FEATURE_JUDGE_TEST_MODE === "true") {
      return buildTestExtract(userMessages);
    }
    const timeoutMs = Number.parseInt(process.env.JUDGE_TIMEOUT_MS ?? "5000", 10);
    const prompt = `Extract explicit user facts and loops. Return ONLY JSON.

MUST:
- If the user states their name, capture it as PROFILE.
- Capture loops as one of: COMMITMENT, THREAD, FRICTION.
- If ambiguous, classify as THREAD.

FOUNDATION (PROFILE/PEOPLE/PROJECT):
- Only if explicitly stated by the user.
- Do not infer or guess.
- Do not capture assistant/persona names as PROFILE.
- Only capture PEOPLE if the user states a relationship (e.g., "my cofounder John"). Passing mentions of names are NOT memories.

LOOPS:
- FRICTION is for negative sentiment, blockers, or feeling stuck (e.g., "visual polish feels off").
- THREAD is for neutral topics or ongoing discussions.

USER MESSAGES:
${userMessages.join("\n")}

JSON SCHEMA:
{
  "memories": [
    { "type": "PROFILE|PEOPLE|PROJECT", "content": "...", "confidence": 0.0 }
  ],
  "loops": [
    { "kind": "COMMITMENT|THREAD|FRICTION", "content": "...", "confidence": 0.0 }
  ]
}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
          max_tokens: 350,
          temperature: 0,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.warn("Shadow Judge request timed out:", { requestId });
        return { memories: [], loops: [] };
      }
      console.warn("Shadow Judge request failed:", { requestId, error });
      return { memories: [], loops: [] };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "<no body>");
      const truncated = errText.length > 500 ? `${errText.slice(0, 500)}…` : errText;
      console.error("Shadow Judge request failed:", {
        requestId,
        status: response.status,
        statusText: response.statusText,
        body: truncated,
      });
      return { memories: [], loops: [] };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    console.log("Shadow Judge raw response:", { requestId, content });
    const repaired = repairJsonContent(content);
    let result: { memories?: any[]; loops?: any[] } | null = null;

    try {
      result = JSON.parse(repaired);
      console.log("Shadow Judge parsed JSON:", { requestId, result });
    } catch {
      const start = repaired.indexOf("{");
      const end = repaired.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        const slice = repaired.slice(start, end + 1);
        try {
          result = JSON.parse(slice);
        } catch {
          const truncated = repaired.length > 500 ? `${repaired.slice(0, 500)}…` : repaired;
          console.error("Shadow Judge JSON parse failed:", { requestId, content: truncated });
          return { memories: [], loops: [] };
        }
      } else {
        const truncated = repaired.length > 500 ? `${repaired.slice(0, 500)}…` : repaired;
        console.error("Shadow Judge JSON parse failed:", { requestId, content: truncated });
        return { memories: [], loops: [] };
      }
    }
    
    if (!result) return { memories: [], loops: [] };
    return { memories: result.memories || [], loops: result.loops || [] };
  } catch (error) {
    console.error("Memory extraction failed:", error);
    return { memories: [], loops: [] };
  }
}

function buildTestExtract(userMessages: string[]) {
  const joined = userMessages.join("\n").toLowerCase();
  const memories: Array<{ type: string; content: string; confidence: number }> = [];
  const loops: Array<{ kind: string; content: string; confidence: number }> = [];
  const loopSeen = new Set<string>();

  if (joined.includes("mukesh")) {
    memories.push({ type: "PROFILE", content: "Mukesh", confidence: 1.0 });
  }

  const pushLoop = (kind: string, content: string) => {
    const key = content.trim().toLowerCase();
    if (!key || loopSeen.has(key)) return;
    loopSeen.add(key);
    loops.push({ kind, content, confidence: 1.0 });
  };

  if (joined.includes("tomorrow 7:30am walk")) {
    pushLoop("COMMITMENT", "Tomorrow 7:30am walk");
  }
  if (joined.includes("30 minutes exercise")) {
    pushLoop("COMMITMENT", "30 minutes exercise");
  }
  if (joined.includes("finish the main chat screen polish tonight")) {
    pushLoop("COMMITMENT", "finish the Main Chat Screen polish tonight");
  }
  if (joined.includes("clean the breakfast bar tonight")) {
    pushLoop("COMMITMENT", "clean the breakfast bar tonight");
  }
  if (joined.includes("kitchen mess")) {
    pushLoop("THREAD", "Venting about the kitchen mess");
  }

  return { memories, loops };
}

function repairJsonContent(content: string) {
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        if (parsed.length === 1 && typeof parsed[0] === "object" && parsed[0] !== null) {
          return JSON.stringify(parsed[0]);
        }
        if (parsed.every((item) => typeof item === "object" && item !== null && "content" in item)) {
          return JSON.stringify({ memories: parsed });
        }
      }
    } catch {
      // Fall through to return cleaned content.
    }
  }
  return cleaned;
}

function normalizeLoopContent(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:'"(){}\[\]\\\/]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeThreadContent(value: string) {
  const cleaned = normalizeLoopContent(value)
    .replace(/\b(talk|discuss|chat|sync|connect|discussed|discussion|need|needs|sophie|user)\b/g, "")
    .replace(/\b(to|about|with|for|on|at|in)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(Boolean).sort();
  return tokens.join(" ").trim();
}

function normalizeCommitmentContent(value: string) {
  const cleaned = normalizeLoopContent(value);
  const tokens = cleaned
    .split(" ")
    .filter(Boolean)
    .filter(
      (token) =>
        !new Set([
          "plans",
          "will",
          "just",
          "actually",
          "sophie",
          "user",
          "about",
          "to",
          "the",
          "a",
          "an",
          "at",
          "in",
          "on",
          "tonight",
          "today",
          "this",
        ]).has(token)
    )
    .sort();
  const normalized = tokens.join(" ").trim();
  return normalized || cleaned;
}

function getLoopTokens(kind: TodoKind, content: string) {
  const signature =
    kind === TodoKind.COMMITMENT
      ? normalizeCommitmentContent(content)
      : kind === TodoKind.THREAD
        ? normalizeThreadContent(content)
        : normalizeLoopContent(content);
  const tokens = signature.split(" ").filter(Boolean);
  if (tokens.length > 0) return tokens;
  return normalizeLoopContent(content).split(" ").filter(Boolean);
}

function getLoopSignature(kind: TodoKind, content: string) {
  return getLoopTokens(kind, content).join("|");
}

function compressLoopsByKind(
  loops: Array<{ kind: TodoKind; content: string; confidence: number }>
) {
  const kinds: TodoKind[] = [
    TodoKind.COMMITMENT,
    TodoKind.THREAD,
    TodoKind.FRICTION,
  ];

  const keep = new Set<string>();
  for (const kind of kinds) {
    const items = loops.filter((loop) => loop.kind === kind);
    if (items.length <= 1) {
      items.forEach((item) => keep.add(item.content));
      continue;
    }

    const normalized = items.map((loop) => ({
      content: loop.content,
      tokens: getLoopTokens(kind, loop.content),
    }));

    for (let i = 0; i < normalized.length; i += 1) {
      const current = normalized[i];
      if (current.tokens.length === 0) continue;
      let isCovered = false;
      for (let j = 0; j < normalized.length; j += 1) {
        if (i === j) continue;
        const other = normalized[j];
        if (other.tokens.length === 0) continue;
        const otherSet = new Set(other.tokens);
        const isSubset = current.tokens.every((token) => otherSet.has(token));
        if (isSubset && other.tokens.length >= current.tokens.length) {
          if (other.tokens.join("|") !== current.tokens.join("|")) {
            isCovered = true;
            break;
          }
        }
      }
      if (!isCovered) {
        keep.add(current.content);
      }
    }
  }

  return loops.filter((loop) => keep.has(loop.content));
}

function isPeopleRelationship(content: string) {
  return /\b(my|mom|mother|dad|father|parent|sister|brother|wife|husband|partner|girlfriend|boyfriend|fiance|fiancé|spouse|friend|cofounder|co-founder|colleague|teammate|manager|boss|client|mentor)\b/i.test(
    content
  );
}

function hasRelationshipInWindow(windowText: string) {
  return /\b(my|our)\b.{0,40}\b(cofounder|co-founder|friend|manager|boss|client|mentor|teammate|colleague|partner|wife|husband|girlfriend|boyfriend|spouse|fiance|fiancé|sister|brother|mom|mother|dad|father|parent)\b/i.test(
    windowText
  );
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
