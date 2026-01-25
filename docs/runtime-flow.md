# Runtime Flow

This document traces what happens when a user sends a message to `/api/chat`.

## Overview

The request follows two parallel paths:

1. **Sync Path**: Auth → Context → LLM → TTS → Response (blocking, ~3-7s)
2. **Async Path**: Memory extraction → Todo processing → Summarization (non-blocking)

The user receives their response from the sync path. The async path runs in the background to update system state for future conversations.

---

## Sync Path (User-Facing)

### 1. Authentication
**Location**: `route.ts` entry point

- Check for Clerk cookie (web clients)
- If missing, check for Bearer token (mobile clients)
- Verify token and extract `clerkUserId`
- **Failure**: Return 401 Unauthorized

### 2. User Resolution
**Location**: `ensureUserByClerkId()`

- Upsert user record in database
- Returns internal `userId`

### 3. Request Parsing
**Location**: `route.ts`

- Parse multipart form data
- Extract: `personaId`, `language`, `audioBlob` (m4a)
- Validate persona exists
- **Failure**: Return 404 if persona not found

### 4. Speech-to-Text
**Location**: `transcribeAudio()` → LemonFox API

- Convert audio blob to text
- Returns: transcript string
- **Latency**: ~0.5-1.5s

### 5. Session Lifecycle
**Location**: `sessionService.ts`

**5a. Close Stale Sessions**
- Find sessions for this user+persona with no activity for >30 minutes
- Mark them as ended (set `endedAt`)
- **Trigger async**: Session summary generation (fire-and-forget)

**5b. Ensure Active Session**
- Look for active session (within 30m window)
- If exists: Update `lastActivityAt`, increment `turnCount`
- If not: Create new session

### 6. Context Building
**Location**: `contextBuilder.ts`

This is the most database-intensive step. It assembles all context blocks for the LLM prompt.

**Database Reads (10+ queries):**
| Query | Purpose | Scoping |
|-------|---------|---------|
| PersonaProfile | Load prompt file path | Global |
| UserSeed | Static user context | Global |
| SessionState | Rolling summary, message count | Persona-scoped |
| Messages (last 6) | Recent conversation | Persona-scoped |
| SummarySpine | Long-term conversation summary | Global |
| SessionSummary | Last session's summary | Persona-scoped |
| Memories (pinned) | Foundation facts | Global + Persona |
| Memories (vector search) | Relevant context | Global + Persona |
| Entity cards (SQL) | Linked facts expansion | Global + Persona |
| Todos (3 queries) | Commitments, threads, frictions | Persona-scoped |
| Todos (wins) | Recent completions | Persona-scoped |

**Output**: `ConversationContext` object with all blocks

### 7. Prompt Assembly
**Location**: `route.ts`

Assembles the LLM messages array in strict order:

```
1.  [REAL-TIME]           - Always (time, date, weather placeholder)
2.  [SESSION STATE]       - If sessionState exists
3.  Persona Prompt        - Always (loaded from file)
4.  [FOUNDATION MEMORIES] - If any pinned memories
5.  [RELEVANT MEMORIES]   - Entity cards + vector search results
6.  COMMITMENTS           - Pending commitments (up to 5)
7.  ACTIVE THREADS        - Pending threads (up to 3)
8.  FRICTIONS / PATTERNS  - Pending frictions (up to 3)
9.  Recent wins           - Completed commitments (last 48h)
10. User context          - UserSeed content
11. Conversation summary  - SummarySpine content
12. [CURRENT SESSION]     - Rolling summary
13. [LATEST SESSION]      - Last session summary
14. Recent messages       - Last 6 turns
15. Current user message  - The transcript
```

**Budget Guard**: If estimated tokens > 1200, blocks are dropped in order:
1. Relevant memories
2. Session summary
3. Threads

### 8. LLM Call
**Location**: `llmService.ts` → OpenRouter API

- Model: Configured per persona
- Max tokens: 350 (Sophie) or 1000 (others)
- Temperature: 0.7
- **Latency**: ~1-3s (largest contributor)

### 9. Text-to-Speech
**Location**: `ttsService.ts` → ElevenLabs API

- Voice: Configured per persona
- **Latency**: ~1-2s

### 10. Message Storage
**Location**: `route.ts`

- Create user message record
- Create assistant message record
- Both linked to session via timestamps

### 11. Response
**Location**: `route.ts`

Returns JSON:
```json
{
  "transcript": "user's spoken text",
  "response": "assistant's text response",
  "audioUrl": "url to TTS audio blob",
  "timing": { "stt": 800, "llm": 2100, "tts": 1500 }
}
```

---

## Async Path (Background Processing)

