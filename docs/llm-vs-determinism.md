# LLM vs Determinism (Great Simplification)

## Current Philosophy
We bias toward **LLM judgment** over brittle deterministic filters. Human language is messy; tiny LLM calls are cheaper than weeks of regex‑based edge cases.

## What This Means Now
- Memory extraction happens in Synapse on full sessions
- The orchestrator stays thin and predictable
- Deterministic logic is reserved for **session boundaries** and **prompt assembly order**

## What We Avoid
- Keyword‑based memory triggers
- Hard‑coded entity parsing in the app layer

## Where Determinism Still Matters
- Session timeout: 5 minutes from last user message (configurable)
- Prompt block order and caps
- Feature flags for safety
