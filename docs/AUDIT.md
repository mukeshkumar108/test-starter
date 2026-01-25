# AUDIT.md

## 1) Trace of a Message (Chat)

**Entry point**
- `src/app/api/chat/route.ts` → `POST(request)`

**Auth + session resolution**
- `auth()` (Clerk cookie) → if missing, bearer token via `verifyToken()`.
- `ensureUserByClerkId(clerkUserId)` (user upsert).
- `personaId` from multipart form field `personaId`.
- `prisma.personaProfile.findUnique({ where: { id: personaId } })` → 404 JSON if missing.
- `closeStaleSessionIfAny(user.id, personaId, now)` → `src/lib/services/session/sessionService.ts`
- `ensureActiveSession(user.id, personaId, now)` → `src/lib/services/session/sessionService.ts`

**Context builder**
- `buildContext(user.id, personaId, sttResult.transcript)` → `src/lib/services/memory/contextBuilder.ts`

**LLM prompt assembly (exact order)**
Source: `src/app/api/chat/route.ts` (messages array)
1. **[REAL-TIME]**
   - Source: `getCurrentContext()` in `route.ts`.
   - Always-on.
   - Includes date/time, weather, session gap (>30m), late-night flag.
2. **[SESSION STATE]**
   - Source: `getSessionContext(context.sessionState)`.
   - Optional (only if SessionState exists).
3. **Persona Prompt**
   - Source: `context.persona` from `contextBuilder` (prompt file from `persona.promptPath`).
4. **[FOUNDATION MEMORIES]**
   - Source: `context.foundationMemories`.
   - Optional (only if non-empty).
5. **[RELEVANT MEMORIES]**
   - Source: `context.relevantMemories`.
   - Optional; dropped first if budget exceeded.
6. **COMMITMENTS (pending)**
   - Source: `context.commitments`.
   - Optional.
7. **ACTIVE THREADS**
   - Source: `context.threads`.
   - Optional; dropped third if budget exceeded.
8. **FRICTIONS / PATTERNS**
   - Source: `context.frictions`.
   - Optional.
9. **Recent wins**
   - Source: `context.recentWins`.
   - Optional.
10. **User context**
    - Source: `context.userSeed`.
    - Optional.
11. **Conversation summary (SummarySpine)**
    - Source: `context.summarySpine`.
    - **Conditional injection**: Fully omitted (returns undefined) when:
      - `persona.enableSummarySpine === false`, OR
      - `FEATURE_SUMMARY_SPINE_GLOBAL === "false"`, OR
      - Content is empty/placeholder (e.g., "PROFILE: -" or < 20 chars)
12. **CURRENT SESSION SUMMARY**
    - Source: `context.rollingSummary` (from SessionState.rollingSummary).
    - **Conditional injection**: Only injected if non-empty string.
13. **LATEST SESSION SUMMARY**
    - Source: `context.sessionSummary` (SessionSummary table).
    - **Conditional injection**: Only injected on session boundary:
      - `isSessionStart === true` (no recent messages for persona), OR
      - `hasGap === true` (> 30 minutes since last message)
    - Dropped second if budget exceeded.
14. **Recent message history**
    - Source: `context.recentMessages` (last 6).
    - Always-on.
15. **Current user message**
    - Source: `sttResult.transcript`.
    - Always-on.

**Budget guard**
- `MAX_CONTEXT_TOKENS = 1200` in `route.ts`.
- Estimated via `chars/4` heuristic.
- Drop order (strict):
  1) relevantMemories
  2) sessionSummary
  3) threads
  4) non-pinned foundation overflow (placeholder; foundation is pinned-only)

**LLM call**
- `generateResponse(messages, persona.slug)` in `src/lib/services/voice/llmService.ts`.
- OpenRouter Chat Completions.
- Parameters: `model`, `max_tokens` (Sophie=350, others=1000), `temperature=0.7`, plus `top_p=0.9` and `presence_penalty=0.1` for Sophie.

**Post-processing**
- `synthesizeSpeech()` → `src/lib/services/voice/ttsService.ts`.
- Stores two `Message` rows (user + assistant).

