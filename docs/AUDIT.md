# AUDIT.md (Great Simplification)

## Trace of a Message (Chat)

**Entry point**
- `src/app/api/chat/route.ts` → `POST(request)`

**Auth + session resolution**
- `auth()` (Clerk cookie) → if missing, bearer token via `verifyToken()`.
- `ensureUserByClerkId(clerkUserId)` (user upsert).
- `personaId` from multipart form field `personaId`.
- `prisma.personaProfile.findUnique({ where: { id: personaId } })` → 404 JSON if missing.
- `closeStaleSessionIfAny(user.id, personaId, now)` → closes if last user msg > 5m (configurable).
- `ensureActiveSession(user.id, personaId, now)` → creates or updates session.

**Context builder**
- `buildContext(user.id, personaId, sttResult.transcript)` → `src/lib/services/memory/contextBuilder.ts`
- On session start, calls Synapse `/session/startbrief` (cached per session)
- Fallback: Synapse `/session/brief`

**LLM prompt assembly (exact order)**
Source: `src/app/api/chat/route.ts` (messages array)
1. **Persona Prompt**
2. **CONVERSATION_POSTURE** (neutral labels; momentum guard appended when relevant)
3. **OVERLAY** (optional)
4. **bridgeBlock** (optional; turn-1 when startbrief `resume.use_bridge=true`)
5. **handoverBlock** (optional; startbrief-v2 policy, verbatim)
6. **opsSnippetBlock** (optional; deterministic, one sentence)
7. **SUPPLEMENTAL_CONTEXT** (Recall Sheet, optional; top 3 facts/entities)
8. **Recent messages** (last 8)
9. **Current user message**

**Write path**
- Store user + assistant messages in Prisma
- If a session closes, fire‑and‑forget Synapse `/session/ingest`

---

## Memory Sources (Current)
- **Working memory**: local last 8 messages
- **Long‑term memory**: Synapse `/session/startbrief` (fallback `/session/brief`)
- **Orientation in prompt**: startbrief-v2 bridge + handover only

Legacy pipelines remain feature‑flagged but are not default.
