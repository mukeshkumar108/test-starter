# TurnExecutionResult Trace Schema - 2026-04-22

## Purpose

`TurnExecutionResult` is the canonical vNext output from `executeTurn(packet, decision)`. At this migration step it is a typed placeholder result only. It does not call live generation, assemble the legacy prompt, execute tools, or affect the production `/api/chat` route.

## Current Fields

- `text`: placeholder user-visible text from the stub execution adapter.
- `execution`: explicit execution metadata.
- `model`: selected model tier and reasoning effort from `TurnDecision`.
- `tools`: empty `calls` and `results` arrays.
- `actionsRequested`: empty action array.
- `trace`: provenance/debug metadata for parity inspection.

## Current Placeholder Semantics

`executeTurn` currently uses `vnext.stubExecutionAdapter`.

Real:

- `model.tier` comes from `TurnDecision.modelTier`.
- `model.reasoningEffort` comes from `TurnDecision.reasoningEffort`.
- `trace.decision` summarizes the supplied `TurnDecision`.
- `trace.packet` summarizes the supplied `TurnPacket`.

Placeholder:

- `text` is fixed skeleton text.
- `execution.mode` is `"stub"`.
- `execution.backend` is `"none"`.
- `execution.status` is `"placeholder"`.
- `tools.calls`, `tools.results`, and `actionsRequested` are empty.

## Trace Shape

```ts
{
  source: "adapter",
  adapter: "vnext.stubExecutionAdapter",
  status: "placeholder",
  decision: {
    intent: TurnIntent,
    sensitivity: TurnSensitivity,
    toolNeed: ToolNeed,
    modelTier: ModelTier,
    responseMode: ResponseMode,
  },
  packet: {
    sectionCount: number,
    sectionKeys: string[],
    recentTurnCount: number,
    hasCurrentTurn: boolean,
  },
  notes: string[],
}
```

## Future Adapter Targets

The intended execution seam is:

```ts
type TurnExecutionAdapter = {
  name: string;
  mode: "stub" | "direct_model" | "tool_enabled" | "legacy_adapter" | "mastra_adapter";
  execute(packet: TurnPacket, decision: TurnDecision): Promise<TurnExecutionResult>;
};
```

Potential adapters:

- `legacy_adapter`: wraps the current route generation path once packet parity is proven.
- `direct_model`: direct model generation with a vNext prompt packet.
- `tool_enabled`: tool-calling generation path.
- `mastra_adapter`: Mastra-backed execution if still useful after harness cleanup.

## Intentionally Missing

- No prompt rendering.
- No model/provider call.
- No tool call execution.
- No action execution.
- No writeback decisions.
- No production route shadow generation.

This is a temporary migration bridge toward full vNext execution ownership.
