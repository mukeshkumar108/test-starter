# State & Memory Model (Great Simplification)

## Working Memory (Local)
- Last 8 turns in the active session (session-scoped)
- Optional rolling session summary (older turns only)
- `CURRENT_SESSION_TRUTHS` for active-scene facts and explicit corrections
- `SessionState.rollingSummary` is used only when `SessionState.state.rollingSummarySessionId`
  matches the active `sessionId`
- New session start clears summary and stamps a new `rollingSummarySessionId`
- Session-start brief cache is stored in `SessionState.state` with
  `startBriefSessionId` + `startBriefData`
- Session-start user model cache is stored in `SessionState.state` with
  `userModelSessionId` + `userModelData`
- Session-start daily analysis cache is stored in `SessionState.state` with
  `dailyAnalysisSessionId` + `dailyAnalysisData`

## Session Model
- A session is open until **30 minutes after the last user message** by default (configurable)
- On close, the full transcript is sent to Synapse `/session/ingest`

## `CURRENT_SESSION_TRUTHS`
- Separate from rolling summary
- Higher priority than handover, bridge, and stale assistant assumptions
- Intended for:
  - present-tense session facts
  - explicit user corrections
  - "today vs yesterday" distinctions
  - small live-scene truths like current activity or location

## Long‑Term Memory (Synapse / Graphiti)
- Synapse stores complete sessions and builds narrative memory
- Orchestrator fetches a **session start brief** via `/session/startbrief` on session start
- `/session/brief` remains fallback-only

## What Is No Longer Used (in Great Simplification)
- Local memory vector search
- Summary spine
- Local todos as the source of long‑term memory

These systems remain feature‑flagged for fallback but are not the default path.
