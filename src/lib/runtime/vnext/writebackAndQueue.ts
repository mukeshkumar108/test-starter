import type {
  PostProcessResult,
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
  TurnExecutionResult,
  TurnPacket,
  WritebackAndQueueResult,
  WritebackInstruction,
  QueueInstruction,
} from "./contracts";

type WritebackAndQueueInput = {
  event: TurnEvent;
  session: SessionContext;
  decision: TurnDecision;
  retrievalPlan: RetrievalPlan;
  retrievals: RetrievalOutputs;
  packet: TurnPacket;
  execution: TurnExecutionResult;
  post: PostProcessResult;
};

export async function writebackAndQueue(
  input: WritebackAndQueueInput
): Promise<WritebackAndQueueResult> {
  // TODO(vNext): migrate message persistence, session updates, memory writes,
  // async job scheduling, retry handling, and error handling behind explicit
  // instruction executors. This stage intentionally performs no side effects.
  const writeback = normalizeWriteback(input.post.writeback);
  const queue = normalizeQueue(input.post.queue);
  const activeWriteback = writeback.filter((instruction) => instruction.kind !== "none");
  const activeQueue = queue.filter((instruction) => instruction.kind !== "none");
  const status = activeWriteback.length === 0 && activeQueue.length === 0 ? "noop" : "skipped";

  return {
    status,
    executed: {
      messagePersistence: false,
      sessionStateUpdate: false,
      memoryWrite: false,
      queueDispatch: false,
    },
    instructions: {
      writeback,
      queue,
    },
    summary: {
      writebackCount: activeWriteback.length,
      queueCount: activeQueue.length,
      actionRequestCount: input.post.actionsRequested?.length ?? 0,
      finalTextLength: input.post.finalText.length,
    },
    metadata: {
      source: "vnext_writeback_noop_executor",
      status,
      sideEffects: false,
    },
    debug: {
      source: "vnext_writeback_noop_executor",
      writebackKinds: writeback.map((instruction) => instruction.kind),
      queueKinds: queue.map((instruction) => instruction.kind),
    },
    trace: {
      source: "adapter",
      adapter: "writebackAndQueue",
      status,
      sideEffects: {
        dbWrites: false,
        sessionMutation: false,
        memoryWrites: false,
        queueDispatch: false,
      },
      event: {
        modality: input.event.modality,
        timestampUtc: input.event.timestampUtc,
      },
      session: {
        sessionId: input.session.sessionId,
        isNewSession: input.session.isNewSession,
        turnCount: input.session.turnCount,
      },
      decision: {
        intent: input.decision.intent,
        sensitivity: input.decision.sensitivity,
        toolNeed: input.decision.toolNeed,
        modelTier: input.decision.modelTier,
        responseMode: input.decision.responseMode,
      },
      retrievalPlan: {
        recentTurns: input.retrievalPlan.recentTurns,
        memory: input.retrievalPlan.memory,
        continuity: input.retrievalPlan.continuity,
        calendar: input.retrievalPlan.calendar,
        tasks: input.retrievalPlan.tasks,
        web: input.retrievalPlan.web,
        weather: input.retrievalPlan.weather,
        traffic: input.retrievalPlan.traffic,
      },
      retrievals: {
        hasRecentTurns: Boolean(input.retrievals.recentTurns?.length),
        hasMemory: Boolean(input.retrievals.memory),
        hasContinuity: Boolean(input.retrievals.continuity),
        hasSituational: Boolean(input.retrievals.situational),
        hasTools: Boolean(input.retrievals.tools),
      },
      packet: {
        sectionCount: input.packet.context.sections.length,
        sectionKeys: input.packet.context.sections.map((section) => section.key),
      },
      execution: {
        mode: input.execution.execution?.mode ?? "unknown",
        status: input.execution.execution?.status ?? "unknown",
        actionRequestCount: input.execution.actionsRequested?.length ?? 0,
      },
      post: {
        finalTextLength: input.post.finalText.length,
        writebackKinds: writeback.map((instruction) => instruction.kind),
        queueKinds: queue.map((instruction) => instruction.kind),
        warningCount: input.post.warnings?.length ?? 0,
      },
      notes: [
        "noop_executor_no_side_effects",
        "real_persistence_not_migrated",
        "real_queue_dispatch_not_migrated",
      ],
    },
  };
}

function normalizeWriteback(instructions: WritebackInstruction[]): WritebackInstruction[] {
  return instructions.length > 0 ? instructions : [{ kind: "none" }];
}

function normalizeQueue(instructions: QueueInstruction[]): QueueInstruction[] {
  return instructions.length > 0 ? instructions : [{ kind: "none" }];
}

export const __test__ = {
  normalizeQueue,
  normalizeWriteback,
};
