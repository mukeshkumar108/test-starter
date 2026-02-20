# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered.

## Current Order
1. **Persona (Identity Anchor)**
2. **CONVERSATION_POSTURE** (neutral labels; may include momentum guard hints)
3. **OVERLAY** (optional deterministic module)
4. **bridgeBlock** (optional; turn 1 only when startbrief resume says `use_bridge=true`)
5. **handoverBlock** (optional; startbrief-v2 rules, verbatim text)
6. **opsSnippetBlock** (optional; deterministic gating, one sentence)
7. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
8. **Recent Messages** (last 8 messages, session-scoped)
9. **Current User Message**

## Notes
- On session start, context uses Synapse `/session/startbrief` and stores it in session state for reuse.
- Startbrief-v2 is the sole orientation mechanism in model-facing prompt assembly.
- Legacy orientation blocks are removed from prompt injection:
  - `SITUATIONAL_CONTEXT`
  - `[CONTINUITY]`
  - `SESSION FACTS`
- On session start, context also fetches Synapse `/user/model` once and stores it as deferred profile context (not injected by default).
- On session start, context fetches Synapse `/analysis/daily` once (best-effort). Only high-confidence steering may surface.
- Low-confidence daily analysis (`needs_review|insufficient_data`) is not surfaced as steering text.
- Daily analysis numeric scores and raw quality flags are retained for telemetry/analytics but are not rendered into model-facing prompt lines.
- `/session/brief` is fallback-only when startbrief is unavailable.
- SUPPLEMENTAL_CONTEXT Recall Sheet is capped (`top 3 facts`, `top 3 entities`).
- Overlay procedural nudges use Synapse `/memory/loops` (fallback: startbrief loop items).
- If `SUPPLEMENTAL_CONTEXT` exists on a turn, `opsSnippetBlock` is suppressed to avoid duplication.
- Loop continuity is user-scoped; Sophie does not assume persona-partitioned loop memory.
- Librarian recall uses `/memory/query` in semantic mode (`includeContext=false`).
- Product kernel guidance comes from compiled prompt kernels (no duplicate runtime product block).
