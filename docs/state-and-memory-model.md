# State & Memory Model (Great Simplification)

## Working Memory (Local)
- Last 8 turns in the active session (session-scoped)
- Optional rolling session summary (older turns only)
- `SessionState.rollingSummary` is used only when `SessionState.state.rollingSummarySessionId`
  matches the active `sessionId`
- New session start clears summary and stamps a new `rollingSummarySessionId`
- Session-start brief cache is stored in `SessionState.state` with
  `startBriefSessionId` + `startBriefData`

## Session Model
- A session is open until **5 minutes after the last user message** (configurable)
- On close, the full transcript is sent to Synapse `/session/ingest`

## Long‑Term Memory (Synapse / Graphiti)
- Synapse stores complete sessions and builds narrative memory
- Orchestrator fetches a **session start brief** via `/session/startbrief` on session start
- `/session/brief` remains fallback-only

## What Is No Longer Used (in Great Simplification)
- Local memory vector search
- Summary spine
- Local todos as the source of long‑term memory

These systems remain feature‑flagged for fallback but are not the default path.
