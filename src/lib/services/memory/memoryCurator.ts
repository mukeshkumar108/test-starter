import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import { MemoryType, TodoKind, type Memory as MemoryRecord } from "@prisma/client";

const MAX_FOLDS_PER_RUN = 5;

// ============================================================
// CURATOR V1: TODO HYGIENE
// ============================================================

// Patterns for completion detection
const COMPLETION_PATTERNS = [
  /\b(i did|i've done|i finished|i completed|done with|finished with)\b/i,
  /\b(went for|took|had my|did my|went out|went to)\b/i,
  /\b(already|just finished|just did|just completed)\b/i,
];

// Patterns for recurrence/habit detection
const RECURRENCE_PATTERNS = [
  /\b(every day|everyday|daily|each day)\b/i,
  /\b(every morning|every evening|every night)\b/i,
  /\b(routine|regularly|habitually)\b/i,
  /\b(i want to .{0,30} every|i need to .{0,30} every)\b/i,
  /\b(weekly|monthly|each week|each month)\b/i,
];

// Patterns for non-actionable threads
const NON_ACTIONABLE_PATTERNS = [
  /\b(sun is|weather is|it's raining|it's sunny|nice day)\b/i,
  /\b(just thinking|wondering|curious about)\b/i,
  /\b(random thought|by the way|btw)\b/i,
];

/**
 * Extract action keywords from user message for matching against commitments
 */
function extractActionKeywords(message: string): string[] {
  const normalized = message.toLowerCase().replace(/[^\w\s]/g, " ");
  const stopwords = new Set([
    "i", "my", "the", "a", "an", "to", "for", "of", "and", "or", "but",
    "did", "have", "had", "went", "took", "just", "already", "finished",
    "completed", "done", "today", "yesterday", "morning", "evening",
  ]);
  return normalized
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopwords.has(word));
}

/**
 * Score how well a commitment matches the user's completion message
 */
