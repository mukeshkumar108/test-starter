# STAGE3_PLAN.md

## Exact Current Retrieval Flow

**Entry**: `src/app/api/chat/route.ts`
1) `buildContext(user.id, personaId, sttResult.transcript)`  
   Source: `src/lib/services/memory/contextBuilder.ts`
2) `buildContext` internally calls:
   - `prisma.personaProfile.findUnique({ where: { id: personaId } })`
   - `prisma.userSeed.findUnique({ where: { userId } })`
   - `prisma.sessionState.findUnique({ where: { userId_personaId } })`
   - `prisma.message.findMany({ where: { userId, personaId }, orderBy: { createdAt: "desc" }, take: 6 })`
   - `prisma.summarySpine.findFirst(...)` (gated by `FEATURE_SUMMARY_SPINE_GLOBAL` + `persona.enableSummarySpine`)
   - `getLatestSessionSummary(userId, personaId)` → `src/lib/services/session/sessionService.ts`
   - `prisma.memory.findMany({ where: { userId, pinned: true, OR: [personaId, null], type in PROFILE/PEOPLE/PROJECT }, take: 20 })`
   - `searchMemories(userId, personaId, userMessage, 12)` → `src/lib/services/memory/memoryStore.ts`
     - `generateEmbedding(query)`
     - `queryRaw` vector search with `embedding <=> query` and `WHERE userId AND (personaId = current OR NULL) AND type in PROFILE/PEOPLE/PROJECT`
     - JS filter for `metadata.status != ARCHIVED`
   - `prisma.todo.findMany(...)` for commitments/threads/frictions
   - `prisma.todo.findMany(...)` for recent wins
3) `route.ts` assembles prompt blocks from `context` (order unchanged).

**Debug path** (optional, if `FEATURE_CONTEXT_DEBUG` + header):
- `route.ts` calls `searchMemories(user.id, personaId, sttResult.transcript, 12)` again to include raw retrieval in debug payload.

## Where to Inject “Entity Card” Retrieval (No Prompt Order Change)

**Recommended insertion point**: inside `buildContext` **after** `searchMemories(...)` and **before** formatting `relevantMemories`.  
Rationale: the entity card fetch can reuse the same `userId`/`personaId` scope and use the `relevantMemories` candidate set to derive entity keys without adding a new prompt block yet.

**Candidate hook**:
- After `const relevantMemories = await searchMemories(...)`  
- Before `const selectedRelevant = selectRelevantMemories(...)`

At this point you can:
- Extract entity refs from `relevantMemories` metadata (if present).
- Fetch “entity cards” from a new store/table or computed view.
- Merge the entity card text into `relevantMemories` content (or hold it for a future block) **without changing block order yet**.

## Minimal Schema Additions for Frequency (If Any)

**Option A (no schema changes)**  
Compute frequency on-demand from existing `Memory` rows:
- Frequency = count of `Memory` rows with same normalized `content` (or future `entityKey`), scoped by `userId` and `personaId` (or NULL).
- Uses aggregate query only against the candidate set.

**Option B (small schema change)**  
Add a `memoryKey` or `entityKey` column to `Memory` to support cheap frequency aggregation:
- `memoryKey` = normalized `content` or `entityKey` (string).  
This makes frequency queries cheaper but is not required to implement Stage 3.

## Safest Blended Ranking (TopK Candidates, No Full Scans)

**Goal**: Blend vector similarity + recency + frequency **without scanning all memories**.

**Recommended flow**:
1) **Vector prefilter**: `searchMemories(..., limit = K)` to return top K by vector distance (e.g., K=50 or 100).
2) **Compute recency + frequency in JS** using only those K items.
   - Recency: exponential decay from `createdAt`.
   - Frequency: count matches within the K set, or one additional aggregate query restricted to the K ids.
3) **Blend score**: `score = 0.4 * similarity + 0.3 * recency + 0.3 * frequency`.
4) **Select top N** for prompt (current cap remains 8).

**Why this is safe**:
- The only DB vector query remains the existing top‑K query (bounded by limit).
- Any additional work is on a small in‑memory set.
- No full table scan is introduced even if frequency/recency is added.

**If recency must be computed in SQL**:
- Use `WHERE id IN (...)` with the K ids from step 1, then compute `recency_score` for that set only.

