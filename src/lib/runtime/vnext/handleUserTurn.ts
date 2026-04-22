import type {
  HandleUserTurnResult,
  PostProcessResult,
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
  TurnExecutionResult,
  TurnPacket,
  WritebackAndQueueResult,
} from "./contracts";
import { composeTurnPacket } from "./composeTurnPacket";
import { decideTurn } from "./decideTurn";
import { ensureSession } from "./ensureSession";
import { executeTurn } from "./executeTurn";
import { postProcessTurn } from "./postProcessTurn";
import { executeRetrievalPlan, runRetrievalPlan } from "./runRetrievalPlan";
import { writebackAndQueue } from "./writebackAndQueue";

type ComposeInput = {
  event: TurnEvent;
  session: SessionContext;
  decision: TurnDecision;
  retrievalPlan: RetrievalPlan;
  retrievals: RetrievalOutputs;
};

type PostProcessInput = ComposeInput & {
  packet: TurnPacket;
  execution: TurnExecutionResult;
};

type WritebackInput = PostProcessInput & {
  post: PostProcessResult;
};

type HandleUserTurnStages = {
  ensureSession: (event: TurnEvent) => Promise<SessionContext>;
  decideTurn: (event: TurnEvent, session: SessionContext) => Promise<TurnDecision>;
  runRetrievalPlan: (
    decision: TurnDecision,
    event: TurnEvent,
    session: SessionContext
  ) => Promise<RetrievalPlan>;
  executeRetrievalPlan: (plan: RetrievalPlan) => Promise<RetrievalOutputs>;
  composeTurnPacket: (input: ComposeInput) => Promise<TurnPacket>;
  executeTurn: (
    packet: TurnPacket,
    decision: TurnDecision
  ) => Promise<TurnExecutionResult>;
  postProcessTurn: (input: PostProcessInput) => Promise<PostProcessResult>;
  writebackAndQueue: (input: WritebackInput) => Promise<WritebackAndQueueResult | void>;
};

const defaultStages: HandleUserTurnStages = {
  ensureSession,
  decideTurn,
  runRetrievalPlan,
  executeRetrievalPlan,
  composeTurnPacket,
  executeTurn,
  postProcessTurn,
  writebackAndQueue,
};

async function runHandleUserTurnWithStages(
  event: TurnEvent,
  stages: HandleUserTurnStages
): Promise<HandleUserTurnResult> {
  const session = await stages.ensureSession(event);
  const decision = await stages.decideTurn(event, session);
  const retrievalPlan = await stages.runRetrievalPlan(decision, event, session);
  const retrievals = await stages.executeRetrievalPlan(retrievalPlan);
  const packet = await stages.composeTurnPacket({
    event,
    session,
    decision,
    retrievalPlan,
    retrievals,
  });
  const execution = await stages.executeTurn(packet, decision);
  const post = await stages.postProcessTurn({
    event,
    session,
    decision,
    retrievalPlan,
    retrievals,
    packet,
    execution,
  });

  await stages.writebackAndQueue({
    event,
    session,
    decision,
    retrievalPlan,
    retrievals,
    packet,
    execution,
    post,
  });

  return {
    text: post.finalText,
    metadata: post.metadata,
    debug: post.debug,
  };
}

/**
 * vNext Sophie turn-control spine.
 *
 * This module is introduced beside the legacy runtime and is not wired into the
 * production route yet. Future migration should move existing policy,
 * retrieval, packet assembly, execution, and writeback concerns into these
 * explicit stages without changing external behavior.
 */
export async function handleUserTurn(
  event: TurnEvent
): Promise<HandleUserTurnResult> {
  return runHandleUserTurnWithStages(event, defaultStages);
}

export const __test__ = {
  runHandleUserTurnWithStages,
};
