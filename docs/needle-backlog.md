# Needle Backlog (Decision Sheet)

Last updated: 2026-02-15

## Why this exists
Use this file to decide what to do next based on measurable impact, not just urgency.

## Scoring rubric
- Impact: `1-5` (effect on user experience, retention, or revenue)
- Confidence: `1-5` (how sure we are this will work)
- Effort: `1-5` (engineering cost; higher = harder)
- Priority score: `Impact * Confidence / Effort`

## Success metrics (global)
- `/api/chat` latency: lower `p50` and `p95`
- Reply reliability: fewer failed/timeout turns
- Product velocity: fewer regressions per change
- Tooling readiness: safe tool-calling rollout

## Prioritized backlog
| # | Item | User benefit | Metric impact | Impact | Confidence | Effort | Score | Risk | Dependencies | Decision | Owner | Target date |
|---|---|---|---|---:|---:|---:|---:|---|---|---|---|---|
| 1 | Enforce latency budgets + degradation policy in `/api/chat` | Faster replies under load | `p50/p95 total_ms` | 5 | 4 | 2 | 10.0 | Medium | Existing timing spans | Do now | TBD | TBD |
| 2 | PromptCompiler extraction (typed modules for system/context/overlays) | More stable behavior as complexity grows | Regression rate, cycle time | 5 | 4 | 3 | 6.7 | Medium | Current route logic | Do now | TBD | TBD |
| 3 | Tool-calling foundation (registry, schema validation, limits) | Enables useful actions safely | Tool success rate, timeout rate | 5 | 4 | 3 | 6.7 | High | PromptCompiler, policy rules | Do now | TBD | TBD |
| 4 | Observability dashboard for stage timings/model/overlay decisions | Clear bottleneck visibility | MTTR, deployment confidence | 4 | 4 | 2 | 8.0 | Low | Existing `[chat.trace]` | Do now | TBD | TBD |
| 5 | Librarian budget tuning from production traces | Better speed/quality balance | librarian_ms, recall hit rate | 4 | 3 | 2 | 6.0 | Medium | Item #4 | Do now | TBD | TBD |
| 6 | Background envelope generation path (not hot path) | Better voice UX with low latency risk | UI quality, total_ms stability | 3 | 3 | 3 | 3.0 | Medium | Storage/keying by audio URL | Later | TBD | TBD |
| 7 | Overlay quality eval set (intent/risk/trigger accuracy) | Better conversational quality | False trigger/skip rates | 4 | 3 | 3 | 4.0 | Medium | Test fixtures | Later | TBD | TBD |
| 8 | RN playback sync improvements (audio state + UI coherence) | Cleaner voice interaction feel | Playback failure rate | 3 | 4 | 2 | 6.0 | Low | Frontend repo changes | Later | TBD | TBD |
| 9 | Python sidecar spike (only if hard capability gap appears) | Optional specialist capabilities | N/A exploratory | 2 | 2 | 4 | 1.0 | High | Infra and contracts | Hold | TBD | TBD |
| 10 | Remove/retire legacy paths not needed anymore | Lower maintenance cost | Defect surface area | 3 | 3 | 2 | 4.5 | Low | Team alignment | Later | TBD | TBD |

