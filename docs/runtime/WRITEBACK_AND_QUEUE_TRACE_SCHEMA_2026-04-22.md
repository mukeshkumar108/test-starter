# WritebackAndQueue Trace Schema - 2026-04-22

## Purpose

`writebackAndQueue` is the final vNext stage for persistence and async work. At this migration step it is a canonical no-op executor: it accepts the full vNext pipeline state and returns a structured result, but performs no database writes, session mutation, memory writes, or queue dispatch.

The live `/api/chat` route remains on the legacy writeback path.

## Current Inputs

- `TurnEvent`
- `SessionContext`
- `TurnDecision`
- `RetrievalPlan`
- `RetrievalOutputs`
- `TurnPacket`
- `TurnExecutionResult`
- `PostProcessResult`

## Current Result

`WritebackAndQueueResult` includes:

- `status`: `"noop"` when only `none` instructions exist, `"skipped"` when active instructions are present but not executed.
- `executed`: all booleans are currently `false`.
- `instructions.writeback`: normalized writeback instructions.
- `instructions.queue`: normalized queue instructions.
- `summary`: counts of active writeback, queue, action requests, and final text length.
- `metadata`: no-op executor status.
- `debug`: writeback and queue kinds observed.
- `trace`: stable provenance/debug shape.

## Real vs Placeholder

Real:

- Instruction normalization.
- Counts and summaries.
- Provenance from event/session/decision/retrieval/packet/execution/postprocess inputs.

Placeholder/no-op:

- Message persistence.
- Session state updates.
- Memory writes.
- Queue dispatch.
- Retry/error handling.

## Trace Shape

```ts
{
  source: "adapter",
  adapter: "writebackAndQueue",
  status: "noop" | "skipped" | "completed" | "failed",
  sideEffects: {
    dbWrites: false,
    sessionMutation: false,
    memoryWrites: false,
    queueDispatch: false,
  },
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
    status: string,
    actionRequestCount: number,
  },
  post: {
    finalTextLength: number,
    writebackKinds: string[],
    queueKinds: string[],
    warningCount: number,
  },
  notes: string[],
}
```

## Migration Role

This is a temporary bridge toward full writeback ownership. Future steps should add real executors behind explicit instruction types, with parity tests and rollback flags before any live persistence changes.
