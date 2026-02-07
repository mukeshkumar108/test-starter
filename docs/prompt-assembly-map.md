# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **CONVERSATION_POSTURE** (mode + pressure)
2. **Persona (Identity Anchor)**
3. **SITUATIONAL_CONTEXT** (Synapse `/session/brief`)
4. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
5. **Rolling Summary** (optional, local)
6. **Recent Messages** (last 8 messages)
7. **Current User Message**

## Notes
- SITUATIONAL_CONTEXT is a single block containing brief narrative, time gap, vibe, and tensions.
- SUPPLEMENTAL_CONTEXT is a short Recall Sheet (facts + entities).
- No local vector search, todos, or summary spine blocks are injected in this mode.
