# Current Decision Log

This log records the important recent architectural decisions and why they were made.

## 2026-04-09: Remove keyword-gated memory prefetch, restore LLM tool-use decisioning

Decision:

- remove all keyword detection functions from `runMastraTurn.ts`
- remove `buildPrefetchedSupplementalContext` and the entire parallel prefetch machinery
- switch from `toolChoice: "none"` / `maxSteps: 1` to `toolChoice: "auto"` / `maxSteps: 3`
- simplify `runMemoryLookup` to a single direct Synapse query using the LLM-provided query string
- tighten agent instructions to intent-based rather than rule-based

Why:

- keyword gating was causing Sophie to loop: natural recall phrases like "what do you know about Ashley", "access your long-term memory", "tell me what you know from before" matched zero patterns
- `toolChoice: "none"` meant the LLM could never call the memory tool even when it recognised the intent
- even when the prefetch did trigger, `buildMemoryLookupCandidates` fell back to "first 6 words of user message" as the Synapse query, returning garbage results
- keyword detection is inherently brittle and language-blind — the entire point of the LLM is to understand intent
- the correct place for "should I call memory?" is the LLM, using the tool description as the signal, not a string-matching function

Impact:

- Sophie now calls the memory tool on any turn where she judges prior knowledge is needed
- latency cost is real but only paid on turns that actually need memory (~10% of turns)
- for those turns the user is explicitly asking for recalled information — a one-second pause is acceptable and correct
- codebase is significantly simpler: ~210 lines deleted across two files

## 2026-04-09: Extend default session window to 30 minutes and add `CURRENT_SESSION_TRUTHS`

Decision:

- change the default active session window from 5 minutes to 30 minutes
- align the background sweeper default with that same 30-minute threshold
- add a separate `CURRENT_SESSION_TRUTHS` prompt block for active-scene facts and user corrections

Why:

- a 5-minute inactivity window was fragmenting natural voice conversations into many tiny sessions
- stale handover/startbrief facts were being reintroduced too often because sessions rolled over too aggressively
- rolling summary is useful for background continuity but is too weak for current-scene truth, corrections, and "today vs yesterday" distinctions
- correction facts were being persisted in overlay state but were not actually injected into the prompt

Impact:

- voice conversations can continue naturally across short cooking/walking gaps without forced session rollover
- the sweeper now matches the same inactivity model by default
- fresh user-provided truths and corrections now have a dedicated higher-priority prompt lane

## 2026-04-09: Replace free-text session truths with structured `CURRENT_SESSION_STATE`

Decision:

- move from bullet/session-truth prose to a compact structured state block
- keep slot count small
- let newer literal user updates overwrite older values by key

Why:

- free-text truth lines were too easy for the model to interpret loosely
- contradictory scene facts like `outside` then `home` need deterministic overwrite behavior
- literal current-scene grounding should be structurally harder to get wrong

Impact:

- current-scene and meal facts now render as stable slots
- prompt injection is more deterministic
- contradictory active-session values no longer pile up as prose

## 2026-04-09: Add lightweight literal-mode reply hardening

Decision:

- add a small post-generation checker/repair layer for literal-mode turns
- keep it lightweight and deterministic

Why:

- even with structured session state, the model could still open with interpretive language
- observed failures were now mostly reply interpretation, not state carry-forward
- the system needed a narrow guard against scene advancement and stale fact resurfacing

Impact:

- literal-mode replies now get checked for:
  - unanchored first sentence
  - interpretive first sentence
  - scene advancement beyond user evidence
  - overwritten fact resurfacing
- replay-style tests now cover:
  - `I'm finally outside.`
  - `I'm home now.`

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
