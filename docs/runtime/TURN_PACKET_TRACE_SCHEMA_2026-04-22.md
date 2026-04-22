# TurnPacket Trace Schema - 2026-04-22

## Purpose

`TurnPacket` is the canonical vNext container passed from retrieval/context stages into execution. At this migration step it is a pure structured packet, not a final system prompt and not a generation request.

This preserves production behavior because the live `/api/chat` route still uses the legacy path.

## Current Sources

`composeTurnPacket` builds from:

- `TurnEvent`: user/persona/modality/text/transcript/timestamp/input metadata.
- `SessionContext`: session id, new/existing state, turn count, timestamps if available.
- `TurnDecision`: intent, sensitivity, tool need, model tier, response mode, policy flags.
- `RetrievalPlan`: requested retrieval lanes and planned tool prefetch count.
- `RetrievalOutputs`: recent turns, memory, continuity, calendar/tasks, situational context, tools.

## Current Packet Sections

- `runtime`: vNext runtime version, selected model tier, response mode.
- `user`: user id, persona id, modality, normalized current-turn text.
- `session`: the mapped `SessionContext`.
- `context.retrievalPlan`: the vNext retrieval plan used to produce outputs.
- `context.retrievals`: canonical `RetrievalOutputs`.
- `context.sections`: only populated retrieval sections. Empty/missing data is not converted into fake content.
- `policy.decision`: the full `TurnDecision`.
- `dialogue.recentTurns`: recent turns when present.
- `dialogue.currentTurn`: current user text, preferring transcript over raw text.
- `metadata.trace`: packet provenance/debug metadata.

## Trace Shape

`TurnPacket.metadata.trace` currently uses:

```ts
{
  source: "adapter",
  adapter: "composeTurnPacket",
  event: {
    modality: TurnModality,
    timestampUtc: string,
    timezone: string | null,
    hasAudio: boolean,
    attachmentCount: number,
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
  retrievalPlan?: {
    recentTurns: boolean,
    memory: boolean,
    continuity: boolean,
    calendar: boolean,
    tasks: boolean,
    web: boolean,
    weather: boolean,
    traffic: boolean,
    toolPrefetchCount: number,
  },
  sections: {
    recentTurns: "populated" | "absent" | "present_unsectioned",
    memory: "populated" | "absent" | "present_unsectioned",
    continuity: "populated" | "absent" | "present_unsectioned",
    calendar: "populated" | "absent" | "present_unsectioned",
    tasks: "populated" | "absent" | "present_unsectioned",
    situational: "populated" | "absent" | "present_unsectioned",
    tools: "populated" | "absent" | "present_unsectioned",
  },
  notes: string[],
}
```

## Intentionally Missing

- No final legacy system prompt assembly.
- No hidden continuity fallbacks.
- No context-builder magic.
- No model execution payload.
- No writeback or queue decisions.
- No new policy beyond what already exists in `TurnDecision`.

## Migration Role

This is a temporary bridge toward full vNext prompt/runtime ownership. The packet makes the handoff between decision/retrieval and execution explicit before any live generation path changes. Future work should migrate legacy prompt sections into named packet sections one domain at a time, with parity tests before execution changes.
