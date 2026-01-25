# Recommended Next Evolutions

This document suggests conceptual next steps. No migrations, no refactors, no new infrastructure.

---

## Model Simplifications

### 1. Unify Summary Layers

**Current state**: Four overlapping summary mechanisms (rolling, session, spine, memory folds).

**Recommendation**: Clarify the purpose of each and reduce redundancy.

- **Rolling summary**: Keep. It's the "working memory" of current conversation.
- **Session summary**: Keep. It bridges time gaps with structured recall.
- **Summary spine**: Question its value. If rolling + session summaries work, spine may be redundant.
- **Memory folds**: Keep but scope. Folding should create durable facts, not summaries.

**Conceptual shift**: Summaries are ephemeral context. Memories are durable facts. Don't blur the line.

### 2. Clarify Friction vs Memory

**Current state**: Frictions are Todos that never complete. They're patterns, not tasks.

**Recommendation**: Frictions might belong in Memory, not Todo.

A friction like "I keep getting stuck at the computer" is a fact about the user's patterns. It's closer to PROFILE than to COMMITMENT.

**Conceptual shift**: Todo = things that resolve. Memory = things that persist. Frictions are the latter.

### 3. Collapse WIN into COMMITMENT Lifecycle

**Current state**: Wins are stored as separate Todo records with special dedupeKey prefix.

**Recommendation**: Consider wins as a status, not a separate record.

When a commitment completes, it's already marked COMPLETED. The win record duplicates information. Instead:
- COMMITMENT.status = COMPLETED is the win
- Add COMMITMENT.completedContent for what user actually said ("I took a stroll")

**Conceptual shift**: A win isn't a thing—it's a completed commitment. Track completion details on the original record.

---

## Boundary Clarifications

### 4. Define Persona Privacy Boundary

**Current state**: Memories are global. Todos are persona-scoped. Unclear intent.

**Recommendation**: Make an explicit decision and document it.

**Option A**: Facts are universal. All personas share knowledge. Document this as a feature.

**Option B**: Allow persona-specific memories. Add `personaId` to memory writes when context is sensitive.

Either is valid. The current ambiguity is the problem.

### 5. Define Commitment Scope

**Current state**: Commitments are persona-scoped, but there's no way to make cross-persona commitments.

**Recommendation**: Decide if this is correct.

If user tells Coach persona "I'll exercise daily" and then talks to Companion persona, should Companion know about the commitment?

**Option A**: No. Commitments are conversations, not facts. Keep scoped.

**Option B**: Yes. Important commitments should be visible everywhere. Add global commitment option.

Document the decision either way.

### 6. Separate Extraction from Classification

**Current state**: Shadow Judge does both—extracts content AND classifies it (COMMITMENT vs HABIT vs THREAD).

**Recommendation**: Consider a cleaner separation.

Shadow Judge extracts: "User intends to walk daily."
A classifier (LLM or rule-based) then decides: "This is a HABIT, not a COMMITMENT."

**Benefit**: Easier to tune classification without changing extraction. Can A/B test classifiers.

---

## Complexity Reduction

### 7. Remove Unused TodoKinds

**Current state**: Schema has OPEN_LOOP and REMINDER in TodoKind, but they're not used in the codebase.

**Recommendation**: Remove them from the prompt and documentation. Don't let dead concepts confuse future work.

### 8. Simplify Entity Card Logic

**Current state**: Entity cards have complex SQL with multiple conditions (importance >= 2 OR pinned, sorted by 3 fields).

**Recommendation**: Consider a simpler mental model.

"Entity cards show the top 3 most important facts about entities mentioned in your query."

Implementation can still be sophisticated, but the concept should be simple to explain.

### 9. Make Budget Configurable

**Current state**: 1200 token budget is hardcoded. Drop order is hardcoded.

**Recommendation**: Make these values live in PersonaProfile or a config table.

Not for users to tweak, but for engineers to experiment. Different personas might need different budgets (Sophie already has different max_tokens).

---

## LLM Mediation Opportunities

### 10. Add LLM Fallback for Commitment Matching

**Current state**: Keyword matching only. Semantic gaps cause missed completions.

**Recommendation**: Add an optional LLM verification step.

When keyword matching fails (score < 1 and multiple candidates), ask a small LLM:
"Did the user complete any of these commitments? [list] Based on: [user message]"

**Key constraint**: Only invoke when ambiguous. Don't add latency to clear matches.

### 11. Add LLM for Disambiguation

**Current state**: "I did it" with multiple pending commitments → no match.

**Recommendation**: When user says something ambiguous, ask LLM to resolve.

Could be in the async path (resolve and mark complete after response).
Could be in the sync path (ask user for clarification in response).

### 12. Consider LLM for Entity Canonicalization

**Current state**: Manual override map for ASR variants.

**Recommendation**: When a new entity is created, check if it might be a variant of existing.

"Is 'Makesh' the same person as 'Mukesh' based on context?"

**Key constraint**: Only when evidence suggests possible match. Don't slow down every memory write.

---

## What to Delay or Avoid

### Avoid: Building a Task Manager UI

The system is not a task manager. Building UI for "manage your commitments" would encourage the wrong mental model.

The power is in the assistant naturally surfacing relevant context—not in users manually checking off tasks.

### Avoid: Adding More Summary Layers

The system already has four. Each new layer adds complexity and budget competition.

Before adding another, demonstrate that existing layers are insufficient and can't be improved.

### Avoid: Real-Time Integrations

Calendar sync, location awareness, smart home integration—these add complexity and privacy concerns without clear ROI.

The system's value is conversational intelligence, not automation.

### Delay: Forgetting / Decay

Eventually the system needs to forget old, irrelevant information. But this is hard to do well.

Premature forgetting destroys value. Aggressive decay loses important context.

Delay until there's clear signal that memory bloat is causing retrieval problems.

### Delay: User Feedback Loops

"Did you mean to commit to X?" / "Is this correct?" feedback flows are valuable but complex.

They interrupt conversation flow. They require UI. They create expectation of control.

Build this when there's evidence that extraction quality is a top user complaint.

### Delay: Multi-Model Orchestration

Using different models for different tasks (fast model for matching, smart model for extraction) is architecturally elegant but operationally complex.

Current single-model approach is simpler to maintain and debug.

---

## Priority Order

If I had to sequence these, the highest-value changes are:

1. **LLM fallback for commitment matching** — Directly addresses the biggest UX gap
2. **Clarify persona privacy boundary** — Prevents future architectural confusion
3. **Collapse WIN into COMMITMENT** — Simplifies model without losing functionality
4. **Make budget configurable** — Enables experimentation without code changes
5. **Unify summary layers** — Reduces redundancy, saves context budget

The rest are valuable but lower urgency. They clarify rather than fix.

---

## Closing Thought

This system has a strong foundation. The core insight—that conversational companions need persistent memory and cognitive tracking—is correct and differentiated.

The gaps are at the edges: matching accuracy, model clarity, configuration flexibility. These are refinements, not rearchitecture.

The biggest risk is over-building. Adding features before the core is solid. The recommended path is:
1. Clarify what exists
2. Simplify where possible
3. Add intelligence where it directly improves UX
4. Resist the urge to add more

The system is already doing something hard. Make it do that thing better before making it do more things.
