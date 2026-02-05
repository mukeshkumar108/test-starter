# Orchestrator Overview (Plain‑English + Technical)

## What “Orchestrator” Means Here
The orchestrator is the glue that decides **what context to retrieve**, **what to send to the LLM**, and **what to store afterward**. It sits between:

- **Upstream:** voice input + auth + app requests
- **Downstream:** memory services (Synapse + local DB), LLMs, and TTS

Think of it as the “traffic controller” for a single chat turn.

---

## One‑Turn Flow (Simple Version)
1. **User speaks**
2. **STT** turns audio into text
3. **Orchestrator builds context**
4. **LLM generates response**
5. **TTS** turns response into audio
6. **Memory is updated** (async)

That’s it. The orchestrator doesn’t invent new data; it only decides what to use and where to save it.

---

## One‑Turn Flow (Technical Version)
1. `/api/chat` receives `audioBlob` + `personaId`
2. Speech‑to‑Text (`transcribeAudio`)
3. `buildContext(...)`:
   - Loads persona prompt
   - Reads recent messages
   - If `FEATURE_SYNAPSE_BRIEF=true`: calls Synapse `/brief`
   - Otherwise uses local memory retrieval
4. Prompt assembly (system blocks + recent messages + user input)
5. LLM call (OpenRouter)
6. TTS call (ElevenLabs)
7. Store user + assistant messages
8. Async updates:
   - Synapse `/ingest` (if enabled)
   - Local Shadow Judge (if enabled)

---

## Key Decisions the Orchestrator Makes
### 1) “Should we query memory at all?”
We avoid querying memory for every message. We only query when it’s useful:
- If user asks: “remember”, “what did we decide”, etc.
- Or the query router suggests a short query (cheap model)
- Or we extract a good name/relationship/location candidate from the message

The router sees the **current user message** plus up to the **last 2 full turns** (user + assistant) when available. If there’s no history (new chat), it uses the current message only.

### 2) “Which memory source do we use?”
Currently:
- **Read path:** Synapse when `FEATURE_SYNAPSE_BRIEF=true`, otherwise local memory.
- **Write path:** Synapse `/ingest` if enabled, plus local Shadow Judge if enabled.

### 3) “What gets into the LLM prompt?”
The orchestrator composes a **stack of context blocks** (persona, memories, summaries, etc.) in a fixed order, then adds recent messages and the current user message.

---

## What a Non‑Technical Person Should Know
- The orchestrator is the **brain of the pipeline**.
- It chooses **what past info matters right now**.
- It keeps the conversation consistent **without slowing down** the response.

---

## What a Technical Person Should Know
- The orchestrator is implemented in:
  - `src/lib/services/memory/contextBuilder.ts`
  - `src/app/api/chat/route.ts`
- It is **feature‑flagged** to switch between local memory and Synapse.
- It uses a **cheap query router** to avoid unnecessary memory calls.
- It uses **async writes** so user latency stays low.

---

## Current Flags That Change Orchestrator Behavior
- `FEATURE_SYNAPSE_BRIEF`
- `FEATURE_SYNAPSE_INGEST`
- `FEATURE_QUERY_ROUTER`
- `FEATURE_SHADOW_JUDGE`

---

## Is LangGraph (or Similar) Necessary?
**Short answer:** Not yet, but it could help later.

**When you do NOT need it:**
- You only have a few steps (STT → context → LLM → TTS).
- Logic is mostly linear with a couple of feature flags.
- You can keep the code readable without a graph framework.

**When you might want it:**
- You add **multiple branches** (tools, external systems, retries).
- You need **explicit state machines** (auditability, replay).
- You want **visual graphs** for non‑engineers.

**Right now:** the current system is still simple enough to manage directly. Adding LangGraph now would add mental overhead without clear payoff. It’s a good future option if the orchestration grows more complex.
