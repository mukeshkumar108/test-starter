# Todos, Commitments, and Open Loops

This document explains the cognitive model behind the Todo system.

## The Core Question

> Is this a task manager, or a cognitive "open loop" system?

**Answer: It's an open loop system.**

The goal is not to manage tasks like a todo app. The goal is to track what's occupying the user's mental space—things they've said they'll do, patterns they're struggling with, threads they're thinking about—so the assistant can be contextually aware and gently supportive.

A task manager says "here are your tasks, check them off."

This system says "I remember you said you'd go for a walk. How did that go?"

---

## The Five Loop Types

### COMMITMENT
**What it is**: A specific, time-bound intention the user has stated.

**Examples**:
- "I'll go for a walk tomorrow morning"
- "I need to text Ashley about the fight"
- "I want to finish the dashboard polish tonight"

**Characteristics**:
- Usually has a timebox (today, tonight, tomorrow, by Friday)
- Action-oriented and specific
- Created when user expresses explicit intention

**Lifecycle**:
- Created: Shadow Judge extracts from "I will...", "I'm going to...", timebox markers
- Completed: Curator detects completion signal ("I did my walk")
- Promoted: If recurrence detected, becomes HABIT

### HABIT
**What it is**: A recurring behavior the user wants to maintain.

**Examples**:
- "I want to walk every day"
- "15 minutes tidying daily"
- "20 minutes exercise each morning"

**Characteristics**:
- Implies ongoing, repeated action
- No specific end date
- Pattern-based, not one-off

**Lifecycle**:
- Created: Shadow Judge extracts from "every day", "daily", "routine"
- Also created: Curator promotes COMMITMENT when recurrence detected
- Persists: Stays PENDING indefinitely (no natural completion)

### THREAD
**What it is**: A topic or conversation thread the user is engaged with.

**Examples**:
- "Thinking about the color scheme for the app"
- "The meeting with investors is on my mind"
- "Venting about the kitchen mess"

**Characteristics**:
- Not necessarily actionable
- Represents cognitive load, not a task
- May resolve naturally through conversation

**Lifecycle**:
- Created: Shadow Judge extracts neutral topics without timebox
- Cleaned: Curator marks as SKIPPED if clearly non-actionable (weather, "just thinking")
- Fades: Lower priority, dropped from context first if budget exceeded

### FRICTION
**What it is**: A recurring pattern of struggle or difficulty.

**Examples**:
- "I wake up, get stuck at the computer, don't walk until 2-3pm"
- "I keep putting off the hard conversations"
- "The color choices always feel off"

**Characteristics**:
- Negative valence
- Repeatable pattern (not a one-time event)
- Implies something to work on over time

