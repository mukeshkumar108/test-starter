# CLAUDE.md — Project Context & Guardrails (READ FIRST)

## Project context (what this is)
This repo implements a single chat+voice endpoint `/api/chat` that handles:
- Clerk auth (cookie) or Bearer token verification
- Session lifecycle (open/close + summaries)
- Context building (memories/todos/summaries/messages)
- LLM response generation (OpenRouter)
- STT + TTS (voice is not a separate route)
- Async “Shadow Judge” extraction + optional curator

Goal: improve the memory + context pipeline without breaking API behavior or latency.

## Critical invariants (DO NOT BREAK)
1) `/api/chat` API contract must remain compatible with the Expo client:
   - multipart form fields: `personaId`, `language`, `audioBlob` (m4a)
   - header: `Authorization: Bearer <token>` (when no Clerk cookie)
2) All DB reads must always be correctly scoped:
   - ALWAYS filter by `userId`
   - Use `personaId` where the concept is persona-specific (Messages, Todos, Sessions)
3) Do not change auth/session semantics unless explicitly requested in the spec.
4) Never drop these prompt blocks:
   - Real-time context
   - Persona prompt
   - Last 6 turns (`recentMessages`)
   - Current user message
5) Keep voice viable:
   - Avoid adding extra network calls on the synchronous request path.
   - Prefer batching DB queries or reducing call count.
6) No new infra/dependencies:
   - No Neo4j, no external memory vendors, no GraphQL layer.
   - Stay Postgres + Prisma + pgvector.

## Source of truth docs
- `AUDIT.md` describes current message lifecycle, prompt block order, and current retrieval behavior.
- `prisma/schema.prisma` defines the DB contract.
- `src/env.ts` defines feature flags; do not remove existing flags.

## Key directories / files
### API
- `src/app/api/chat/route.ts` — main entrypoint: prompt assembly, LLM call, message writes, async hooks
- `src/app/api/personas/route.ts` — persona list

### Memory + context
- `src/lib/services/memory/contextBuilder.ts` — builds context pack blocks
- `src/lib/services/memory/memoryStore.ts` — vector search + memory CRUD
- `src/lib/services/memory/shadowJudge.ts` — async extraction; updates Memory/Todo/SessionState
- `src/lib/services/memory/memoryCurator.ts` — optional curator (async)

### Sessions + summaries
- `src/lib/services/session/sessionService.ts` — session open/close; triggers summaries
- `src/lib/services/session/sessionSummarizer.ts` — sessionSummary + rollingSummary generation

### Voice services (same endpoint)
- `src/lib/services/voice/sttService.ts`
- `src/lib/services/voice/llmService.ts`
- `src/lib/services/voice/ttsService.ts`

## Current prompt block order (must respect contract)
Prompt assembly happens in `src/app/api/chat/route.ts`.
Current contract (do not change unless spec says so):
- First: real-time block, optional session-state block, then persona prompt.
- Last: last 6 messages + current user message.
Budget guard drops blocks in order: relevantMemories → sessionSummary → threads → non-pinned foundation overflow.

## Testing and quality bar
Before committing changes:
- Run all existing tests (e.g. `pnpm test`, `pnpm test:core`, etc. use repo scripts)
- Run typecheck/lint if scripts exist
- Ensure Expo client still works unchanged (no API breakage)

## Working style rules (very important)
- Prefer minimal, surgical changes over refactors.
- If uncertain about behavior, READ the relevant file; do not guess.
- If you want to change schemas or introduce new tables/columns, STOP and ask first.
- Every change must include:
  - Files changed list
  - Why it’s safe
  - Tests run
  - Any performance impact (DB calls added/removed)
