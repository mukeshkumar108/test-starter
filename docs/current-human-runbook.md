# Current Human Runbook

This is the shortest practical guide for working on the app as it exists now.

## What changed recently

The big changes are:

- Mastra now owns turn-time memory decisioning.
- old librarian decisioning is bypassed on the Mastra path.
- session start no longer depends on a live Synapse startbrief fetch when cached continuity exists.
- session continuity now uses:
  - one persisted backend-owned `resume_packet`
  - one tiny derived `handshake_view`
- session-close maintenance now has an Inngest path, with local fallback when Inngest is not configured.

## Current session-start model

### `resume_packet`

Stored in backend session state.

Purpose:

- rich continuity for substantive first turns
- fast local read at session start
- no live Synapse dependency for the first turn when cache exists

It stores compact, backend-shaped continuity derived from Synapse:

- `handover_text`
- `narrative`
- `bridge_text`
- `entity_profiles`
- `ops_context`
- `items`
- compact snapshots from:
  - Synapse user model
  - daily analysis
  - signals pack

### `handshake_view`

Not stored separately.

Derived at request time from:

- app/session metadata
- selected `resume_packet` fields

It only contains:

- user name if available
- time since last session
- sessions today
- first session today
- time of day
- short bridge hint

This is what powers a lightweight first “hi”.

## How the handshake works now

### Lightweight first greeting

If the first turn is very light, like:

- "hi"
- "hey"
- very short opener

the app uses only `handshake_view`.

That means:

- no live Synapse startbrief fetch
- no heavy handover injection
- fast, lightweight opening

### Substantive first turn

If the first turn is meaningful, like:

- a real question
- a continuation request
- emotional or practical content

the app can immediately use cached `resume_packet` continuity.

That means:

- cached handover
- cached bridge
- cached profile context

without waiting on live Synapse startbrief.

## What `contextBuilder` does now

At session start it is mostly a read/assemble layer.

It reads:

- persona prompt
- recent messages
- rolling summary
- app/session metadata
- stored `resume_packet`

It should not normally block lightweight greetings on live:

- `/session/startbrief`
- `/session/brief`
- user model fetch
- daily analysis fetch
- signal pack fetch

Live Synapse startbrief is now fallback-only behavior, not the default handshake path.

## What still happens on the live request path

- STT
- `ensureActiveSession`
- `buildContext`
- shell prompt assembly
- Mastra turn execution
- TTS
- persistence

## Explicit session close

There is now a user-facing close endpoint:

- [route.ts](/Users/mukeshkumar/play/test-starter/src/app/api/session/close/route.ts)

It accepts:

```json
{ "personaId": "..." }
```

Auth:

- Clerk cookie auth
- or bearer token verified with Clerk, same as the chat route

Purpose:

- let frontend explicitly end the current session
- trigger session-close maintenance immediately
- avoid waiting for the inactivity sweeper during product use or testing

## What now happens in background / maintenance

Session-close maintenance now owns:

- resume packet refresh
- session summary generation
- Synapse session ingest

Important current detail:

- `resume_packet` refresh is now requested immediately as a fast path on session close
- broader session-close maintenance still handles summary + Synapse ingest
- this is intentional so next-session continuity is not blocked behind slower maintenance work

If Inngest is configured:

- session close emits `app/session.closed`
- Inngest runs the maintenance flow

If Inngest is not configured:

- the app falls back to direct local background execution

## Inngest status

You only use real Inngest if these are set in Vercel:

- `INNGEST_EVENT_KEY`
- `INNGEST_SIGNING_KEY`

Do not set:

- `INNGEST_DEV` in production

Without those, the app still works through fallback execution.

## Important env flags

These are the main ones relevant to the current system:

- `FEATURE_MASTRA_ENABLED=true`
- `FEATURE_SYNAPSE_BRIEF=true`
- `FEATURE_SYNAPSE_SESSION_INGEST=true`
- `FEATURE_SESSION_SUMMARY=true` if you want session summaries
- `FEATURE_ROLLING_SUMMARY=true` if you want rolling summary behavior

Also required for continuity:

- `SYNAPSE_BASE_URL`
- `SYNAPSE_TENANT_ID`

## Prisma / DB reminder

There is a recent schema change:

- added session active lookup index on `Session(userId, personaId, endedAt, lastActivityAt)`

Migration file:

- [prisma/migrations/20260408124500_add_session_active_lookup_index/migration.sql](/Users/mukeshkumar/play/test-starter/prisma/migrations/20260408124500_add_session_active_lookup_index/migration.sql)

You must apply this to your DB.

Typical options:

```bash
pnpm prisma migrate deploy
```

or locally during development:

```bash
pnpm prisma migrate dev
```

## Useful commands

### Validate build/tests

```bash
pnpm build
pnpm test
```

### Resume-packet synths

```bash
pnpm synth:resume-packet:refresh
pnpm synth:resume-packet:start
pnpm synth:resume-packet:repair
```

These are the best fast checks for:

- packet generation
- packet reuse
- session-start handshake behavior
- repair flow

### Remote prod smoke

Admin-only remote smoke for deployed Vercel:

```bash
BASE_URL=https://your-app.vercel.app \
ADMIN_SECRET=your-admin-secret \
pnpm smoke:remote:session-start
```

Optional:

- `SMOKE_SCENARIO=session-start`
- `SMOKE_SCENARIO=repair`
- `SMOKE_PERSONA_SLUG=creative`

This hits:

- [src/app/api/admin/session-start-smoke/route.ts](/Users/mukeshkumar/play/test-starter/src/app/api/admin/session-start-smoke/route.ts)

and returns JSON covering:

- session-close timing
- resume-packet availability
- `ensureActiveSession` timing probe
- `buildContext` timing probes
- lightweight vs substantive first-turn behavior
- whether the deployed app thinks maintenance mode is `inngest` or `fallback`

## Safe deploy checklist

1. push code
2. ensure Vercel envs are correct
3. apply Prisma migration
4. redeploy
5. verify:
   - session-close still generates `resume_packet`
   - first lightweight greeting does not depend on live startbrief
   - substantive first turn still gets continuity
   - if Inngest is configured, verify `/api/inngest` is active and events show up

## What to be careful about

- old docs in this repo still often describe live startbrief as the default session-start path
- current reality is now cached `resume_packet` + derived `handshake_view`
- local `trace.json` is just local noise, not a source of truth
