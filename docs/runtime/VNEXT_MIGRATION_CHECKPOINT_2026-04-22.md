# vNext Harness Migration Checkpoint - 2026-04-22

## Current Status

The vNext harness exists beside the legacy Sophie chat runtime. It is not wired into live `/api/chat` execution.

The only route-side integration is a disabled preparation path behind:

```env
FEATURE_CHAT_VNEXT_PREPARE_EVENT=false
```

When enabled explicitly, the route builds a `TurnEvent`, maps legacy decision/session signals for tracing, and logs only under the existing context-debug path. It does not call `handleUserTurn`.

## What Was Added

Core vNext spine:

- `src/lib/runtime/vnext/contracts.ts`
- `src/lib/runtime/vnext/handleUserTurn.ts`
- `src/lib/runtime/vnext/ensureSession.ts`
- `src/lib/runtime/vnext/decideTurn.ts`
- `src/lib/runtime/vnext/runRetrievalPlan.ts`
- `src/lib/runtime/vnext/buildRetrievalOutputs.ts`
- `src/lib/runtime/vnext/composeTurnPacket.ts`
- `src/lib/runtime/vnext/executeTurn.ts`
- `src/lib/runtime/vnext/postProcessTurn.ts`
- `src/lib/runtime/vnext/writebackAndQueue.ts`
- `src/lib/runtime/vnext/renderPromptPreview.ts`

Boundary/adapters:

- `buildTurnEvent.ts`
- `buildTurnEventFromChatRouteInput.ts`
- `sessionMapping.ts`
- `mapLegacyDecisionSignalsFromChatRoute.ts`

Local-only tooling:

- `scripts/vnext-turn-replay.ts`
- `scripts/vnext-section-compare.ts`

Focused tests now cover each vNext stage and recent-turn parity fixtures under `src/lib/runtime/vnext/__tests__`.

## What Is Intentionally Not Migrated

- Live `/api/chat` execution.
- Real prompt assembly.
- Real model generation.
- Tool execution.
- Retrieval fetching.
- DB persistence.
- Session mutation.
- Memory writes.
- Queue dispatch.
- Overlay/stance/tactic/hysteresis policy.
- Persona kernel migration.

## Current Live-Behavior Safety Check

`src/app/api/chat/route.ts` imports vNext boundary helpers only. The disabled prep block is guarded by:

```ts
if (env.FEATURE_CHAT_VNEXT_PREPARE_EVENT === "true") {
  // build TurnEvent and trace only
}
```

There is no route call to `handleUserTurn`.

Default env remains:

```env
FEATURE_CHAT_VNEXT_PREPARE_EVENT=false
```

## Verification Run

Commands run on 2026-04-22:

```bash
pnpm build
pnpm test
```

Results:

- `pnpm build`: passed.
- `pnpm test`: passed all selected tests.
- `continuityIntegration` remains opt-in and was skipped by the test runner unless `RUN_INTEGRATION=1` is set.

Additional targeted checks used during migration:

```bash
pnpm tsx scripts/vnext-turn-replay.ts
RECENT_TURNS_JSON='[{"role":"user","content":"previous question"},{"role":"assistant","content":"previous answer"}]' pnpm tsx scripts/vnext-turn-replay.ts
LEGACY_SECTIONS=persona,recent_turns,memory VNEXT_SECTIONS=recent_turns pnpm tsx scripts/vnext-section-compare.ts
```

## Main Findings

- The legacy route remains too powerful, but the vNext control plane now has explicit stage boundaries.
- Decision ownership has begun through a temporary `legacyDecisionSignals` bridge.
- Retrieval planning is now explicit but conservative.
- Retrieval outputs, packets, execution results, postprocess results, and writeback results now have canonical shapes.
- All execution/writeback stages are no-op or placeholder only.
- `recent_turns` is the first fixture-backed parity bridge.
- Preview output makes missing sections visible without pretending prompt parity is complete.

## Current Parity Gaps

- `memory` can be requested but is not yet mapped from real legacy artifacts.
- `continuity` / handover / startbrief richness is not mapped.
- Persona kernel and overlay policy are not represented in vNext preview.
- Live recent-turn selection rules are not migrated; only fixtures are supported.
- Prompt ordering/wording parity is not attempted yet.

## Resume Here Next

Recommended next safe moves:

1. Add saved replay fixtures for known legacy turns and compare section presence with `scripts/vnext-section-compare.ts`.
2. Add fixture-backed `memory` parity using the same pattern as `recent_turns`.
3. Define live recent-turn selection rules separately before any DB-backed retrieval migration.

Do not enable live vNext execution until packet/preview parity is substantially stronger and behind a separate execution flag.
