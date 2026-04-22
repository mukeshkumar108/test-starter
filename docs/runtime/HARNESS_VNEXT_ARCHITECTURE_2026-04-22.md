# Harness vNext Architecture (2026-04-22)

## Objective
Define a canonical Sophie turn harness that preserves current capabilities while centralizing decision-making and reducing branching complexity.

## Canonical Flow

`normalizeInput`
-> `ensureSession`
-> `decideTurn`
-> `runRetrievalPlan`
-> `composeTurnPacket`
-> `executeTurn`
-> `postProcessTurn`
-> `writebackAndQueue`
-> `synthesizeVoice` (if needed)

## Stage Ownership and Responsibility

## 1) `normalizeInput`
**Owns:** transport normalization only.

- Accepts voice/text/image/pdf/attachment envelopes.
- Produces one `TurnEvent` shape.
- No policy/routing decisions.

## 2) `ensureSession`
**Owns:** session lifecycle only.

- Resolve active session.
- Close stale session.
- Increment turn counters.
- Return session metadata needed by downstream stages.

## 3) `decideTurn`
**Owns:** single turn-control policy decision.

- Risk/sensitivity classification.
- Memory/tool/model requirements.
- Behavioral mode selection.
- Output mode selection (text-only vs text+voice).

This is the canonical control plane.

## 4) `runRetrievalPlan`
**Owns:** executing retrievals implied by decision.

- Context retrieval in parallel.
- Memory fetch (when requested).
- External/tool prefetch (when requested).
- Returns normalized retrieval artifacts.

## 5) `composeTurnPacket`
**Owns:** packet assembly only.

- Deterministically composes all model-facing context.
- No hidden gating; all gating comes from `TurnDecision`.

## 6) `executeTurn`
**Owns:** model/tool execution path.

- Single orchestration spine.
- Backend adapters allowed (direct model, Mastra tool runtime).
- Produces typed `TurnResult`.

## 7) `postProcessTurn`
**Owns:** output checks and actionable writeback intents.

- Safety and contradiction checks.
- Commitment extraction or corrections.
- Post-generation policy adjustments.

## 8) `writebackAndQueue`
**Owns:** persistence and async jobs.

- Persist user/assistant turns.
- Persist state updates.
- Queue async maintenance jobs.

## 9) `synthesizeVoice`
**Owns:** audio generation only when output mode requires voice.

- Runs after final text is stable.

## Proposed Module/File Map

Target folder scaffold (vNext side-by-side with existing runtime):

- `src/lib/runtime/vnext/handleUserTurn.ts`
- `src/lib/runtime/vnext/contracts.ts`
- `src/lib/runtime/vnext/normalizeInput.ts`
- `src/lib/runtime/vnext/ensureSession.ts`
- `src/lib/runtime/vnext/decideTurn.ts`
- `src/lib/runtime/vnext/runRetrievalPlan.ts`
- `src/lib/runtime/vnext/composeTurnPacket.ts`
- `src/lib/runtime/vnext/executeTurn.ts`
- `src/lib/runtime/vnext/postProcessTurn.ts`
- `src/lib/runtime/vnext/writebackAndQueue.ts`
- `src/lib/runtime/vnext/synthesizeVoice.ts`
- `src/lib/runtime/vnext/adapters/contextAdapter.ts`
- `src/lib/runtime/vnext/adapters/memoryAdapter.ts`
- `src/lib/runtime/vnext/adapters/modelAdapter.ts`
- `src/lib/runtime/vnext/adapters/toolAdapter.ts`
- `src/lib/runtime/vnext/adapters/mastraAdapter.ts`
- `src/lib/runtime/vnext/adapters/synapseAdapter.ts`

Boundary route target (thin over time):

- `src/app/api/chat/route.ts` should delegate to `handleUserTurn` and remain transport/auth-centric.

## Core Contracts (Typed)

Note: field names are draft contracts intended for migration; they should be finalized before implementation.

