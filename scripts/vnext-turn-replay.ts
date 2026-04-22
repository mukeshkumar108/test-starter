/**
 * Local-only migration harness for constructing a vNext TurnEvent and running
 * the current stub spine. This is not wired into production routes.
 *
 * Usage:
 *   pnpm tsx scripts/vnext-turn-replay.ts
 *   TRANSCRIPT=\"typed text\" pnpm tsx scripts/vnext-turn-replay.ts
 */

import { readFileSync } from "fs";
import { buildTextTurnEvent } from "@/lib/runtime/vnext/buildTurnEvent";
import {
  buildRetrievalOutputs,
  buildStubRetrievalOutputs,
  mapRecentTurnFixtures,
} from "@/lib/runtime/vnext/buildRetrievalOutputs";
import type {
  RetrievalPlan,
  SessionContext,
} from "@/lib/runtime/vnext/contracts";
import { composeTurnPacket } from "@/lib/runtime/vnext/composeTurnPacket";
import { decideTurn, LEGACY_DECISION_SIGNALS_METADATA_KEY } from "@/lib/runtime/vnext/decideTurn";
import { executeTurn } from "@/lib/runtime/vnext/executeTurn";
import { __test__ } from "@/lib/runtime/vnext/handleUserTurn";
import { postProcessTurn } from "@/lib/runtime/vnext/postProcessTurn";
import { renderPromptPreview } from "@/lib/runtime/vnext/renderPromptPreview";
import { runRetrievalPlan } from "@/lib/runtime/vnext/runRetrievalPlan";
import { writebackAndQueue } from "@/lib/runtime/vnext/writebackAndQueue";

function getInputText() {
  return process.env.TRANSCRIPT?.trim() || process.env.TEXT?.trim() || "hello from vnext replay";
}

function getReplayLegacySignals() {
  const signals: Record<string, unknown> = {};
  if (process.env.RISK_LEVEL) signals.riskLevel = process.env.RISK_LEVEL;
  if (process.env.INTENT) signals.intent = process.env.INTENT;
  if (process.env.PRESSURE) signals.pressure = process.env.PRESSURE;
  if (process.env.POSTURE) signals.posture = process.env.POSTURE;
  if (process.env.MODEL_TIER) signals.modelTier = process.env.MODEL_TIER;
  if (process.env.MEMORY_QUERY_ELIGIBLE) {
    signals.memoryQueryEligible = process.env.MEMORY_QUERY_ELIGIBLE === "true";
  }
  return Object.keys(signals).length > 0 ? signals : null;
}

function readJsonInput(jsonValue?: string, filePath?: string): unknown {
  const raw = filePath ? readFileSync(filePath, "utf8") : jsonValue;
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function getRecentTurnFixtures() {
  const input = readJsonInput(process.env.RECENT_TURNS_JSON, process.env.RECENT_TURNS_FILE);
  return mapRecentTurnFixtures(input);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("vNext replay harness is disabled in production.");
  }

  const timestampUtc = new Date().toISOString();
  const legacySignals = getReplayLegacySignals();
  const event = buildTextTurnEvent({
    userId: process.env.USER_ID ?? "replay-user",
    personaId: process.env.PERSONA_ID ?? "replay-persona",
    sessionId: process.env.SESSION_ID,
    text: getInputText(),
    timestampUtc,
    timezone: process.env.TIMEZONE ?? "Europe/London",
    routeMetadata: {
      source: "scripts/vnext-turn-replay",
    },
    metadata: legacySignals
      ? {
          [LEGACY_DECISION_SIGNALS_METADATA_KEY]: legacySignals,
        }
      : undefined,
  });

  const sequence: string[] = [];
  const session: SessionContext = {
    sessionId: event.sessionId ?? "replay-session",
    isNewSession: !event.sessionId,
    turnCount: 1,
    lastActivityAt: timestampUtc,
  };
  const decision = await decideTurn(event, session);
  const plannedRetrievals = await runRetrievalPlan(decision, event, session);
  const recentTurns = getRecentTurnFixtures();
  const retrievalPlan: RetrievalPlan = recentTurns.length > 0
    ? { ...plannedRetrievals, recentTurns: true }
    : plannedRetrievals;
  const retrievals = recentTurns.length > 0
    ? buildRetrievalOutputs({
        plan: retrievalPlan,
        event,
        session,
        source: "replay_fixture",
        recentTurns,
        trace: {
          notes: ["recent_turns_fixture_only_no_live_fetch"],
        },
      })
    : buildStubRetrievalOutputs({ plan: retrievalPlan, event, session });
  const packet = await composeTurnPacket({ event, session, decision, retrievalPlan, retrievals });
  const preview = renderPromptPreview({
    event,
    session,
    decision,
    retrievalPlan,
    retrievals,
    packet,
  });
  const execution = await executeTurn(packet, decision);
  const post = await postProcessTurn({
    event,
    session,
    decision,
    retrievalPlan,
    retrievals,
    packet,
    execution,
  });
  const writeback = await writebackAndQueue({
    event,
    session,
    decision,
    retrievalPlan,
    retrievals,
    packet,
    execution,
    post,
  });

  const result = await __test__.runHandleUserTurnWithStages(event, {
    async ensureSession() {
      sequence.push("ensureSession");
      return session;
    },
    async decideTurn() {
      sequence.push("decideTurn");
      return decision;
    },
    async runRetrievalPlan() {
      sequence.push("runRetrievalPlan");
      return retrievalPlan;
    },
    async executeRetrievalPlan() {
      sequence.push("executeRetrievalPlan");
      return retrievals;
    },
    async composeTurnPacket() {
      sequence.push("composeTurnPacket");
      return packet;
    },
    async executeTurn() {
      sequence.push("executeTurn");
      return execution;
    },
    async postProcessTurn() {
      sequence.push("postProcessTurn");
      return post;
    },
    async writebackAndQueue() {
      sequence.push("writebackAndQueue");
      return writeback;
    },
  });

  console.log(
    JSON.stringify(
      {
        event,
        decision,
        retrievalPlan,
        retrievals,
        packet,
        preview,
        execution,
        post,
        writeback,
        result,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[vnext-turn-replay] failed", error);
  process.exit(1);
});
