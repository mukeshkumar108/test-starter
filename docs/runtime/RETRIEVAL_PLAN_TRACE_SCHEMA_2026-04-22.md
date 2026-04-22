# RetrievalPlan Trace Schema - 2026-04-22

## Purpose

`RetrievalPlan` is the vNext ownership point for deciding which context retrieval lanes should run for a turn. At this migration stage it is a planning adapter only: it maps `TurnDecision.contextNeeds` into a typed plan and does not fetch memory, continuity, tools, web, weather, or traffic.

## Current Mapping

Source of truth:

- `TurnDecision.contextNeeds.recentTurns` -> `RetrievalPlan.recentTurns`
- `TurnDecision.contextNeeds.memory` -> `RetrievalPlan.memory`
- `TurnDecision.contextNeeds.continuity` -> `RetrievalPlan.continuity`
- `TurnDecision.contextNeeds.calendar` -> `RetrievalPlan.calendar`
- `TurnDecision.contextNeeds.tasks` -> `RetrievalPlan.tasks`
- `TurnDecision.contextNeeds.web` -> `RetrievalPlan.web`
- `TurnDecision.contextNeeds.weather` -> `RetrievalPlan.weather`
- `TurnDecision.contextNeeds.traffic` -> `RetrievalPlan.traffic`

Defaults remain conservative because `decideTurn` currently owns the context-needs shape.

## Trace Shape

`RetrievalPlan.trace` currently uses:

```ts
{
  source: "adapter",
  adapter: "TurnDecision.contextNeeds",
  requested: {
    recentTurns: boolean,
    memory: boolean,
    continuity: boolean,
    calendar: boolean,
    tasks: boolean,
    web: boolean,
    weather: boolean,
    traffic: boolean,
  },
  decision: {
    intent: TurnIntent,
    sensitivity: TurnSensitivity,
    toolNeed: ToolNeed,
    modelTier: ModelTier,
  },
  event: {
    modality: TurnModality,
    hasText: boolean,
    attachmentCount: number,
  },
  session: {
    sessionId: string,
    isNewSession: boolean,
    turnCount: number,
  },
  notes: string[],
}
```

## Intentionally Missing

- No real retrieval execution.
- No memory query construction.
- No continuity/startbrief/handover policy migration.
- No calendar/tasks/tool prefetch argument construction.
- No web/weather/traffic heuristics.
- No packet composition or prompt assembly decisions.

These remain outside this step to avoid changing production behavior or inventing replacement policy before legacy parity is understood.

## Migration Role

This is a temporary bridge toward full vNext retrieval ownership. The next stage should migrate one retrieval domain at a time behind parity tests, starting with recent-turns or memory planning before any live fetching changes.
