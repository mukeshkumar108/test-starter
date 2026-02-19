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
2. **Style guard** (single line)
3. **CONVERSATION_POSTURE** (neutral labels; momentum guard appended when relevant)
4. **SITUATIONAL_CONTEXT** (Synapse brief; includes CURRENT_FOCUS when present)
5. **SESSION_FACT_CORRECTIONS** (optional)
6. **CONTINUITY** (optional; gap-based)
7. **OVERLAY** (optional)
8. **SUPPLEMENTAL_CONTEXT** (Recall Sheet, optional; top 3 facts/entities)
9. **SESSION FACTS** (rolling summary, optional)
10. **Recent messages** (last 8)
11. **Current user message**

**Write path**
- Store user + assistant messages in Prisma
- If a session closes, fire‑and‑forget Synapse `/session/ingest`

---

## Memory Sources (Current)
- **Working memory**: local last 8 messages
- **Long‑term memory**: Synapse `/session/startbrief` (fallback `/session/brief`)

Legacy pipelines remain feature‑flagged but are not default.