## 1-week execution cut (recommended)
1. Ship hard latency budgets + degrade rules (item #1).
2. Build trace dashboard view from existing structured logs (item #4).
3. Tune librarian budget with live trace data (item #5).
4. Start PromptCompiler extraction in small slices (item #2).

## Implementation tickets (top 3)

### Ticket 1: Latency budget enforcement in `/api/chat` (P0)
**Outcome**
- Prevent long-tail stalls while preserving response quality defaults.

**Scope**
- Add explicit per-stage budget constants and guard behavior in `src/app/api/chat/route.ts`.
- Keep product behavior unchanged: still return `response + audioUrl` in one payload.
- Degrade only optional context/reflex paths when budget is exhausted.

**Acceptance criteria**
- `pnpm test` stays green.
- No additional LLM calls introduced.
- `/api/chat` still returns `response`, `audioUrl`, `timing`, `requestId`.
- New logs show budget-hit reasons in `[chat.trace]` for degraded turns.
- Under synthetic slow librarian conditions, request still returns successfully.

**Success metric**
- Reduce `/api/chat` `p95 total_ms` by at least 10% from current baseline.

---

### Ticket 2: Trace dashboard from existing structured logs (P0)
**Outcome**
- Fast visibility into where latency is spent and why turns degrade.

**Scope**
- Build a lightweight dashboard/query view using existing `[chat.trace]` payload fields:
  - `timings.*`
  - `chosenModel`, `risk_level`, `intent`
  - `overlaySelected`, `overlaySkipReason`
- No schema changes required.

**Acceptance criteria**
- Can filter by persona, session, and time range.
- Can plot p50/p95 for `total_ms`, `llm_ms`, `tts_ms`, `librarian_ms`, `db_write_ms`.
- Can list top reasons for overlay skips and budget guardrails.
- Documentation includes where logs are emitted and how to query them.

**Success metric**
- Time to identify top bottleneck from a latency incident < 10 minutes.

---

### Ticket 3: Librarian budget tuning via live traces (P0)
**Outcome**
- Better speed/quality tradeoff with deterministic guardrails.

**Scope**
- Tune only budget thresholds/timeouts, not decision semantics.
- Use production trace slices to evaluate:
  - recall quality hit rate
  - librarian timeout/degrade rate
  - net latency impact

**Acceptance criteria**
- One tuning pass documented (before/after numbers).
- Recall regressions are within agreed tolerance.
- `p50/p95 librarian_ms` decreases measurably.
- Existing librarian/overlay tests remain green.

**Success metric**
- `librarian_ms p95` reduced by 15%+ while preserving accepted recall quality.

## Optional ticket templates (next)

### Ticket 4: PromptCompiler extraction (P1)
**Outcome**
- Route logic becomes simpler, safer, and easier to evolve.

**Scope**
- Create compiler module(s) that assemble prompt blocks deterministically from typed inputs.
- Move prompt assembly concerns out of `src/app/api/chat/route.ts`.
- Keep final composed prompt behavior unchanged for baseline cases.

**Acceptance criteria**
- Compiler has clear input/output types and unit tests.
- Existing overlay injection order tests remain green.
- No increase in LLM call count.
- Route file shrinks in responsibility (orchestration only).

**Success metric**
- Reduce prompt-related regression incidents by 30% over next 2 releases.

---

### Ticket 5: Tool-calling foundation (P1)
**Outcome**
- Safe, controlled rollout path for tools without destabilizing chat.

**Scope**
- Implement tool registry with:
  - typed schemas
  - allowlist per persona/intent
  - max tool steps per turn
  - per-tool timeout budget
  - deterministic fallback when tool fails
- Keep tool execution optional and bounded.

**Acceptance criteria**
- End-to-end path supports at least 1 simple internal tool.
- Tool timeout/failure does not break response generation.
- Logs include tool attempts/outcomes with request id.
- No blocking changes to current overlay/risk behavior.

**Success metric**
- >95% successful tool-assisted turns within timeout budget on staging.

---

### Ticket 6: Overlay quality evaluation set (P1)
**Outcome**
- Better confidence that overlay triggers/skips match intent/risk policy.

**Scope**
- Build representative test fixture set for:
  - curiosity vs conflict precedence
  - momentum/daily focus cases
  - urgent/output-task skips
- Add expected overlay decision snapshots.

**Acceptance criteria**
- At least 30 labeled scenarios covering normal + edge cases.
- CI test reports scenario pass/fail clearly.
- Changes to overlay policy require fixture updates (intentionality gate).

**Success metric**
- Cut overlay misfire reports by 40% after policy updates.

## Decision log
Use this section to record what changed and why.

- 2026-02-15: Initial prioritized backlog added.
- 2026-02-15: Added concrete P0 execution tickets with acceptance criteria and metrics.
