# Tests & Validation

This repo uses lightweight `tsx` test files instead of a full test runner.

## Default test command
```
pnpm test
```
Runs `scripts/run-tests.ts`, which executes the core unit/integration checks.

## What `pnpm test` runs
- `src/lib/services/__tests__/synapseClient.test.ts`
- `src/lib/services/session/__tests__/sessionSynapseIngest.test.ts`
- `src/app/api/__tests__/chat.synapse-ingest.test.ts` (per‑turn ingest wiring, optional feature)
- `src/lib/services/memory/__tests__/entityNormalizer.test.ts`
- `src/lib/services/memory/__tests__/queryRouter.synapse.test.ts`
- `src/lib/services/memory/__tests__/contextBuilder.synapse.test.ts`
- `src/lib/services/memory/__tests__/overlaySelector.test.ts`
- `src/lib/llm/__tests__/safeCompletion.strip.test.ts`
- `src/synapse/librarian.test.ts`
- `src/app/api/__tests__/overlayInjection.test.ts`
- `src/app/api/__tests__/memoryQueryNormalization.test.ts`
- `src/app/api/__tests__/correctionGuards.test.ts`

## Optional integration test (hits real Synapse)
```
RUN_INTEGRATION=1 pnpm test
```
Adds:
- `tests/integration/continuity.test.ts`

## Notes
- If you do not want to test per‑turn ingest, remove
  `src/app/api/__tests__/chat.synapse-ingest.test.ts` from `scripts/run-tests.ts`.
- Some tests rely on `SYNAPSE_BASE_URL` being set when integration is enabled.

## Synapse Contract Smoke Check
For a live endpoint contract check (outside unit tests):
```bash
pnpm run check:synapse-contract -- --tenantId=<tenant> --userId=<user> --personaId=<persona> --sessionId=<session>
```
This validates required keys and basic types for:
- `GET /session/startbrief`
- `POST /memory/query`
