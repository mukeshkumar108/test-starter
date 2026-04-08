# Current Roadmap

This is the current roadmap, not the historical backlog.

## Done

### Session-start continuity

- moved from live startbrief dependency to cached continuity
- introduced persisted `resume_packet`
- introduced derived `handshake_view`
- lightweight first greeting no longer blocks on live startbrief

### Mastra adoption

- Mastra is integrated behind `FEATURE_MASTRA_ENABLED`
- Mastra now owns memory-use decisioning on the Mastra path
- old librarian decisioning is bypassed on the Mastra path
- thin Synapse-backed memory tool is live

### Background maintenance

- session-close maintenance moved onto an Inngest-capable path
- fallback still works when Inngest is not configured
- resume packet refresh now has a fast-priority path

### Testing

- local synth harness for resume packet flows
- remote prod smoke harness for deployed session-start behavior

## Current Priorities

### 1. Tool pass

High-value tools to add through Mastra:

- web search / fetch
- explicit memory save
- reminder / follow-up scheduling

Current state:

- Tavily-backed web search is now wired into the Mastra path
- next tool slices are explicit memory save and reminder/follow-up scheduling

### 2. Frontend explicit session close

Backend endpoint exists.

Need:

- UI button / menu action in app
- client call to `/api/session/close`

### 3. Docs hygiene

Need to keep current docs authoritative and avoid drift with older historical docs.

## Recommended Tool Order

### First

- web search / fetch

Reason:

- largest immediate usefulness jump
- lets Sophie verify current facts and external reality

### Second

- explicit memory save

Reason:

- complements passive ingest
- gives user intentional control over what Sophie should remember

### Third

- reminder / follow-up scheduling

Reason:

- turns Sophie into a more active continuity agent
- pairs naturally with Inngest later

## Deferred On Purpose

Do not do these yet unless there is a strong reason:

- replace Synapse memory with a framework-native memory store
- move STT/TTS into Mastra
- rewrite `route.ts` broadly
- fully move model choice into Mastra right now
- add many tools at once

## Success Criteria For Next Phase

### Web tool phase

- Sophie can look up current information reliably
- tool use is observable in traces
- normal conversation does not over-trigger web use

### Memory-save phase

- user can explicitly ask Sophie to remember something
- saved information becomes retrievable later
- no silent over-saving of trivial details

### Reminder phase

- user can ask for follow-up later
- reminders are scheduled durably
- async execution is visible and debuggable

## Current Validation Loop

Before merging meaningful changes:

1. `pnpm build`
2. `pnpm test`
3. relevant local synth
4. if continuity/session-close affected:
   - run remote prod smoke after deploy

## One-Line Direction

Make Sophie better by adding:

- world access
- intentional memory save
- follow-up ability

without reintroducing heavy request-path orchestration.
