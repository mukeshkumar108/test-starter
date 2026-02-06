# Architecture Overview (Great Simplification)

## What This System Is
A voice‑first conversational companion with **bookend memory**:
- **Working memory** is local and fast (recent turns + rolling summary)
- **Long‑term memory** is externalized to Synapse/Graphiti

The system optimizes for continuity without bloating every request.

---

## Core Layers
### 1) Working Memory (Immediate)
- Last 8 messages from the current session
- Rolling summary of older messages (updates every 4 turns)
- Lives in the local DB only for the active session

### 2) Session Boundary (Bookends)
- A session ends when **last user message > 15 minutes**
- On close, we send the full transcript to Synapse `/session/ingest`
- On start, we pull Synapse `/session/brief`

### 3) Long‑Term Memory (Synapse / Graphiti)
- Episodic + semantic memory built from entire sessions
- Returned as a **situational narrative** for new sessions

### 4) Librarian Reflex (On‑Demand Recall)
- Gate → Spec → Relevance (3-step) flow
- If memory is needed, call `/memory/query` and inject a Recall Sheet

---

## What Makes This Different
| Generic Chatbot | This System |
| --- | --- |
| Stateless | Bookend memory across sessions |
| Full transcript always | Local working memory + Synapse brief |
| Memory stored in app DB | Memory stored in Synapse/Graphiti |
| Large prompts | Tight prompt blocks |

---

## Personas
Personas are different identities with:
- Unique prompts
- Separate sessions
- Shared long‑term user memory in Synapse

---

## Guarantees
1. **Fast response**: Synapse calls are lightweight and async ingest never blocks.
2. **Session continuity**: Working memory keeps the current conversation tight.
3. **Durable memory**: Sessions are stored in Synapse for long‑term recall.

---

## System Boundaries
Upstream:
- STT (LemonFox)
- Client apps (React Native + web)

Core:
- Orchestrator (`/api/chat`)
- Session lifecycle (`sessionService.ts`)
- Context builder (`contextBuilder.ts`)

Downstream:
- Synapse Memory API (`/session/brief`, `/session/ingest`)
- LLM (OpenRouter)
- TTS (ElevenLabs)

---

## Non‑Goals (for now)
- Deterministic memory filters
- Heavy tool orchestration (LangGraph)
- Cross‑session caching or prefetching
