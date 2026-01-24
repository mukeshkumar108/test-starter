# Prompt Assembly Map (v1.3.6+)

## v1.3.6+ Changes
- Commitments/threads/frictions replace the previous open-loops block.
- Cross-block dedupe: relevant memories exclude any content already in foundation.
- Foundation memories are pinned-only and persona-scoped (personaId or NULL).
- Relevant memory retrieval is persona-scoped (personaId or NULL).
- Soft prompt-size warning at 20,000 chars (`[chat.prompt.warn]`).
- Shadow Judge test mode (`FEATURE_JUDGE_TEST_MODE`) and Judge timeout (`JUDGE_TIMEOUT_MS`).

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
    const commitmentStrings = context.commitments.join("\n");
    const threadStrings = context.threads.join("\n");
    const frictionStrings = context.frictions.join("\n");
    const recentWinStrings = context.recentWins.join("\n");
    const rollingSummary = context.rollingSummary ?? "";
    const sessionSummary = context.sessionSummary ?? "";
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
        ? [{ role: "system" as const, content: `COMMITMENTS (pending):\n${commitmentStrings}` }]
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
      ...(rollingSummary
        ? [{ role: "system" as const, content: `CURRENT SESSION SUMMARY: ${rollingSummary}` }]
        : []),
      ...(context.sessionSummary
        ? [{ role: "system" as const, content: `LATEST SESSION SUMMARY: ${context.sessionSummary}` }]
        : []),
      ...context.recentMessages,
      { role: "user" as const, content: sttResult.transcript },
    ];
```

### src/lib/services/memory/contextBuilder.ts (context fields + caps)
```ts
const MAX_COMMITMENTS = 5;
const MAX_THREADS = 3;
const MAX_FRICTIONS = 3;
const MAX_USER_SEED_CHARS = 800;
const MAX_SUMMARY_SPINE_CHARS = 1200;
const MAX_RECENT_MESSAGE_CHARS = 800;
const MAX_ROLLING_SUMMARY_CHARS = 600;
const MAX_SESSION_SUMMARY_CHARS = 600;

function selectRelevantMemories(memories: Array<{ type: string; content: string }>) {
  const allowedTypes = new Set(["PROFILE", "PEOPLE", "PROJECT"]);
  const perTypeCaps = { PROFILE: 2, PEOPLE: 3, PROJECT: 3 };
  // dedupe + per-type caps, max 8 total
}

const foundationMemories = await prisma.memory.findMany({
  where: {
    userId,
    type: { in: ["PROFILE", "PEOPLE", "PROJECT"] },
    pinned: true,
    OR: [{ personaId }, { personaId: null }],
  },
  orderBy: { createdAt: "asc" },
  take: 20,
});

const sortedFoundation = [...foundationMemories];

const relevantMemories = await searchMemories(userId, personaId, userMessage, 12);
const foundationSet = new Set(foundationMemories.map((m) => normalizeText(m.content)));
const filteredRelevant = relevantMemories.filter((m) => !foundationSet.has(normalizeText(m.content)));
const selectedRelevant = selectRelevantMemories(filteredRelevant);

const commitments = dedupeTodos(commitmentTodos).slice(0, MAX_COMMITMENTS);
const threads = dedupeTodos(threadTodos).slice(0, MAX_THREADS);
const frictions = dedupeTodos(frictionTodos).slice(0, MAX_FRICTIONS);
```

### src/lib/services/memory/shadowJudge.ts (inputs + writes)
```ts
const recentUserMessages = await prisma.message.findMany({
  where: { userId, role: "user" },
  orderBy: { createdAt: "desc" },
  take: 6,
});
const cutoff = Date.now() - 60 * 60 * 1000;
const recentWindow = recentUserMessages
  .filter((m) => m.createdAt.getTime() >= cutoff)
  .map((m) => m.content);