**Async (non-blocking) paths**
- Shadow Judge: `processShadowPath(...)` (fire-and-forget). Inside shadow path, rolling summary updates are awaited every 4 user turns with a timeout guard. Also triggers `curatorTodoHygiene(...)` for todo cleanup.
- Curator V1 Todo Hygiene: `curatorTodoHygiene(...)` (fire-and-forget, called from shadow path). Handles commitment completion, habit promotion, thread cleanup.
- Curator auto-trigger: `autoCurateMaybe(...)` (fire-and-forget). Memory folding and deduplication.
- Session summaries (on stale session close): `closeStaleSessionIfAny` triggers `createSessionSummary(...)` (fire-and-forget).

**DB reads/writes (chat path)**
Sync reads (typical):
- `personaProfile.findUnique`
- `message.findFirst` (lastMessageAt)
- `buildContext` (see below)
- Session lifecycle (`session.findFirst` / `session.update|create`)
- `ensureUserByClerkId` (user upsert)

Sync writes:
- `message.create` (user)
- `message.create` (assistant)
- Session update/create

Async writes (shadow path):
- `memory.create` (PROFILE/PEOPLE/PROJECT)
- `todo.create` (COMMITMENT/HABIT/THREAD/FRICTION)
- `sessionState.upsert`
- `summarySpine.create` (if enabled)
- `sessionSummary.upsert` (on session close)
- `memory.update` / `memory.create` (curator)


## 2) Trace of a Message (Voice)

There is **no separate /api/voice route**. Voice is handled by `/api/chat`.
- STT (`transcribeAudio`) and TTS (`synthesizeSpeech`) are part of the same `/api/chat` flow.
- No divergent context builder, flags, or budgets for “voice vs chat.”


## 3) Current Context Pack Contract

**Block order (must stay first/last)**
- First: `[REAL-TIME]` (always) and `[SESSION STATE]` (optional) before persona.
- Last: `recentMessages` and the current user message.

**Budget drop order**
- `relevantMemories` → `sessionSummary` → `threads` → `non-pinned foundation overflow` (placeholder).
- Never dropped: real-time, persona prompt, commitments, frictions, pinned foundation, rolling summary, last 6 turns.

**Conditional injection flags**
- `isSessionStart`: True when no recent messages exist for this user+persona. Returned by `contextBuilder`.
- `hasGap`: True when > 30 minutes since last message. Computed in `route.ts`.
- SessionSummary is only injected when `isSessionStart || hasGap`.
- SummarySpine is only included when enabled AND has meaningful content (>20 chars, not placeholder).
- RollingSummary is only included when non-empty.


## 4) Shadow Judge Contract (CURRENT)

**Source**: `src/lib/services/memory/shadowJudge.ts`

**Input window**
- Last up to 4 unique user messages within last 60 minutes (deduped).

**Output JSON schema (expected)**
```json
{
  "memories": [
    { "type": "PROFILE|PEOPLE|PROJECT", "content": "...", "confidence": 0.0 }
  ],
  "loops": [
    { "kind": "COMMITMENT|HABIT|THREAD|FRICTION", "content": "...", "dedupe_key": "...", "confidence": 0.0 }
  ]
}
```

**Kinds recognized**
- `COMMITMENT`, `HABIT`, `THREAD`, `FRICTION`

**Dedupe strategy**
- In-memory dedupe: `dedupe_key` (normalized), fallback to normalized content.
- DB dedupe check: existing `Todo` rows with `status=PENDING` + same `kind` + same dedupe signature.

**Pinned behavior**
- Pinned applies only to foundation memory query (context builder). Shadow Judge does not set pinned.
**Persona scoping (writes)**
- Shadow Judge memory writes remain global (`Memory.personaId` is left NULL).

**Curator V1 integration**
- After todo writes, shadow path calls `curatorTodoHygiene(userId, personaId, userMessage)` async.
- Gated by `FEATURE_MEMORY_CURATOR === "true"`.


## 4b) Curator V1 Contract (CURRENT)