function scoreCommitmentMatch(commitmentContent: string, actionKeywords: string[]): number {
  const normalized = commitmentContent.toLowerCase();
  let score = 0;
  for (const keyword of actionKeywords) {
    if (normalized.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Check if a date is today (for win idempotency)
 */
function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

/**
 * Curator V1: Complete matching commitment and extract win
 *
 * When user confirms completion ("I did my walk", "I went out"):
 * 1. Find the most recent matching PENDING COMMITMENT
 * 2. Mark it COMPLETED with timestamp
 * 3. Create a Win record (idempotent)
 */
export async function curatorCompleteCommitment(
  userId: string,
  personaId: string,
  userMessage: string
): Promise<{ completed: boolean; winCreated: boolean; commitmentId?: string }> {
  if (!isCuratorEnabled()) {
    return { completed: false, winCreated: false };
  }

  // Check if message signals completion
  const hasCompletionSignal = COMPLETION_PATTERNS.some((pattern) =>
    pattern.test(userMessage)
  );
  if (!hasCompletionSignal) {
    return { completed: false, winCreated: false };
  }

  // Get pending commitments
  const pendingCommitments = await prisma.todo.findMany({
    where: {
      userId,
      personaId,
      status: "PENDING",
      kind: TodoKind.COMMITMENT,
    },
    orderBy: { createdAt: "desc" },
  });

  if (pendingCommitments.length === 0) {
    return { completed: false, winCreated: false };
  }

  // Extract keywords and find best matching commitment
  const actionKeywords = extractActionKeywords(userMessage);
  let bestMatch = pendingCommitments[0];
  let bestScore = 0;

  for (const commitment of pendingCommitments) {
    const score = scoreCommitmentMatch(commitment.content, actionKeywords);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = commitment;
    }
  }

  // If only one commitment or we found a good match, complete it
  const shouldComplete = pendingCommitments.length === 1 || bestScore >= 1;
  if (!shouldComplete) {
    return { completed: false, winCreated: false };
  }

  const now = new Date();

  // Mark commitment as completed
  await prisma.todo.update({
    where: { id: bestMatch.id },
    data: {
      status: "COMPLETED",
      completedAt: now,
    },
  });

  // Check for existing win today (idempotency)
  const existingWin = await prisma.todo.findFirst({
    where: {
      userId,
      personaId,
      kind: TodoKind.COMMITMENT, // We use COMMITMENT + isWin metadata
      status: "COMPLETED",
      completedAt: {
        gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        lt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
      },
    },
  });

  // Check if this specific commitment already has a win
  const winDedupeKey = `win:${bestMatch.dedupeKey ?? normalizeContent(bestMatch.content)}`;
  const existingWinForCommitment = await prisma.todo.findFirst({
    where: {
      userId,
      personaId,
      dedupeKey: winDedupeKey,
    },
  });

  let winCreated = false;
  if (!existingWinForCommitment) {
    // Create win record using Todo with metadata flag
    await prisma.todo.create({
      data: {
        userId,
        personaId,
        content: `✓ ${bestMatch.content}`,
        kind: TodoKind.COMMITMENT, // Reuse COMMITMENT kind
        status: "COMPLETED",
        completedAt: now,
        dedupeKey: winDedupeKey,
      },
    });
    winCreated = true;
  }

  console.log("[curator.v1.complete]", {
    userId,
    personaId,
    commitmentId: bestMatch.id,
    commitmentContent: bestMatch.content,
    matchScore: bestScore,
    winCreated,
  });

  return { completed: true, winCreated, commitmentId: bestMatch.id };
}

/**
 * Curator V1: Promote commitment to habit
 *
 * When user expresses recurrence ("every day", "daily"):
 * 1. Check recent pending commitments for ones that should be habits
 * 2. Create HABIT if not exists
 * 3. Mark original COMMITMENT as COMPLETED (not archived, to preserve history)
 */
export async function curatorPromoteToHabit(
  userId: string,
  personaId: string,
  userMessage: string
): Promise<{ promoted: boolean; habitCreated: boolean; commitmentId?: string }> {
  if (!isCuratorEnabled()) {
    return { promoted: false, habitCreated: false };
  }

  // Check if message signals recurrence
  const hasRecurrenceSignal = RECURRENCE_PATTERNS.some((pattern) =>
    pattern.test(userMessage)
  );
  if (!hasRecurrenceSignal) {
    return { promoted: false, habitCreated: false };
  }

  // Get recent pending commitments (last 24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCommitments = await prisma.todo.findMany({
    where: {
      userId,
      personaId,
      status: "PENDING",
      kind: TodoKind.COMMITMENT,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
  });

  if (recentCommitments.length === 0) {
    return { promoted: false, habitCreated: false };
  }

  // Extract keywords to find matching commitment
  const actionKeywords = extractActionKeywords(userMessage);
  let bestMatch = recentCommitments[0];
  let bestScore = 0;

  for (const commitment of recentCommitments) {
    const score = scoreCommitmentMatch(commitment.content, actionKeywords);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = commitment;
    }
  }

  // Check if we have a good match or only one recent commitment
  if (recentCommitments.length > 1 && bestScore < 1) {
    return { promoted: false, habitCreated: false };
  }

  // Check for existing habit with same content or similar keywords
  const habitDedupeKey = `habit:${bestMatch.dedupeKey ?? normalizeContent(bestMatch.content)}`;
  const commitmentKeywords = extractActionKeywords(bestMatch.content);

  // Get all pending habits
  const existingHabits = await prisma.todo.findMany({
    where: {
      userId,
      personaId,
      kind: TodoKind.HABIT,
      status: "PENDING",
    },
  });

  // Check if any habit matches by dedupeKey, content substring, or keyword overlap
  const existingHabit = existingHabits.find((habit) => {
    // Check dedupeKey match
    if (habit.dedupeKey === habitDedupeKey) return true;

    // Check content substring match
    if (normalizeContent(habit.content).includes(normalizeContent(bestMatch.content).slice(0, 15))) {
      return true;
    }

    // Check keyword overlap (e.g., both contain "walk")
    const habitKeywords = extractActionKeywords(habit.content);
    const overlap = commitmentKeywords.filter((k) => habitKeywords.includes(k));
    if (overlap.length > 0) return true;

    return false;
  });

  let habitCreated = false;
  if (!existingHabit) {
    // Create the habit
    await prisma.todo.create({
      data: {
        userId,
        personaId,
        content: bestMatch.content,
        kind: TodoKind.HABIT,
        status: "PENDING",
        dedupeKey: habitDedupeKey,
      },
    });
    habitCreated = true;
  }

  // Mark original commitment as completed (not archived)
  await prisma.todo.update({
    where: { id: bestMatch.id },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });

  console.log("[curator.v1.habit_promote]", {
    userId,
    personaId,
    commitmentId: bestMatch.id,
    commitmentContent: bestMatch.content,
    habitCreated,
  });

  return { promoted: true, habitCreated, commitmentId: bestMatch.id };
}

