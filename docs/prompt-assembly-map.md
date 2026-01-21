# Prompt Assembly Map (Live Code)

## v1.3.5 / v1.3.6 changes
- Open loops are split into COMMITMENTS, THREADS, and FRICTIONS.
- COMMITMENTS drive tasks; THREADS/FRICTIONS are tracked separately.
- Curator auto-trigger runs deterministically and asynchronously.

## Raw Code Excerpts

### src/app/api/chat/route.ts (assembly + injected blocks)
```ts
    const context = await buildContext(user.id, personaId, sttResult.transcript);
    const lastMessage = await prisma.message.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    const foundationMemoryStrings = context.foundationMemories.join("\n");
    const relevantMemoryStrings = context.relevantMemories.join("\n");
    const sessionContext = getSessionContext(context.sessionState);
    const activeTodos = context.activeTodos;
    const activeTodoStrings = activeTodos.join("\n");
    const recentWins = context.recentWins;
    const recentWinStrings = recentWins.join("\n");
    const model = getChatModelForPersona(persona.slug);
    const messages = [
      { role: "system" as const, content: getCurrentContext({ lastMessageAt: lastMessage?.createdAt }) },
      ...(sessionContext ? [{ role: "system" as const, content: sessionContext }] : []),
      { role: "system" as const, content: context.persona },
      ...(foundationMemoryStrings
        ? [{ role: "system" as const, content: `[FOUNDATION MEMORIES]:\n${foundationMemoryStrings}` }]
        : []),
      ...(relevantMemoryStrings
        ? [{ role: "system" as const, content: `[RELEVANT MEMORIES]:\n${relevantMemoryStrings}` }]
        : []),
      ...(commitmentStrings
        ? [
            {
              role: "system" as const,
              content: `COMMITMENTS (pending):\n${commitmentStrings}`,
            },
          ]
        : []),
      ...(threadStrings
        ? [{ role: "system" as const, content: `ACTIVE THREADS:\n${threadStrings}` }]
        : []),
      ...(frictionStrings
        ? [{ role: "system" as const, content: `FRICTIONS / PATTERNS:\n${frictionStrings}` }]
        : []),
      ...(recentWinStrings
        ? [{ role: "system" as const, content: `Recent wins:\n${recentWinStrings}` }]
        : []),
      ...(context.userSeed ? [{ role: "system" as const, content: `User context: ${context.userSeed}` }] : []),
      ...(context.summarySpine ? [{ role: "system" as const, content: `Conversation summary: ${context.summarySpine}` }] : []),
      ...(context.sessionSummary
        ? [
            {
              role: "system" as const,
              content: `LATEST SESSION SUMMARY: ${context.sessionSummary}`,
            },
          ]
        : []),
      ...context.recentMessages,
      { role: "user" as const, content: sttResult.transcript },
    ];
```

### src/lib/services/memory/contextBuilder.ts (context fields + caps)
```ts
export interface ConversationContext {
  persona: string;
  userSeed?: string;
  sessionState?: any;
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
const MAX_USER_SEED_CHARS = 800;
const MAX_SUMMARY_SPINE_CHARS = 1200;
const MAX_RECENT_MESSAGE_CHARS = 800;
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

    const foundationMemories = await prisma.memory.findMany({
      where: {
        userId,
        type: { in: ["PROFILE", "PEOPLE", "PROJECT"] },
      },
      orderBy: { createdAt: "asc" },
      take: 12,
      select: { content: true, metadata: true },
    });

    const sortedFoundation = [...foundationMemories].sort((a, b) => {
      const aMeta = a.metadata as { source?: string } | null;
      const bMeta = b.metadata as { source?: string } | null;
      const aSeeded = aMeta?.source === "seeded_profile";
      const bSeeded = bMeta?.source === "seeded_profile";
      if (aSeeded === bSeeded) return 0;
      return aSeeded ? -1 : 1;
    });

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
      recentMessages: messages
        .map((message) => ({
          ...message,
          content: message.content.slice(0, MAX_RECENT_MESSAGE_CHARS),
        }))
        .reverse(),
      foundationMemories: foundationMemoryStrings,
      relevantMemories: relevantMemoryStrings,
      commitments: commitments.map((todo) => todo.content),
      threads: threads.map((todo) => todo.content),
      frictions: frictions.map((todo) => todo.content),
      recentWins: recentWins.map((todo) => todo.content),
      summarySpine: summarySpine?.content?.slice(0, MAX_SUMMARY_SPINE_CHARS),
      sessionSummary: formatSessionSummary(latestSessionSummary?.summary),
    };
```

