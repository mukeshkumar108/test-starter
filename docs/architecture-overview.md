# Architecture Overview

## What This System Is

This is a **voice-first conversational companion** with persistent memory and cognitive tracking. It is not a generic chatbot—it maintains an evolving model of who the user is, what they care about, and what they've committed to doing.

The system is designed for **ongoing relationship**, not one-shot Q&A. Each conversation builds on previous ones. The assistant remembers facts about the user, tracks their commitments, notices patterns in their behavior, and surfaces relevant context at the right moments.

## The Problem It Solves

Traditional voice assistants are stateless. Every conversation starts from zero. Users must re-explain context, re-state preferences, and manually track their own commitments.

This system solves that by:

1. **Remembering who you are**: Facts about your life, relationships, projects, and preferences persist across sessions
2. **Tracking what you said you'd do**: Commitments and habits are extracted automatically and surfaced when relevant
3. **Noticing patterns**: Repeated frictions or struggles are identified and remembered
4. **Maintaining conversational continuity**: Summaries bridge sessions so conversations can resume naturally

## Mental Model

Think of this system as having three layers:

### Layer 1: The Conversation (Ephemeral)
What's happening right now. The current exchange, recent messages, real-time context (time, weather). This is fast and responsive.

### Layer 2: The Session (Short-term)
The current conversation block. Tracked from first message until 30 minutes of inactivity. Summarized when it ends. Rolling summaries update every few turns to maintain continuity within a session.

### Layer 3: The Memory (Long-term)
Everything the system has learned about the user. Facts (profile, people, projects), commitments, habits, patterns. This persists indefinitely and informs every future conversation.

## What Makes This Different

| Generic Chatbot | This System |
|-----------------|-------------|
| Stateless | Persistent memory across sessions |
| No tracking | Extracts and tracks commitments automatically |
| Single persona | Multiple personas with shared/isolated context |
| No structure | Structured cognitive model (facts, loops, frictions) |
| Context = recent messages | Context = curated blend of memory, summaries, todos |

## Personas

The system supports multiple **personas**—different conversational identities that share the same underlying user memory but maintain separate:
- Session history
- Commitments and todos
- Conversational style (different prompts, voice, token limits)

This enables use cases like having a "coach" persona and a "companion" persona that both know who you are but behave differently.

## Guarantees the System Makes

1. **Responsiveness**: The user gets a response in 3-7 seconds. Memory extraction and todo processing happen asynchronously—they never block the response.

2. **Durability**: Extracted memories and commitments are persisted to a database. They survive server restarts and session boundaries.

3. **Scoped isolation**: Todos and sessions are persona-scoped. Memories are global but retrieved per-persona. Cross-persona contamination is prevented.

4. **No silent failures**: Async processes (summarization, extraction) have timeout guards. Failures are logged but don't crash the system.

## Guarantees the System Does NOT Make

1. **Perfect extraction**: The LLM-based extraction is probabilistic. It may miss important facts or misclassify commitments. There is no human-in-the-loop verification.

2. **Deterministic matching**: Commitment completion relies on keyword matching. "I did my walk" will match "Go for a walk" but may not match "Take a stroll around the block."

3. **Bounded memory**: There is no automatic forgetting. Over time, the memory pool grows. Retrieval remains efficient (vector search), but context budget limits what can be surfaced.

4. **Real-time accuracy**: The system does not have internet access or live data. Weather context is placeholder. Time is server time, not necessarily user time.

## Key Architectural Decisions

### Why async extraction?
LLM-based memory extraction takes 2-5 seconds. Making the user wait would destroy the voice experience. Running it async means the user gets a fast response, and the system learns in the background.

### Why multiple summary layers?
Different timescales need different summaries:
- **Rolling summary**: Updates every 4 turns. Keeps the current session's context fresh.
- **Session summary**: Generated when a session closes. Bridges conversations across time gaps.
- **Summary spine**: Long-term tracking across 20+ messages. Captures durable facts.

### Why persona-scoped todos but global memories?
Facts about you ("I live in Austin", "My cofounder is John") are true regardless of which persona you're talking to. But commitments ("I'll go for a walk tomorrow") are contextual—made to a specific persona in a specific conversation.

### Why keyword matching for completion?
LLM-based matching would be more accurate but adds latency and cost. Keyword matching is instant and good enough for common cases. The tradeoff is explicit: lower accuracy, higher speed.

## System Boundaries

This system is the **conversational intelligence layer**. It sits between:

- **Upstream**: Speech-to-text (STT), authentication, client apps
- **Downstream**: Text-to-speech (TTS), LLM providers (OpenRouter), database (PostgreSQL + pgvector)

It does not handle:
- User account management (delegated to Clerk)
- Audio processing (delegated to LemonFox for STT, ElevenLabs for TTS)
- Model hosting (uses OpenRouter as LLM gateway)
