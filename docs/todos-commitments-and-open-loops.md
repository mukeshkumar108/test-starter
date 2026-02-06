# Todos, Commitments, and Open Loops (Great Simplification)

## Current Source of Truth
In the Great Simplification model, **Synapse** is the source of long‑term memory, including active loops (tensions, commitments, frictions).

These are surfaced in the prompt via the **SITUATIONAL_CONTEXT** block, not via local Todo tables.

## Legacy Local Loops
The local Shadow Judge pipeline can still generate Todos and loops, but it is **feature‑flagged** and should be treated as legacy:
- `FEATURE_SHADOW_JUDGE=true` enables it
- Otherwise, loops should come from Synapse only

## Why This Change
- Synapse has the full episodic context
- Bookend memory avoids partial, per‑turn extraction errors
- Local deterministic filters were brittle and are no longer the default
