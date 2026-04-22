# TurnDecision Trace Schema (2026-04-22)

## Purpose

`TurnDecision.trace` is the stable debug surface for comparing legacy runtime decisions against the vNext control-plane adapter. It is migration instrumentation only; it does not execute retrieval, tools, generation, or writeback.

## Current Shape

```ts
trace?: {
  source: "stub" | "classifier" | "adapter";
  confidence?: number;
  reasons?: string[];
  legacy?: Record<string, unknown>;
}
```

## Source Values

- `stub`: no legacy decision signals were supplied; vNext returned conservative defaults.
- `adapter`: vNext adapted explicitly supplied legacy decision signals.
- `classifier`: reserved for a future classifier-backed decision stage.

## Legacy Adapter Metadata

Current `legacy` fields may include:

- `riskLevel`: legacy risk level when supplied.
- `posture`: legacy posture when supplied.
- `pressure`: legacy pressure when supplied.
- `stanceSelected`: legacy stance when supplied.
- `routeSafetyOverride`: true when vNext mirrors the current route behavior that forces high-risk/crisis turns to `T1` after base routing.

## Stability Notes

- `reasons` should remain short machine-readable strings.
- Additive fields are allowed under `legacy`.
- Do not put prompt text, memory payloads, or user-private retrieval contents in this trace.
- This schema is for parity/debugging, not product behavior.

