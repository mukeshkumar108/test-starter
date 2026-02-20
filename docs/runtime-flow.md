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
   - On session start: Synapse `/session/startbrief` (cached per session, used as startbrief-v2 packet)
   - On session start: Synapse `/user/model` (cached per session; stored as deferred profile context)
   - On session start: Synapse `/analysis/daily` (best-effort; used only for high-confidence steering)
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
   - If yes, call `/memory/query` (semantic recall mode) and format Recall Sheet
   - `/memory/query` request explicitly sets `includeContext=false`
   - `/memory/query` parsing accepts both `facts: string[]` and `facts: {text}[]`
8. **Prompt assembly** (`route.ts`)
  - Persona → CONVERSATION_POSTURE → OVERLAY (optional) → bridge (optional) → handover (optional) → ops snippet (optional) → SUPPLEMENTAL_CONTEXT (optional) → Last 8 messages → User msg
  - Startbrief-v2 is now the only orientation path. Legacy orientation blocks are removed from prompt injection.
  - Overlay loop inputs are sourced from Synapse `/memory/loops` on session start (fallback to startbrief loop items)
  - Loop continuity is user-scoped (not persona-partitioned)
  - startbrief-v2 injection policy:
    - Turn 1: bridge (only when `resume.use_bridge=true`) + handover (verbatim)
    - Turn 2: handover only if depth is `yesterday|multi_day`, or `gap_minutes>=120`, or first user message is low-signal
    - Turn 3+: no handover/bridge, except one semantic reinjection path
  - Ops snippet is suppressed when SUPPLEMENTAL_CONTEXT exists (mutual exclusion to prevent duplication).
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
1. Persona (compiled kernel)
2. CONVERSATION_POSTURE (with momentum guard when applicable)
3. OVERLAY (optional)
4. bridge block (optional, turn-1 only when `resume.use_bridge=true`)
5. handover block (optional, startbrief-v2 rules; verbatim text)
6. ops snippet block (optional, deterministic gating)
7. SUPPLEMENTAL_CONTEXT (optional Recall Sheet)
8. Last 8 messages (session-scoped)
9. Current user message

---

## Notes
- Synapse `/session/startbrief` is the primary session-start continuity source.
- Startbrief loop items and `/memory/loops` are treated as user-scoped canonical loop memory.
- `/session/brief` is a fallback path.
- Product-kernel trajectory guidance is loaded from compiled prompt kernels (not duplicated at runtime).
- Session boundaries are based on **last user message**, not assistant activity.
- Recent messages are session-scoped: no carryover from previous session.
- Orientation context is no longer injected via `SITUATIONAL_CONTEXT`, `CONTINUITY`, or `SESSION FACTS`.

## Debug & Trace
- `[chat.trace]` includes:
  - `startbrief_used`
  - `startbrief_fallback`
  - `startbrief_items_count`
  - `bridgeText_chars`
  - `startbrief_runtime`:
    - `session_id`
    - `userTurnsSeen`
    - `handover_injected`
    - `bridge_injected`
    - `ops_injected`
    - `ops_source`
    - `startbrief_fetch`
    - `reinjection_used`
  - `system_blocks` (final system block order for that turn)
- Daily analysis behavior:
  - Steering from `/analysis/daily` is included only when confidence is high.
  - Low-confidence daily analysis (`needs_review` / `insufficient_data`) is not surfaced in model-facing orientation text.
- Mid-conversation deferred profile triggers:
  - `relationships` only when `posture=RELATIONSHIP` or user names a tracked person.
  - `patterns` only when bouncer/gate signals avoidance or drift.
  - `work_context` only when `intent=momentum` or `intent=output_task`.
  - `long_term_direction` only when `intent=momentum` and direct request is true.
  - `communication_preference` only when user explicitly asks about tone/style/wording.
- Debug headers:
  - `x-debug-context: 1` with `FEATURE_CONTEXT_DEBUG=true` adds context debug blocks.
  - `x-debug-prompt: 1` additionally includes the fully composed prompt packet (`model + messages`).
