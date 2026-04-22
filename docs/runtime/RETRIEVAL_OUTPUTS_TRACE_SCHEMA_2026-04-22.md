# RetrievalOutputs Trace Schema - 2026-04-22

## Purpose

`RetrievalOutputs` is the canonical vNext container for data returned by retrieval stages. At this migration step it defines and normalizes shape only. It does not perform retrieval, change live route behavior, compose prompts, or execute tools.

## Current Sections

- `recentTurns`: mapped dialogue turns, currently stubbed as `[]` only when explicitly requested by a stub plan.
- `memory`: memory facts/entities/raw payloads when provided by an adapter; otherwise absent.
- `continuity`: handover/bridge/raw continuity payloads when provided; otherwise absent.
- `calendar`: future calendar retrieval output slot; currently unmapped.
- `tasks`: future task retrieval output slot; currently unmapped.
- `situational.weather`: future weather or local context slot; currently mapped only if provided by fixtures/adapters.
- `situational.traffic`: future traffic context slot; currently mapped only if provided by fixtures/adapters.
- `situational.web`: future web context slot; currently mapped only if provided by fixtures/adapters.
- `tools`: planned tool prefetch metadata/result slot; stub mode can echo planned prefetches without executing them.
- `trace`: provenance/debug metadata for parity inspection.

## Trace Shape

`RetrievalOutputs.trace` currently uses:

```ts
{
  source: "stub" | "legacy_adapter" | "replay_fixture" | "manual",
  adapter: "buildRetrievalOutputs",
  requested: {
    recentTurns: boolean,
    memory: boolean,
    continuity: boolean,
    calendar: boolean,
    tasks: boolean,
    web: boolean,
    weather: boolean,
    traffic: boolean,
    tools: boolean,
  },
  sections: {
    recentTurns: "mapped" | "missing" | "not_requested" | "provided_unrequested",
    memory: "mapped" | "missing" | "not_requested" | "provided_unrequested",
    continuity: "mapped" | "missing" | "not_requested" | "provided_unrequested",
    calendar: "mapped" | "missing" | "not_requested" | "provided_unrequested",
    tasks: "mapped" | "missing" | "not_requested" | "provided_unrequested",
    web: "mapped" | "missing" | "not_requested" | "provided_unrequested",
    weather: "mapped" | "missing" | "not_requested" | "provided_unrequested",
    traffic: "mapped" | "missing" | "not_requested" | "provided_unrequested",
    tools: "mapped" | "missing" | "not_requested" | "provided_unrequested",
  },
  event?: {
    userId: string,
    sessionId: string | null,
    modality: TurnModality,
  },
  session?: {
    sessionId: string,
    isNewSession: boolean,
    turnCount: number,
  },
  notes: string[],
}
```

## Real vs Stubbed vs Unmapped

- Real: none from vNext yet.
- Stubbed: `recentTurns: []` when requested by `buildStubRetrievalOutputs`; tool prefetch metadata can be echoed without execution.
- Mapped: partial legacy artifacts can be passed through `mapLegacyRetrievalOutputs`, but no live route adapter is wired yet.
- Unmapped: memory query construction, continuity assembly, calendar/tasks, web/weather/traffic fetching, and tool execution results.

## Migration Role

This is a temporary migration bridge. It gives vNext one stable shape for retrieval data before actual retrieval ownership moves over. Future work should migrate one retrieval domain at a time and preserve the `trace.sections` statuses for parity testing.
