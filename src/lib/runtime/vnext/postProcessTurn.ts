import type {
  PostProcessResult,
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
  TurnExecutionResult,
  TurnPacket,
} from "./contracts";

type PostProcessTurnInput = {
  event: TurnEvent;
  session: SessionContext;
  decision: TurnDecision;
  retrievalPlan: RetrievalPlan;
  retrievals: RetrievalOutputs;
  packet: TurnPacket;
  execution: TurnExecutionResult;
};

function getExecutionStatus(execution: TurnExecutionResult) {
  return execution.execution?.status ?? "completed";
}

function buildWarnings(execution: TurnExecutionResult): string[] {
  const warnings: string[] = [];
  if (execution.execution?.isPlaceholder) {
    warnings.push("placeholder_execution");
  }
  return warnings;
}

export async function postProcessTurn({
  event,
  session,
  decision,
  retrievalPlan,
  retrievals,
  packet,
  execution,
}: PostProcessTurnInput): Promise<PostProcessResult> {
  // TODO(vNext): migrate promise extraction, commitment extraction, safety
  // review, writeback recommendation logic, and async queue triggers here.
  const actionRequests = execution.actionsRequested ?? [];
  const warnings = buildWarnings(execution);
  const executionStatus = getExecutionStatus(execution);

  return {
    finalText: execution.text,
    actionsRequested: actionRequests,
    warnings,
    flags: {
      placeholderExecution: execution.execution?.isPlaceholder === true,
      hasActionRequests: actionRequests.length > 0,
      hasToolCalls: Boolean(execution.tools?.calls?.length),
    },
    writeback: [{ kind: "none" }],
    queue: [{ kind: "none" }],
    metadata: {
      source: "vnext_postprocess_adapter",
      modelTier: decision.modelTier,
      responseMode: decision.responseMode,
      executionMode: execution.execution?.mode ?? "unknown",
      executionStatus,
      actionRequestCount: actionRequests.length,
      writebackCount: 0,
      queueCount: 0,
    },
    debug: {
      source: "vnext_postprocess_adapter",
      warnings,
      writeback: "not_migrated",
      queue: "not_migrated",
    },
    trace: {
      source: "adapter",
      adapter: "postProcessTurn",
      event: {
        modality: event.modality,
        timestampUtc: event.timestampUtc,
      },
      session: {
        sessionId: session.sessionId,
        isNewSession: session.isNewSession,
        turnCount: session.turnCount,
      },
      decision: {
        intent: decision.intent,
        sensitivity: decision.sensitivity,
        toolNeed: decision.toolNeed,
        modelTier: decision.modelTier,
        responseMode: decision.responseMode,
      },
      retrievalPlan: {
        recentTurns: retrievalPlan.recentTurns,
        memory: retrievalPlan.memory,
        continuity: retrievalPlan.continuity,
        calendar: retrievalPlan.calendar,
        tasks: retrievalPlan.tasks,
        web: retrievalPlan.web,
        weather: retrievalPlan.weather,
        traffic: retrievalPlan.traffic,
      },
      retrievals: {
        hasRecentTurns: Boolean(retrievals.recentTurns?.length),
        hasMemory: Boolean(retrievals.memory),
        hasContinuity: Boolean(retrievals.continuity),
        hasSituational: Boolean(retrievals.situational),
        hasTools: Boolean(retrievals.tools),
      },
      packet: {
        sectionCount: packet.context.sections.length,
        sectionKeys: packet.context.sections.map((section) => section.key),
      },
      execution: {
        mode: execution.execution?.mode ?? "unknown",
        backend: execution.execution?.backend ?? "unknown",
        status: executionStatus,
        isPlaceholder: execution.execution?.isPlaceholder === true,
        toolCallCount: execution.tools?.calls?.length ?? 0,
        actionRequestCount: actionRequests.length,
      },
      outputs: {
        finalTextLength: execution.text.length,
        writebackKinds: ["none"],
        queueKinds: ["none"],
      },
      notes: [
        "no_real_writeback",
        "no_queue_triggers",
        "execution_text_is_authoritative",
      ],
    },
  };
}

export const __test__ = {
  buildWarnings,
  getExecutionStatus,
};
