# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **Persona (Identity Anchor)**
2. **Style guard** (single line)
3. **CONVERSATION_POSTURE** (neutral labels)
4. **SITUATIONAL_CONTEXT** (Synapse `/session/brief`)
5. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
6. **SESSION FACTS** (rolling summary, optional)
7. **Recent Messages** (last 8 messages)
8. **Current User Message**

## Notes
- SITUATIONAL_CONTEXT is a single block containing brief narrative, time gap, tensions, and CURRENT_FOCUS (when present).
- SUPPLEMENTAL_CONTEXT is a short Recall Sheet (facts + entities).
- No local vector search, todos, or summary spine blocks are injected in this mode.
