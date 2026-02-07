# Production Readiness Snapshot

This is a living checklist based on the latest audit. It tracks what we have done and what is still pending.

## Done (Recent)
- Safe LLM fallback chain (OpenRouter primary → OpenRouter fallback → OpenAI emergency)
- Librarian gate/spec/relevance flow with timeouts
- Rolling summary every 4 turns from older messages
- Rolling summary cleared on new session creation (prevents cross‑session drift)
- Session boundary is based on last user message (default 5 minutes, configurable)
- Admin read endpoints for traces and messages (guarded by `ADMIN_API_KEY`)
- Synapse session ingest trace logging with 24h failure count

## Still To Do (High Priority)
- Add abortable timeouts to STT and TTS calls
- Make LLM fallback logs include actual model used
- Store `sessionId` on messages to simplify debug and querying
- Add rate limiting to admin endpoints
- Move session ingest to a true background task (`waitUntil`) or queue

## Still To Do (Medium Priority)
- Remove legacy memory pipeline (shadow judge, curator, summary spine)
- Bound or remove Synapse brief cache
- Add structured log helper for consistent request‑level logging
- Add alerting on LLM fallback + Synapse ingest failures

## Notes
- Synapse/Graphiti is the source of truth for long‑term memory.
- Rolling summary is strictly local working memory and never ingested into Synapse.
