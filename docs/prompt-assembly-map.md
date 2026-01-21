# Prompt Assembly Map (Live Code)

## v1.3.2 changes
- Session summaries run asynchronously on session close and never block chat requests.
- Session summarizer uses a hard timeout (default 2500ms) via `SUMMARY_TIMEOUT_MS`.
- Relevant memories are deduped against foundation memories by normalized content.

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
      ...(activeTodoStrings
        ? [
            {
              role: "system" as const,
              content: `OPEN LOOPS (pending):\n${activeTodoStrings}`,
            },
          ]
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
  activeTodos: string[];
  recentWins: string[];
  summarySpine?: string;
  sessionSummary?: string;
}

const MAX_OPEN_LOOPS = 5;
const MAX_USER_SEED_CHARS = 800;
const MAX_SUMMARY_SPINE_CHARS = 1200;
const MAX_RECENT_MESSAGE_CHARS = 800;

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
      activeTodos: openLoops.map((todo) => todo.content),
      recentWins: recentWins.map((todo) => todo.content),
      summarySpine: summarySpine?.content?.slice(0, MAX_SUMMARY_SPINE_CHARS),
      sessionSummary: latestSessionSummary?.summary.slice(0, 600),
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

      const openLoopTodos = filteredMemories.filter(
        (memory) => memory.type === MemoryType.OPEN_LOOP
      );
      if (openLoopTodos.length > 0) {
        await Promise.all(
          openLoopTodos.map(async (memory) => {
            await prisma.todo.create({
              data: {
                userId,
                personaId,
                content: memory.content,
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
| Foundation | contextBuilder.ts -> foundationMemories | Memory (PROFILE/PEOPLE/PROJECT) | take 12 | none | Ordered asc; can include old low-signal entries. |
| Relevant | memoryStore.ts searchMemories + contextBuilder selectRelevantMemories | Memory (PROFILE/PEOPLE/PROJECT) | top 12 raw; max 8 selected | per-type + content | Deduped against Foundation by normalized content. |
| Open Loops | contextBuilder.ts dedupeOpenLoops | Todo (PENDING) | max 5 | normalized content | Depends on Todo creation; may still include noisy commitments. |
| Wins | contextBuilder.ts recentWins | Todo (COMPLETED, last 48h) | max 3 | none | Uses content only; no metadata. |
| Summary Spine | contextBuilder.ts summarySpine | SummarySpine.content | max 1200 chars | none | No truncation per section; could still be dense. |
| Latest Session Summary | sessionService.ts getLatestSessionSummary | SessionSummary.summary | max 600 chars | none | Only injected if exists. |
| Session State | route.ts getSessionContext | SessionState.state | derived | n/a | Duplicates Session lastActivityAt; possible overlap. |
| UserSeed | contextBuilder.ts userSeed | UserSeed.content | max 800 chars | none | Manual seed, can be stale. |

## Duplications / Contradictions
- SessionState lastInteraction duplicates Session.lastActivityAt; both can inform “time since last message.”
- Foundation and Relevant can repeat the same memory content (same text appears in both blocks).
- Open Loops are derived from Todos; if Todo creation duplicates, block can still show repetition despite dedupe by text.

## Smallest 3 Improvements (no behavior change)
1) Prefer seeded profile entries first in Foundation (ordering by metadata.source then createdAt) to reduce noise.
2) Normalize relevant memory text before formatting to reduce near‑duplicates between Foundation/Relevant.
3) Add a soft warning log when combined system blocks exceed a size budget (no truncation change).
