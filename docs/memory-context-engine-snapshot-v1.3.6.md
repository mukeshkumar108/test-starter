# Memory & Context Engine — Snapshot v1.3.6

This snapshot reflects current code paths as of v1.3.6. It is based on:
- `src/app/api/chat/route.ts`
- `src/lib/services/memory/contextBuilder.ts`
- `src/lib/services/memory/shadowJudge.ts`
- `src/lib/services/memory/memoryStore.ts`
- `src/lib/services/session/sessionService.ts`
- `src/lib/services/session/sessionSummarizer.ts`
- `src/lib/services/memory/memoryCurator.ts`
- `src/lib/providers/models.ts`

## Prompt Assembly (exact order)
1) `[REAL-TIME CONTEXT]` from `route.ts#getCurrentContext()`
2) `[SESSION STATE]` from `route.ts#getSessionContext()` if SessionState exists
3) Persona prompt (prompt file path from PersonaProfile)
4) `[FOUNDATION MEMORIES]` (12 max; seeded-first ordering)
5) `[RELEVANT MEMORIES]` (max 8, type-filtered, deduped vs foundation)
6) `COMMITMENTS (pending)` (max 5, Todo kind=COMMITMENT)
7) `ACTIVE THREADS` (max 3, Todo kind=THREAD)
8) `FRICTIONS / PATTERNS` (max 3, Todo kind=FRICTION)
9) `Recent wins` (max 3, Todo kind=COMMITMENT, completed within 48h)
10) `User context` (UserSeed, 800 chars)
11) `Conversation summary` (SummarySpine, 1200 chars)
12) `LATEST SESSION SUMMARY` (SessionSummary, 600 chars)
13) Recent message history (10 messages, 800 chars each)
14) Current user message (STT transcript)

## Writes: What is stored and where
- Message rows:
  - `route.ts` writes user/assistant messages with timing metadata.
- Memory rows:
  - `shadowJudge.ts` writes PROFILE/PEOPLE/PROJECT only (no OPEN_LOOP).
  - `memoryStore.ts#storeMemory` writes embedding after create.
- Todo rows:
  - `shadowJudge.ts` writes Todo PENDING with kind COMMITMENT/THREAD/FRICTION.
  - Auto-complete only when exactly one COMMITMENT is pending and user says done/finished/completed.
- Session rows:
  - `sessionService.ts#ensureActiveSession` maintains a rolling 30-minute active session.
- SessionSummary rows:
  - `sessionService.ts#closeStaleSessionIfAny` triggers async summary creation (non-blocking).

## Shadow Judge (async)
- User-only window: last 60 minutes, up to 4 deduped user messages.
- Prompt requires JSON: `{ memories: [...], loops: [...] }`.
- Test mode (regress only): `FEATURE_JUDGE_TEST_MODE=true` bypasses OpenRouter and returns deterministic fixtures.
- Timeout: `JUDGE_TIMEOUT_MS` (default 5000ms).

## Session Summary Behavior
- Triggered when a session becomes stale (>30 minutes since lastActivityAt).
- Uses `MODELS.SUMMARY` from `src/lib/providers/models.ts`.
- `sessionSummarizer.ts`:
  - Pulls last 10 user + last 10 assistant messages within session window.
  - Caps each message to 800 chars.
  - Timeout: `SUMMARY_TIMEOUT_MS` (default 2500ms).
  - Normalizes JSON output; falls back to a safe JSON payload on parse errors.
- Stored via `SessionSummary` with metadata `{ source: "auto_session_summary", format: "json" }`.

## Curator Behavior (deterministic)
- Auto-triggered by `autoCurateMaybe()` (fire-and-forget) after each chat request.
- Trigger conditions (either):
  - 24h since last run OR
  - 25+ non-archived memories since last run.
- Dedupe: archives older duplicates by normalized content + type.
- Folding: for PEOPLE memories with `metadata.entity`, groups of 3+ are folded into a curated summary; original items archived.
- Never modifies Todos; never deletes rows.
- Logs: `[curator.auto]`, `[curator.auto.done]`, `[curator.warn]`, `[curator.auto.err]`.

## Memory Retrieval
- `memoryStore.ts#searchMemories` uses pgvector cosine distance:
  - Filters to PROFILE/PEOPLE/PROJECT and non-null embeddings.
  - No similarity threshold; top-K returned, then filtered to non-ARCHIVED.
- `contextBuilder.ts` applies type caps and dedupe, max 8 relevant memories.

## Regress Determinism Mode
- `scripts/regress-core.ts` sets `FEATURE_JUDGE_TEST_MODE=true` at runtime.
- Shadow Judge returns deterministic JSON outputs to avoid OpenRouter dependency.

## Schema Notes / Migrations
- TodoKind in `prisma/schema.prisma` currently: OPEN_LOOP, COMMITMENT, HABIT, REMINDER.
- Code paths in `shadowJudge.ts` and `contextBuilder.ts` expect TODO kinds THREAD and FRICTION.
- Ensure schema + migrations are aligned to include THREAD/FRICTION before production deploy.

## Environment Variables (engine-related)
- `FEATURE_CONTEXT_DEBUG`, `FEATURE_MEMORY_CURATOR`, `FEATURE_SESSION_SUMMARY`.
- `FEATURE_JUDGE_TEST_MODE` (regress only).
- `JUDGE_TIMEOUT_MS`, `SUMMARY_TIMEOUT_MS`.
- `OPENROUTER_API_KEY`, `OPENAI_API_KEY`.

## Invariants
- OPEN_LOOP is never stored in Memory.
- Relevant memories only include PROFILE/PEOPLE/PROJECT.
- Session summaries never block /api/chat.
- Shadow Judge never reads assistant messages.
- Curator never deletes rows.
