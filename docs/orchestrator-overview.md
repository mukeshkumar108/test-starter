# Orchestrator Overview (Great Simplification)

## What The Orchestrator Does
The orchestrator is the glue between the app, Synapse, and the LLM. It decides:
- When a session starts or ends
- What context to fetch from Synapse
- What working memory to include in the prompt
- What to send to Synapse when the session closes

It is intentionally simple: **bookend memory** (brief at session start, ingest at session end) with **local working memory** in between.

---

## One‑Turn Flow (Simple)
1. User speaks
2. STT → transcript
3. Orchestrator builds prompt context
4. LLM responds
5. TTS speaks
6. Memory updates happen async

---

## One‑Turn Flow (Technical)
1. `/api/chat` receives audio + personaId
2. STT (`transcribeAudio`)
3. Session lifecycle in `sessionService.ts`
   - If `now - last_user_message > 5 min`, close session (configurable)
   - Open or continue the active session
   - Session close triggers Synapse `/session/ingest` (async)
4. `buildContext(...)` in `contextBuilder.ts`
   - Load persona prompt
   - Load last 8 messages (working memory)
   - If `FEATURE_SYNAPSE_BRIEF=true`, call Synapse `/session/brief`
5. Prompt assembly in `route.ts`
   - Persona (Identity Anchor)
   - SITUATIONAL_CONTEXT (Synapse brief)
   - SUPPLEMENTAL_CONTEXT (Recall Sheet, if triggered)
   - Rolling summary (if present)
   - Last 8 messages + current user message
6. LLM call (OpenRouter primary → fallback, then OpenAI emergency)
7. TTS (ElevenLabs)
8. Store messages
9. Async updates (session ingest, legacy shadow judge if enabled)

---

## Bookend Memory Model
### Opening Book: Synapse Brief
- Called via `/session/brief`
- Provides a compact **situational narrative** for this user+persona+session
- Injected as a single block: `SITUATIONAL_CONTEXT`

### Closing Book: Synapse Ingest
- Called via `/session/ingest` when a session ends
- Sends **full transcript** for long‑term memory ingestion
- Fire‑and‑forget so it never blocks user response

---

## Working Memory (Local)
In‑session context is kept locally for speed:
- Last 8 messages (user + assistant)
- Rolling summary (generated every 4 turns from older messages)
- Rolling summary is cleared when a new session is created (prevents cross‑session drift)

This keeps LLM context tight while Synapse handles long‑term memory.

---

## Key Decisions The Orchestrator Makes
### 1) When is a new session started?
- If **no active session** exists
- Or if **last user message > 5 minutes ago** (configurable)

### 2) When do we fetch Synapse context?
- When `FEATURE_SYNAPSE_BRIEF=true`
- We call `/session/brief` to build `SITUATIONAL_CONTEXT`

### 3) When do we fetch extra memory (Librarian Reflex)?
- **Gate** decides if memory is needed (explicit vs ambient)
- **Spec** extracts entities/topics/time intent
- **Relevance** checks if retrieved memory should be injected
- If used, we format a Recall Sheet as `SUPPLEMENTAL_CONTEXT`
 - Entire reflex is capped by `LIBRARIAN_TIMEOUT_MS` (default 5s)

### 4) What goes into the prompt?
Blocks are in this order:
- Persona (Identity Anchor)
- SITUATIONAL_CONTEXT (Synapse brief)
- SUPPLEMENTAL_CONTEXT (Recall Sheet)
- Rolling summary (if any)
- Last 8 messages

---

## Flags That Change Behavior
- `FEATURE_SYNAPSE_BRIEF`
- `FEATURE_SYNAPSE_SESSION_INGEST`
- `FEATURE_SHADOW_JUDGE` (legacy local pipeline)
- `FEATURE_SESSION_SUMMARY` (legacy local summaries)

---

## Query Router Status
A query router exists in code, but `/session/brief` currently ignores query hints. This is intentionally conservative until Synapse exposes query‑aware briefs for sessions.

---

## Is LangGraph Needed?
Not yet.
- The current flow is linear and easy to reason about.
- If we add many tools, branching flows, or retries, a graph framework could help.
