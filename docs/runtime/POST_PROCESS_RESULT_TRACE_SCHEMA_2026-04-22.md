# PostProcessResult Trace Schema - 2026-04-22

## Purpose

`PostProcessResult` is the canonical vNext output from `postProcessTurn(...)`. At this migration step it is a conservative adapter over `TurnExecutionResult` and surrounding turn state. It does not persist data, enqueue work, perform safety review, or change live `/api/chat` behavior.

## Current Inputs

`postProcessTurn` receives:

- `TurnEvent`
- `SessionContext`
- `TurnDecision`
- `RetrievalPlan`
- `RetrievalOutputs`
- `TurnPacket`
- `TurnExecutionResult`

## Current Outputs

Real:

- `finalText`: copied directly from `TurnExecutionResult.text`.
- `actionsRequested`: copied from `TurnExecutionResult.actionsRequested` when present.
- `metadata.modelTier`: from `TurnDecision.modelTier`.
- `metadata.responseMode`: from `TurnDecision.responseMode`.
- `metadata.executionMode`: from execution metadata when present.
- `metadata.executionStatus`: from execution metadata when present, otherwise `"completed"`.
- `flags.hasActionRequests`: true when execution returned action requests.
- `flags.hasToolCalls`: true when execution returned tool calls.

Placeholder:

- `writeback`: always `[{ kind: "none" }]`.
- `queue`: always `[{ kind: "none" }]`.
- `flags.placeholderExecution`: true only when execution explicitly marks itself as placeholder.
- `warnings`: currently only includes `"placeholder_execution"` when applicable.

## Trace Shape

```ts
{
  source: "adapter",
  adapter: "postProcessTurn",
  event: {
    modality: TurnModality,
    timestampUtc: string,
  },
  session: {
    sessionId: string,
    isNewSession: boolean,
    turnCount: number,
  },
  decision: {
    intent: TurnIntent,
    sensitivity: TurnSensitivity,
    toolNeed: ToolNeed,
    modelTier: ModelTier,
    responseMode: ResponseMode,
  },
  retrievalPlan: {
    recentTurns: boolean,
    memory: boolean,
    continuity: boolean,
    calendar: boolean,
    tasks: boolean,
    web: boolean,
    weather: boolean,
    traffic: boolean,
  },
  retrievals: {
    hasRecentTurns: boolean,
    hasMemory: boolean,
    hasContinuity: boolean,
    hasSituational: boolean,
    hasTools: boolean,
  },
  packet: {
    sectionCount: number,
    sectionKeys: string[],
  },
  execution: {
    mode: string,
    backend: string,
    status: string,
    isPlaceholder: boolean,
    toolCallCount: number,
    actionRequestCount: number,
  },
  outputs: {
    finalTextLength: number,
    writebackKinds: string[],
    queueKinds: string[],
  },
  notes: string[],
}
```

## Intentionally Missing

- No real writeback recommendations.
- No async queue trigger decisions.
- No promise extraction.
- No commitment extraction.
- No safety review or moderation policy.
- No memory write decision.
- No persistence.

## Migration Role

This is a temporary bridge toward full post-execution/writeback ownership. Future migrations should add explicit, tested instruction types before `writebackAndQueue` performs real work.
