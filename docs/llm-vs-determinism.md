# LLM vs Determinism Boundary Analysis

This document maps where the system uses LLM intelligence versus deterministic logic, and analyzes the tradeoffs.

## Current Boundaries

### Where LLMs Are Used

| Component | LLM Call | Model | Purpose |
|-----------|----------|-------|---------|
| Main response | Yes | Per-persona config | Generate conversational response |
| Shadow Judge extraction | Yes | JUDGE model | Extract memories and loops from conversation |
| Rolling summary | Yes | JUDGE model | Summarize recent conversation |
| Session summary | Yes | JUDGE model | Summarize closed session |
| Summary spine | Yes | JUDGE model | Long-term conversation tracking |
| Embeddings | Yes | OpenAI | Vector representation for similarity search |

**Total LLM calls per user turn**: 1-3 (main response required, others conditional/async)

### Where Deterministic Logic Is Used

| Component | Logic Type | Purpose |
|-----------|------------|---------|
| Commitment downgrade | Regex | Hedge words → demote COMMITMENT to THREAD |
| Completion detection | Regex | "I did", "I finished" → trigger completion |
| Recurrence detection | Regex | "every day", "daily" → trigger habit |
| Non-actionable detection | Regex | Weather, "just thinking" → skip thread |
| Keyword extraction | String manipulation | Remove stopwords, extract action words |
| Commitment matching | Keyword overlap score | Match user statement to pending todo |
| Habit deduplication | String/keyword overlap | Prevent duplicate habits |
| Entity key normalization | Regex + map | Slugify names, canonicalize variants |
| Memory deduplication | memoryKey matching | Prevent duplicate memory records |
| Blended ranking | Math formula | 0.4×sim + 0.3×recency + 0.3×frequency |
| Budget guard | Char counting | Estimate tokens, drop blocks |
| Session timeout | Time comparison | 30 minutes → close session |

---

## Why Each Choice Was Made

### LLM for Extraction (Shadow Judge)

**Choice**: LLM extracts memories and loops from conversation.

**Why LLM**:
- Natural language is ambiguous. "My cofounder John is handling the backend" requires understanding relationships.
- Extraction requires judgment: Is this worth remembering? Is this a commitment or just musing?
- Structured output (JSON) with semantic fields (type, entityRefs, importance).

**Why not deterministic**:
- Rule-based extraction would miss nuance.
- Maintaining comprehensive regex patterns for all phrasings is impractical.
- LLM handles novel phrasings naturally.

### Deterministic for Completion Detection

**Choice**: Regex patterns detect completion signals.

**Why deterministic**:
- Speed: Instant vs 2-3 second LLM call
- Cost: No API call per detection attempt
- Reliability: "I did my walk" reliably matches completion patterns
- Simplicity: Easy to debug and extend

**Why not LLM**:
- Would add latency to every message
- Diminishing returns: Common completion phrases are predictable
- Determinism is valuable for user trust (predictable behavior)

### Deterministic for Keyword Matching

**Choice**: Keyword overlap scores match statements to commitments.

**Why deterministic**:
- Speed: Critical for responsive async path
- Transparency: Can explain why a match happened
- Cost: Free vs per-match LLM cost

**Why not LLM**:
- Each match attempt would need an LLM call
- Multiple pending commitments × frequent messages = many calls
- Latency would compound

### LLM for Summarization

**Choice**: LLM generates rolling, session, and spine summaries.

**Why LLM**:
- Summarization requires understanding and synthesis
- Output quality matters for context injection
- No deterministic algorithm can summarize conversations well

**Why not deterministic**:
- No good algorithm exists for conversation summarization
- Rule-based extraction would miss what actually mattered

---

## Where Ambiguity Is Mishandled

### Commitment Matching Failures

**The problem**: Keyword matching fails on semantic equivalents.

**Example**:
- Pending: "Go for a walk"
- User says: "I took a stroll around the block"
- Keywords: ["took", "stroll", "around", "block"]
- None match "go", "for", "walk"
- **Result**: No completion detected

**Current handling**: Silently fails. Commitment stays pending.

**Impact**: User frustration. "I told it I went for a walk, why is it still asking?"

### Hedge Word False Positives

**The problem**: Downgrade logic is too aggressive.

**Example**:
- "Maybe I could try walking more" → Downgraded to THREAD
- "I might go for a walk, but I'll definitely do 30 minutes exercise" → Both downgraded

