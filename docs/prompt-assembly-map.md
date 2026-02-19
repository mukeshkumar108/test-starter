# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **Persona (Identity Anchor)**
2. **Style guard** (single line)
3. **CONVERSATION_POSTURE** (neutral labels; may include momentum guard hints)
4. **SITUATIONAL_CONTEXT** (session-open handoff + deterministic mid-turn context cues)
5. **SESSION_FACT_CORRECTIONS** (optional; correction memory for current session)
6. **CONTINUITY** (optional; gap-based)
7. **OVERLAY** (optional)
8. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
9. **SESSION FACTS** (rolling session summary, optional)
10. **Recent Messages** (last 8 messages, session-scoped)
11. **Current User Message**

## Notes
- On session start, context uses Synapse `/session/startbrief` and stores it in session state for reuse.
- On session start, Sophie renders only a 3-part handoff in `SITUATIONAL_CONTEXT`:
  - opener sentence (time/gap + one key thing)
  - optional one-line steering note (high confidence only)
  - optional active threads (max 2, plain English) when intent/direct-request indicates relevance
- On session start, context also fetches Synapse `/user/model` once and stores it as deferred profile context (not injected by default).
- On session start, context fetches Synapse `/analysis/daily` once (best-effort). Only high-confidence steering may surface.
- Low-confidence daily analysis (`needs_review|insufficient_data`) is not surfaced in model-facing `SITUATIONAL_CONTEXT`.
- Daily analysis numeric scores and raw quality flags are retained for telemetry/analytics but are not rendered into model-facing prompt lines.
- Deferred profile fields inject mid-conversation only under explicit conditions:
  - `relationships`: posture `RELATIONSHIP` or user names a tracked person
  - `patterns`: bouncer/gate flags avoidance or drift
  - `work_context`: intent `momentum` or `output_task`
  - `long_term_direction`: intent `momentum` and direct request
  - `communication_preference`: user explicitly asks about tone/style/wording
- `/session/brief` is fallback-only when startbrief is unavailable.
- SUPPLEMENTAL_CONTEXT Recall Sheet is capped (`top 3 facts`, `top 3 entities`).
- Overlay procedural nudges use Synapse `/memory/loops` (fallback: startbrief loop items).
- Loop continuity is user-scoped; Sophie does not assume persona-partitioned loop memory.
- Librarian recall uses `/memory/query` in semantic mode (`includeContext=false`).
- Product kernel guidance comes from compiled prompt kernels (no duplicate runtime product block).
- No local vector search, todos, or summary spine blocks are injected in this mode.
