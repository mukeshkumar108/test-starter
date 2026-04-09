# Memory Recall Diagnosis — 2026-04-09

> **Status: resolved.** Fix shipped same day. See changelog 2026-04-09 (2) and decision log entry "Remove keyword-gated memory prefetch".


## The Symptom

Sophie loops and repeats the current conversation when asked to recall long-term memory. The user explicitly asked multiple times to "access your long-term memory" and "tell me what you know from before" — and Sophie kept repeating facts the user had just said in the same session.

---

## Call Chain (Current State)

```
Voice input
  → STT (sttService.ts)
    → route.ts: buildContext + librarianResult (bypassed on Mastra path)
      → runAssistantTurn (orchestrator/runAssistantTurn.ts)
        → buildChatMessages (composes full prompt incl. conversation history)
          → runMastraTurn (mastra/runMastraTurn.ts)
            → buildPrefetchedSupplementalContext
                → shouldPrefetchMemory(lastUserMessage) → maybe runMemoryLookup()
                → shouldPrefetchWeb(lastUserMessage)   → maybe runWebSearch()
            → createMastraRuntime → createAssistantAgent
            → assistant.generate(messages, { toolChoice: "none", maxSteps: 1 })
              → LLM generates reply (NO live tool calls possible)
        → applyLiteralModeReplyGuard
      → TTS → persistence
```

The key fact: **`toolChoice: "none"` and `maxSteps: 1` are hardcoded in the `assistant.generate` call.** The LLM cannot call any tool during generation under any circumstances.

---

## Root Cause: Three Compounding Problems

### Problem 1: `toolChoice: "none"` kills all live tool calling

**File:** `src/mastra/runMastraTurn.ts` lines 263–279  
**Introduced:** commit `0c25a4c` "Make voice retrieval path single-step and grounded" (Apr 8)

```ts
const result = await assistant.generate(params.messages, {
  maxSteps: 1,
  toolChoice: "none",   // ← LLM cannot call any tool
  model: { ... },
});
```

This was intentional: the architecture shifted from "LLM decides when to use tools" → "we prefetch before the LLM call, then generate in one shot." The idea was to reduce latency and avoid unpredictable multi-step tool chains during voice turns.

**The consequence:** The memory tool and web search tool registered in `createAssistantAgent` (`assistant.ts`) are completely unreachable during generation. The `instructions` in `assistant.ts` that say "Use the memory tool when..." describe behavior that is now **structurally impossible**.

---

### Problem 2: Prefetch keyword detection is too narrow

**File:** `src/mastra/runMastraTurn.ts` — `looksLikeRecallQuestion()`  
**Made narrower:** commit `dc7f052` "Tighten voice web summaries and recall triggers" (Apr 8)

The change replaced the broad pattern `"remember"` with three strict variants:

```ts
// Before (broader — matched "remember" anywhere)
normalized.includes("remember")

// After (much narrower)
normalized.includes("do you remember") ||
normalized.includes("can you remember") ||
normalized.includes("what do you remember")
```

Plus the full list of recall triggers:
```
"do you remember" | "can you remember" | "what do you remember"
"earlier" | "previous" | "what did i"
"who is" | "who was" | "told you" | "mentioned"
"my friend" | "my ex" | "my partner"
```

**User's actual phrases that were NOT detected:**

| User said | Matched? |
|---|---|
| "what do you know about Ashley?" | ❌ |
| "access your long-term memory" | ❌ |
| "tell me what you know from before" | ❌ |
| "what can you recall" | ❌ |
| "check your memory" | ❌ |
| "what is stored in your memory" | ❌ |
| "I have already told you" | ✅ (matches "told you") |

So several of the user's messages DID trigger the prefetch — but see Problem 3 for why that still didn't work.

---

### Problem 3: Even when prefetch runs, the query is often garbage

**File:** `src/mastra/tools/memory.ts` — `buildMemoryLookupCandidates()`

When `looksLikeRecallQuestion` is true, `runMemoryLookup` is called with the raw `lastUserMessage`. That function calls `buildMemoryLookupCandidates(input)` which:

1. Checks named `recallPatterns` (hospital, weather, jasmine, ashley)
2. Checks for specific words (`remember`, `do you know`, `who is`, `who was`, `what changed`, `why`) to extract named entities
3. Falls back to `add(input)` — the full user message sanitized to **first 6 words, max 48 chars**

For the message "Okay, all you're doing is repeating what I have already told you. I have asked you to access your fucking memory..." the sanitized query becomes `"Okay all you re doing is"` — completely meaningless as a Synapse semantic query. Synapse returns zero results.

Ashley is hardcoded as a special case (`/\bashley\b/` in recallPatterns), but the user's request turned was _about_ Ashley in the sense of "what do you know about her" — and the phrase "what do you know about Ashley" does contain "ashley" but the pattern check requires the exact word `ashley` in the `normalized` version, and `buildMemoryLookupCandidates` would generate `"Ashley relationship recent"` etc. However, `looksLikeRecallQuestion` does NOT match "what do you know about Ashley?" so the prefetch is never triggered in the first place.

