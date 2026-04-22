# Harness Migration Roadmap (2026-04-22)

## Goal
Migrate from the current accreted runtime to a vNext harness with a single explicit turn-control plane, without breaking existing production behavior.

## Strategy

- No big-bang rewrite.
- Build vNext beside current runtime.
- Preserve capabilities; relocate logic into explicit stages.
- Use parity-based cutover and controlled rollback.

## Migration Order (Execution Plan)

## 1) Documentation and freeze

### Deliverables
- Runtime audit and target architecture docs approved.
- Temporary freeze on adding new policy branches in `route.ts` except critical fixes.
- Feature-flag inventory documented.

### Exit criteria
- Team alignment on canonical flow and ownership.

## 2) vNext skeleton

### Deliverables
- Introduce `src/lib/runtime/vnext/` harness skeleton.
- Add `handleUserTurn` orchestrator with no-op/dummy stage wiring.
- Keep existing runtime as source of truth.

### Exit criteria
- vNext compiles and runs in internal test mode.

## 3) Input normalization

### Deliverables
- Implement `normalizeInput` with one `TurnEvent` contract.
- Support text-first/voice-first/multimodal envelopes.
- Keep current `/api/chat` transport semantics unchanged externally.

### Exit criteria
- Existing voice path behavior unchanged.
- Text path can be exercised internally without affecting production route.

## 4) Central decision stage

### Deliverables
- Implement `decideTurn` as single control plane.
- Initial decision can adapt current triage/router outputs via adapter.
- Decision output typed as `TurnDecision`.

### Exit criteria
- Decision trace logs available per turn.
- No runtime policy decision in route except transport safeguards.

## 5) Packet composition extraction

### Deliverables
- Implement `composeTurnPacket` as single packet composer.
- Move prompt assembly and block ordering into one module.
- Remove duplicate packet-building logic from legacy branches where safely possible.

### Exit criteria
- One packet composition implementation used by vNext path.

## 6) Unified execution path

### Deliverables
- Implement `executeTurn` with adapter backends (direct + Mastra).
- Remove branched execution orchestration from route for vNext path.

### Exit criteria
- One vNext execution spine, backend-selectable via config.

## 7) Postprocess + writeback centralization

### Deliverables
- Implement `postProcessTurn` and `writebackAndQueue`.
- Move state patching and async queue decisions out of route into vNext modules.

### Exit criteria
- Route does not own deep writeback policy for vNext turns.

## 8) One policy domain at a time

Migrate policy domains incrementally, in this order:

1. memory gating and retrieval relevance
2. continuity/startbrief reinjection behavior
3. overlay/cooldown/hysteresis behavior
4. tier/burst model selection policy

### Exit criteria
- Each domain has explicit tests and decision traces.
- No hidden policy branches left in route for migrated domains.

## 9) Parity testing and legacy removal

### Deliverables
- Run side-by-side parity harness against curated transcript set.
- Cut traffic gradually behind feature flag.
- Remove legacy duplicated paths only after parity and stability thresholds hold.

### Exit criteria
- vNext meets parity criteria (below).
- rollback path remains available during canary phase.

## Risks and Mitigations

## Risk: behavior regression from policy relocation
- **Mitigation:** migrate one policy domain at a time with replay tests.

## Risk: hidden coupling in session/overlay state
- **Mitigation:** define explicit state patch contracts in `postProcessTurn`.

## Risk: drift during dual-path period
- **Mitigation:** freeze new behavior in legacy path; all new behavior targets vNext only.

## Risk: observability blind spots
- **Mitigation:** standard turn trace schema with decision/plan/packet/result IDs.

## Dependencies

1. Agreement on vNext contracts (`TurnEvent`, `TurnDecision`, etc.).
2. Feature flags for side-by-side execution and controlled rollout.
3. Replay/parity test dataset (real anonymized turns).
4. Baseline metrics for current runtime.

## Rollback Strategy

- Keep legacy runtime path active until full cutover success.
- Guard vNext with explicit feature flag and percentage rollout.
- On regression, switch flag off and route all traffic back to legacy path.
- Preserve shared persistence schema compatibility during migration window.

## Parity Criteria

vNext must match or exceed current runtime on:

1. correctness parity on curated turn set (response intent and continuity behavior)
2. safety policy parity (high-risk and ambiguity handling)
3. memory retrieval precision/recall parity
4. tool invocation precision parity
5. latency budget parity at p50/p95
6. trace/debug quality improvement (decision + packet + execution visibility)

## Definition of Done

Migration is done when:

1. Production traffic runs through vNext harness by default.
2. Route handler is thin boundary (auth, validation, transport, delegation).
3. Legacy duplicated policy/execution branches are removed.
4. All core policy domains are represented as explicit decision/postprocess modules.
5. Operational dashboards and replay tests validate stability for a sustained period.

## Recommended Guardrails During Migration

1. No new policy features directly in legacy `route.ts` unless emergency fix.
2. Every migrated domain must add explicit tests before cutover.
3. Keep change slices small and reversible.