```ts
export type TurnEvent = {
  requestId: string;
  userId: string;
  personaId: string;
  input: {
    modality: "voice" | "text" | "multimodal";
    text?: string | null;
    audio?: { mimeType: string; bytes: number } | null;
    attachments?: Array<{ id: string; kind: "pdf" | "image" | "file"; mimeType: string; size: number }>;
  };
  client: {
    timezone?: string | null;
    locale?: string | null;
    platform?: string | null;
  };
  debug?: {
    context?: boolean;
    prompt?: boolean;
    trace?: boolean;
  };
  nowIso: string;
};

export type TurnDecision = {
  riskLevel: "LOW" | "MED" | "HIGH" | "CRISIS";
  intent: "companion" | "momentum" | "output_task" | "learning";
  mode: "direct" | "tool_augmented" | "clarify_first";
  needsMemory: boolean;
  needsTools: boolean;
  toolIntents: string[];
  modelTier: "T1" | "T2" | "T3";
  responseMode: { voice: boolean; text: boolean };
  policyFlags: {
    continuity: "none" | "light" | "full";
    correctionGuard: boolean;
    probingAllowed: boolean;
  };
  confidence: number;
  reasons: string[];
};

export type RetrievalPlan = {
  includeRecentTurns: boolean;
  includeStartbrief: boolean;
  includeSignalPack: boolean;
  memoryQuery?: { enabled: boolean; query?: string; limit?: number };
  toolPrefetches: Array<{ name: string; args: Record<string, unknown> }>;
};

export type TurnPacket = {
  systemBlocks: Array<{ key: string; content: string }>;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  userTurn: string;
  model: { tier: "T1" | "T2" | "T3"; id: string };
  executionHints: {
    toolMode: "none" | "auto";
    maxSteps: number;
  };
  metadata: Record<string, unknown>;
};

export type TurnResult = {
  assistantText: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  toolResults: Array<{ name: string; ok: boolean; data?: unknown; error?: string }>;
  generation: {
    provider: "openrouter" | "openai" | "safe_text";
    model: string;
    fallbackUsed: boolean;
  };
  timingsMs: Record<string, number>;
};

export type PostProcessResult = {
  finalText: string;
  warnings: string[];
  statePatches: Record<string, unknown>;
  asyncTasks: Array<{ kind: string; payload: Record<string, unknown> }>;
};
```

## Hooks vs Skills vs Tools

## Hooks
Lifecycle extension points around the harness spine.

- Examples: before/after `decideTurn`, before model execution, after `postProcessTurn`.
- Use for observability, guardrails, experiment toggles.
- Hooks should not become independent policy brains.

## Skills
Composable higher-level behaviors.

- Examples: recap planning, reflection flow, meeting prep.
- Skills are orchestrated capabilities, not low-level I/O.
- Skills should depend on decisions from `decideTurn`, not bypass them.

## Tools
Low-level world interaction primitives.

- Examples: memory query, web search, calendar read/write.
- Tools should be declarative and policy-governed.
- Tool invocation must flow through `executeTurn` under one orchestrator spine.

## Keep / Collapse / Rename / Remove Guidance

## Keep (capabilities)
- Session lifecycle and async maintenance.
- Continuity/startbrief concept.
- Memory recall capability.
- Safety-aware routing concept.
- Tool-capable runtime path.

## Collapse / Relocate
- Route-level policy choreography -> `decideTurn` + `postProcessTurn`.
- Distributed prompt gating -> `composeTurnPacket`.
- Duplicate context-governor logic -> single implementation.
- Legacy/v2 execution branching -> `executeTurn` with adapters.

## Rename (for clarity)
- "Librarian reflex" -> memory decision + retrieval stages.
- "Overlay mythology" terms -> explicit policy flags/state descriptors where possible.
- "Burst" semantics -> explicit premium-tier policy windows in decision state.

## Remove (only where clearly redundant)
- Duplicated legacy branches after parity.
- Duplicate prompt assembly and signal-pack gating implementations.

## Adapter-Only Concepts (Not Core Brains)

The following should remain adapters or helper services, not independent control planes:

- Synapse access/fallback specifics.
- Mastra runtime specifics.
- Provider-specific model transport/fallback mechanics.
- TTS provider behavior.

Core brain remains `decideTurn` + harness spine.

## Non-Goals

- No immediate deletion of current behavior domains.
- No big-bang rewrite.
- No capability regression accepted without explicit tradeoff decision.
