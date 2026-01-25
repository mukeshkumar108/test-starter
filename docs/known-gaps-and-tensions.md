# Known Gaps and Tensions

This document surfaces architectural fault lines, overlapping concepts, and areas that will be hard to evolve.

---

## Conceptual Overlaps

### 1. Four Layers of Summarization

The system has four distinct summarization mechanisms:

| Layer | Scope | Trigger | Storage | Lifetime |
|-------|-------|---------|---------|----------|
| Rolling summary | Current session | Every 4 turns | SessionState.rollingSummary | Overwrites each update |
| Session summary | Closed session | Session close | SessionSummary table | Permanent |
| Summary spine | Long-term | Every 20 messages | SummarySpine table | Versioned, permanent |
| Memory (curated) | Entity-grouped | Curator fold | Memory table | Permanent |

**The tension**: These layers overlap in purpose. A session summary captures "what mattered" but so does the rolling summary. The spine tracks OPEN_LOOPS but so does the Todo system.

**The risk**: Context budget is limited. Injecting all four layers competes for space. Currently they're prioritized (rolling > session summary in drop order), but the redundancy means information is stored multiple times in slightly different forms.

**What's unclear**: When should an insight live in a summary vs become a memory vs become a todo? The boundaries are fuzzy.

### 2. Memories vs Todos vs Session State

Three systems track user "stuff":

| System | What it tracks | Persistence | Retrieval |
|--------|----------------|-------------|-----------|
| Memory | Facts about user | Permanent, vector-searchable | Embedding similarity |
| Todo | Intentions/patterns | Permanent, status-filtered | Kind + status query |
| SessionState | Recent context | Overwrites, per-persona | Direct lookup |

**The tension**: A friction ("I keep getting stuck at the computer") could be:
- A Memory (type=PROFILE, metadata about pattern)
- A Todo (kind=FRICTION)
- Part of a summary

Currently it's a Todo, but frictions don't "complete"—they persist indefinitely. Are they really todos?

**The risk**: Users might express the same concern multiple ways. It might become a memory AND a friction AND part of a summary, creating redundancy.

### 3. Entity Cards vs Foundation Memories

Both provide "important facts" in context:

| Mechanism | Source | Selection | Position in prompt |
|-----------|--------|-----------|-------------------|
| Foundation memories | pinned=true | Up to 20, by createdAt | After persona prompt |
| Entity cards | entityRefs match, importance≥2 | Up to 5 cards × 3 facts | Top of relevant memories |

**The tension**: A pinned memory about "John" and an entity card about "person:john" might contain the same information. Both get injected into context.

**The risk**: Duplicated context wastes budget. A fact about John might appear twice.

**What's unclear**: Should pinned memories automatically become entity card sources? Should entity cards replace foundation memories?

---

## Systems That Feel Bolted Together

### 1. Curator V1 + Shadow Judge

Shadow Judge extracts. Curator cleans up. But they run sequentially in the async path, and their responsibilities overlap.

**Shadow Judge**:
- Extracts memories and todos
- Normalizes loop kinds
- Dedupes against existing todos

**Curator V1**:
- Detects completion (could Shadow Judge do this?)
- Promotes habits (could Shadow Judge classify as HABIT directly?)
- Cleans threads (post-hoc cleanup of Shadow Judge output?)

**The tension**: Why extract a COMMITMENT just to immediately promote it to HABIT? The recurrence pattern was in the original message—Shadow Judge could have classified it directly.

**Current justification**: Shadow Judge runs the LLM; Curator runs deterministic logic. Separation of concerns. But the division feels arbitrary.

### 2. Memory B Metadata + Todo System

Memory B introduced structured metadata (entityRefs, importance, subtype). But Todos have none of this.

A commitment to "meet John for coffee" could benefit from:
- entityRefs: ["person:john"]
- importance: 2 (involves a relationship)

But todos are flat: just content, kind, status.

**The tension**: Memory and Todo systems evolved separately. Memory got rich metadata; Todo stayed simple.

**The risk**: Can't do "show me all commitments involving John" without text search. Can't prioritize important commitments.

### 3. Persona Scoping Inconsistency

| Data | Write Scope | Read Scope |
|------|-------------|------------|
| Memory | Global (NULL) | Persona-filtered |
| Todo | Persona | Persona |
| Session | Persona | Persona |
| SummarySpine | Global | Global |
| SessionState | Persona | Persona |

**The tension**: Memories are written globally but read per-persona. This means:
- All personas see all memories (eventually, via vector search)
- But the retrieval query includes personaId filter
- So a memory written with personaId=NULL is visible to all, but one with personaId=X is only visible to X

Currently, Shadow Judge always writes personaId=NULL. There's no mechanism for persona-specific memories.