const windowCandidates = [userMessage, ...recentWindow].filter(Boolean);
const deduped = windowCandidates.filter((content, index, arr) => arr.indexOf(content) === index);
const userWindow = deduped.slice(0, 4).reverse();
const extracted = await extractMemories(userWindow);

// Memory writes (PROFILE/PEOPLE/PROJECT only)
await prisma.memory.create({ data: { userId, type, content, metadata: { source: "shadow_extraction" } } });

// Loop writes
await prisma.todo.create({ data: { userId, personaId, content, kind, status: "PENDING" } });
```

### src/lib/services/session/sessionService.ts (summary retrieval + non-blocking)
```ts
if (isSummaryEnabled()) {
  void createSessionSummary({ ... }).catch((error) => {
    console.warn("[session.summary] failed", error);
  });
}

export async function getLatestSessionSummary(userId: string, personaId: string) {
  return prisma.sessionSummary.findFirst({ where: { userId, personaId }, orderBy: { createdAt: "desc" } });
}
```

## Block Map Table

| Block Name | Source | Data | Caps | Dedupe | Notes/Risks |
| --- | --- | --- | --- | --- | --- |
| [REAL-TIME CONTEXT] | `route.ts#getCurrentContext` | lastMessageAt, timezone, cached WeatherAPI | n/a | n/a | Weather cached per user/coords; non-blocking fetch. |
| [SESSION STATE] | `route.ts#getSessionContext` | SessionState JSON | n/a | n/a | Derived from SessionState, not Session. |
| Persona Prompt | `contextBuilder.ts` file read | promptPath content | n/a | n/a | Full prompt text. |
| [FOUNDATION MEMORIES] | `contextBuilder.ts` | Memory PROFILE/PEOPLE/PROJECT | 20 entries | none | Pinned-only; personaId = current or NULL. |
| [RELEVANT MEMORIES] | `memoryStore.ts` + `contextBuilder.ts` | Memory PROFILE/PEOPLE/PROJECT | max 8 selected | normalized content | Persona-scoped + cross-block dedupe vs foundation. |
| COMMITMENTS (pending) | `contextBuilder.ts` | Todo kind=COMMITMENT | max 5 | normalized content | Status=PENDING only. |
| ACTIVE THREADS | `contextBuilder.ts` | Todo kind=THREAD | max 3 | normalized content | Status=PENDING only. |
| FRICTIONS / PATTERNS | `contextBuilder.ts` | Todo kind=FRICTION | max 3 | normalized content | Status=PENDING only. |
| Recent wins | `contextBuilder.ts` | Todo kind=COMMITMENT, COMPLETED (48h) | max 3 | none | Content only. |
| User context | `contextBuilder.ts` | UserSeed.content | 800 chars | none | Optional. |
| Conversation summary | `contextBuilder.ts` | SummarySpine.content | 1200 chars | none | Optional; persona flag + global env. |
| CURRENT SESSION SUMMARY | `contextBuilder.ts` | SessionState.rollingSummary | 600 chars | none | Optional. |
| LATEST SESSION SUMMARY | `contextBuilder.ts` | SessionSummary.summary | 600 chars | none | JSON normalized to one-line string. |
| Recent messages | `contextBuilder.ts` | Message history | 6 messages; 800 chars each | none | Chronological order; persona-scoped. |
| User message | `route.ts` | STT transcript | n/a | n/a | Final user input. |

## Duplications / Contradictions
- SessionState lastInteraction duplicates Session.lastActivityAt; they can drift.
- Foundation vs Relevant can still overlap if normalization differs (punctuation/whitespace edge cases).
- Todo kinds in code include THREAD/FRICTION; ensure schema/migrations match (see `prisma/schema.prisma`).

## Smallest 3 Improvements (no behavior change)
1) Centralize normalization for dedupe across Foundation/Relevant/Loops in one helper module.
2) Add a log metric for total injected blocks length per request (beyond the warning threshold).
3) Record the active Todo.kind counts in `[chat.trace]` for better runtime visibility.
