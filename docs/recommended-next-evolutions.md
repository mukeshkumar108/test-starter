# Recommended Next Evolutions (Post‑Simplification)

1. **Rolling summary in‑session**
Keep last 8 messages + rolling summary to stabilize long conversations without bloating tokens.

2. **Query‑aware session brief**
Let `/session/brief` accept query hints so Synapse can surface targeted memory.

3. **Brief caching**
Cache session briefs for a few minutes to reduce repeated calls on fast turn‑taking.

4. **Tool orchestration**
Add tool calls (calendar, gmail) behind a clean router layer once memory is stable.

5. **Session end heuristics**
Add explicit “goodbye” detection or user intent to close sessions sooner.
