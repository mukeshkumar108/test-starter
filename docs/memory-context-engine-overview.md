# Memory & Context Engine — Overview (Great Simplification)

## Purpose
- Keep the LLM prompt small and relevant
- Move long‑term memory out of Prisma and into Synapse/Graphiti
- Use local working memory only for the active session

---

## High‑Level Flow
Sync path (blocks response):
- STT → `buildContext()` → LLM → TTS → store messages

Async path (never blocks response):
- On session close → Synapse `/session/ingest`

---

## Context Builder (Current)
`buildContext()` now returns a minimal structure:
- `persona` (prompt file)
- `situationalContext` (from Synapse `/session/startbrief`, fallback `/session/brief`)
- `rollingSummary` (rolling summary of older messages; updates every 4 turns)
- Rolling summary is cleared on new session creation to avoid cross‑session drift
- `recentMessages` (last 8 messages)

Supplemental recall (Recall Sheet) is added in `/api/chat` after the brief if the Librarian Reflex (triage → optional router → spec → relevance) triggers a `/memory/query`.
Recall Sheet is compact by default (top 3 facts + top 3 entities).

Conversation posture (mode + pressure) uses:
- TRIAGE for pressure/risk/runway
- ROUTER for posture (when allowed by safety + budget)
- fallback posture when router is skipped/fails

Hysteresis is stored in `SessionState.state.postureState` and can reset after long gaps.

User state (mood + energy + tone) comes from router output when available and influences runtime guidance.

Probing tactics are now conservative:
- model-driven rupture cooldown
- soft cooldown when `harm_if_wrong=HIGH` and capacity is not high
- eligibility gating applies to fresh selection and continuation.

No Prisma‑based long‑term memory queries are used in this mode.

---

## Session Lifecycle
- Active window is **5 minutes** based on last user message (configurable)
- Session close is the moment we send a full transcript to Synapse

---

## Legacy Systems (Feature‑Flagged)
These still exist but are off by default:
- Shadow Judge (local memory + todo extraction)
- Session summaries / summary spine
- Local memory vector search

---

## Debug Signals
- `[context.synapse]` when Synapse brief is unavailable
- `[synapse.ingest]` when session ingest fires
- `[session.summary]` (legacy)
 - `[llm.primary.timeout]` / `[llm.primary.error]` / `[llm.fallback.used]` / `[llm.emergency.used]`
