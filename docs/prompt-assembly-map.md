# Prompt Assembly Map (Great Simplification)

The prompt is intentionally small and ordered.

## Current Order
1. **Persona (Identity Anchor)**
2. **CONVERSATION_POSTURE** (neutral labels; may include momentum guard hints)
3. **STYLE_GUARD** (optional; witness/endearment guardrails)
4. **USER_CONTEXT** (optional; deterministic profile/local lines)
5. **STANCE_OVERLAY** (optional deterministic stance block)
6. **OVERLAY** (optional deterministic tactic module)
7. **bridgeBlock** (optional; turn 1 only when startbrief resume says `use_bridge=true`)
8. **handoverBlock** (optional; startbrief-v2 rules, verbatim text)
9. **opsSnippetBlock** (optional; deterministic gating, one sentence)
10. **SUPPLEMENTAL_CONTEXT** (Recall Sheet from `/memory/query`, optional)
11. **Recent Messages** (last 8 messages, session-scoped)
12. **Current User Message**

## Notes
- On session start, context uses Synapse `/session/startbrief` and stores it in session state for reuse.
- Startbrief-v2 is the sole orientation mechanism in model-facing prompt assembly.
- Legacy orientation blocks are removed from prompt injection:
  - `SITUATIONAL_CONTEXT`
  - `[CONTINUITY]`
  - `SESSION FACTS`
- On session start, context also fetches Synapse `/user/model` once and stores it as deferred profile context (not injected by default).
- On session start, context fetches Synapse `/analysis/daily` once (best-effort). Only high-confidence steering may surface.
- Low-confidence daily analysis (`needs_review|insufficient_data`) is not surfaced as steering text.
- Daily analysis numeric scores and raw quality flags are retained for telemetry/analytics but are not rendered into model-facing prompt lines.
- `/session/brief` is fallback-only when startbrief is unavailable.
- SUPPLEMENTAL_CONTEXT Recall Sheet is capped (`top 3 facts`, `top 3 entities`).
- Overlay procedural nudges use Synapse `/memory/loops` (fallback: startbrief loop items).
- If `SUPPLEMENTAL_CONTEXT` exists on a turn, `opsSnippetBlock` is suppressed to avoid duplication.
- Loop continuity is user-scoped; Sophie does not assume persona-partitioned loop memory.
- Librarian recall uses `/memory/query` in semantic mode (`includeContext=false`).
- Product kernel guidance comes from compiled prompt kernels (no duplicate runtime product block).
- Bouncer authority remap is feature-flagged:
  - `FEATURE_BOUNCER_AUTHORITY_REMAP_V1` toggles effective signal remap for overlay policy/selector inputs.
  - `FEATURE_BOUNCER_AUTHORITY_SHADOW_LOG` controls prompt-packet shadow fields (`gate_confidence`, `posture_confidence`, `state_confidence`, plus raw/effective signal mirrors).
- Chat model routing is tiered per turn (after stance + user-context moment signals):
  - Safety override (unchanged): `risk_level in {HIGH, CRISIS}` -> `MODELS.CHAT.SAFETY`.
  - Non-safety tier mapping:
    - `T1` -> `bytedance-seed/seed-1.6-flash`
    - `T2` -> `google/gemini-2.5-flash`
    - `T3` -> `anthropic/claude-sonnet-4.6`
  - Precedence: `risk > stance > moment > pressure > intent`.
  - T3 is burst-limited in session state:
    - peak events get max 2 T3 turns per stable event id
    - then forced fallback to T2 until a new event id appears
    - event id is stance-dominant (`stance|intent|topicHint`)
  - Prompt-packet trace includes `tierSelected` and `routingReason` in `memoryQuery`.
  - Prompt-packet trace also includes burst metadata:
    - `burstActiveId`, `burstRemainingBefore`, `burstRemainingAfter`, `burstEventId`, `burstWasStarted`.
