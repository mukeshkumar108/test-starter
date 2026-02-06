# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **Persona (Identity Anchor)**
2. **SITUATIONAL_CONTEXT** (Synapse `/session/brief`)
3. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
4. **Rolling Summary** (optional, local)
5. **Recent Turns** (last 6 messages)
6. **Current User Message**

## Notes
- SITUATIONAL_CONTEXT is a single block containing brief narrative, time gap, vibe, and tensions.
- SUPPLEMENTAL_CONTEXT is a short Recall Sheet (facts + entities).
- No local vector search, todos, or summary spine blocks are injected in this mode.
