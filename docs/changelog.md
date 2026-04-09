# Changelog

## 2026-04-09 (2)

- Removed all keyword-gated memory and web prefetch logic from `src/mastra/runMastraTurn.ts`.
  - Deleted: `looksLikeRecallQuestion`, `looksLikeCurrentInfoQuestion`, `looksLikeDeepResearchQuestion`, `isLikelyTemporalReminder`, `shouldPrefetchMemory`, `shouldPrefetchWeb`, `buildPrefetchedSupplementalContext`.
  - Root cause: keyword gating was brittle, language-blind, and missed the majority of natural recall phrasings. The user asking "what do you know about Ashley?" or "access your long-term memory" never matched any pattern.
- Switched Mastra generation from `toolChoice: "none"` / `maxSteps: 1` to `toolChoice: "auto"` / `maxSteps: 3`.
  - The LLM now decides when to call the memory tool based on semantic understanding of the question — not string matching.
- Simplified `runMemoryLookup` in `src/mastra/tools/memory.ts` to a single direct Synapse query.
  - Deleted: `buildMemoryLookupCandidates`, `extractQueryCandidates`, `sanitizeMemoryQueryValue`.
  - Was running up to 3 Synapse queries built from keyword/capitalisation heuristics. Now: one query, using the string the LLM provides directly.
- Tightened agent instructions in `src/mastra/agents/assistant.ts`.
  - Replaced a prescriptive 6-bullet "Use the memory tool when:" list with a short intent-based description.
  - The tool's own description (read by the LLM at call time) is the authoritative signal.
- Removed two now-obsolete tests for `buildMemoryLookupCandidates` from `src/mastra/tools/__tests__/memory.test.ts`.
- Tracing preserved: `[mastra.memory.tool.used]` logs query when tool fires; `[mastra.memory.tool.skipped]` logs user message when it doesn't.
- Confirmed literal-mode reply guard does not interfere with memory-tool turns (guard only fires when `assistant.response_mode=literal` in `CURRENT_SESSION_STATE`, which is never set on recall turns).
- Build clean, all 26 tests pass.

## 2026-04-09 (1)

- Raised the default active session window from 5 minutes to 30 minutes.
- Aligned the stale-session sweeper default inactivity threshold with the active session window.
- Added a dedicated `CURRENT_SESSION_TRUTHS` prompt block for:
  - current scene state
  - recent user corrections
  - "today vs yesterday" distinctions
- Wired stored correction/session-truth state into prompt assembly so it actually reaches the model.
- Updated current human and agent docs to reflect the new continuity model and the recommended QStash sweeper URL:
  - `/api/admin/run-session-sweeper?inactivityMinutes=30&limit=100`
- Replaced free-text session truths with a structured `CURRENT_SESSION_STATE` block.
- Added slot overwrite rules for current-scene and meal facts so newer literal user updates replace older values.
- Moved `CURRENT_SESSION_STATE` late in the prompt stack so it outranks bridge/handover more reliably.
- Tightened literal-mode generation instructions to prefer concrete low-inference wording.
- Added a lightweight literal-mode reply checker/repair layer that:
  - anchors the first sentence to the latest literal user update
  - blocks scene advancement beyond user evidence
  - blocks resurfacing overwritten facts like stale meal details
- Added targeted replay-style tests for:
  - `I'm finally outside.`
  - `I'm home now.`
