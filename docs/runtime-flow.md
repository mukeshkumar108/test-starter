# Runtime Flow (Great Simplification)

This document traces what happens when a user sends a message to `/api/chat`.

## Overview
Two paths run in parallel:
- **Sync path**: Auth → Context → LLM → TTS → Response
- **Async path**: Session close → Synapse ingest (bookend memory)

---

## Sync Path (User‑Facing)
1. **Authentication** (`route.ts`)
2. **User resolution** (`ensureUserByClerkId`)
3. **Parse request** (audio + personaId)
4. **STT** (`transcribeAudio`)
5. **Session lifecycle** (`sessionService.ts`)
   - If `now - last_user_message > 15 min`, close session
   - Start or continue active session
6. **Context build** (`contextBuilder.ts`)
   - Persona prompt
   - Last 6 messages
   - Synapse `/session/brief` if enabled
7. **Librarian Reflex** (optional)
   - Gate decides if memory query is needed (explicit vs ambient)
   - Spec extracts entities/topics/time intent
   - Relevance check validates retrieval
   - If yes, call `/memory/query` and format Recall Sheet
8. **Prompt assembly** (`route.ts`)
   - Persona → SITUATIONAL_CONTEXT → SUPPLEMENTAL_CONTEXT → Rolling Summary → Last 6 turns → User msg
9. **LLM call** (OpenRouter)
10. **TTS** (ElevenLabs)
11. **Store messages** (user + assistant)
12. **Return response**

---

## Async Path (Background)
- **Synapse session ingest** (`/session/ingest`)
  - Triggered when a session closes
  - Sends full transcript
  - Fire‑and‑forget

Optional legacy path (feature‑flagged):
- Shadow Judge + local Todo/Memory extraction

---

## Prompt Assembly (Current)
Order is fixed:
1. Persona (Identity Anchor)
2. SITUATIONAL_CONTEXT (Synapse brief)
3. Rolling Summary (if present)
4. Last 6 turns
5. Current user message

---

## Notes
- Synapse `/session/brief` is designed to be light‑weight and narrative.
- Session boundaries are based on **last user message**, not assistant activity.
