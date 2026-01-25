import { prisma } from "@/lib/prisma";
import { searchMemories, type Memory } from "@/lib/services/memory/memoryStore";
import { readFile } from "fs/promises";
import { join } from "path";
import { env } from "@/env";
import { getLatestSessionSummary } from "@/lib/services/session/sessionService";
import { Prisma } from "@prisma/client";

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
  /** True if this is the first turn of a new session (for conditional SessionSummary injection) */
  isSessionStart: boolean;
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

// Entity card constants
const MAX_ENTITY_CARDS = 5;
const MAX_FACTS_PER_CARD = 3;
const ENTITY_KEY_PATTERN = /^(person|place|org|project):[a-z0-9_]+$/;

/**
 * Extract valid entity keys from memory metadata.entityRefs
 */
function extractEntityKeysFromMemories(memories: Memory[]): Set<string> {
  const keys = new Set<string>();
  for (const m of memories) {
    const refs = (m.metadata?.entityRefs as string[]) ?? [];
    for (const ref of refs) {
      if (ENTITY_KEY_PATTERN.test(ref)) {
        keys.add(ref);
      }
    }
  }
  return keys;
}

interface LinkedMemory {
  id: string;
  content: string;
  metadata: any;
  pinned: boolean;
  createdAt: Date;
}

/**
 * Build entity cards via SQL filtering (1-hop expansion).
 * Uses metadata->'entityRefs' ?| ARRAY[...] for efficient any-of matching.
 * Sorted by: pinned DESC → importance DESC → createdAt DESC
 */
async function buildEntityCards(
  userId: string,
  personaId: string,
  entityKeys: Set<string>,
  excludeIds: Set<string>
): Promise<string[]> {
  if (entityKeys.size === 0) return [];

  const entityKeyArray = Array.from(entityKeys);
  const excludeIdArray = Array.from(excludeIds);

  // SQL query with ?| ARRAY[] for "any-of" matching on entityRefs
  // Sort by: pinned DESC, importance DESC, createdAt DESC
  // Note: We use Prisma.join for the array and cast to text[] for PostgreSQL ?| operator
  let linkedMemories: LinkedMemory[] = [];
  try {
    linkedMemories = await prisma.$queryRaw<LinkedMemory[]>`
      SELECT id, content, metadata, pinned, "createdAt"
      FROM "Memory"
      WHERE "userId" = ${userId}
        AND ("personaId" = ${personaId} OR "personaId" IS NULL)
        AND "type" IN ('PROFILE', 'PEOPLE', 'PROJECT')
        AND metadata ? 'entityRefs'
        AND metadata->'entityRefs' ?| ARRAY[${Prisma.join(entityKeyArray)}]::text[]
        AND (pinned = true OR COALESCE((metadata->>'importance')::int, 1) >= 2)
        ${excludeIdArray.length > 0 ? Prisma.sql`AND id NOT IN (${Prisma.join(excludeIdArray)})` : Prisma.empty}
      ORDER BY pinned DESC, COALESCE((metadata->>'importance')::int, 1) DESC, "createdAt" DESC
      LIMIT 30
    `;
  } catch (error) {
    console.error("[context.entity_cards.error]", { error, entityKeyArray, excludeIdArray });
    return [];
  }

  // Group facts by entity key
  const cardsByEntity = new Map<string, string[]>();

  for (const m of linkedMemories) {
    const refs = (m.metadata?.entityRefs as string[]) ?? [];
    // Find which of our target entity keys this memory matches
    for (const ref of refs) {
      if (entityKeys.has(ref)) {
        if (!cardsByEntity.has(ref)) {
          cardsByEntity.set(ref, []);
        }
        const facts = cardsByEntity.get(ref)!;
        if (facts.length < MAX_FACTS_PER_CARD) {
          facts.push(m.content);
        }
        break; // Only assign to first matching entity to avoid duplication
      }
    }
  }

  // Format cards: [entity_key]: fact1; fact2; fact3
  const cardStrings: string[] = [];
  for (const [entityKey, facts] of cardsByEntity) {
    if (facts.length > 0) {
      const uniqueFacts = [...new Set(facts)];
      cardStrings.push(`[${entityKey}]: ${uniqueFacts.join("; ")}`);
    }
  }

  return cardStrings.slice(0, MAX_ENTITY_CARDS);
}

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:]+$/g, "");
}