/**
 * Curator V1: Clean non-actionable threads
 *
 * Mark threads as SKIPPED if they are:
 * - Non-actionable
 * - Contextual/informational only
 */
export async function curatorCleanThreads(
  userId: string,
  personaId: string
): Promise<{ cleaned: number }> {
  if (!isCuratorEnabled()) {
    return { cleaned: 0 };
  }

  const pendingThreads = await prisma.todo.findMany({
    where: {
      userId,
      personaId,
      status: "PENDING",
      kind: TodoKind.THREAD,
    },
    orderBy: { createdAt: "desc" },
    take: 20, // Limit per run
  });

  let cleaned = 0;

  for (const thread of pendingThreads) {
    const isNonActionable = NON_ACTIONABLE_PATTERNS.some((pattern) =>
      pattern.test(thread.content)
    );

    if (isNonActionable) {
      await prisma.todo.update({
        where: { id: thread.id },
        data: { status: "SKIPPED" },
      });
      cleaned += 1;
    }
  }

  if (cleaned > 0) {
    console.log("[curator.v1.thread_clean]", {
      userId,
      personaId,
      cleaned,
    });
  }

  return { cleaned };
}

/**
 * Curator V1: Light memory hygiene
 *
 * Archive obvious low-importance, stale memories only if:
 * - Duplicated or superseded
 * - importance <= 1
 * - NOT pinned
 */
export async function curatorMemoryHygiene(
  userId: string
): Promise<{ archived: number }> {
  if (!isCuratorEnabled()) {
    return { archived: 0 };
  }

  const candidates = await prisma.memory.findMany({
    where: {
      userId,
      pinned: false, // Never touch pinned
      type: { in: [MemoryType.PROFILE, MemoryType.PEOPLE, MemoryType.PROJECT] },
    },
    orderBy: { createdAt: "desc" },
  });

  const active = candidates.filter((memory) => {
    const metadata = getMetadataObject(memory.metadata);
    const status = metadata?.status ?? "ACTIVE";
    const importance = typeof metadata?.importance === "number" ? metadata.importance : 1;
    // Only consider low-importance for archival
    return status !== "ARCHIVED" && importance <= 1;
  });

  // Group by normalized content for duplicate detection
  const groups = new Map<string, MemoryRecord[]>();
  for (const memory of active) {
    const key = `${memory.type}:${normalizeContent(memory.content)}`;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }

  let archived = 0;
  const nowIso = new Date().toISOString();

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Keep the newest, archive the rest
    const sorted = group.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const keep = sorted[0];

    for (const memory of sorted.slice(1)) {
      const metadata = getMetadataObject(memory.metadata) ?? {};
      await prisma.memory.update({
        where: { id: memory.id },
        data: {
          metadata: {
            ...metadata,
            status: "ARCHIVED",
            archivedAt: nowIso,
            archiveReason: "curator_v1_dedupe",
          },
        },
      });
      archived += 1;
    }
  }

  if (archived > 0) {
    console.log("[curator.v1.memory_hygiene]", { userId, archived });
  }

  return { archived };
}

