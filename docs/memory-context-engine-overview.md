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
- `situationalContext` (from Synapse `/session/brief`)
- `rollingSummary` (optional, local)
- `recentMessages` (last 6 turns)

Supplemental recall (Recall Sheet) is added in `/api/chat` after the brief if the Librarian Reflex triggers a `/memory/query`.

No Prisma‑based long‑term memory queries are used in this mode.

---

## Session Lifecycle
- Active window is **15 minutes** based on last user message
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
