# Runtime Audit (2026-04-22)

## Scope
This audit covers the current Sophie chat runtime in:

- `src/app/api/chat/route.ts`
- `src/lib/services/memory/contextBuilder.ts`
- `src/lib/orchestrator/runAssistantTurn.ts`
- `src/lib/providers/models.ts`
- `src/lib/services/session/sessionService.ts`

This is an architecture/runtime audit, not a product-quality critique.

## Current End-to-End Request Flow

1. Request boundary: `POST /api/chat` validates auth, form-data (`personaId`, `audioBlob`), minimum audio bytes, persona existence.
2. Speech: STT (`transcribeAudio`) returns transcript.
3. Session lifecycle: `ensureActiveSession` creates/updates active session and may close stale sessions.
4. Context assembly: `buildContext` resolves persona + recent messages + session continuity artifacts (startbrief/resume/fallbacks), signals pack, and optional rolling summary.
5. Runtime policy pass (non-Mastra path): `runLibrarianReflex` performs triage/router/memory-gate/relevance checks.
6. Overlay + policy state machine in `route.ts`: stance/tactic/cooldowns/hysteresis/reinjection/corrections/unknown-entity handling.
7. Model routing: tier selection (`getTurnTierForSignals`) + burst policy (`applyT3BurstRouting`) + model mapping.
8. Prompt assembly + execution:
   - Legacy inline path in `route.ts`, or
   - Orchestrator v2 (`runAssistantTurn`), which can still branch to Mastra.
9. TTS synthesis and response payload generation.
10. Persistence/writeback: user+assistant message writes, overlay state updates, optional background ingestion/curation/rolling summary.

## Major Runtime Stages

1. Input boundary and auth
2. Speech normalization
3. Session management
4. Context retrieval/composition
5. Turn policy and behavioral decisions
6. Prompt composition
7. Model execution/tool execution
8. Output synthesis (voice)
9. Persistence + async queueing

## Where Policy Currently Lives

Policy is distributed across multiple layers:

- `route.ts`: triage application, overlay/tactic/stance logic, cooldown policies, reinjection rules, prompt gating, execution branching.
- `contextBuilder.ts`: startbrief usability, fallback behavior, signal-pack and daily-analysis inclusion decisions.
- `models.ts`: turn tier policy and burst routing behavior.
- `runAssistantTurn.ts`: prompt gating/context governor/signal-pack inclusion logic (duplicated with route legacy path).
- Session state read/write helpers in `route.ts` encode implicit behavior state transitions.

## Branching Points / Runtime Permutations

Primary runtime permutations are driven by:

1. `FEATURE_CHAT_ORCHESTRATOR_V2` (legacy inline path vs orchestrator path).
2. `FEATURE_MASTRA_ENABLED` inside orchestrator path.
3. Triage/router outcomes in `runLibrarianReflex`.
4. Startbrief/cache/fallback paths in `buildContextFromSynapse`.
5. Multiple policy gates for overlays and contextual injection.

Net effect: behavior can differ substantially depending on feature flags + policy outputs + session state.

## Duplicated Logic (Explicit)

1. Prompt gating / context governor logic exists in both:
   - `route.ts` legacy path
   - `runAssistantTurn.ts` orchestrator path
2. Signal-pack injection decisions are implemented in both paths.
3. Prompt assembly order logic is maintained in multiple places.

These are drift risks because updates can land in one path only.

## Implicit State-Machine Risks

Overlay/posture/user-state behavior is persisted as broad mutable state with many fields, including cooldowns, burst state, reinjection counters, short-reply streaks, correction overlays, and injected-context history. This creates risks:

1. Cross-turn behavior is difficult to predict from a single code location.
2. Transition invariants are implicit; they are not declared as an explicit machine contract.
3. Debugging odd turn behavior requires tracing many conditionals and historical fields.

## What Is Worth Keeping

1. Clear request boundary and auth validation.
2. Session lifecycle before generation.
3. Strong persistence and async maintenance model.
4. Existing capabilities: memory recall, continuity/startbrief model, safety-aware routing, and tool-capable runtime path.
5. Existing observability/tracing hooks.

## What Is Causing Maintainability Risk

1. `route.ts` is too large and too powerful; it owns boundary concerns and deep runtime policy/orchestration decisions.
2. Decision-making is spread across too many modules; no single turn control plane.
3. Feature-flag branching creates multiple behavioral spines.
4. Duplicated policy/prompt code increases drift probability.
5. Voice-first input contract is not yet a modality-agnostic runtime boundary.

## Severity-Ordered Findings

### Critical
1. **No single turn control plane**. Decision authority is distributed across route/context/policy/orchestrator/model layers.
2. **Dual execution spines** (legacy vs v2) with additional Mastra branch increase permutation complexity.

### High
3. **Policy duplication** across legacy and v2 paths (context governor, signal pack, prompt composition concerns).
4. **Implicit state machine** spread across many mutable overlay/state fields in request path.

### Medium
5. **Input normalization is voice-centric**, making multimodal expansion harder than necessary.
6. **Boundary leakage**: route includes domain policy and behavioral choreography rather than acting as thin transport boundary.

### Low
7. Some runtime assumptions (example: fixed timezone defaults) are embedded in route-level policy code.

## Ruthless but Fair Verdict

The current system is functional and feature-rich, but architecture debt is concentrated in the request path. This is not a failure of capability; it is a control-plane design issue.

The right move is not a rewrite. The right move is:

1. Preserve working capabilities.
2. Introduce one explicit vNext turn harness.
3. Relocate (not delete) policy into explicit stages with typed contracts.
4. Gradually retire legacy branching and duplicated logic after parity.

The route handler should become a thin boundary over time.
