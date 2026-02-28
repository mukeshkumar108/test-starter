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
   - Synapse tenant is canonicalized from a single runtime constant (`SYNAPSE_CANONICAL_TENANT_ID`);
     legacy `sophie-prod` is remapped to `default`.
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
  - Persona → CONVERSATION_POSTURE → STYLE_GUARD (optional) → USER_CONTEXT (optional) → STANCE_OVERLAY (optional) → OVERLAY (optional) → bridge (optional) → handover (optional) → ops snippet (optional) → SUPPLEMENTAL_CONTEXT (optional) → Last 8 messages → User msg
  - Startbrief-v2 is now the only orientation path. Legacy orientation blocks are removed from prompt injection.
  - Overlay loop inputs are sourced from Synapse `/memory/loops` on session start (fallback to startbrief loop items)
  - Loop continuity is user-scoped (not persona-partitioned)
  - startbrief-v2 injection policy:
    - Turn 1: bridge (only when `resume.use_bridge=true`) + handover
      (prepended with a fixed structured time anchor line derived from `time_context`,
      followed by handover narrative)
    - Turn 2: handover only if depth is `yesterday|multi_day`, or `gap_minutes>=120`, or first user message is low-signal
    - Turn 3+: no handover/bridge, except one semantic reinjection path
  - Ops snippet is suppressed when SUPPLEMENTAL_CONTEXT exists (mutual exclusion to prevent duplication).
9. **Model routing + LLM call**
   - Safety override remains unchanged via `getChatModelForGate({ gate: { risk_level } })`.
   - Non-safety turns use tier router (`getTurnTierForSignals` -> `getChatModelForTurn`).
   - Tier precedence: `risk > stance > moment > intent > depth > direct/urgent > default`.
   - Tier models:
     - `T1`: `allenai/olmo-3.1-32b-instruct`
     - `T2`: `x-ai/grok-4.1-fast`
     - `T3`: `anthropic/claude-sonnet-4.6`
   - Depth routing:
     - If posture is `RELATIONSHIP|RECOVERY|REFLECTION`, route to `T2` with reason `companion_depth`.
     - If pressure is `MED|HIGH`, route to `T2` with reason `companion_depth`.
   - Direct/urgent routing:
     - If `isDirectRequest` or `isUrgent`, route to `T2` with reason `direct_or_urgent_support`.
   - Default fallback:
     - Route to `T1` with reason `default_balanced`.
   - `moment` is derived before tier selection from selected user-context moment keys + transcript heuristics, with fallback: `stance=witness && pressure=HIGH` => `moment=grief`.
   - T3 uses burst routing in session-local state:
     - Peak event starts a 2-turn T3 burst (`remaining=2` then decrement each use).
     - Same event after remaining reaches 0 is forced to `T2`.
     - New event ID re-starts a fresh 2-turn burst.
     - Event ID is deterministic and stance-dominant: `stance|intent|topicHint`.
   - Final call: OpenRouter primary → fallback, then OpenAI emergency.
10. **TTS** (ElevenLabs)
11. **Store messages** (user + assistant)
12. **Return response**

---

## Async Path (Background)
- **Synapse session ingest** (`/session/ingest`)
  - Triggered when a session closes
  - Sends full transcript
  - Fire‑and‑forget
  - Non-OK/exception writes durable retry state in `sessionState.state.synapseSessionIngestRetry`
  - Retry runs non-blocking on next `ensureActiveSession` pass
  - Retry attempts are capped at 3 with `lastError` and `lastAttemptAt`
- **Session sweeper cron** (`/api/admin/run-session-sweeper`)
  - Runs every 5 minutes in production (Vercel cron).
  - Closes sessions where `endedAt IS NULL` and inactivity exceeds configured threshold (default 10m).
  - Sets `endedAt = lastActivityAt` and triggers session ingest.
  - Auth accepts either `x-admin-secret` or `x-vercel-cron: 1`.

Optional legacy path (feature‑flagged):
- Shadow Judge + local Todo/Memory extraction

---

## Prompt Assembly (Current)
Order is fixed:
1. Persona (compiled kernel)
2. CONVERSATION_POSTURE (with momentum guard when applicable)
3. STYLE_GUARD (optional)
4. USER_CONTEXT (optional)
5. STANCE_OVERLAY (optional)
6. OVERLAY (optional)
7. bridge block (optional, turn-1 only when `resume.use_bridge=true`)
8. handover block (optional, startbrief-v2 rules; verbatim text)
9. ops snippet block (optional, deterministic gating)
10. SUPPLEMENTAL_CONTEXT (optional Recall Sheet)
11. Last 8 messages (session-scoped)
12. Current user message

---

## Notes
- Synapse `/session/startbrief` is the primary session-start continuity source.
- Startbrief loop items and `/memory/loops` are treated as user-scoped canonical loop memory.
- `/session/brief` is a fallback path.
- Startbrief usability gate rejects only when all are true:
  - `evidence.summary_content_quality` is `none_fetched` or `empty_after_normalization`
  - `handover_text` is empty
  - `items` is empty
  - `resume.bridge_text` is empty
  - Rejected startbrief falls through to `/session/brief`
- Product-kernel trajectory guidance is loaded from compiled prompt kernels (not duplicated at runtime).
- Session boundaries are based on **last user message**, not assistant activity.
- Recent messages are session-scoped: no carryover from previous session.
- Orientation context is no longer injected via `SITUATIONAL_CONTEXT`, `CONTINUITY`, or `SESSION FACTS`.

## Debug & Trace
- `[chat.trace]` includes:
  - `chosenModel`
  - `tierSelected` (prompt-packet trace `memoryQuery`)
  - `routingReason` (prompt-packet trace `memoryQuery`)
  - `burstActiveId`
  - `burstRemainingBefore`
  - `burstRemainingAfter`
  - `burstEventId`
  - `burstWasStarted`
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
  - `synapse_session_ingest_ok`
  - `synapse_session_ingest_error`
- `[librarian.trace]` with `kind=startbrief` includes:
  - `startbrief_quality` (`usable` | `weak_rejected`)
  - `summary_content_quality`
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
