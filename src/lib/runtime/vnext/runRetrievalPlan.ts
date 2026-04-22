import type {
  ContextNeeds,
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
} from "./contracts";
import { buildStubRetrievalOutputs } from "./buildRetrievalOutputs";

function requestedFromContextNeeds(contextNeeds: ContextNeeds) {
  return {
    recentTurns: contextNeeds.recentTurns,
    memory: contextNeeds.memory,
    continuity: contextNeeds.continuity,
    calendar: contextNeeds.calendar,
    tasks: contextNeeds.tasks,
    web: contextNeeds.web,
    weather: contextNeeds.weather,
    traffic: contextNeeds.traffic,
  };
}

export async function runRetrievalPlan(
  decision: TurnDecision,
  event: TurnEvent,
  session: SessionContext
): Promise<RetrievalPlan> {
  // TODO(vNext): migrate legacy memory, continuity, and tool-context policy into
  // decideTurn before this stage starts planning richer retrieval parameters.
  const requested = requestedFromContextNeeds(decision.contextNeeds);

  return {
    ...requested,
    toolPrefetches: [],
    trace: {
      source: "adapter",
      adapter: "TurnDecision.contextNeeds",
      requested,
      decision: {
        intent: decision.intent,
        sensitivity: decision.sensitivity,
        toolNeed: decision.toolNeed,
        modelTier: decision.modelTier,
      },
      event: {
        modality: event.modality,
        hasText: Boolean(event.text || event.transcript),
        attachmentCount: event.attachments?.length ?? 0,
      },
      session: {
        sessionId: session.sessionId,
        isNewSession: session.isNewSession,
        turnCount: session.turnCount,
      },
      notes: [
        "planning_only_no_fetch",
        "memory_query_not_mapped_until_legacy_memory_policy_migrates",
      ],
    },
  };
}

export async function executeRetrievalPlan(
  plan: RetrievalPlan
): Promise<RetrievalOutputs> {
  // TODO(vNext): execute selected retrievals concurrently via thin adapters.
  return buildStubRetrievalOutputs({ plan });
}
