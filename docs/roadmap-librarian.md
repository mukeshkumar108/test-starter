# Librarian Roadmap (High-Leverage)

## Quick Wins (1–2 days)
1. Add admin endpoint to fetch recent `LibrarianTrace` rows.
2. Add debug response payload when `x-debug-librarian=1` (gate/spec/query/relevance summary).
3. Normalize query tokens (strip possessives, dedupe, cap to 3–4 keywords).
4. Add explicit recall short-circuit (skip gate, run spec directly).

## Medium Wins (1–2 weeks)
1. Cache `/session/brief` per session for 2–5 minutes.
2. Sort recall sheet by relevance, cap to 3–5 facts.
3. Make thresholds configurable via env (`LIBRARIAN_EXPLICIT_THRESHOLD`, `LIBRARIAN_AMBIENT_THRESHOLD`).
4. Add “goodbye” / “talk later” detection to end sessions early.

## Bigger Wins (2–4 weeks)
1. Latency telemetry for gate/spec/relevance vs main LLM.
2. Unified Memory Router module (typed, tested, reusable).
3. Optional narrative rewriter for recall sheet (feature-flagged).
