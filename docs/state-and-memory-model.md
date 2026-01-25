# State and Memory Model

This document explains how memory and state evolve over time in the system.

## Memory Types

The system stores factual knowledge in the `Memory` table with these types:

### PROFILE
Facts about the user themselves.
- Name, location, occupation
- Preferences, habits, routines
- Personal characteristics

**Examples:**
- "Lives in Austin, Texas"
- "Prefers dark mode"
- "Is a morning person"

### PEOPLE
Facts about people in the user's life.
- Relationships and roles
- Facts about specific people
- Group memberships

**Examples:**
- "John is my cofounder; handles backend"
- "Mom lives in Seattle"
- "Sarah is CEO of TechStartup Inc"

### PROJECT
Facts about things the user is working on.
- Project names and descriptions
- Status and deadlines
- Key details

**Examples:**
- "Working on dashboard redesign"
- "Launching beta next month"
- "Project uses React and TypeScript"

### OPEN_LOOP (Deprecated)
Originally used for tracking open items. Now handled by the Todo system instead.

---

## Memory Metadata (Memory B Schema)

Each memory carries structured metadata:

### entityRefs
Array of normalized entity keys that this memory relates to.

**Format**: `<type>:<slug>`
- `person:john_doe`
- `org:acme_corp`
- `place:austin_texas`
- `project:dashboard_redesign`

**Slug rules**: Lowercase, punctuation removed, spaces/hyphens become underscores.

**Purpose**: Enables entity card expansion—finding all facts about "person:john" across memories.

### entityLabel
Human-readable display name for the primary entity.
- "John Doe"
- "Acme Corp"
- "Austin, Texas"

### subtype
Structured classification of the memory:
```json
{
  "entityType": "person|place|org|project",
  "factType": "fact|preference|relationship|friction|habit"
}
```

### importance
Numeric score from 0-3:
- **0**: Trivial, ephemeral
- **1**: Standard (default)
- **2**: Significant (relationships, key facts)
- **3**: Critical (core identity: name, role)

**Effect**: Memories with importance < 2 are excluded from entity cards unless pinned.

### pinned
Boolean flag. Pinned memories:
- Always included in foundation memories (up to 20)
- Always included in entity cards regardless of importance
- Never archived by curator
- Importance is forced to 3

### memoryKey
Unique key for deduplication:
```
${type.lower()}|${entityType}|${primaryRef}|${factType}
```

**Example**: `people|person|john_doe|relationship`

When a memory with the same key is stored, the existing memory is updated rather than duplicated.

### source
Origin of the memory:
- `shadow_extraction`: Extracted by Shadow Judge from conversation
- `seeded_profile`: Loaded from initial user profile
- `curated_fold`: Created by curator when folding multiple memories

### status
- `ACTIVE`: Normal, retrievable
- `ARCHIVED`: Hidden from retrieval, preserved for audit

### confidence
LLM's confidence score when extracting (0.0-1.0).

---

## Memory Retrieval

### Vector Search Pipeline

1. **Embedding**: Query text is embedded via OpenAI (1536 dimensions)
2. **Candidate fetch**: Top 50 candidates by cosine similarity
3. **Filtering**:
   - User-scoped (`userId`)
   - Persona-scoped (`personaId = X OR personaId IS NULL`)
   - Type in (PROFILE, PEOPLE, PROJECT)
   - Status != ARCHIVED
4. **Blended ranking** (if entity pipeline enabled):
   - 40% similarity score
   - 30% recency (14-day half-life exponential decay)
   - 30% frequency (entity key occurrence in candidate set)
5. **Return**: Top results after re-ranking

### Entity Card Expansion

When relevant memories are found:
1. Extract all `entityRefs` from those memories
2. SQL query for other memories sharing those entity keys
3. Filter: `importance >= 2 OR pinned`
4. Sort: `pinned DESC → importance DESC → createdAt DESC`
5. Group by entity key, take top 3 facts per card
6. Format: `[person:john]: fact1; fact2; fact3`

**Injected at top of relevant memories block.**

---

## State Objects

### SessionState
**Scope**: Per user + persona
**Persistence**: Survives across sessions
**Location**: `SessionState` table

Contains:
```typescript
{
  state: {
    messageCount: number,
    lastInteraction: string,  // ISO timestamp
    lastUserMessage: string,  // Truncated
    curator: {
      lastRunAt: string,
      lastMemoryCountAtRun: number
    },
    // Rolling summary diagnostics
    lastRollingAttemptAt: string,
    lastRollingSuccessAt: string,
    lastRollingError: { reason: string, detail?: string } | null
  },
  rollingSummary: string  // Max 600 chars
}
```

**Updated**: Every message (message count), every 4 turns (rolling summary)

### Session
**Scope**: Per user + persona
**Lifecycle**: Created on first message, closed after 30m inactivity
**Location**: `Session` table

