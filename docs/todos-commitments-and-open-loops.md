# Todos, Commitments, and Open Loops (Great Simplification)

## Current Source of Truth
In the Great Simplification model, **Synapse** is the source of long‑term memory, including active loops (tensions, commitments, frictions).

These are surfaced through:
- startbrief-v2 ops context (session-start orientation)
- optional `opsSnippetBlock` (deterministic, one sentence)
- optional `SUPPLEMENTAL_CONTEXT` recall sheet (when librarian recall is used)

Note: if `SUPPLEMENTAL_CONTEXT` is present, `opsSnippetBlock` is suppressed to avoid duplication.

## Legacy Local Loops
The local Shadow Judge pipeline can still generate Todos and loops, but it is **feature‑flagged** and should be treated as legacy:
- `FEATURE_SHADOW_JUDGE=true` enables it
- Otherwise, loops should come from Synapse only

## Why This Change
- Synapse has the full episodic context
- Bookend memory avoids partial, per‑turn extraction errors
- Local deterministic filters were brittle and are no longer the default
