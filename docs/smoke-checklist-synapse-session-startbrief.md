# Synapse Session + Startbrief Smoke Checklist

## Scope
- Validate fire-and-forget session ingest failure handling and retry.
- Validate weak-empty `/session/startbrief` rejection and fallback to `/session/brief`.
- Validate librarian trace fields for startbrief quality metadata.

## Preconditions
- Run from repo root.
- No external Synapse dependency required (script uses local overrides/mocks).

## Steps
1. Run `pnpm tsx scripts/smoke-synapse-session-startbrief.ts`.
2. Confirm session close path triggers ingest and writes retry state after first forced non-OK.
3. Confirm retry is attempted on next `ensureActiveSession` and queue is drained.
4. Confirm weak-empty startbrief is rejected and `/session/brief` fallback executes.
5. Confirm librarian trace includes:
   - `startbrief_quality=weak_rejected`
   - `summary_content_quality=none_fetched`

## Pass Criteria
- Script exits `0`.
- Console contains all expected `SMOKE:*` lines listed by the script run instructions.
