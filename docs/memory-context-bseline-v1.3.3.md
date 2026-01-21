Memory & Context Engine — Baseline v1.3.3 (Production Snapshot)
===============================================================

1) Purpose
----------

This engine composes per-turn context for the voice assistant and persists durable user facts and commitments. It keeps responses grounded with memory, commitments, and summaries while protecting the sync chat path from non-critical work.

2) High-Level Flow
------------------

*   **Sync path (blocks response)**
    
    *   STT → buildContext → LLM → TTS → response
        
    *   Context assembly includes memories, todos, summaries, and recent messages
        
*   **Async path (never blocks)**
    
    *   Shadow Judge: extracts memories + todos, updates session state, summary spine
        
    *   Session Summary: generated on session close via non-blocking async call
        

3) Prompt Assembly (exact order)
--------------------------------

1.  **\[REAL-TIME CONTEXT\]**
    
    *   Source: route.ts → getCurrentContext
        
    *   Max: derived string (no truncation)
        
    *   Required: yes
        
2.  **\[SESSION STATE\]**
    
    *   Source: route.ts → getSessionContext (from contextBuilder.ts)
        
    *   Max: derived string
        
    *   Required: optional
        
3.  **Persona Prompt**
    
    *   Source: contextBuilder.ts (file read via persona.promptPath)
        
    *   Max: file contents
        
    *   Required: yes
        
4.  **\[FOUNDATION MEMORIES\]**
    
    *   Source: contextBuilder.ts
        
    *   Max: 12 entries
        
    *   Required: optional
        
    *   Notes: Seeded (metadata.source="seeded\_profile") sorted first, then createdAt asc
        
5.  **\[RELEVANT MEMORIES\]**
    
    *   Source: memoryStore.ts → searchMemories, filtered in contextBuilder.ts
        
    *   Max: 8 entries
        
    *   Required: optional
        
    *   Notes: PROFILE/PEOPLE/PROJECT only; deduped vs Foundation by normalized content
        
6.  **OPEN LOOPS (pending)**
    
    *   Source: contextBuilder.ts (Todo PENDING)
        
    *   Max: 5 entries
        
    *   Required: optional
        
    *   Notes: content-deduped by normalized text
        
7.  **Recent wins**
    
    *   Source: contextBuilder.ts (Todo COMPLETED, last 48h)
        
    *   Max: 3 entries
        
    *   Required: optional
        
8.  **User context**
    
    *   Source: contextBuilder.ts (UserSeed)
        
    *   Max: 800 chars
        
    *   Required: optional
        
9.  **Conversation summary**
    
    *   Source: contextBuilder.ts (SummarySpine)
        
    *   Max: 1200 chars
        
    *   Required: optional
        
10.  **LATEST SESSION SUMMARY**
    
    *   Source: contextBuilder.ts (SessionSummary)
        
    *   Max: 600 chars
        
    *   Required: optional
        
    *   Notes: JSON formatted into a compact human-readable string
        
11.  **Recent message history**
    
    *   Source: contextBuilder.ts (Message table)
        
    *   Max: last 10 messages, each capped at 800 chars
        
    *   Required: yes
        
12.  **User turn**
    

*   Source: route.ts
    
*   Max: raw transcript
    
*   Required: yes
    

Soft warning: if total prompt chars > 20,000, logs \[chat.prompt.warn\] with sizes and counts (no truncation).

4) Memory Writes (what gets stored)
-----------------------------------

*   **Memory**
    
    *   Writer: shadowJudge.ts (async)
        
    *   When: after each assistant response
        
    *   What: PROFILE / PEOPLE / PROJECT only
        
    *   Never written: OPEN\_LOOP (explicitly filtered out)
        
*   **Todo**
    
    *   Writer: shadowJudge.ts (async)
        
    *   When: after memory extraction
        
    *   What: OPEN\_LOOP items become PENDING todos
        
*   **Session**
    
    *   Writer: sessionService.ts (ensureActiveSession, closeStaleSessionIfAny)
        
    *   When: each chat turn
        
    *   What: session lifecycle + turnCount
        
*   **SessionSummary**
    
    *   Writer: sessionService.ts → sessionSummarizer.ts (async, fire-and-forget)
        
    *   When: session closes due to inactivity
        
    *   What: JSON summary string stored in SessionSummary.summary with metadata
        

5) Sessions & Summaries
-----------------------

*   **Session definition**: (userId, personaId) active if lastActivityAt >= now - 30m.
    
*   **Session end**: when inactivity exceeds 30m; endedAt set on stale session.
    
*   **Summary creation**: triggered after session close, non-blocking.
    
*   **Why non-blocking**: summary generation uses OpenRouter; it must never delay chat.
    
*   **Model**: MODELS.SUMMARY = "amazon/nova-micro-v1" (cheap, fast); fallback to skip on error or missing key.
    
*   **Timeout**: hard abort at 2500ms (SUMMARY\_TIMEOUT\_MS override).
    

6) Guardrails & Caps
--------------------

*   Foundation memories: 12 entries max, seeded-first ordering.
    
*   Relevant memories: 12 raw, 8 selected max; PROFILE/PEOPLE/PROJECT only; deduped vs Foundation.
    
*   Open loops: 5 max (deduped by normalized content).
    
*   Recent wins: 3 max (last 48h).
    
*   UserSeed: 800 chars.
    
*   SummarySpine: 1200 chars.
    
*   SessionSummary: 600 chars (formatted).
    
*   Recent messages: last 10, each 800 chars max.
    
*   Prompt size warning: logs when > 20,000 chars (no truncation).
    
*   Session summary timeout: 2500ms default (SUMMARY\_TIMEOUT\_MS).
    

7) What This System Does Not Do (Out of Scope)
----------------------------------------------

*   No memory importance decay or pruning.
    
*   No global memory across users.
    
*   No cross-persona memory sharing.
    
*   No automated curator runs (manual/admin only).
    
*   No user scoring or behavioral analytics.
    
*   No automatic completion of todos except the conservative single-todo “done” rule.
    
*   No background cron infrastructure.
    

8) Invariants (must always hold)
--------------------------------

*   OPEN\_LOOP is never stored in Memory.
    
*   Session summarization never blocks chat responses.
    
*   Relevant memories include only PROFILE/PEOPLE/PROJECT.
    
*   Pending todos are deduped and capped at 5.
    
*   Recent messages are capped and never exceed 10 entries.
    
*   Session summaries are optional and injected only if present.
    
*   Prompt size warnings do not alter or truncate content.