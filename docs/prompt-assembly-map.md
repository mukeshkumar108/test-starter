# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **Persona (Identity Anchor)**
2. **Style guard** (single line)
3. **CONVERSATION_POSTURE** (neutral labels; may include momentum guard hints)
4. **SITUATIONAL_CONTEXT** (Synapse session-start brief narrative + additive user-model lines + optional compact daily-analysis lines, cached per session)
5. **SESSION_FACT_CORRECTIONS** (optional; correction memory for current session)
6. **CONTINUITY** (optional; gap-based)
7. **OVERLAY** (optional)
8. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
9. **SESSION FACTS** (rolling session summary, optional)
10. **Recent Messages** (last 8 messages, session-scoped)
11. **Current User Message**

## Notes
- On session start, context uses Synapse `/session/startbrief` and stores it in session state for reuse.
- On session start, context also fetches Synapse `/user/model` once and renders concise additive continuity lines.
- On session start, context fetches Synapse `/analysis/daily` once (best-effort). If startbrief bridge text is missing/short/truncated, Sophie appends compact daily steering lines.
- Daily analysis `quality_flag=needs_review|insufficient_data` is treated as low-confidence (soft signal, not hard directive).
- Daily analysis numeric scores and raw quality flags are retained for telemetry/analytics but are not rendered into model-facing prompt lines.
- User-model `north_star` is domain-based; Sophie prefers explicit (`user_stated`) vision over inferred goals and avoids hard certainty for inferred content.
- `/session/brief` is fallback-only when startbrief is unavailable.
- SUPPLEMENTAL_CONTEXT Recall Sheet is capped (`top 3 facts`, `top 3 entities`).
- Overlay procedural nudges use Synapse `/memory/loops` (fallback: startbrief loop items).
- Loop continuity is user-scoped; Sophie does not assume persona-partitioned loop memory.
- Librarian recall uses `/memory/query` in semantic mode (`includeContext=false`).
- Product kernel guidance comes from compiled prompt kernels (no duplicate runtime product block).
- No local vector search, todos, or summary spine blocks are injected in this mode.