**Lifecycle**:
- Created: Shadow Judge extracts from patterns with negative language
- Persists: Not auto-completed (frictions don't "complete")
- Surfaced: Shown in context to inform assistant responses

### WIN (via metadata)
**What it is**: Record of a completed commitment or habit instance.

**Note**: WIN is not a TodoKind in the schema. Wins are stored as COMMITMENT with `dedupeKey = "win:..."` and `status = COMPLETED`.

**Examples**:
- "✓ Go for a walk" (when user says "I did my walk")
- "✓ 30 minutes exercise"

**Characteristics**:
- Always COMPLETED status
- Content prefixed with "✓"
- Dedupe key prefixed with "win:"
- Idempotent per original commitment per day

**Purpose**:
- Track progress
- Surface "recent wins" in context (last 48h)
- Provide positive reinforcement data

---

## How Commitments Are Created

### Path 1: Shadow Judge Extraction

The LLM-based Shadow Judge analyzes the last 4 user messages and extracts loops.

**Extraction rules** (from prompt):
- COMMITMENT: explicit promise/decision, often timeboxed
- Must have: "I will", "I'm going to", or timebox markers (today, tonight, tomorrow, by X, at X:00)
- Must NOT be: hedged with "maybe", "might", "could" (unless overridden by timebox)

**Downgrade to THREAD**:
If the Shadow Judge outputs COMMITMENT but:
- Contains hedge words ("maybe", "might", "could", "wish", "hope")
- AND no timebox marker
- AND no explicit will ("I will", "I'll", "I'm going to")

Then the system downgrades it to THREAD.

### Path 2: Direct HABIT Creation

If the Shadow Judge detects recurrence language ("every day", "daily"), it creates a HABIT directly instead of a COMMITMENT.

---

## How Commitments Are Completed

### Curator V1: Keyword Matching

When a user message contains completion signals, the curator attempts to match it to a pending commitment.

**Completion signals** (regex patterns):
- "I did", "I've done", "I finished", "I completed"
- "went for", "took", "had my", "did my"
- "already", "just finished", "just did"

**Matching algorithm**:
1. Extract action keywords from user message (words > 2 chars, excluding stopwords)
2. For each pending COMMITMENT, count how many keywords appear in its content
3. Select the commitment with highest score
4. If only one pending commitment, match it regardless of score
5. If multiple and best score >= 1, match the best
6. If multiple and best score < 1, no match (ambiguous)

**Example**:
- User says: "I did my walk today"
- Keywords: ["walk"]
- Commitment "Go for a walk" contains "walk" → score 1
- Commitment matched, marked COMPLETED

**When completed**:
- Status → COMPLETED
- completedAt → current timestamp
- WIN record created (if not already exists for this commitment today)

---

## How Habits Are Promoted

### Curator V1: Recurrence Detection

When a user message contains recurrence signals, the curator checks if a recent commitment should become a habit.

**Recurrence signals** (regex patterns):
- "every day", "everyday", "daily", "each day"
- "every morning", "every evening", "every night"
- "routine", "regularly", "habitually"
- "weekly", "monthly"

**Promotion algorithm**:
1. Detect recurrence signal in user message
2. Find pending COMMITMENTs from last 24 hours
3. Match by keyword overlap (same as completion)
4. Check for existing HABIT with similar content (dedupeKey, substring, or keyword overlap)
5. If no similar habit exists, create HABIT
6. Mark original COMMITMENT as COMPLETED

**Example**:
- User says: "I want to walk every day"
- Recurrence: "every day" detected
- Recent commitment: "Go for a walk"
- Keywords: ["walk"] match
- No existing habit with "walk"
- Create HABIT "Go for a walk"
- Mark COMMITMENT "Go for a walk" as COMPLETED

---

## Keyword Matching: Where and Why

### Where It's Used
1. **Commitment completion**: Matching "I did my walk" to "Go for a walk"
2. **Habit promotion**: Matching recurrence context to recent commitment
3. **Habit deduplication**: Checking if similar habit already exists

### Why Keyword Matching (Not LLM)

**Speed**: Keyword matching is instant. LLM matching would add 2-3 seconds to the async path.

**Cost**: Each LLM call costs money. Curator runs frequently; costs would accumulate.

**Simplicity**: For common cases ("I did my walk" → "Go for a walk"), keyword overlap works well.

**Determinism**: Keyword matching is predictable and debuggable. LLM matching can produce surprising results.

### Limitations

**Synonym blindness**: "Took a stroll" won't match "Go for a walk" because there's no keyword overlap.

**Partial matches**: "I walked to the store" might incorrectly match "Go for a walk" (both contain "walk").

**Context loss**: "I did it" with only one pending commitment works, but with multiple commitments it fails (no keywords to match).

**Language variance**: Works best for English. Keyword extraction assumes English stopwords.

---

## Design Philosophy

### Open Loops, Not Tasks

The system tracks cognitive load, not a task list. The difference:

| Task Manager | Open Loop System |
|--------------|------------------|
| "Complete task" button | Inferred from conversation |
| Explicit due dates | Implied urgency from language |
| User creates tasks | System extracts intentions |
| Binary: done/not done | Nuanced: completed, skipped, became habit |
| Task-centric UI | Conversation-centric |

### Surfacing, Not Managing

Todos are surfaced in context so the assistant can reference them naturally:
- "You mentioned wanting to go for a walk—did you get a chance?"
- "I remember you've been struggling with getting stuck at the computer in the mornings."

The user doesn't "manage" their todos. The assistant is aware of them and can bring them up appropriately.

### Forgiving, Not Punitive

The system doesn't nag. Commitments don't have hard deadlines. There's no "overdue" status. If a commitment sits pending for days, it simply remains available for the assistant to reference when relevant.

---

## Current Gaps

### No Negative Completion
There's no way to say "I didn't do it" and have the system understand. The commitment stays pending.

### No Explicit Dismissal
Users can't say "never mind about the walk" and have the commitment removed. It stays pending until completed or manually cleaned.

### No Confidence Scoring
All extracted commitments are treated equally. A confidently stated "I will definitely call her tomorrow" and a tentatively extracted "maybe check in on John" have the same weight.

### No Time-Aware Surfacing
A commitment to "go for a walk tomorrow morning" should surface more prominently the next morning. Currently, surfacing is based on recency, not scheduled relevance.

### No Semantic Matching
"Took a stroll around the block" should complete "Go for a walk" but doesn't because keywords don't overlap. This is the biggest UX gap.
