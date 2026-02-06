# AUDIT.md (Great Simplification)

## Trace of a Message (Chat)

**Entry point**
- `src/app/api/chat/route.ts` → `POST(request)`

**Auth + session resolution**
- `auth()` (Clerk cookie) → if missing, bearer token via `verifyToken()`.
- `ensureUserByClerkId(clerkUserId)` (user upsert).
- `personaId` from multipart form field `personaId`.
- `prisma.personaProfile.findUnique({ where: { id: personaId } })` → 404 JSON if missing.
- `closeStaleSessionIfAny(user.id, personaId, now)` → closes if last user msg > 15m.
- `ensureActiveSession(user.id, personaId, now)` → creates or updates session.

**Context builder**
- `buildContext(user.id, personaId, sttResult.transcript)` → `src/lib/services/memory/contextBuilder.ts`
- If `FEATURE_SYNAPSE_BRIEF=true`, calls Synapse `/session/brief`

**LLM prompt assembly (exact order)**
Source: `src/app/api/chat/route.ts` (messages array)
1. **Persona Prompt**
2. **SITUATIONAL_CONTEXT** (Synapse brief)
3. **Rolling Summary** (optional)
4. **Recent messages** (last 6)
5. **Current user message**

**Write path**
- Store user + assistant messages in Prisma
- If a session closes, fire‑and‑forget Synapse `/session/ingest`

---

## Memory Sources (Current)
- **Working memory**: local last 6 messages
- **Long‑term memory**: Synapse `/session/brief`

Legacy pipelines remain feature‑flagged but are not default.
