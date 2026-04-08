# Current Architecture Overview

This is the current architecture, not the older "Great Simplification" snapshot.

## What Sophie Is Now

Sophie is a voice-first companion app with:

- local request-path orchestration in the app
- Mastra as the runtime agent layer for reply generation and tool use
- Synapse/Graphiti as the long-term memory backend
- Inngest for async maintenance and scheduled background work

## Ownership Model

### App shell owns

- auth
- STT / TTS
- session lifecycle
- request parsing and response shaping
- DB persistence
- session-start context assembly
- model routing / shell behavior logic that still exists in `route.ts`

### Mastra owns

- turn-time reply generation on the Mastra path
- whether to call the thin memory tool
- tool-using response behavior for the tools currently exposed

Mastra does not currently own:

- session lifecycle
- STT / TTS
- session-start context assembly
- model choice
- shell stance / burst / clarity routing

### Synapse owns

- long-term memory retrieval
- startbrief generation
- session ingest
- user model
- daily analysis
- signals pack

### Inngest owns

- session-close maintenance orchestration when configured
- resume packet refresh event handling
- scheduled resume packet repair

## Live Turn Path

The live user-facing path is still:

1. auth
2. STT
3. `ensureActiveSession`
4. `buildContext`
5. shell prompt assembly and routing
6. `runAssistantTurn`
7. Mastra or custom fallback generation
8. TTS
9. persistence

## Session-Start Continuity Model

Session start now uses:

- one persisted backend-owned `resume_packet`
- one derived `handshake_view`

This replaced the old default behavior of live-fetching startbrief on first contact.

### `resume_packet`

Stored in:

- `SessionState.state.resumePacketData`

Contains compact backend-shaped continuity derived from Synapse:

- `handover_text`
- `narrative`
- `bridge_text`
- `entity_profiles`
- `ops_context`
- `items`
- compact user-model snapshot
- compact daily-analysis snapshot
- compact signal-pack snapshot

### `handshake_view`

Derived at request time from:

- app/session metadata
- selected `resume_packet` fields

Contains only:

- `user_name`
- `time_since_last_session_human`
- `sessions_today`
- `first_session_today`
- `time_of_day_label`
- `bridge_hint`

## Session-Start Behavior

### Lightweight first greeting

Examples:

- "hi"
- "hey"
- very short opener

Behavior:

- use `handshake_view`
- do not inject full rich continuity
- do not block on live startbrief

### Substantive first turn

Examples:

- continuation request
- meaningful practical/emotional question

Behavior:

- use cached `resume_packet` if usable
- if packet is missing, fallback may still live-fetch startbrief

## Session Close Model

### Explicit close

User-facing endpoint:

- [route.ts](/Users/mukeshkumar/play/test-starter/src/app/api/session/close/route.ts)

This closes the active session immediately and triggers session-close maintenance.

### Sweeper close

Safety net:

- periodic stale-session close via admin/scheduled path

### Background maintenance split

On session close:

1. fast-path `resume_packet` refresh is requested immediately
2. broader session-close maintenance continues separately

Broader maintenance includes:

- Synapse session ingest
- session summary generation

This split exists so next-session continuity is not blocked behind slower maintenance work.

## Current Memory Model

### Local DB

Stores:

- users
- personas
- sessions
- messages
- rolling summary
- session state
- cached `resume_packet`

### Synapse / Graphiti

Stores / serves:

- long-term memory
- `/memory/query`
- `/session/startbrief`
- `/session/ingest`
- `/user/model`
- `/analysis/daily`
- `/signals/pack`

### Mastra memory tool

Mastra does not use a separate memory backend here.

It uses a thin tool that calls:

- `POST /memory/query` on Synapse

So:

- Mastra owns memory-use decisioning
- Synapse still owns actual memory retrieval

## Current Testing Model

### Local validation

- `pnpm build`
- `pnpm test`
- `pnpm synth:resume-packet:refresh`
- `pnpm synth:resume-packet:start`
- `pnpm synth:resume-packet:repair`

### Remote prod validation

- `pnpm smoke:remote:session-start`

This is the current best deployed smoke for:

- session-close maintenance
- resume packet readiness
- session-start timing
- lightweight vs substantive first-turn behavior

## What Is Intentionally Not True

These older assumptions are no longer current:

- session start always live-fetches Synapse startbrief
- librarian owns memory-use decisioning
- Inngest is optional in theory but irrelevant in practice
- Mastra is only a passive wrapper at the end of the turn

## Current Strategic Direction

Keep:

- Synapse as long-term memory backend
- Mastra as the runtime/tool brain
- Inngest for async maintenance

Reduce over time:

- shell-owned behavior hacks
- live request-path continuity fetches
- brittle custom orchestration branches

Keep:

- Synapse as long-term memory backend
- Mastra as the runtime brain for tool use
- Inngest for async maintenance

Reduce over time:

- shell-owned behavior hacks
- live request-path continuity fetches
- brittle custom orchestration branches
