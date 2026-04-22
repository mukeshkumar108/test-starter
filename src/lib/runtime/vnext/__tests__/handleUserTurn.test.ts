/**
 * Unit tests for the vNext turn-control spine.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/handleUserTurn.test.ts
 */

import type {
  PostProcessResult,
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
  TurnExecutionResult,
  TurnPacket,
} from "../contracts";
import { __test__ } from "../handleUserTurn";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  await runTest("handleUserTurn executes stages in canonical order", async () => {
    const sequence: string[] = [];
    const event: TurnEvent = {
      userId: "user-vnext",
      personaId: "persona-vnext",
      modality: "text",
      text: "hello",
      timestampUtc: "2026-04-22T12:00:00.000Z",
    };
    const session: SessionContext = {
      sessionId: "session-vnext",
      isNewSession: true,
      turnCount: 1,
    };
    const decision: TurnDecision = {
      intent: "unknown",
      sensitivity: "low",
      toolNeed: "none",
      contextNeeds: {
        recentTurns: false,
        memory: false,
        continuity: false,
        calendar: false,
        tasks: false,
        web: false,
        weather: false,
        traffic: false,
      },
      responseMode: "text",
      modelTier: "T1",
    };
    const retrievalPlan: RetrievalPlan = {
      recentTurns: false,
      memory: false,
      continuity: false,
      calendar: false,
      tasks: false,
      web: false,
      weather: false,
      traffic: false,
    };
    const retrievals: RetrievalOutputs = {};
    const packet: TurnPacket = {
      runtime: {
        version: "vnext",
        modelTier: "T1",
        responseMode: "text",
      },
      user: {
        userId: event.userId,
        personaId: event.personaId,
        modality: event.modality,
        text: event.text ?? "",
      },
      session,
      context: {
        sections: [],
        retrievals,
      },
      policy: {
        decision,
      },
      dialogue: {
        recentTurns: [],
        currentTurn: event.text ?? "",
      },
    };
    const execution: TurnExecutionResult = {
      text: "placeholder response",
    };
    const post: PostProcessResult = {
      finalText: "placeholder response",
      writeback: [{ kind: "none" }],
      queue: [{ kind: "none" }],
      metadata: {
        test: true,
      },
      debug: {
        sequence: true,
      },
    };

    const result = await __test__.runHandleUserTurnWithStages(event, {
      async ensureSession(receivedEvent) {
        sequence.push("ensureSession");
        expect(receivedEvent).toBe(event);
        return session;
      },
      async decideTurn(receivedEvent, receivedSession) {
        sequence.push("decideTurn");
        expect(receivedEvent).toBe(event);
        expect(receivedSession).toBe(session);
        return decision;
      },
      async runRetrievalPlan(receivedDecision, receivedEvent, receivedSession) {
        sequence.push("runRetrievalPlan");
        expect(receivedDecision).toBe(decision);
        expect(receivedEvent).toBe(event);
        expect(receivedSession).toBe(session);
        return retrievalPlan;
      },
      async executeRetrievalPlan(receivedPlan) {
        sequence.push("executeRetrievalPlan");
        expect(receivedPlan).toBe(retrievalPlan);
        return retrievals;
      },
      async composeTurnPacket(input) {
        sequence.push("composeTurnPacket");
        expect(input.event).toBe(event);
        expect(input.session).toBe(session);
        expect(input.decision).toBe(decision);
        expect(input.retrievalPlan).toBe(retrievalPlan);
        expect(input.retrievals).toBe(retrievals);
        return packet;
      },
      async executeTurn(receivedPacket, receivedDecision) {
        sequence.push("executeTurn");
        expect(receivedPacket).toBe(packet);
        expect(receivedDecision).toBe(decision);
        return execution;
      },
      async postProcessTurn(input) {
        sequence.push("postProcessTurn");
        expect(input.retrievalPlan).toBe(retrievalPlan);
        expect(input.packet).toBe(packet);
        expect(input.execution).toBe(execution);
        return post;
      },
      async writebackAndQueue(input) {
        sequence.push("writebackAndQueue");
        expect(input.retrievalPlan).toBe(retrievalPlan);
        expect(input.post).toBe(post);
      },
    });

    expect(sequence).toEqual([
      "ensureSession",
      "decideTurn",
      "runRetrievalPlan",
      "executeRetrievalPlan",
      "composeTurnPacket",
      "executeTurn",
      "postProcessTurn",
      "writebackAndQueue",
    ]);
    expect(result.text).toBe("placeholder response");
    expect(result.metadata).toEqual({ test: true });
    expect(result.debug).toEqual({ sequence: true });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext handleUserTurn tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext handleUserTurn tests passed.");
}

main();