**Current handling**: Entire statement classified by presence of hedge words.

**Impact**: Real commitments missed when phrased tentatively.

### Recurrence vs One-Time

**The problem**: "every day" in context doesn't always mean habit.

**Example**:
- "I've been tired every day this week" → Not a habit intention
- Current: Might trigger habit promotion if there's a matching commitment

**Current handling**: Pattern match without semantic context.

**Impact**: Spurious habit creation.

### Entity Variant Fragmentation

**The problem**: ASR variants create separate entities.

**Example**:
- ASR produces "Makesh" in one session, "Mukesh" in another
- Unless "Makesh" is in the canonicalization map, two separate entities exist

**Current handling**: Small manual override map.

**Impact**: Context about "Mukesh" not found when searching for "Makesh".

---

## Where LLM Mediation Would Help

### 1. Semantic Commitment Matching

**Current**: Keyword overlap
**With LLM**: "Did 'I took a stroll around the block' complete 'Go for a walk'? Yes/No"

**Benefit**: Handle synonyms, paraphrases, indirect references.

**Cost**: ~500ms latency per match attempt. Could batch multiple commitments.

**Implementation path**:
- Add optional `FEATURE_LLM_COMPLETION_MATCH`
- Call small/fast model for yes/no judgment
- Fall back to keyword if LLM unavailable/slow

### 2. Commitment Disambiguation

**Current**: If multiple commitments, best keyword match wins (or no match if tie)
**With LLM**: "Which of these commitments does 'I finished it' refer to? [A, B, C, None]"

**Benefit**: Resolve "I did it" when multiple commitments pending.

**Cost**: Additional LLM call when ambiguous.

**Implementation path**:
- Only invoke when keyword match is ambiguous (score < 1 and multiple candidates)
- Present top candidates to LLM for selection

### 3. Negative/Dismissal Detection

**Current**: No handling
**With LLM**: "Is the user saying they won't do the commitment, or just discussing it?"

**Benefit**: Handle "never mind", "I decided not to", "I couldn't make it".

**Cost**: Additional LLM call, risk of misclassification.

**Implementation path**:
- Detect negative language patterns first (deterministic)
- Confirm with LLM before marking dismissed

### 4. Entity Canonicalization

**Current**: Manual override map
**With LLM**: "Are 'Makesh' and 'Mukesh' the same person based on context?"

**Benefit**: Automatic handling of ASR variants.

**Cost**: Would need context to judge. Complex to implement well.

**Implementation path**:
- When new entity created, check for similar existing entities
- If found, ask LLM to confirm merge

### 5. Importance Inference

**Current**: Default importance=1, manually set for pinned
**With LLM**: "How important is this fact? [0-3]"

**Benefit**: Critical facts automatically prioritized.

**Cost**: Already done in Shadow Judge extraction, but often ignored.

**Implementation path**:
- Trust Shadow Judge importance scores more
- Adjust retrieval ranking to weight importance higher

---

## Boundary Philosophy

### Current Philosophy

**"LLM for generation and extraction, determinism for classification and matching"**

The system uses LLMs where:
- Understanding natural language semantics is required
- Quality of output is more important than speed
- The task is creative or synthetic (generation, summarization)

The system uses determinism where:
- Speed is critical (user-facing or high-frequency)
- Patterns are predictable and enumerable
- Transparency and debuggability matter
- Cost would compound with volume

### Tension: Accuracy vs Latency

The biggest tension is in commitment matching. Keyword matching is fast but inaccurate. LLM matching is accurate but slow.

**Current resolution**: Accept lower accuracy for speed. Users will adapt their language or the system will miss some completions.

**Alternative resolution**: Hybrid approach—deterministic first pass, LLM second pass for ambiguous cases. Adds complexity but improves both metrics.

---

## Summary Table

| Operation | Current | Ideal | Gap |
|-----------|---------|-------|-----|
| Memory extraction | LLM | LLM | None |
| Commitment detection | LLM | LLM | None |
| Completion matching | Keyword | Semantic | Synonyms missed |
| Habit promotion | Keyword | Semantic | Context ignored |
| Entity deduplication | Manual map | Auto + LLM | Variants fragment |
| Summarization | LLM | LLM | None |
| Disambiguation | None | LLM | Ties unresolved |
| Negative detection | None | LLM | Not handled |
| Importance scoring | LLM (ignored) | LLM (weighted) | Underutilized |