### src/lib/services/memory/shadowJudge.ts (inputs + writes)
```ts
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
    const memories = await extractMemories(userWindow);

      const foundationMemories = filteredMemories.filter(
        (memory) => memory.type !== MemoryType.OPEN_LOOP
      );

      await Promise.all(
        sanitizedFoundation.map(async (memory) => {
          await prisma.memory.create({
            data: {
              userId,
              type: memory.type,
              content: memory.content,
              metadata: { source: "shadow_extraction", confidence: memory.confidence },
            },
          });
        })
      );

    const normalizedLoops = loops
      .map((loop) => {
        const rawKind = typeof loop.kind === "string" ? loop.kind : "";
        const normalizedKind = rawKind.trim().toUpperCase();
        const content = typeof loop.content === "string" ? loop.content.trim() : "";
        if (!content) return null;
        const allowedKinds = new Set(["COMMITMENT", "THREAD", "FRICTION"]);
        const safeKind = allowedKinds.has(normalizedKind) ? normalizedKind : "THREAD";
        return { kind: safeKind as TodoKind, content, confidence: loop.confidence };
      })
      .filter((loop) => loop !== null)
      .slice(0, 8);

    if (normalizedLoops.length > 0) {
      await Promise.all(
        normalizedLoops.map(async (loop) => {
          await prisma.todo.create({
            data: {
              userId,
              personaId,
              content: loop.content,
              kind: loop.kind,
              status: "PENDING",
            },
          });
        })
      );
    }
```

### src/lib/services/session/sessionService.ts (summary retrieval)
```ts
export async function getLatestSessionSummary(userId: string, personaId: string) {
  return prisma.sessionSummary.findFirst({
    where: { userId, personaId },
    orderBy: { createdAt: "desc" },
  });
}
```

## Block Map Table

| Block Name | Source Function | Data Types | Caps | Dedupe | Notes/Risks |
| --- | --- | --- | --- | --- | --- |
| Foundation | contextBuilder.ts -> foundationMemories | Memory (PROFILE/PEOPLE/PROJECT) | take 12 | none | Seeded profiles sorted first, then oldest-first. |
| Relevant | memoryStore.ts searchMemories + contextBuilder selectRelevantMemories | Memory (PROFILE/PEOPLE/PROJECT) | top 12 raw; max 8 selected | per-type + content | Deduped against Foundation by normalized content. |
| Commitments | contextBuilder.ts dedupeTodos | Todo (PENDING, kind=COMMITMENT) | max 5 | normalized content | Tasks only; avoids ambiguous/venting loops. |
| Active Threads | contextBuilder.ts dedupeTodos | Todo (PENDING, kind=THREAD) | max 3 | normalized content | Unresolved topics/questions. |
| Frictions / Patterns | contextBuilder.ts dedupeTodos | Todo (PENDING, kind=FRICTION) | max 3 | normalized content | Recurring blockers/patterns. |
| Wins | contextBuilder.ts recentWins | Todo (COMPLETED, kind=COMMITMENT, last 48h) | max 3 | none | Uses content only; no metadata. |
| Summary Spine | contextBuilder.ts summarySpine | SummarySpine.content | max 1200 chars | none | No truncation per section; could still be dense. |
| Latest Session Summary | sessionService.ts getLatestSessionSummary | SessionSummary.summary | max 600 chars | none | Only injected if exists. |
| Prompt Size Warn | route.ts assembly | all blocks | warn at >20,000 chars | n/a | Logs `[chat.prompt.warn]` with sizes and counts. |
| Session State | route.ts getSessionContext | SessionState.state | derived | n/a | Duplicates Session lastActivityAt; possible overlap. |
| UserSeed | contextBuilder.ts userSeed | UserSeed.content | max 800 chars | none | Manual seed, can be stale. |

## Duplications / Contradictions
- SessionState lastInteraction duplicates Session.lastActivityAt; both can inform “time since last message.”
- Commitments/threads/frictions are derived from Todos; duplicates can still occur if similar phrasing varies.
- Session summaries are generated asynchronously; they may lag behind the most recent turns.

## Smallest 3 Improvements (no behavior change)
1) Prefer a fixed cap of seeded truths in Foundation (e.g., always include up to N seeded before any extracted).
2) Normalize Todo content further (strip parentheses/quotes) before dedupe to reduce near-duplicates.
3) Add per-kind counts to the prompt-size warning for quicker triage.
