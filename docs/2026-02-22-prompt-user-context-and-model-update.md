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