**Source**: `src/lib/services/memory/memoryCurator.ts`

**Trigger**
- Called from `processShadowPath()` after todo writes (async, non-blocking).
- Gated by `FEATURE_MEMORY_CURATOR === "true"`.

**Todo Hygiene Operations**

1. **Commitment Completion** (`curatorCompleteCommitment`)
   - Detects completion signals: "I did", "I finished", "went for", "took", "had my", etc.
   - Finds best matching PENDING COMMITMENT via keyword overlap scoring.
   - Marks commitment as COMPLETED with timestamp.
   - Creates Win record (Todo with `✓` prefix and `win:` dedupe key).
   - Idempotent: checks for existing win by dedupe key.

2. **Habit Promotion** (`curatorPromoteToHabit`)
   - Detects recurrence signals: "every day", "daily", "routine", "weekly", etc.
   - Finds matching recent COMMITMENT (within 24h) via keyword overlap.
   - Creates HABIT if no similar habit exists (checks dedupeKey, content, keyword overlap).
   - Marks original COMMITMENT as COMPLETED (not deleted).

3. **Thread Cleanup** (`curatorCleanThreads`)
   - Detects non-actionable threads: weather, "just thinking", "by the way", etc.
   - Marks matching PENDING THREADs as SKIPPED.
   - Processes up to 20 threads per run.

4. **Memory Hygiene** (`curatorMemoryHygiene`)
   - Archives duplicate low-importance memories (importance ≤ 1).
   - Never touches pinned memories.
   - Groups by normalized content, keeps newest, archives rest.

**Win Records**
- Stored as Todo with kind=COMMITMENT, status=COMPLETED.
- Content prefixed with `✓` (e.g., "✓ Go for a walk").
- Dedupe key format: `win:<original_dedupe_key>`.
- Idempotent per commitment per day.

**Keyword Matching**
- Extracts action keywords (>2 chars, excludes stopwords).
- Scores commitment match by counting keyword overlaps.
- Requires score ≥ 1 or single pending commitment.

**Guardrails**
- No deletes — only status updates (COMPLETED, SKIPPED, ARCHIVED).
- Async/non-blocking — never blocks user response.
- Feature flagged — disabled by default.


## 5) Retrieval Strategy (CURRENT)

**Memory retrieval**
- `searchMemories(userId, personaId, query, limit)` in `src/lib/services/memory/memoryStore.ts`
- Uses pgvector cosine distance (`embedding <=> query`) with score `1 - distance`.
- Filters:
  - `userId`
  - `personaId = current OR personaId IS NULL`
  - `type` in PROFILE/PEOPLE/PROJECT
  - `embedding IS NOT NULL`
  - JS filter: `metadata.status != ARCHIVED`
- Stage 3 pipeline (enabled when `FEATURE_ENTITY_PIPELINE !== "false"`):
  - Top‑K prefilter: `PREFILTER_K = 50` vector candidates.
  - Blended re‑rank: similarity (0.4) + recency (0.3) + frequency (0.3), then sort by blended score.

**Foundation memory**
- `contextBuilder` reads `Memory` where `pinned=true` and `personaId = current OR personaId IS NULL`, capped 20.

**Entity card expansion**
- In `contextBuilder`, when `FEATURE_ENTITY_PIPELINE !== "false"`:
  - Extracts `entityRefs` from **all** relevant memories (before per‑type caps).
  - SQL‑filtered 1‑hop fetch with `metadata->'entityRefs' ?| ARRAY[...]` and `(pinned = true OR importance >= 2)`.
  - Sorted by `pinned DESC → importance DESC → createdAt DESC`.
  - Injected at **top** of `[RELEVANT MEMORIES]` block (max 5 cards, 3 facts each).

**Todos**
- `commitments/threads/frictions` read from `Todo` scoped by userId + personaId + kind + status.

**Messages**
- `contextBuilder` recent messages query uses `userId` + `personaId` (null personaId excluded).


## 6) Feature Flags + Defaults

