# Current Agent Notes

This file is for future coding agents working in this repo.

## Current docs to trust

Use these first:

- [current-agent-notes.md](/Users/mukeshkumar/play/test-starter/docs/current-agent-notes.md)
- [current-human-runbook.md](/Users/mukeshkumar/play/test-starter/docs/current-human-runbook.md)
- [current-architecture-overview.md](/Users/mukeshkumar/play/test-starter/docs/current-architecture-overview.md)
- [current-roadmap.md](/Users/mukeshkumar/play/test-starter/docs/current-roadmap.md)
- [current-decision-log.md](/Users/mukeshkumar/play/test-starter/docs/current-decision-log.md)
- [system-explainer.md](/Users/mukeshkumar/play/test-starter/docs/system-explainer.md)

Treat many older architecture/runtime docs as historical unless they are explicitly marked current.

## Current architecture boundaries

### Live turn

The live request path is still:

- STT
- `ensureActiveSession`
- `buildContext`
- shell prompt assembly
- `runAssistantTurn`
- Mastra or custom fallback generation
- TTS
- persistence

### Mastra ownership

Mastra currently owns:

- memory-use decisioning on the Mastra path
- web-search decisioning on the Mastra path
- whether to call the thin memory tool
- whether to call the Tavily-backed web tool
- final reply generation on the Mastra path

Mastra does **not** currently own:

- shell-side tier routing by default, unless `MASTRA_ORCHESTRATION_MODEL` is set
- shell stance/burst/clarity routing
- STT/TTS
- session lifecycle

Important current detail:

- if `MASTRA_ORCHESTRATION_MODEL` is set, Mastra uses that OpenRouter model as a stable orchestration model
- if it is unset, Mastra still falls back to the shell-chosen model for the turn

### Session-start continuity

Session start now uses:

- one persisted `resume_packet`
- one derived `handshake_view`

This replaced the old assumption that turn 1 should live-fetch Synapse startbrief.

## `resume_packet`

Stored in backend state via `SessionState.state.resumePacketData`.

Source code:

- [src/lib/services/session/resumePacket.ts](/Users/mukeshkumar/play/test-starter/src/lib/services/session/resumePacket.ts)

Key behavior:

- built from Synapse data after session close
- reused at next session start
- used directly for substantive first turns

Important helpers:

- `getResumePacketFromState`
- `isResumePacketStale`
- `isUsableResumePacket`
- `resumePacketToStartbriefPacket`
- `deriveHandshakeView`
- `handshakeViewToStartbriefPacket`

## `handshake_view`

Derived only.

Do not introduce a second persisted handshake packet unless there is a very strong reason.

It exists to keep lightweight first greetings fast and low-friction.

## `contextBuilder`

Main file:

- [src/lib/services/memory/contextBuilder.ts](/Users/mukeshkumar/play/test-starter/src/lib/services/memory/contextBuilder.ts)

Current session-start behavior:

- reads cached `resume_packet`
- derives `handshake_view`
- lightweight greeting:
  - handshake only
- substantive first turn:
  - cached `resume_packet` continuity

Live Synapse startbrief/session-brief is now fallback behavior, not the normal path.

## `ensureActiveSession`

Main file:

- [src/lib/services/session/sessionService.ts](/Users/mukeshkumar/play/test-starter/src/lib/services/session/sessionService.ts)

Recent optimizations:

- removed duplicate last-user-message lookup
- reduced session/window read duplication
- added hot-path timing probes
- added no-op guard for rolling-summary reset when already clean
- added active-session composite DB index

Do not casually expand synchronous work here.

## Session-close maintenance

Current model:

- session closes
- one maintenance lane handles:
  - Synapse session ingest
  - session summary generation

Important current detail:

- `requestSessionClosedMaintenance(...)` now also triggers a separate fast-path `resume_packet` refresh request immediately on session close
- `runSessionClosedMaintenance(...)` is now for slower follow-on work, mainly session summary + Synapse session ingest
- this split is deliberate to improve packet readiness without touching request-path behavior

Code:

- [src/lib/services/session/sessionService.ts](/Users/mukeshkumar/play/test-starter/src/lib/services/session/sessionService.ts)
- [src/inngest/functions.ts](/Users/mukeshkumar/play/test-starter/src/inngest/functions.ts)

### Inngest path

If configured:

- emits `app/session.closed`
- Inngest handles maintenance

### Fallback path

If Inngest is not configured:

- maintenance runs locally in fallback mode

## Explicit close endpoint

New endpoint:

- [route.ts](/Users/mukeshkumar/play/test-starter/src/app/api/session/close/route.ts)

Shared helper:

- [closeCurrentSession.ts](/Users/mukeshkumar/play/test-starter/src/lib/services/session/closeCurrentSession.ts)

Use this for frontend explicit-close UI rather than duplicating session-close logic.

Do not assume Inngest is active unless envs are actually set.

## Inngest

Current functions:

- `refresh-resume-packet`
- `session-closed-maintenance`
- `repair-resume-packets`

Route:

- [src/app/api/inngest/route.ts](/Users/mukeshkumar/play/test-starter/src/app/api/inngest/route.ts)

Production envs needed for real Inngest usage:

- `INNGEST_EVENT_KEY`
- `INNGEST_SIGNING_KEY`

Without them, the code falls back to local execution.

## Tavily web search

Current tool:

- [web.ts](/Users/mukeshkumar/play/test-starter/src/mastra/tools/web.ts)

Env:

- `TAVILY_API_KEY`

Behavior:

- Mastra can call `searchWeb` for live/current external information
- the tool returns a compact supplemental context block built from Tavily results
- if Tavily is unconfigured, the tool returns `used=false` and the agent falls back to direct answering

Trace fields now include:

- `mastra_model_used`
- `mastra_memory_tool_used`
- `mastra_web_tool_used`

## Tests / synths that matter right now

Primary fast validation loop:

```bash
pnpm build
pnpm test
pnpm synth:resume-packet:refresh
pnpm synth:resume-packet:start
pnpm synth:resume-packet:repair
```

These are the highest-signal checks for the current continuity architecture.

Remote deployed smoke:

```bash
BASE_URL=https://your-app.vercel.app \
ADMIN_SECRET=... \
pnpm smoke:remote:session-start
```

Important files:

- [src/app/api/admin/session-start-smoke/route.ts](/Users/mukeshkumar/play/test-starter/src/app/api/admin/session-start-smoke/route.ts)
- [src/lib/admin/sessionStartSmoke.ts](/Users/mukeshkumar/play/test-starter/src/lib/admin/sessionStartSmoke.ts)
- [scripts/admin/remote-session-start-smoke.ts](/Users/mukeshkumar/play/test-starter/scripts/admin/remote-session-start-smoke.ts)

This is the correct way to check deployed timing/prod continuity behavior without going through STT/TTS.

## Prisma migration added recently

Migration:

- [prisma/migrations/20260408124500_add_session_active_lookup_index/migration.sql](/Users/mukeshkumar/play/test-starter/prisma/migrations/20260408124500_add_session_active_lookup_index/migration.sql)

This adds:

- `Session(userId, personaId, endedAt, lastActivityAt)` index

If debugging production performance, verify this migration is actually applied.

## What not to regress

- lightweight first turn should not block on live startbrief when cached packet exists
- substantive first turn should still get cached continuity
- session-close should still produce a usable `resume_packet`
- Mastra path should remain behind the existing feature gate and fallback safely
- request-path work should not creep back into session-close maintenance