/**
 * Curator V1: Main entry point for todo hygiene
 * Called from shadow path with user message context
 */
export async function curatorTodoHygiene(
  userId: string,
  personaId: string,
  userMessage: string
): Promise<{
  completionResult: { completed: boolean; winCreated: boolean };
  habitResult: { promoted: boolean; habitCreated: boolean };
  threadResult: { cleaned: number };
}> {
  if (!isCuratorEnabled()) {
    return {
      completionResult: { completed: false, winCreated: false },
      habitResult: { promoted: false, habitCreated: false },
      threadResult: { cleaned: 0 },
    };
  }

  // Run all todo hygiene operations
  const [completionResult, habitResult, threadResult] = await Promise.all([
    curatorCompleteCommitment(userId, personaId, userMessage),
    curatorPromoteToHabit(userId, personaId, userMessage),
    curatorCleanThreads(userId, personaId),
  ]);

  return { completionResult, habitResult, threadResult };
}

// ============================================================
// EXISTING CURATOR CODE (Memory folding)
// ============================================================
const AUTO_RUN_COOLDOWN_MS = 60 * 1000;
const AUTO_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_RUN_MEMORY_THRESHOLD = 25;
const autoRunGuards = new Map<string, number>();

function isCuratorEnabled() {
  // Check process.env directly for testability (env is parsed at load time)
  return process.env.FEATURE_MEMORY_CURATOR === "true" || env.FEATURE_MEMORY_CURATOR === "true";
}

function getMetadataObject(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  return metadata as Record<string, unknown>;
}

function normalizeContent(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:]+$/g, "");
}

function isSeeded(metadata: Record<string, unknown> | null) {
  return metadata?.source === "seeded_profile";
}

function getEntityKey(content: string) {
  const match = content.match(/\b[A-Z][a-z]+\b/);
  return match?.[0] ?? null;
}

function buildSummary(prefix: string, items: Array<{ content: string }>) {
  const details = items.map((item) => item.content).slice(0, 5).join(" / ");
  return `${prefix}: ${details}`;
}

export async function runCuratorForUser(userId: string) {
  if (!isCuratorEnabled()) {
    return { enabled: false, folded: 0 };
  }

  const candidates = await prisma.memory.findMany({
    where: {
      userId,
      type: { in: [MemoryType.PEOPLE, MemoryType.PROJECT] },
    },
    orderBy: { createdAt: "asc" },
  });

  const activeObservations = candidates.filter((memory) => {
    const metadata = getMetadataObject(memory.metadata);
    const source = metadata?.source;
    const status = metadata?.status ?? "ACTIVE";
    return source === "shadow_extraction" && status !== "ARCHIVED";
  });

  type Observation = MemoryRecord;
  type Group = {
    type: MemoryType;
    key: string;
    items: Observation[];
    metaKey?: { entity?: string; project?: string };
  };
  const groups = new Map<string, Group>();

  for (const memory of activeObservations) {
    if (memory.type === MemoryType.PEOPLE) {
      const metadata = getMetadataObject(memory.metadata);
      const entityValue = metadata?.entity;
      const entity =
        typeof entityValue === "string" ? entityValue : getEntityKey(memory.content);
      if (!entity) continue;
      const key = `PEOPLE:${entity}`;
      const group = groups.get(key) ?? {
        type: MemoryType.PEOPLE,
        key,
        items: [] as Observation[],
        metaKey: { entity },
      };
      group.items.push(memory);
      groups.set(key, group);
    }

    if (memory.type === MemoryType.PROJECT) {
      const metadata = getMetadataObject(memory.metadata);
      const projectValue = metadata?.project;
      const project = typeof projectValue === "string" ? projectValue : null;
      if (!project) continue;
      const key = `PROJECT:${project}`;
      const group = groups.get(key) ?? {
        type: MemoryType.PROJECT,
        key,
        items: [] as Observation[],
        metaKey: { project },
      };
      group.items.push(memory);
      groups.set(key, group);
    }
  }

  let folded = 0;
  const nowIso = new Date().toISOString();

  for (const group of groups.values()) {
    if (folded >= MAX_FOLDS_PER_RUN) break;
    if (group.items.length < 3) continue;

    const summary =
      group.type === MemoryType.PEOPLE
        ? buildSummary(group.metaKey?.entity ?? "Person", group.items)
        : buildSummary(group.metaKey?.project ?? "Project", group.items);

    const foldedIds = group.items.map((item) => item.id);

    await prisma.memory.create({
      data: {
        userId,
        type: group.type,
        content: summary,
        metadata: {
          source: "curated_fold",
          status: "ACTIVE",
          importance: 2,
          folded_from_ids: foldedIds,
          ...(group.metaKey ?? {}),
        },
      },
    });

    for (const memory of group.items) {
      const metadata = getMetadataObject(memory.metadata) ?? {};
      await prisma.memory.update({
        where: { id: memory.id },
        data: {
          metadata: {
            ...metadata,
            status: "ARCHIVED",
            archivedAt: nowIso,
          },
        },
      });
    }

    folded += 1;
  }

  return { enabled: true, folded };
}

