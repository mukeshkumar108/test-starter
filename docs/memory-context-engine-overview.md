# Memory & Context Engine — Overview (v1.3.6)

## Purpose
- Provide durable user context to the /api/chat LLM prompt without bloating the main request path.
- Persist actionable commitments and stable facts so the persona can stay consistent across turns and sessions.

## Non-goals
- No global memory across users or personas.
- No background cron/worker infrastructure.
- No autonomous task completion or scoring.

## High-Level Flow
- Sync path (blocks response):
  - STT → `buildContext()` → LLM → TTS → store Message rows.
  - Session lifecycle: `closeStaleSessionIfAny()` + `ensureActiveSession()`.
- Async path (never blocks response):
  - Shadow Judge (`processShadowPath`) writes Memory + Todo kinds.
  - Curator auto-run (`autoCurateMaybe`) for deterministic hygiene.
  - Session summary creation runs after stale session close (fire-and-forget).

## Data Model Primitives
- Memory (`Memory`): PROFILE / PEOPLE / PROJECT only. Stored with embeddings and metadata.
- Todo (`Todo`): scoped by userId + personaId, with kinds and status.
  - Kinds used by code: COMMITMENT / THREAD / FRICTION.
- Session (`Session`): 30-minute active window tracking.
- SessionSummary (`SessionSummary`): JSON summary per sessionId.
- SessionState (`SessionState`): per-persona state + curator bookkeeping.

## Loop Semantics
- COMMITMENT: explicit actionable intent → stored as Todo PENDING, injected as "COMMITMENTS (pending)".
- THREAD: unresolved topic or emotional thread → stored as Todo PENDING, injected as "ACTIVE THREADS".
- FRICTION: recurring blocker/pattern → stored as Todo PENDING, injected as "FRICTIONS / PATTERNS".

## Guardrails & Caps (high level)
- Relevant memories are limited and type-filtered.
- Commitments/threads/frictions are capped and deduped by normalized content.
- Session summary and user seed are truncated before injection.
- Prompt-size warning logged at 20,000 chars (no truncation change).

## Invariants (must hold)
- OPEN_LOOP is never stored in Memory.
- Relevant memories only include PROFILE / PEOPLE / PROJECT.
- Shadow Judge sees user messages only (no assistant text).
- Session summary creation never blocks /api/chat.
- Curator never deletes rows; it only archives via metadata.

## Operational Notes
- Migration required for TodoKind values used by code (THREAD/FRICTION).
- Key env vars:
  - `FEATURE_CONTEXT_DEBUG`, `FEATURE_MEMORY_CURATOR`, `FEATURE_SESSION_SUMMARY`.
  - `FEATURE_JUDGE_TEST_MODE` (regress only).
  - `JUDGE_TIMEOUT_MS`, `SUMMARY_TIMEOUT_MS`.
- OpenRouter models configured in `src/lib/providers/models.ts`.

## Debugging Signals / Logs
- `[chat.trace]` and `[chat.prompt.warn]` in `src/app/api/chat/route.ts`.
- `[context.debug]` in `src/lib/services/memory/contextBuilder.ts`.
- `Shadow Judge ...` logs in `src/lib/services/memory/shadowJudge.ts`.
- `[session.summary] failed` in `src/lib/services/session/sessionService.ts`.
- `[curator.auto]`, `[curator.auto.done]`, `[curator.warn]`, `[curator.auto.err]` in `src/lib/services/memory/memoryCurator.ts`.

## Roadmap / Next Upgrades (based on code TODOs)
- Replace the hardcoded weather placeholder in `getCurrentContext()` with a real weather API.