These processes are triggered fire-and-forget. They never block the user response.

### A. Shadow Judge (processShadowPath)
**Trigger**: After response is sent
**Location**: `shadowJudge.ts`

**A1. Build Input Window**
- Fetch last 6 user messages (within 60 minutes)
- Dedupe and take last 4 unique
- Include current message

**A2. LLM Extraction**
- Call OpenRouter with extraction prompt
- Temperature: 0
- Max tokens: 350
- **Output**: JSON with `memories[]` and `loops[]`

**A3. Memory Sanitization**
- Filter out test phrases, persona names
- Validate PEOPLE memories have relationship context
- Slice to first 5 memories

**A4. Memory Storage**
- For each memory: Call `storeMemory()`
- Deduplication via `memoryKey`
- Updates existing if key matches

**A5. Loop Normalization**
- Downgrade hedged commitments to threads
- Normalize kind to allowed set
- Dedupe in-memory

**A6. Todo Storage**
- Check DB for existing PENDING + same kind + signature
- Create if not duplicate

**A7. SessionState Update**
- Increment `messageCount`
- Update `lastInteraction`

**A8. Curator V1 Trigger**
- If `FEATURE_MEMORY_CURATOR=true`:
- Call `curatorTodoHygiene()` async

**A9. Rolling Summary (every 4 turns)**
- If `messageCount % 4 === 0`:
- Call `summarizeRollingSession()`
- Timeout guard: 4 seconds
- Update `SessionState.rollingSummary`

**A10. Summary Spine Update**
- If no spine OR `messageCount > 20`:
- Generate new spine version
- Store in `SummarySpine` table

### B. Curator V1 (curatorTodoHygiene)
**Trigger**: From Shadow Judge (if enabled)
**Location**: `memoryCurator.ts`

Runs three operations in parallel:

**B1. Commitment Completion**
- Pattern match: "I did", "I finished", "went for", etc.
- Find best matching PENDING COMMITMENT
- Mark COMPLETED
- Create WIN record (idempotent)

**B2. Habit Promotion**
- Pattern match: "every day", "daily", "routine", etc.
- Find matching recent COMMITMENT
- Create HABIT if not exists
- Mark original COMPLETED

**B3. Thread Cleanup**
- Pattern match: weather, "just thinking", etc.
- Mark non-actionable threads as SKIPPED

### C. Session Summary (on session close)
**Trigger**: When stale session is closed
**Location**: `sessionSummarizer.ts`

- Fetch messages from session time window
- Call LLM with summarization prompt
- Parse JSON response
- Store in `SessionSummary` table

### D. Auto-Curator (autoCurateMaybe)
**Trigger**: After async path, subject to cooldown
**Location**: `memoryCurator.ts`

- Cooldown: 60 seconds per persona
- Interval: 24 hours OR 25+ new memories
- Runs memory deduplication and folding

---

## State Read vs Write Summary

| Component | Reads | Writes |
|-----------|-------|--------|
| Auth/User | 1 | 0-1 (upsert) |
| Persona | 1 | 0 |
| Session | 2 | 1-2 |
| Context Builder | 12+ | 0 |
| Messages | 0 | 2 |
| Shadow Judge | 1 | 0-13 |
| Curator | 1-5 | 0-5 |

---

## Persona Scoping Summary

| Data | Scoping | Notes |
|------|---------|-------|
| User | Global | One per Clerk account |
| Persona | Global | Shared definition |
| Session | Persona-scoped | Separate per persona |
| SessionState | Persona-scoped | Rolling summary is per-persona |
| SessionSummary | Persona-scoped | Via session link |
| Messages | Persona-scoped | Filter on retrieval |
| Memories | Global (write) | personaId = NULL on write |
| Memories | Persona-scoped (read) | Filter: personaId = X OR NULL |
| Todos | Persona-scoped | Always filtered by personaId |
| SummarySpine | Global | "default" conversationId |
| UserSeed | Global | One per user |

---

## Timing Breakdown (Typical)

| Step | Sync/Async | Typical Duration |
|------|------------|------------------|
| Auth + User | Sync | ~50ms |
| STT | Sync | ~800ms |
| Session Lifecycle | Sync | ~100ms |
| Context Build | Sync | ~300ms |
| LLM Call | Sync | ~2000ms |
| TTS | Sync | ~1500ms |
| Message Storage | Sync | ~100ms |
| **Total Sync** | | **~4-5s** |
| Shadow Extraction | Async | ~3000ms |
| Memory/Todo Writes | Async | ~500ms |
| Rolling Summary | Async | ~2000ms (if triggered) |
| Curator | Async | ~200ms |
