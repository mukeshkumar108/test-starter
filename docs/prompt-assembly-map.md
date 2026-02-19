# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **Persona (Identity Anchor)**
2. **Style guard** (single line)
3. **CONVERSATION_POSTURE** (neutral labels; may include momentum guard hints)
4. **SITUATIONAL_CONTEXT** (Synapse session-start brief narrative, cached per session)
5. **SESSION_FACT_CORRECTIONS** (optional; correction memory for current session)
6. **CONTINUITY** (optional; gap-based)
7. **OVERLAY** (optional)
8. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
9. **SESSION FACTS** (rolling session summary, optional)
10. **Recent Messages** (last 8 messages, session-scoped)
11. **Current User Message**

## Notes
- On session start, context uses Synapse `/session/startbrief` and stores it in session state for reuse.
- `/session/brief` is fallback-only when startbrief is unavailable.
- SUPPLEMENTAL_CONTEXT Recall Sheet is capped (`top 3 facts`, `top 3 entities`).
- Product kernel guidance comes from compiled prompt kernels (no duplicate runtime product block).
- No local vector search, todos, or summary spine blocks are injected in this mode.