function selectRelevantMemories<T extends { id: string; type: string; content: string }>(
  memories: T[]
): T[] {
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
  const selected: T[] = [];

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
      where: { userId, personaId },
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

    // Get latest summary spine (only if enabled)
    const summarySpineRecord = summarySpineEnabled
      ? await prisma.summarySpine.findFirst({
          where: {
            userId,
            conversationId: "default",
          },
          orderBy: { version: "desc" },
        })
      : null;

    // Validate summarySpine content - return undefined if empty or placeholder
    const summarySpineContent = summarySpineRecord?.content?.trim();
    const isSpineEmpty = !summarySpineContent ||
      summarySpineContent === "" ||
      /^PROFILE:\s*-?\s*$/i.test(summarySpineContent) ||
      summarySpineContent.length < 20;

    const latestSessionSummary = await getLatestSessionSummary(userId, personaId);

    // Detect session start: no recent messages for this persona means new session
    // This is used for conditional SessionSummary injection
    const isSessionStart = messages.length === 0;

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
        OR: [{ personaId }, { personaId: null }],
      },
      orderBy: { createdAt: "asc" },
      take: MAX_FOUNDATION_MEMORIES,
      select: { content: true, metadata: true },
    });

    const sortedFoundation = [...foundationMemories];

    const relevantMemories = await searchMemories(userId, personaId, userMessage, 12);

    // Filter out foundation (pinned) memories first - they go to separate block
    const foundationSet = new Set(
      foundationMemories.map((memory) => normalizeText(memory.content))
    );
    const filteredRelevant = relevantMemories.filter(
      (memory) => !foundationSet.has(normalizeText(memory.content))
    );
    const selectedRelevant = selectRelevantMemories(filteredRelevant);

    // Entity card expansion (1-hop) - gated by feature flag
    // Extract entity keys from ALL relevant memories (including ones going to foundation)
    // But only exclude IDs of memories that will appear in the final relevant memories
    let entityCardStrings: string[] = [];
    if (env.FEATURE_ENTITY_PIPELINE !== "false") {
      const entityKeys = extractEntityKeysFromMemories(relevantMemories);
      if (entityKeys.size > 0) {
        // Only exclude memories that will appear in final relevantMemories
        const excludeIds = new Set(selectedRelevant.map((m) => m.id));
        entityCardStrings = await buildEntityCards(userId, personaId, entityKeys, excludeIds);
      }
    }

    // Inject entity cards at TOP of relevant memories block
    const relevantMemoryStrings = [
      ...entityCardStrings,
      ...selectedRelevant.map(formatMemory),
    ];
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

    // Only include rollingSummary if non-empty
    const rollingSummaryContent = sessionState?.rollingSummary?.trim();
    const validRollingSummary = rollingSummaryContent && rollingSummaryContent.length > 0
      ? rollingSummaryContent.slice(0, MAX_ROLLING_SUMMARY_CHARS)
      : undefined;

    return {
      persona: personaPrompt,
      userSeed: userSeed?.content?.slice(0, MAX_USER_SEED_CHARS),
      sessionState: sessionState?.state,
      rollingSummary: validRollingSummary,
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
      // Only include summarySpine if enabled AND has meaningful content
      summarySpine: (summarySpineEnabled && !isSpineEmpty)
        ? summarySpineContent!.slice(0, MAX_SUMMARY_SPINE_CHARS)
        : undefined,
      sessionSummary: formatSessionSummary(latestSessionSummary?.summary),
      isSessionStart,
    };
  } catch (error) {
    console.error("Context Builder Error:", error);
    throw new Error("Failed to build conversation context");
  }
}
