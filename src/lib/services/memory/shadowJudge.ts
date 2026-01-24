import { prisma } from "@/lib/prisma";
import { storeMemory } from "@/lib/services/memory/memoryStore";
import { MemoryType, TodoKind } from "@prisma/client";
import { MODELS } from "@/lib/providers/models";
import { env } from "@/env";
import { summarizeRollingSession } from "@/lib/services/session/sessionSummarizer";
import {
  sanitizeSubtype,
  sanitizeEntityRefs,
  sanitizeImportance,
  sanitizeEntityLabel,
  canonicalizeEntityRefs,
  type MemorySubtype,
} from "./entityNormalizer";

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
    const { userWindow, windowText } = await getUserWindow(userId, userMessage);
    console.log("Shadow Judge user messages:", { requestId, userWindow });

    const extracted = await judgeExtract(userWindow);
    const memories = extracted.memories ?? [];
    const loops = extracted.loops ?? [];

    // Store memories if any
    if (memories.length > 0) {
      console.log("Shadow Judge parsed memories:", { requestId, memories });
      const sanitizedFoundation = sanitizeMemories(memories, windowText);
      await writeMemories(userId, sanitizedFoundation, requestId);
    }

    const normalizedLoops = normalizeLoops(loops);
    const dedupedLoops = dedupeLoops(normalizedLoops);
    const compressedLoops = dedupedLoops;
    await writeTodos(userId, personaId, compressedLoops, requestId);
    await autoCompleteCommitment(userId, personaId, userMessage);

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

    const messageCount =
      typeof updatedSessionState?.messageCount === "number"
        ? updatedSessionState.messageCount
        : null;
    const shouldTriggerRollingSummary =
      Boolean(messageCount) && messageCount % ROLLING_SUMMARY_TURN_INTERVAL === 0;
    console.log("Shadow Judge rolling summary check:", {
      requestId,
      messageCount,
      shouldTriggerRollingSummary,
    });
    if (shouldTriggerRollingSummary) {
      const timeoutMs = Number.parseInt(env.SUMMARY_TIMEOUT_MS ?? "", 10);
      const rollingTimeout = Number.isFinite(timeoutMs) ? timeoutMs : 4000;
      try {
        await withTimeout(
          triggerRollingSummaryUpdate(userId, personaId, requestId, messageCount),
          rollingTimeout
        );
      } catch (error) {
        await updateRollingDiagnostics(userId, personaId, {
          lastRollingError: { reason: "timeout_or_exception", detail: String(error) },
        });
        console.warn("Shadow Judge rolling summary timed out:", { requestId, error });
      }
    }

    // Update summary spine
    await updateSummarySpine(userId, userMessage, assistantResponse);

  } catch (error) {
    console.error("Shadow Judge Error:", error);
    // Don't throw - shadow processing should never block user
  }
}

const ROLLING_SUMMARY_TURN_INTERVAL = 4;

async function triggerRollingSummaryUpdate(
  userId: string,
  personaId: string,
  requestId: string,
  messageCount?: number | null
) {
  try {
    const sessionState = await prisma.sessionState.findUnique({
      where: { userId_personaId: { userId, personaId } },
      select: { rollingSummary: true, state: true },
    });

    await updateRollingDiagnostics(userId, personaId, {
      lastRollingAttemptAt: new Date().toISOString(),
      lastRollingMessageCount: messageCount ?? null,
    });

    const summary = await summarizeRollingSession({
      userId,
      personaId,
      previousSummary: sessionState?.rollingSummary,
    });
    if (!summary) {
      await updateRollingDiagnostics(userId, personaId, {
        lastRollingError: { reason: "summary_empty_or_failed" },
      });
      return;
    }

    await prisma.sessionState.update({
      where: { userId_personaId: { userId, personaId } },
      data: {
        rollingSummary: summary,
        updatedAt: new Date(),
      },
    });
    await updateRollingDiagnostics(userId, personaId, {
      lastRollingSuccessAt: new Date().toISOString(),
      lastRollingError: null,
    });
    console.log("Shadow Judge rolling summary updated:", { requestId });
  } catch (error) {
    await updateRollingDiagnostics(userId, personaId, {
      lastRollingError: { reason: "exception", detail: String(error) },
    });
    console.warn("Shadow Judge rolling summary failed:", { requestId, error });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Rolling summary timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

async function updateRollingDiagnostics(
  userId: string,
  personaId: string,
  patch: Record<string, unknown>
) {
  const existing = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
    select: { state: true },
  });
  const currentState =
    existing?.state && typeof existing.state === "object"
      ? (existing.state as Record<string, unknown>)
      : {};
  await prisma.sessionState.update({
    where: { userId_personaId: { userId, personaId } },
    data: { state: { ...currentState, ...patch } as any },
  });
}

async function getUserWindow(userId: string, userMessage: string) {
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
  const deduped = windowCandidates.filter(
    (content, index, arr) => arr.indexOf(content) === index
  );
  const userWindow = deduped.slice(0, 4).reverse();
  return {
    userWindow,
    windowText: userWindow.join(" ").toLowerCase(),
  };
}

