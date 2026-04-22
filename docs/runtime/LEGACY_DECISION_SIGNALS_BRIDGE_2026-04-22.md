# Legacy Decision Signals Bridge (2026-04-22)

## Purpose

`legacyDecisionSignals` is a temporary migration bridge from the live `/api/chat` route into the vNext `TurnEvent` boundary.

It packages decision outputs that the legacy route has already computed so vNext can inspect and compare them without executing `handleUserTurn` in production.

## Where It Runs

The bridge runs only inside the disabled vNext preparation path:

- flag: `FEATURE_CHAT_VNEXT_PREPARE_EVENT=true`
- trace output also requires existing context debug flow

It does not change external API behavior and does not call vNext generation.

## Current Fields

Currently mapped when available:

- `riskLevel`
- `intent`
- `pressure`
- `posture`
- `stanceSelected` except `clarity`
- `moment`
- `isDirectRequest`
- `isUrgent`
- `memoryQueryEligible`
- `modelTier`
- `routeSafetyOverride`
- `confidence`
- `reasons`

## Intentionally Missing

These are not bridged yet:

- tool choice beyond an explicit `toolNeed` placeholder
- overlay/cooldown/hysteresis state
- retrieval plan details
- packet composition details
- generated response metadata
- writeback instructions

## Notes

- This bridge adapts existing route outputs; it must not invent new heuristics.
- `clarity` is intentionally omitted from generic `stanceSelected` until that policy domain migrates.
- This file describes migration instrumentation, not final runtime architecture.

