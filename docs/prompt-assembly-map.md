# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered. No nested memory blocks.

## Current Order
1. **Persona (Identity Anchor)**
2. **SITUATIONAL_CONTEXT** (Synapse `/session/brief`)
3. **Rolling Summary** (optional, local)
4. **Recent Turns** (last 6 messages)
5. **Current User Message**

## Notes
- SITUATIONAL_CONTEXT is a single block containing brief narrative, time gap, vibe, and tensions.
- No local vector search, todos, or summary spine blocks are injected in this mode.
