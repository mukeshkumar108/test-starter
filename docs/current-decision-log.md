# Current Decision Log

This log records the important recent architectural decisions and why they were made.

## 2026-04-08: Store one `resume_packet`, derive `handshake_view`

Decision:

- persist one backend-owned `resume_packet`
- derive a tiny `handshake_view` at request time

Why:

- avoid blocking the first greeting on a live Synapse startbrief fetch
- keep continuity ready from backend state
- avoid overbuilding two separately persisted packet types

Impact:

- lightweight first turn is faster
- substantive first turn can use cached continuity

## 2026-04-08: Bypass old librarian on the Mastra path

Decision:

- on `FEATURE_MASTRA_ENABLED`, skip old librarian decisioning
- set `supplementalContext` to null initially
- let Mastra decide whether to call memory

Why:

- make Mastra the real owner of memory-use decisioning
- stop hidden recall from the old pipeline

Impact:

- memory decision is now genuinely Mastra-owned on that path

## 2026-04-08: Keep Synapse as memory backend

Decision:

- do not replace Synapse/Graphiti memory with Mastra-native memory

Why:

- Synapse is already the source of truth for long-term memory
- Graphiti-backed retrieval is part of the product’s real memory system
- Mastra should decide when to call memory, not own storage

Impact:

- Mastra memory tool remains a thin Synapse wrapper

## 2026-04-08: Move session-close maintenance onto an Inngest-capable path

Decision:

- session-close work can run through Inngest when configured
- keep fallback local execution if Inngest is not configured

Why:

- make background work more durable and observable
- avoid hidden fire-and-forget maintenance behavior

Impact:

- session close now has a cleaner async maintenance lane

## 2026-04-08: Split fast resume refresh from broader maintenance

Decision:

- request `resume_packet` refresh immediately as a fast path on session close
- keep session summary + session ingest in the broader maintenance lane

Why:

- packet readiness affects next-session continuity directly
- summary and ingest are slower and should not delay cached continuity readiness

Impact:

- prod session-close now gets cached packet readiness fast enough for the next session-start path

## 2026-04-08: Add explicit session close endpoint

Decision:

- expose a user-facing authenticated endpoint to close the active session explicitly

Why:

- users and testers should not depend only on the inactivity sweeper
- explicit close should trigger continuity preparation immediately

Impact:

- frontend can add an "end conversation" action cleanly
- testing is faster and more deterministic

## 2026-04-08: Add remote prod smoke harness

Decision:

- add an admin-only remote smoke endpoint + script for deployed validation

Why:

- local synths are not enough for deployed timing and Inngest verification
- manual Expo testing is too slow as the only validation loop

Impact:

- deployed continuity behavior can now be tested with a repeatable command

## 2026-04-08: Keep request-path optimization narrow

Decision:

- optimize `ensureActiveSession` and `buildContext` read/query shape
- avoid broad request-flow refactors

Why:

- easiest measurable latency wins
- lower regression risk

Impact:

- buildContext improved materially
- live request path is in a better place

## Current Principles

These decisions reflect the current principles:

- keep long-term memory in Synapse
- keep Mastra as runtime/tool brain
- keep Inngest for async maintenance
- move expensive continuity prep off the live request path
- prefer small ownership transfers over large rewrites