**The risk**: User tells persona A something private. It might surface in persona B's context.

**What's unclear**: Is this intentional (facts are universal) or an oversight (should support persona-specific memories)?

---

## Areas Hard to Evolve

### 1. Keyword Matching for Completion

The commitment matching algorithm is deeply embedded:
- Hardcoded stopwords list
- Specific keyword extraction logic
- Score threshold (>=1) for match

**Why hard to change**:
- No abstraction layer—logic is inline in curator
- Tests rely on specific matching behavior
- Changing matching changes what "works" for existing users

**Evolution path blocked**: Can't easily A/B test different matching algorithms or add LLM fallback without significant restructuring.

### 2. Context Budget and Drop Order

The 1200-token budget and drop order are hardcoded:
```
relevantMemories → sessionSummary → threads
```

**Why hard to change**:
- Drop order is in route.ts, mixed with prompt assembly
- No configuration mechanism
- No per-persona override

**Evolution path blocked**: Can't experiment with different budgets or drop orders without code changes.

### 3. Session Timeout (30 minutes)

The session boundary is a magic number:
```javascript
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
```

**Why hard to change**:
- No user preference mechanism
- No persona-specific override
- Changing affects all users immediately

**What's unclear**: Is 30 minutes right? For some users, 5 minutes of silence means they're done. For others, they might return after an hour and expect continuity.

### 4. Entity Canonicalization Map

The override map for ASR variants is a hardcoded object:
```javascript
const CANONICAL_OVERRIDES: Record<string, string> = {
  makesh: "mukesh",
  // ...
};
```

**Why hard to change**:
- Requires code deploy to add new mappings
- No learning mechanism
- No user correction flow

**Evolution path blocked**: Every new ASR variant requires manual intervention.

---

## Unrealistic Assumptions About User Language

### 1. Users Speak in Completable Commitments

**Assumption**: Users will say "I did my walk" after committing to "Go for a walk."

**Reality**: Users say:
- "Yeah, I went out this morning" (indirect)
- "Got my steps in" (different framing)
- "Took a stroll" (synonym)
- "Finally did it" (no keywords at all)

**Gap**: Keyword matching assumes linguistic consistency that doesn't exist.

### 2. Users Timebox Their Commitments

**Assumption**: The presence of "tomorrow" or "tonight" indicates a commitment.

**Reality**: Users say:
- "I should probably exercise" (intention without timebox)
- "I want to be better about walking" (aspiration, not commitment)
- "Tomorrow I might try to..." (hedged timebox)

**Gap**: The commitment/thread boundary is fuzzy. System may under- or over-extract.

### 3. Entity Names Are Consistent

**Assumption**: Users will consistently say "John" or "my cofounder John."

**Reality**: Users say:
- "John" / "Johnny" / "J" (nicknames)
- "My cofounder" / "the CTO" / "him" (role references)
- Names with ASR errors

**Gap**: Entity linking assumes surface form consistency.

### 4. Recurrence Is Explicit

**Assumption**: Users will say "every day" or "daily" when they want a habit.

**Reality**: Users imply recurrence:
- "I've been trying to walk more" (ongoing effort)
- "I usually exercise in the morning" (existing pattern)
- "I need to get back to meditating" (lapsed habit)

**Gap**: Current detection only catches explicit recurrence markers.

---

## Tensions Without Clear Resolution

### Latency vs Accuracy

LLM matching would be more accurate but adds latency. Current choice: favor speed.

**Unresolved**: Is there a sweet spot? Hybrid approach? User preference?

### Global Memory vs Persona Privacy

Facts are shared; conversations are separate. But some facts are contextual.

**Unresolved**: Should users be able to tell one persona something others won't see?

### Automatic Extraction vs User Control

System extracts without confirmation. Users can't correct or remove.

**Unresolved**: Should there be a feedback loop? "Did you mean to commit to X?"

### Permanent Storage vs Forgetting

Everything persists. Old commitments linger. Outdated facts remain.

**Unresolved**: Should the system forget? Decay? Archive automatically?

---

## Summary: The Core Tension

The system tries to be **intelligent** (understand intent, track cognitive state) while remaining **fast** (sub-second processing) and **cheap** (minimize LLM calls).

These goals conflict:
- Intelligence requires LLM reasoning
- Speed requires deterministic shortcuts
- Cost requires batching and caching

The current architecture resolves this by:
- LLM for extraction (async, can be slow)
- Deterministic for matching (sync-ish, must be fast)
- Caching via summaries (reduce repeated LLM work)

But the resolution is imperfect. The keyword matching gap causes real UX issues. The summary layers create redundancy. The session timeout is arbitrary.

These aren't bugs—they're tradeoffs. But they're tradeoffs worth revisiting as the system matures.