Contains:
- `startedAt`: When session began
- `lastActivityAt`: Last message time
- `endedAt`: When closed (null if active)
- `turnCount`: Messages in session

### SessionSummary
**Scope**: Per session (therefore per persona)
**Created**: Async when session closes
**Location**: `SessionSummary` table

Contains structured JSON:
```json
{
  "one_liner": "Brief session description",
  "what_mattered": ["key topic 1", "key topic 2"],
  "open_loops": ["unresolved item"],
  "commitments": ["promised action"],
  "people": ["mentioned people"],
  "tone": "emotional quality"
}
```

**Used**: In next session's context as "latest session summary"

### SummarySpine
**Scope**: Per user (global, "default" conversationId)
**Created**: Every 20+ messages
**Location**: `SummarySpine` table

Contains:
- `version`: Incrementing version number
- `content`: Structured summary (PROFILE, PROJECTS, PEOPLE, OPEN_LOOPS sections)
- `messageCount`: Messages since last spine

**Used**: Long-term conversation context

---

## What Persists Where

### Across All Sessions (Permanent)
| Data | Storage | Scoping |
|------|---------|---------|
| User account | User table | Global |
| Memories | Memory table | Global (write), Persona-filtered (read) |
| Todos | Todo table | Persona-scoped |
| UserSeed | UserSeed table | Global |
| SummarySpine | SummarySpine table | Global |

### Across Sessions Within Persona
| Data | Storage | Lifetime |
|------|---------|----------|
| SessionState | SessionState table | Permanent per persona |
| Session history | Session table | Permanent |
| SessionSummaries | SessionSummary table | Permanent |
| Message history | Message table | Permanent |

### Within Single Session Only
| Data | Storage | Lifetime |
|------|---------|----------|
| Rolling summary | SessionState.rollingSummary | Overwrites each update |
| Turn count | Session.turnCount | Reset on new session |
| Recent messages | Context build cache | Request-scoped |

---

## State Evolution Timeline

```
t=0: User sends first message to persona "Coach"
  → Create User (if new)
  → Create Session (Coach)
  → Create SessionState (Coach) with messageCount=1
  → Shadow extracts memories → stored globally
  → Shadow extracts todos → stored for Coach

t=1: Second message
  → Update Session (turnCount=2)
  → Update SessionState (messageCount=2)
  → More memories/todos extracted

t=3: Fourth message
  → messageCount=4 → Trigger rolling summary
  → SessionState.rollingSummary updated

t=35min: No activity
  → Session marked as ended
  → SessionSummary created async

t=36min: User sends message
  → New Session created
  → SessionState preserved (messageCount continues)
  → Context includes: latest SessionSummary, rollingSummary

t=n: messageCount > 20
  → New SummarySpine version created
```

---

## Global vs Persona-Scoped: The Design Tension

### The Current Model

**Global (shared across personas):**
- Memory storage (personaId = NULL)
- SummarySpine
- UserSeed

**Persona-scoped (isolated per persona):**
- Memory retrieval (filters by personaId OR NULL)
- Todos (commitments, habits, threads, frictions)
- Sessions
- SessionState (rolling summary)
- Messages

### Why This Design?

**Facts are universal**: "I live in Austin" is true regardless of which persona you're talking to. Storing memories globally means all personas can access the same knowledge base.

**Commitments are contextual**: "I'll go for a walk tomorrow" is a promise made to a specific persona in a specific conversation. It shouldn't appear in a different persona's context.

**Retrieval is persona-aware**: Even though memories are global, the retrieval query includes `personaId = X OR personaId IS NULL`. This means:
- Memories written without personaId (global) are visible to all personas
- If a memory were written with a specific personaId, only that persona would see it

### Current Gap

Shadow Judge always writes memories with `personaId = NULL`. There's no mechanism to write persona-specific memories. This is intentional but worth noting—it means there's no way to tell a persona something that other personas won't eventually see (via vector search).

---

## Ambiguities and Edge Cases

### Memory Deduplication Race Condition
If two messages trigger Shadow Judge simultaneously, both might try to store the same memory. The `memoryKey` unique constraint prevents duplicates at the database level, but one write will fail silently.

### Rolling Summary Overwrites
Rolling summary is a single string, not a history. Each update replaces the previous. If important context was in the previous summary but not re-stated, it's lost.

### Session Boundary Fuzziness
A session closes after 30 minutes of inactivity. But the user might return at minute 31, and the old session is gone. The SessionSummary captures context, but the transition can feel abrupt.

### Entity Key Variants
ASR (speech-to-text) can produce variants: "Makesh" vs "Mukesh". The entity normalizer has a small override map, but unknown variants create separate entities that don't merge.

### Importance Bootstrap Problem
New memories default to importance=1. The system has no mechanism to increase importance over time based on frequency of reference. A fact mentioned once and a fact mentioned 50 times have the same importance unless manually set.