export async function runCuratorBatch(limitUsers: number = 25) {
  if (!isCuratorEnabled()) {
    return { enabled: false, folded: 0, usersProcessed: 0 };
  }

  const userIds = await prisma.memory.findMany({
    where: { type: { in: [MemoryType.PEOPLE, MemoryType.PROJECT] } },
    distinct: ["userId"],
    take: limitUsers,
    select: { userId: true },
  });

  let foldedTotal = 0;
  for (const user of userIds) {
    const result = await runCuratorForUser(user.userId);
    foldedTotal += result.folded;
  }

  return { enabled: true, folded: foldedTotal, usersProcessed: userIds.length };
}

async function runDeterministicHygiene(userId: string) {
  const candidates = await prisma.memory.findMany({
    where: {
      userId,
      type: { in: [MemoryType.PROFILE, MemoryType.PEOPLE, MemoryType.PROJECT] },
    },
    orderBy: { createdAt: "desc" },
  });

  const active = candidates.filter((memory) => {
    const metadata = getMetadataObject(memory.metadata);
    const status = metadata?.status ?? "ACTIVE";
    return status !== "ARCHIVED";
  });

  const groups = new Map<string, MemoryRecord[]>();
  for (const memory of active) {
    const key = `${memory.type}:${normalizeContent(memory.content)}`;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }

  let archived = 0;
  let deduped = 0;
  const nowIso = new Date().toISOString();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const seeded = group.filter((item) => isSeeded(getMetadataObject(item.metadata)));
    const keep =
      seeded.length > 0
        ? seeded.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        : group.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

    for (const memory of group) {
      if (memory.id === keep.id) continue;
      const metadata = getMetadataObject(memory.metadata) ?? {};
      await prisma.memory.update({
        where: { id: memory.id },
        data: {
          metadata: {
            ...metadata,
            status: "ARCHIVED",
            archivedAt: nowIso,
            archiveReason: "dedupe",
          },
        },
      });
      archived += 1;
      deduped += 1;
    }
  }

  let folded = 0;
  for (const memory of active) {
    if (folded >= MAX_FOLDS_PER_RUN) break;
    if (memory.type !== MemoryType.PEOPLE) continue;
    const metadata = getMetadataObject(memory.metadata);
    if (isSeeded(metadata) || metadata?.source === "curated_fold") continue;
    const entityValue = metadata?.entity;
    if (typeof entityValue !== "string") continue;
    const related = active.filter((item) => {
      if (item.type !== MemoryType.PEOPLE) return false;
      const meta = getMetadataObject(item.metadata);
      if (isSeeded(meta)) return false;
      return meta?.entity === entityValue;
    });
    if (related.length < 3) continue;

    const summary = buildSummary(entityValue, related);
    const foldedIds = related.map((item) => item.id);

    await prisma.memory.create({
      data: {
        userId,
        type: MemoryType.PEOPLE,
        content: summary,
        metadata: {
          source: "curated_fold",
          status: "ACTIVE",
          importance: 2,
          folded_from_ids: foldedIds,
          entity: entityValue,
        },
      },
    });

    for (const item of related) {
      const meta = getMetadataObject(item.metadata) ?? {};
      await prisma.memory.update({
        where: { id: item.id },
        data: {
          metadata: {
            ...meta,
            status: "ARCHIVED",
            archivedAt: nowIso,
            archiveReason: "fold",
          },
        },
      });
      archived += 1;
    }

    folded += 1;
  }

  return { archived, deduped, folded };
}

