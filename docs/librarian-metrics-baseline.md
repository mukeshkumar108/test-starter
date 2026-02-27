# Librarian Metrics Baseline

## Purpose
Measure routing and overlay behavior using trace metadata, then tune thresholds by evidence (not more policy branches).

## Canonical Turn Join
- Join key: `requestId` in `LibrarianTrace`.
- A turn record is built from rows sharing the same `requestId`.
- No timestamp-nearest matching.

## Eligibility Definitions
- `overlay_eligible`:
  - `overlaySkipReason == null`
  - `triage.risk_level != HIGH/CRISIS`
- `probing_eligible`:
  - `triage.capacity == HIGH`
  - `triage.permission != NONE`
  - `triage.tactic_appetite == HIGH`
  - `triage.risk_level == LOW`
  - `triage.pressure != HIGH`
  - `cooldown_turns_remaining == 0`

## Core Metrics (counts first)
- overlay fired / overlay eligible
- probing fired / probing eligible
- regret candidate / probing fired
- cooldown activation / total turns
- router fallback / router runs
- triage failed_parse / total turns
- safe clamp / total turns

Each rate prints:
- numerator
- denominator
- rate
- Wilson 95% CI

## Data Quality Checks
- rows_total
- rows_by_kind
- unique_request_ids_total
- request_ids_with_prompt_packet
- request_ids_with_overlay
- request_ids_with_both
- missing_triage_output
- missing_router_run_reason
- missing_tactic_selected
- missing_cooldown_fields
- missing_veto_reasons
- request_id_with_multiple_userIds
- request_id_with_multiple_sessionIds

## Alert Thresholds (warn-only defaults)
- regret/probing fired `> 0.08`
- cooldown/total turns `> 0.12`
- router fallback/router runs `> 0.02`
- triage failed_parse/total turns `> 0.005`

## CLI
```bash
pnpm tsx scripts/librarian-metrics.ts --days 7 --maxRows 50000 --alert
```

Optional:
- `--since 2026-02-20T00:00:00Z`
- `--minSegmentSize 200`
- `--json`
- `--jsonPath tmp/librarian-metrics.json`
- `--thresholdRegret 0.08`
- `--thresholdCooldown 0.12`
- `--thresholdRouterFallback 0.02`
- `--thresholdTriageParseFallback 0.005`
