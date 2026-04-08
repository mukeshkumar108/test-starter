# System Explainer

This is the plain-English version of what the app does now.

## What Sophie Remembers

Sophie remembers things in two different ways.

### 1. What is happening right now

This is short-term context:

- recent messages
- the current active session
- some local session summary state

This lives in the app database and helps Sophie stay coherent inside the current conversation.

### 2. What matters across conversations

This is long-term memory:

- previous sessions
- remembered facts
- people and relationships
- longer-term patterns and context

This lives in Synapse / Graphiti, not just in the app database.

## What happens when you start a new conversation

The app does **not** try to rebuild everything live before Sophie says hello.

Instead:

- the app reads a cached `resume_packet`
- it derives a tiny `handshake_view`

### `handshake_view`

This is the light version used for a simple opening like:

- "hi"
- "hey"

It gives Sophie just enough to feel aware:

- roughly how long it has been
- whether this is the first conversation today
- a short bridge hint if useful

### `resume_packet`

This is the richer cached continuity packet.

It contains things like:

- handover text
- narrative continuity
- bridge text
- entity profiles
- ops context
- a few compact snapshot fields from Synapse

If your first turn is substantive, Sophie can use that richer packet immediately.

## Why this matters

Older behavior made the first turn depend on a live Synapse startbrief fetch.

That meant:

- more waiting
- more fragility

Now the richer continuity is prepared in the background after the previous session closes.

So:

- first greetings stay light and fast
- real continuity is still ready when needed

## What happens when a session ends

When a session closes:

1. the app triggers `resume_packet` refresh quickly
2. the app also runs broader background maintenance

That broader maintenance includes:

- session summary generation
- Synapse session ingest

This background work is handled through Inngest when configured.

## What Inngest does

Inngest is used for background jobs.

It helps with:

- session-close maintenance
- resume packet refresh jobs
- repair jobs

It is **not** the live chat engine.

## What Mastra does

Mastra is Sophie’s runtime agent layer on the Mastra path.

Right now it mainly decides:

- whether Sophie can answer directly
- whether Sophie should call the memory tool

Mastra does **not** currently replace:

- Synapse memory storage
- session lifecycle
- STT/TTS

## What Synapse does

Synapse is still the real long-term memory backend.

It is used for:

- memory query
- session startbrief
- session ingest
- user model
- daily analysis
- signals pack

When Sophie needs memory, Mastra calls a thin tool that queries Synapse.

## What gets stored where

### App database

- users
- sessions
- messages
- session state
- rolling summary
- cached `resume_packet`

### Synapse / Graphiti

- long-term memory
- ingested session knowledge
- memory retrieval results
- continuity-building data like startbrief/user model

## What is exposed externally

### User-facing endpoint

- `POST /api/session/close`

This lets the frontend explicitly close the current session and trigger continuity preparation.

### Admin/testing endpoint

- `/api/admin/session-start-smoke`

This is for deployed smoke testing, not normal product use.

## Why this system is better now

Because it separates:

- live conversation speed

from:

- background continuity preparation

That means Sophie can feel:

- faster
- more stable
- still continuous across sessions

without doing all the expensive memory work during the first hello.