export async function autoCurateMaybe(userId: string, personaId: string) {
  const key = `${userId}:${personaId}`;
  const now = Date.now();
  const lastGuard = autoRunGuards.get(key) ?? 0;
  if (now - lastGuard < AUTO_RUN_COOLDOWN_MS) {
    return { skipped: true, reason: "cooldown" };
  }
  autoRunGuards.set(key, now);

  const sessionState = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
  });
  const baseState =
    sessionState?.state && typeof sessionState.state === "object" && !Array.isArray(sessionState.state)
      ? (sessionState.state as Record<string, unknown>)
      : {};
  const curatorState =
    baseState.curator && typeof baseState.curator === "object" && !Array.isArray(baseState.curator)
      ? (baseState.curator as Record<string, unknown>)
      : {};
  const lastRunAtRaw = curatorState.lastRunAt;
  const lastRunAt = typeof lastRunAtRaw === "string" ? new Date(lastRunAtRaw) : null;
  const lastRunMs = lastRunAt?.getTime() ?? 0;

  const dueByTime = !lastRunAt || now - lastRunMs >= AUTO_RUN_INTERVAL_MS;
  let dueByCount = false;

  if (!dueByTime && lastRunAt) {
    const recent = await prisma.memory.findMany({
      where: {
        userId,
        createdAt: { gt: lastRunAt },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { metadata: true },
    });
    const recentCount = recent.filter((item) => {
      const metadata = getMetadataObject(item.metadata);
      const status = metadata?.status ?? "ACTIVE";
      return status !== "ARCHIVED";
    }).length;
    dueByCount = recentCount >= AUTO_RUN_MEMORY_THRESHOLD;
  }

  if (!dueByTime && !dueByCount) {
    return { skipped: true, reason: "not_due" };
  }

  const reason = dueByTime ? "24h" : "25mem";
  const startedAt = Date.now();
  console.log(
    "[curator.auto]",
    JSON.stringify({ userId, personaId, reason, startedAt })
  );

  const result = await runDeterministicHygiene(userId);
  const elapsedMs = Date.now() - startedAt;

  const newState = {
    ...baseState,
    curator: {
      lastRunAt: new Date().toISOString(),
      lastMemoryCountAtRun: result.deduped + result.archived,
    },
  };

  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId, personaId } },
    update: { state: newState },
    create: { userId, personaId, state: newState },
  });

  console.log(
    "[curator.auto.done]",
    JSON.stringify({
      userId,
      personaId,
      reason,
      elapsedMs,
      counts: {
        archived: result.archived,
        deduped: result.deduped,
        folded: result.folded,
      },
    })
  );
  if (elapsedMs > 5000) {
    console.warn(
      "[curator.warn]",
      JSON.stringify({
        userId,
        personaId,
        reason,
        elapsedMs,
        counts: {
          archived: result.archived,
          deduped: result.deduped,
          folded: result.folded,
        },
      })
    );
  }

  return { ...result, reason };
}
