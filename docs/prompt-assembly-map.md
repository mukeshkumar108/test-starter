# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **USER_STATE** (mood + energy + tone)
2. **CONVERSATION_POSTURE** (mode + pressure)
3. **Persona (Identity Anchor)**
4. **SITUATIONAL_CONTEXT** (Synapse `/session/brief`)
5. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
6. **Rolling Summary** (optional, local)
7. **Recent Messages** (last 8 messages)
8. **Current User Message**

## Notes
- SITUATIONAL_CONTEXT is a single block containing brief narrative, time gap, vibe, and tensions.
- SUPPLEMENTAL_CONTEXT is a short Recall Sheet (facts + entities).
- No local vector search, todos, or summary spine blocks are injected in this mode.
