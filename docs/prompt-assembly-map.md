# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **Persona (Identity Anchor)**
2. **Style guard** (single line)
3. **CONVERSATION_POSTURE** (neutral labels)
4. **SITUATIONAL_CONTEXT** (Synapse session-start brief narrative, cached per session)
5. **CONTINUITY** (optional; gap-based)
6. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
7. **SESSION FACTS** (rolling session summary, optional)
8. **Recent Messages** (last 8 messages, session-scoped)
9. **Current User Message**

## Notes
- On session start, context uses Synapse `/session/startbrief` and stores it in session state for reuse.
- `/session/brief` is fallback-only when startbrief is unavailable.
- SUPPLEMENTAL_CONTEXT is a short Recall Sheet (facts + entities).
- No local vector search, todos, or summary spine blocks are injected in this mode.
