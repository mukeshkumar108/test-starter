# 2026-02-22 Prompt/User-Context and Model Update

## Scope
This batch wires deferred user context into prompt assembly, expands user-model mapping coverage, and updates Sophie's default chat model.

## Code changes
- Added user-model fields in Synapse contract:
  - `model.daily_anchors`
  - `model.recent_signals`
  - File: `src/lib/services/synapseClient.ts`

- Expanded deferred profile mapping:
  - Added `dailyAnchorsLine`
  - Added `recentSignalsLine`
  - Mapped from `daily_anchors` and `recent_signals`
  - File: `src/lib/services/memory/contextBuilder.ts`

- Added deterministic gating rules in deferred profile policy:
  - `dailyAnchorsLine` only when posture is `MOMENTUM` or `PRACTICAL`
  - `recentSignalsLine` only when posture is `COMPANION` or `RECOVERY`
  - Existing max-2-lines cap unchanged
  - File: `src/app/api/chat/route.ts`

- Wired deferred profile call site into runtime prompt assembly:
  - Compute deferred profile lines before `buildChatMessages(...)`
  - Create `[USER_CONTEXT]` block when lines exist
  - Inject as `system` message after `[CONVERSATION_POSTURE]` and before `[OVERLAY]`
  - Included `user_context` in `systemBlockOrder` tracing
  - File: `src/app/api/chat/route.ts`

- Updated Sophie default chat model:
  - `MODELS.CHAT.CREATIVE` -> `bytedance-seed/seed-1.6`
  - File: `src/lib/providers/models.ts`

## Tests updated
- `src/app/api/__tests__/situationalContextPolicy.test.ts`
  - Added daily anchors gating coverage
  - Added recent signals gating coverage

- `src/app/api/__tests__/promptStackV2.test.ts`
  - Updated expected prompt order to include `[USER_CONTEXT]`

- `src/app/api/__tests__/overlayInjection.test.ts`
  - Added ordering assertion: `[USER_CONTEXT]` before `[OVERLAY]`

- `src/lib/services/memory/__tests__/contextBuilder.synapse.test.ts`
  - Added assertions for mapped deferred lines from `daily_anchors` and `recent_signals`

- `src/lib/providers/__tests__/models.test.ts`
  - Model routing checked after Sophie model update

## Runtime impact summary
- Deferred user context can now appear as a dedicated `[USER_CONTEXT]` system block when gated conditions pass.
- User-model coverage includes anchors/signals in addition to north-star/work/relationships/patterns/preferences.
- Sophie non-safety turns now default to the non-flash Seed 1.6 model.

## Additional working-tree files included in this batch
- `fixtures/prompt-playback.json`
- `docs/needle-backlog.md`
- `prompts/__orig-10_identity_kernel-w-soul.md`
- `prompts/__test-10_identity_kernel.md`

---

## 2026-02-23 Addendum: Authority Remap + Style/Steering Hardening

### Scope
- Reduce low-confidence bouncer authority in overlay policy/selector inputs.
- Increase stance stability for grief/repair continuation turns.
- Add confidence shadow telemetry into prompt-packet traces.
- Reduce therapy-loop and endearment spam pressure from kernels/guards.

### Code changes
- Added deterministic per-turn derived constraints and confidence-gated effective signal remap:
  - `deriveTurnConstraintsFromTranscript(...)`
  - `resolveEffectiveOverlaySignals(...)`
  - `shouldHoldWitnessOnContinuation(...)`
  - `buildBouncerAuthorityTraceFields(...)`
  - File: `src/app/api/chat/route.ts`

- Wired overlay policy + selector to `effectiveSignals` (feature-flagged):
  - `isUrgent`, `isDirectRequest`, `explicitTopicShift` now route through confidence gates.
  - Recall and risk paths remain unchanged.
  - File: `src/app/api/chat/route.ts`

- Prompt packet trace shadow fields (no DB migration):
  - `gate_confidence`, `posture_confidence`, `state_confidence`
  - `is_urgent`, `is_direct_request`, `explicit_topic_shift`
  - plus `bouncer_raw`, `effective_signals`, `authority_mode`
  - File: `src/app/api/chat/route.ts`

- Added env flags:
  - `FEATURE_BOUNCER_AUTHORITY_REMAP_V1=false`
  - `FEATURE_BOUNCER_AUTHORITY_SHADOW_LOG=true`
  - Files: `src/env.ts`, `.env.example`

- Added confidence analysis script:
  - `scripts/admin/gate-confidence-report.ts`
  - Reads trace rows and outputs histograms/breakdowns/sample rows.

- Prompt-kernel updates:
  - `CONVERSATION STEERING` reduced to 3 lines.
  - Style removed explicit endearment list and now states rarity/non-stacking + grief/repair restriction.
  - Added explicit ban phrase: `"that must feel"`.
  - Files: `prompts/20_steering_kernel.md`, `prompts/40_style_kernel.md`

- Runtime style guard alignment:
  - witness banned phrase list includes `"that must feel"`.
  - endearment cadence increased from 8 turns to 10 turns.
  - File: `src/app/api/chat/route.ts`

### Tests updated
- `src/app/api/__tests__/promptStackV2.test.ts`
  - Added effective-signal fallback tests.
  - Added witness continuation hold/release tests.
  - Added trace authority field helper test.
  - Updated endearment cadence expectation (10 turns).
  - Extended witness style guard phrase assertions.

- `src/lib/prompts/__tests__/personaPromptLoader.test.ts`
  - Added assertion that compiled creative prompt does not include explicit `"babes", "babe", "buddy"` list.

### Operational note
- Existing DB snapshots may have sparse `gate` traces if librarian trace was not enabled on all turns.
- Once shadow logging is enabled, use:
  - `pnpm tsx scripts/admin/gate-confidence-report.ts --userId=<userId> --limit=2000`