---

### Problem 4: Fallback instruction contradicts what the model actually sees

When no memory is prefetched, the Mastra instructions say:

> "If the user asks about prior conversations, relationships, or earlier events and no verified memory result is provided, be honest that you cannot verify that memory right now. Do not guess."

**But the model is given the full conversation history** via `buildChatMessages` → `conversationHistoryBlock`. The current session DOES contain the Ashley information (the user just told Sophie about it). So the model does what feels natural: it answers from the conversation context.

From the LLM's perspective it is being truthful — "here's what I know about Ashley from this conversation." It doesn't understand that the user wants long-term Synapse memory, not the current-session echo. The instruction says "don't guess" but the model isn't guessing — it's correctly citing the conversation. The real requirement ("access Synapse long-term memory, not the session") is nowhere stated clearly enough.

---

## What Was Working Before

Before `0c25a4c` (Apr 8), the flow was:
- `toolChoice` was not set to `"none"` (default `"auto"`)
- `maxSteps` was not capped at 1
- The LLM could autonomously call `memoryTool` whenever it judged appropriate
- The agent instructions in `assistant.ts` accurately described available behavior

The shift to prefetch-only was made for voice latency reasons, which is valid. But it broke the memory recall behavior because:
1. The prefetch keyword list is too narrow
2. The LLM no longer has a fallback tool it can call
3. The instructions lie about what the model can do

---

## What Is Good

- The Mastra memory tool (`createMemoryTool`) is correctly registered and well-implemented. The tool schema, description, and `runMemoryLookup` logic are all sound.
- The Synapse `POST /memory/query` integration is correct.
- The prefetch architecture (pre-fetching before generation) is a good latency strategy in principle.
- The `[VERIFIED_MEMORY]` block injection into instructions works correctly when the prefetch succeeds.
- The Ashley-specific and other named recallPatterns in `buildMemoryLookupCandidates` show the right intent.
- `buildRecallSheet` output format is clean and usable.

---

## What Can Be Improved

### Fix A: Broaden `looksLikeRecallQuestion` (low risk, immediate impact)

Add the natural phrases users actually say:

```ts
normalized.includes("what do you know") ||
normalized.includes("what you know about") ||
normalized.includes("your memory") ||
normalized.includes("long-term memory") ||
normalized.includes("from before") ||
normalized.includes("from our") ||
normalized.includes("what have i told") ||
normalized.includes("what has been") ||
normalized.includes("recall") ||
normalized.includes("stored in") ||
normalized.includes("in your memory") ||
normalized.includes("your records") ||
```

This is the lowest-risk, highest-bang fix. Widens the gate so the prefetch fires more reliably.

### Fix B: Fix `buildMemoryLookupCandidates` query extraction

When the input is a long rant, the current fallback of "take first 6 words" is useless. A better approach:
- Extract named entities (capitalized words)
- Extract relationship nouns
- If none found, use a short semantic summary of the user intent (e.g. "relationship status recent history")

The Ashley pattern already does this right:
```ts
{ test: /\bashley\b/, values: ["Ashley relationship recent", "Ashley recent"] }
```

Extend this pattern to activate when "what do you know" or "recall" are present alongside a named entity.

### Fix C: Fix the fallback instruction

The current fallback instruction:
> "If the user asks about prior conversations... be honest that you cannot verify that memory right now. Do not guess."

Is too vague. The model interprets the current session context as valid "memory." Replace with:

> "If the user explicitly asks to retrieve stored long-term memory and no `[VERIFIED_MEMORY]` block is present in this context, say clearly: 'I tried to look up your long-term memory but couldn't retrieve it right now.' Do not use the current session's conversation history as a substitute for long-term memory retrieval."

### Fix D (longer term): Re-enable tool calling for memory-heavy queries

The `toolChoice: "none"` approach works for latency but is too blunt for explicit memory recall requests. A middle ground:

- Keep `toolChoice: "none"` for general turns
- Use `toolChoice: "auto"` (or `"required"`) specifically when `shouldPrefetchMemory` is true AND the prefetch returned no results
- This gives the LLM a second-chance tool call only on confirmed recall queries that didn't prefetch cleanly

This is the most robust fix but adds latency on recall turns.

---

## Summary

| Problem | Root Cause | Impact |
|---|---|---|
| No tool calling during generation | `toolChoice: "none"` hardcoded (commit `0c25a4c`) | LLM can never autonomously call memory |
| Most recall phrases miss the prefetch gate | `looksLikeRecallQuestion` keywords too narrow (commit `dc7f052`) | Prefetch doesn't fire on natural recall language |
| Prefetch fires but queries are garbage | `buildMemoryLookupCandidates` falls back to first-6-words | Synapse gets nonsense queries, returns nothing |
| Sophie loops the current session | Fallback instruction is ambiguous + session history is visible | Model finds Ashley in session history and echoes it |

**Immediate lowest-risk fix:** broaden `looksLikeRecallQuestion` + improve query extraction + clarify the fallback instruction text. No architectural change needed.

**Proper fix:** also restore conditional tool calling for explicit recall turns.