async function judgeExtract(userWindow: string[]) {
  return extractMemories(userWindow);
}

function sanitizeMemories(memories: Array<any>, windowText: string) {
  const allowedTypes = new Set(Object.values(MemoryType));
  const normalizedMemories = memories
    .map((memory) => {
      const rawType = memory.type ?? "";
      const normalized = rawType.split("|")[0].trim().toUpperCase();
      if (!allowedTypes.has(normalized as MemoryType)) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("Shadow memory skipped (invalid type):", {
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
  return foundationMemories.filter((memory) => {
    if (memory.type === MemoryType.PROFILE) {
      const normalized = memory.content.trim().toLowerCase();
      return !profileStoplist.has(normalized);
    }
    if (memory.type === MemoryType.PEOPLE) {
      return isPeopleRelationship(memory.content) && hasRelationshipInWindow(windowText);
    }
    return true;
  });
}

async function writeMemories(
  userId: string,
  sanitizedFoundation: Array<any>,
  requestId: string
) {
  await Promise.all(
    sanitizedFoundation.map(async (memory) => {
      try {
        // Sanitize Memory B fields
        const subtype = sanitizeSubtype(memory.subtype);
        const entityRefs = canonicalizeEntityRefs(sanitizeEntityRefs(memory.entityRefs));
        const entityLabel = sanitizeEntityLabel(memory.entityLabel);
        const rawImportance = sanitizeImportance(memory.importance);

        console.log("Shadow Judge memory write attempt:", {
          requestId,
          type: memory.type,
          content: memory.content,
          confidence: memory.confidence,
          subtype,
          entityRefs,
          importance: rawImportance,
        });

        await storeMemory(
          userId,
          memory.type,
          memory.content,
          {
            source: "shadow_extraction",
            confidence: memory.confidence,
            // Memory B fields
            ...(subtype && { subtype: subtype as Record<string, string> }),
            ...(entityRefs.length > 0 && { entityRefs }),
            ...(entityLabel && { entityLabel }),
            importance: rawImportance,
          },
          null
        );
        console.log("Shadow Judge memory write success:", { requestId, content: memory.content });
      } catch (error) {
        console.error("Shadow Judge memory write failed:", { requestId, error });
      }
    })
  );
}

function normalizeLoops(loops: Array<any>) {
  return loops
    .map((loop) => {
      const rawKind = typeof loop.kind === "string" ? loop.kind : "";
      const normalizedKind = rawKind.trim().toUpperCase();
      const content = typeof loop.content === "string" ? loop.content.trim() : "";
      const dedupeKeyRaw = typeof loop.dedupe_key === "string" ? loop.dedupe_key : "";
      if (!content) return null;
      const allowedKinds = new Set(["COMMITMENT", "HABIT", "THREAD", "FRICTION"]);
      const safeKind = allowedKinds.has(normalizedKind) ? normalizedKind : "THREAD";
      const shouldDowngrade =
        safeKind === "COMMITMENT" &&
        hasHedgeWords(content) &&
        !hasTimeboxMarker(content) &&
        !hasExplicitWill(content);
      const finalKind = shouldDowngrade ? "THREAD" : safeKind;
      const dedupeKey = dedupeKeyRaw ? normalizeDedupeKey(dedupeKeyRaw) : null;
      return {
        kind: finalKind as TodoKind,
        content,
        dedupeKey,
        confidence: loop.confidence,
      };
    })
    .filter((loop) => loop !== null)
    .slice(0, 8);
}

function dedupeLoops(normalizedLoops: Array<{
  kind: TodoKind;
  content: string;
  dedupeKey: string | null;
  confidence: number;
}>) {
  const seenLoopKeys = new Set<string>();
  return normalizedLoops.filter((loop) => {
    const signature = loop.dedupeKey ?? normalizeLoopContent(loop.content);
    const key = `${loop.kind}:${signature}`;
    if (seenLoopKeys.has(key)) return false;
    seenLoopKeys.add(key);
    return true;
  });
}

async function writeTodos(
  userId: string,
  personaId: string,
  loops: Array<{
    kind: TodoKind;
    content: string;
    dedupeKey: string | null;
    confidence: number;
  }>,
  requestId: string
) {
  if (loops.length === 0) return;
  const existingTodos = await prisma.todo.findMany({
    where: {
      userId,
      personaId,
      status: "PENDING",
      kind: { in: [TodoKind.COMMITMENT, TodoKind.HABIT, TodoKind.THREAD, TodoKind.FRICTION] },
    },
    select: { content: true, kind: true, dedupeKey: true },
  });
  const existingSet = new Set(
    existingTodos.map((todo) => {
      const signature = todo.dedupeKey
        ? normalizeDedupeKey(todo.dedupeKey)
        : normalizeLoopContent(todo.content);
      return `${todo.kind}:${signature}`;
    })
  );
  await Promise.all(
    loops.map(async (loop) => {
      try {
        const signature = loop.dedupeKey
          ? normalizeDedupeKey(loop.dedupeKey)
          : normalizeLoopContent(loop.content);
        const key = `${loop.kind}:${signature}`;
        if (existingSet.has(key)) {
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
            dedupeKey: loop.dedupeKey ?? undefined,
          },
        });
        console.log("Shadow Judge todo write success:", { requestId, content: loop.content });
      } catch (error) {
        console.error("Shadow Judge todo write failed:", { requestId, error });
      }
    })
  );
}

async function autoCompleteCommitment(
  userId: string,
  personaId: string,
  userMessage: string
) {
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
}

function hasHedgeWords(content: string) {
  return /\b(maybe|might|could|wish|hope|if i|if we)\b/i.test(content);
}

function hasTimeboxMarker(content: string) {
  return /\b(today|tonight|tomorrow|before|by|end of day|end of the day)\b/i.test(content) ||
    /\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/i.test(content);
}

function hasExplicitWill(content: string) {
  return /\b(i will|i'm going to|i am going to|i'll)\b/i.test(content);
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
- Capture loops as one of: COMMITMENT, HABIT, THREAD, FRICTION.
- If ambiguous, classify as THREAD.

FOUNDATION (PROFILE/PEOPLE/PROJECT) - Memory B Schema:
- Only if explicitly stated by the user.
- Do not infer or guess.
- Do not capture assistant/persona names as PROFILE.
- Only capture PEOPLE if the user states a relationship (e.g., "my cofounder John"). Passing mentions of names are NOT memories.

MEMORY B FIELDS (required for all memories):
- subtype.entityType: person | place | org | project (required for PEOPLE/PROJECT)
- subtype.factType: fact | preference | relationship | friction | habit
- entityRefs: Array of entity keys mentioned (format: "<type>:<slug>" e.g. "person:john_doe")
  - Slug rules: lowercase, no punctuation, underscores for spaces/hyphens
- entityLabel: Display name for the primary entity (e.g. "John Doe")
- importance: 0 (trivial) | 1 (standard, default) | 2 (significant) | 3 (critical)
  - Use 2 for relationships, locations, key project facts
  - Use 3 only for core identity facts (name, role, primary relationships)

LOOPS:
- COMMITMENT = explicit promise/decision to do a specific action (often timeboxed).
- HABIT = recurring routine user wants daily/regular (walk, exercise, tidy).
- FRICTION = blocker + negative valence + repeatable pattern ("I get stuck", "burnt out", "colors feel off", "I waste hours").
- THREAD = neutral topic/discussion thread (non-negative, not timeboxed, not a habit).
- If the user states ANY timebox or rule ("before/by/end of day", "tomorrow", "home by 11am", "20 minutes", "15 minutes", "hold me accountable"),
  you MUST output COMMITMENT or HABIT items for those statements.
- Do NOT create vague friction like "things to address". Frictions must be stable/repeatable patterns.
- Every loop item MUST include dedupe_key: stable across paraphrases, snake_case, 3-8 words.
- If multiple sentences express the same intent, output ONE loop item only.
- Keep the SAME kind and dedupe_key for paraphrases of the same intent.

EXAMPLES:
1. "My cofounder John is handling the backend"
   -> type: PEOPLE, subtype: {entityType: "person", factType: "relationship"}, entityRefs: ["person:john"], entityLabel: "John", importance: 2, content: "John is my cofounder; handles backend"

2. "I live in Austin, Texas"
   -> type: PROFILE, subtype: {entityType: "place", factType: "fact"}, entityRefs: ["place:austin_texas"], entityLabel: "Austin, Texas", importance: 2, content: "Lives in Austin, Texas"

3. "I prefer dark mode in all my apps"
   -> type: PROFILE, subtype: {factType: "preference"}, entityRefs: [], importance: 1, content: "Prefers dark mode"

4. "I'm the CEO of Acme Corp"
   -> type: PROFILE, subtype: {entityType: "org", factType: "relationship"}, entityRefs: ["org:acme_corp"], entityLabel: "Acme Corp", importance: 3, content: "CEO of Acme Corp"

LOOP EXAMPLES (unchanged):
- FRICTION: "I wake up, go on the computer, get stuck, don't walk until 2–3pm." -> "Delays walking until mid-afternoon after getting stuck at computer"
- HABIT: "Daily I need 15 minutes tidying." -> "15 minutes tidying daily"
- COMMITMENT: "Tomorrow morning walk before midday, home by 11am." -> "Morning walk completed before 11am tomorrow"

USER MESSAGES:
${userMessages.join("\n")}

JSON SCHEMA:
{
  "memories": [
    {
      "type": "PROFILE|PEOPLE|PROJECT",
      "content": "...",
      "confidence": 0.0,
      "subtype": { "entityType": "person|place|org|project", "factType": "fact|preference|relationship|friction|habit" },
      "entityRefs": ["person:john_doe"],
      "entityLabel": "John Doe",
      "importance": 1
    }
  ],
  "loops": [
    { "kind": "COMMITMENT|HABIT|THREAD|FRICTION", "content": "...", "dedupe_key": "...", "confidence": 0.0 }
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

function normalizeDedupeKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
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
