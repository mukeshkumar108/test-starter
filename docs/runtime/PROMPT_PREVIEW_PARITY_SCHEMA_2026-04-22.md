# Prompt Preview Parity Schema - 2026-04-22

## Purpose

`renderPromptPreview` is a non-executing vNext parity/debug aid. It renders a structured and readable preview of what the current vNext packet contains so we can compare ingredients against the legacy runtime.

It is not the live prompt stack, not a final execution prompt, and not wired into `/api/chat`.

## Inputs

The preview accepts:

- `TurnEvent`
- `SessionContext`
- `TurnDecision`
- `RetrievalPlan`
- `RetrievalOutputs`
- `TurnPacket`

## Output Shape

`PromptPreview` includes:

- `kind`: `"vnext_prompt_preview"`
- `version`: dated schema marker
- `text`: readable preview text for local inspection
- `sections.runtime`: model tier and response mode
- `sections.session`: session id, turn count, new/existing status
- `sections.decision`: intent, sensitivity, tool need, model tier, response mode
- `sections.context`: packet section count, keys, and retrieval presence
- `sections.dialogue`: current turn and recent-turn counts
- `sections.policy`: policy flags and reasoning effort already exposed by `TurnDecision`
- `contextSections`: packet context section summaries with source, length, and truncated preview
- `missing`: missing/absent context domains
- `trace`: provenance and explicit non-execution flags

## Difference From Legacy Prompt Stack

The preview does not:

- Recreate the legacy system prompt.
- Inject persona kernels.
- Apply hidden context fallbacks.
- Run overlay, stance, tactic, or hysteresis logic.
- Execute model generation.
- Execute tools.
- Persist anything.

It only reflects the current vNext packet state.

## Meaningful Today

Currently meaningful:

- Runtime/model-tier preview.
- Session summary.
- Turn decision summary.
- Packet context section presence.
- Dialogue current-turn/recent-turn counts.
- Retrieval output presence/missing markers.

Currently partial:

- Memory content, unless supplied by fixtures/adapters.
- Continuity/handover content, unless supplied by fixtures/adapters.
- Calendar/tasks/web/weather/traffic context.
- Tool context beyond planned/stubbed prefetch metadata.
- Policy beyond fields already present in `TurnDecision`.

## Intended Use

Use this for local/dev parity inspection:

```bash
pnpm tsx scripts/vnext-turn-replay.ts
MEMORY_QUERY_ELIGIBLE=true INTENT=momentum RISK_LEVEL=MED pnpm tsx scripts/vnext-turn-replay.ts
```

Compare `preview.sections`, `preview.contextSections`, and `preview.missing` against the legacy route/context-builder ingredients for the same turn.

## Trace Flags

The trace explicitly marks:

- `noExecution: true`
- `noGeneration: true`
- `noLegacyPromptAssembly: true`

Those flags are intentional guardrails. The preview is a migration/debug aid, not a replacement prompt.