**Env flags (`src/env.ts`)**
- `FEATURE_MEMORY_CURATOR` (default false) → enables curator.
- `FEATURE_CONTEXT_DEBUG` (default false) → adds debug blocks to response.
- `FEATURE_ENTITY_PIPELINE` (default true unless "false") → enables blended ranking + entity cards.
- `FEATURE_SESSION_SUMMARY` (default true unless "false") → creates SessionSummary on session close.
- `FEATURE_SUMMARY_TEST_STALL` (test only).
- `FEATURE_JUDGE_TEST_MODE` (test only).
- `FEATURE_SUMMARY_SPINE_GLOBAL` (default true unless "false").

**Persona flag**
- `PersonaProfile.enableSummarySpine` (default true). Sophie (`creative`) seeded false.

**Pinned**
- `Memory.pinned` (default false) controls foundation inclusion.

**Rolling summary**
- `SessionState.rollingSummary` updated every 4 user turns in Shadow Judge, awaited with timeout guard; diagnostics stored in `SessionState.state` (attempt/success/error timestamps).


## 7) Latency / Perf Hotspots (Static Analysis Only)

**Approx DB calls per /api/chat** (typical, excluding network to LLM/STT/TTS/embeddings):
- Auth/user: `ensureUserByClerkId` (1 write or upsert + 1 read internally)
- Persona lookup: 1 read
- Session lifecycle: 1–2 reads + optional update
- Context builder:
  - personaProfile (1)
  - userSeed (1)
  - sessionState (1)
  - recent messages (1)
  - summarySpine (0–1)
  - sessionSummary (1)
  - foundation memories (1)
  - relevant memories (1 queryRaw)
  - todos (3)
  - recent wins (1)
- lastMessageAt (1)
- message writes (2)

**Async path DB calls**
- Shadow Judge: recent messages (1), memory writes (0–N), todo writes (0–N), sessionState upsert (1), summarySpine create (0–1), rolling summary update (0–1) + diagnostic state updates (0–2).
- Curator V1 (todo hygiene): pending todos (1–3), existing habits (0–1), todo updates (0–N), win creates (0–1).
- Curator (memory folding): `sessionState` read + memory reads + updates/creates.

**Obvious hotspots**
- `searchMemories` triggers embedding call (network) + queryRaw.
- Multiple `findMany` calls in `contextBuilder` per request.
- Curator can be heavy (fold/dedupe loops), but runs async.

**Index suggestions (notes only)**
- If recent messages should be persona-scoped, index `(userId, personaId, createdAt)` on `Message`.
- Ensure `Memory(userId, type)` index exists (it does).
- `Memory(userId, personaId, type)` index exists (schema).
- `Todo(userId, personaId, kind, status, dedupeKey)` index exists (schema).


## 8) File Map

**Entry / API**
- `src/app/api/chat/route.ts` — main chat handler, prompt assembly, LLM call, message writes, async hooks.
- `src/app/api/personas/route.ts` — persona list.

**Context / Memory**
- `src/lib/services/memory/contextBuilder.ts` — builds context blocks.
- `src/lib/services/memory/shadowJudge.ts` — async extraction + memory/todo writes + rolling summary update.
- `src/lib/services/memory/memoryStore.ts` — pgvector search + memory writes.
- `src/lib/services/memory/memoryCurator.ts` — curator (manual + auto-trigger).

**Sessions**
- `src/lib/services/session/sessionService.ts` — session lifecycle + session summary trigger.
- `src/lib/services/session/sessionSummarizer.ts` — session summary + rolling summary LLM calls.

**Voice**
- `src/lib/services/voice/sttService.ts`
- `src/lib/services/voice/llmService.ts`
- `src/lib/services/voice/ttsService.ts`

**Schema / Config / Seeds**
- `prisma/schema.prisma` — Memory (includes `personaId`, `memoryKey`, `pinned`), Todo, Session, SessionSummary, SessionState, PersonaProfile.
- `src/lib/seed.ts` — persona seeds (slugs and prompts).
- `src/lib/providers/models.ts` — model IDs.
- `src/env.ts` — feature flags and required keys.
