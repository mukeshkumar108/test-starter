# Changelog

## 2026-04-22

### vNext harness checkpoint

- Added side-by-side vNext runtime skeleton under `src/lib/runtime/vnext`.
- Added canonical contracts for turn events, decisions, retrieval plans/outputs, turn packets, execution results, postprocess results, writeback results, and prompt previews.
- Added disabled route-side preparation bridge behind `FEATURE_CHAT_VNEXT_PREPARE_EVENT=false`; live `/api/chat` still does not call `handleUserTurn`.
- Added local-only replay/parity tooling: `scripts/vnext-turn-replay.ts` and `scripts/vnext-section-compare.ts`.
- Added fixture-backed `recent_turns` parity bridge.
- Added checkpoint doc: `docs/runtime/VNEXT_MIGRATION_CHECKPOINT_2026-04-22.md`.
- Verified on 2026-04-22: `pnpm build` passed and `pnpm test` passed all selected tests.

### Harness refactor planning initiated

- Added runtime audit: `docs/runtime/RUNTIME_AUDIT_2026-04-22.md`.
- Added vNext harness architecture spec: `docs/runtime/HARNESS_VNEXT_ARCHITECTURE_2026-04-22.md`.
- Added migration roadmap: `docs/runtime/HARNESS_MIGRATION_ROADMAP_2026-04-22.md`.
- Direction set: preserve current capabilities, introduce a single explicit turn-control plane, migrate side-by-side without big-bang rewrite.

## 2026-04-09 (3)

### TTS pipeline

- Removed `MAX_TTS_SENTENCES = 3` (`limitSentences`) and `MAX_TTS_CHARS = 420` (`capVoiceText`) from `ttsService.ts`.
  - Both were silently truncating mid-sentence. The correct fix is prompt-level conciseness instructions, not TTS layer clipping.
- Made Vercel Blob upload fire-and-forget: `put()` is no longer awaited; HTTP response unblocks as soon as the audio buffer is encoded.
  - `audioUrl` in the response is now always `null`. Blob is still uploaded for history replay; it just does not block the live turn.
- Added `audioBase64` (raw MP3 base64) to the `TTSResult` interface and JSON response.
  - iOS decodes this inline without a second HTTP request.

### Frontend (sophie-mobile)

- `use-voice.ts`: switched live playback from blob URL to `data:audio/mpeg;base64,{...}` data URI.
  - Eliminates a second network round-trip for every turn.
  - URL-based `playAudio` kept for history message replay.
- Filler clips: infrastructure added (`FILLER_CLIPS` array, `startFillerTimer`, `stopFillerAudio`) but disabled.
  - Root cause: all turns take 3.5–8 s; even a 4 s threshold fires nearly every time, degrading the experience.
  - Correct trigger would be a signal that a tool call is actually in progress. Disabled until that signal is available.
- Added "End session" button to the main screen (`app/(app)/index.tsx`).
  - States: `idle` → `loading` ("Ending...") → `done` ("Done", full-brightness text, 1.5 s) → `idle`.
  - Haptics: light impact on tap, success pulse on completion.
  - Calls `POST /api/session/close` via new `closeSession(token)` function in `services/api.ts`.
  - Clears local message history on success.
- `types/index.ts`: added `audioBase64: string`, made `audioUrl: string | null`.

### Session state / prompt hardening — removing over-steering

- Removed all literal-mode reply checking and repair from `runAssistantTurn.ts` (~190 lines deleted):
  - `LiteralModeFlags`, `LiteralModeCheckResult`, `parseCurrentSessionStateBlock`, `getFirstSentence`, `evaluateLiteralModeReply`, `buildLiteralModeRepairReply`, `enforceLiteralModeReply`, `applyLiteralModeReplyGuard`.
  - Root cause: literal mode was being set unconditionally on every turn (see below), so the checker was fighting the model 100% of turns rather than rare edge cases.
- Removed unconditional `patch["assistant.response_mode"] = "literal"` from `extractCurrentSessionStatePatch`.
  - This was setting literal mode on every single user message. Combined with keyword-detected scene anchoring it locked Sophie into looping on the same topic.
- Removed per-turn call to `extractCurrentSessionStatePatch` in `route.ts`.
  - The function was running on every message and forcibly writing state that conflicted with natural LLM responses.
- Removed hardcoded control flags from `buildCurrentSessionTruthsBlock`:
  - `do_not_advance_scene=true`, `prefer_latest_literal_user_update=true`, `first_sentence_anchor_latest_literal_user_update=true`.
  - These were injecting model-steering instructions as if they were facts. Steering belongs in the system prompt, not the state block.
- Tightened `detectSceneActivity` to require affirmative present-tense phrases (`"I'm walking"`, `"going for a walk"`) instead of matching bare `\bwalk\b` anywhere in the message.
- Updated `prompts/20_steering_kernel.md`: added "When the user states a fact or correction, acknowledge it directly and concretely before anything else. Do not embellish, advance, or interpret beyond what they said."
- Removed literal-mode example keywords from memory tool instruction in `assistant.ts`. Constraint is now purely semantic.
- Removed `literalModeReply` test entry from `scripts/run-tests.ts`; corrected `correctionGuards.test.ts` assertion to match new block output.

### Root cause of Sophie's conversation loop (post-mortem)

Sophie was repeating "How's your walk going?" on every turn regardless of what the user said. Root causes in stack order:

1. `extractCurrentSessionStatePatch` set `assistant.response_mode=literal` on every message unconditionally.
2. `detectSceneActivity` matched `\bwalk\b` and wrote `user.current_focus=walk` to session state.
3. `buildCurrentSessionTruthsBlock` injected `do_not_advance_scene=true` + scene anchor flags as structured state.
4. The literal-mode reply guard then anchored Sophie's first sentence to the stale walk context from the handover.

Removing items 1–4 restored natural turn-by-turn behaviour. The model was following its instructions correctly; the instructions were wrong.

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
