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
   - If `now - last_user_message > 5 min`, close session (configurable)
   - Start or continue active session
6. **Context build** (`contextBuilder.ts`)
   - Persona prompt
   - Last 8 messages from the active session only
   - On session start: Synapse `/session/startbrief` (cached per session)
   - Fallback: Synapse `/session/brief` if startbrief unavailable
   - Startbrief payload is normalized defensively:
     - `items` coerced to array
     - malformed item rows dropped
     - missing top-level fields become `null`
7. **Librarian Reflex** (optional)
   - Gate decides if memory query is needed (explicit vs ambient)
   - Spec extracts entities/topics/time intent
   - Query compilation drops pronouns/ghost tokens and prefers noun-heavy tokens
   - Relevance check validates retrieval
   - If yes, call `/memory/query` and format Recall Sheet
   - `/memory/query` parsing accepts both `facts: string[]` and `facts: {text}[]`
8. **Prompt assembly** (`route.ts`)
   - Persona → Style guard → CONVERSATION_POSTURE → SITUATIONAL_CONTEXT → CONTINUITY (optional) → SUPPLEMENTAL_CONTEXT → SESSION FACTS → Last 8 messages → User msg
9. **LLM call** (OpenRouter primary → fallback, then OpenAI emergency)
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
2. Style guard (single line)
3. CONVERSATION_POSTURE (neutral labels)
4. SITUATIONAL_CONTEXT (Synapse brief; includes CURRENT_FOCUS when present)
5. CONTINUITY (optional, gap-based)
6. SUPPLEMENTAL_CONTEXT (Recall Sheet, if present)
7. SESSION FACTS (rolling summary, if present)
8. Last 8 messages
9. Current user message

---

## Notes
- Synapse `/session/startbrief` is the primary session-start continuity source.
- `/session/brief` is a fallback path.
- CONTINUITY injects only when timeGapMinutes ≥ 60 and the opener is not urgent.
- Session boundaries are based on **last user message**, not assistant activity.
- SESSION FACTS is session-scoped: it is included only when the stored
  `rollingSummarySessionId` equals the active `sessionId`.
- Recent messages are session-scoped: no carryover from previous session.

## Debug & Trace
- `[chat.trace]` includes:
  - `startbrief_used`
  - `startbrief_fallback`
  - `startbrief_items_count`
  - `bridgeText_chars`
- Debug headers:
  - `x-debug-context: 1` with `FEATURE_CONTEXT_DEBUG=true` adds context debug blocks.
  - `x-debug-prompt: 1` additionally includes the fully composed prompt packet (`model + messages`).
