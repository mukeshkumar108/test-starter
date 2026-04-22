/**
 * Unit tests for vNext postProcessTurn adapter contract.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/postProcessTurn.test.ts
 */

import type {
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
  TurnExecutionResult,
  TurnPacket,
} from "../contracts";
import { postProcessTurn } from "../postProcessTurn";

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

const event: TurnEvent = {
  userId: "user-1",
  personaId: "persona-1",
  modality: "text",
  text: "hello",
  timestampUtc: "2026-04-22T12:00:00.000Z",
};

const session: SessionContext = {
  sessionId: "session-1",
  isNewSession: false,
  turnCount: 4,
};

const decision: TurnDecision = {
  intent: "companion",
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
    userId: "user-1",
    personaId: "persona-1",
    modality: "text",
    text: "hello",
  },
  session,
  context: {
    sections: [],
    retrievalPlan,
    retrievals,
  },
  policy: {
    decision,
  },
  dialogue: {
    recentTurns: [],
    currentTurn: "hello",
  },
};

function input(execution: TurnExecutionResult) {
  return {
    event,
    session,
    decision,
    retrievalPlan,
    retrievals,
    packet,
    execution,
  };
}

async function main() {
  await runTest("uses execution text as authoritative finalText", async () => {
    const post = await postProcessTurn(
      input({
        text: "final answer",
        execution: {
          mode: "stub",
          backend: "none",
          status: "placeholder",
          isPlaceholder: true,
        },
        model: {
          tier: "T1",
        },
      })
    );

    expect(post.finalText).toBe("final answer");
    expect(post.writeback).toEqual([{ kind: "none" }]);
    expect(post.queue).toEqual([{ kind: "none" }]);
    expect(post.actionsRequested).toEqual([]);
    expect(post.warnings).toEqual(["placeholder_execution"]);
    expect(post.flags).toEqual({
      placeholderExecution: true,
      hasActionRequests: false,
      hasToolCalls: false,
    });
  });

  await runTest("handles sparse execution metadata conservatively", async () => {
    const post = await postProcessTurn(input({ text: "plain text only" }));

    expect(post.finalText).toBe("plain text only");
    expect(post.warnings).toEqual([]);
    expect(post.metadata?.executionMode).toBe("unknown");
    expect(post.metadata?.executionStatus).toBe("completed");
    expect(post.flags?.placeholderExecution).toBe(false);
  });

  await runTest("passes through action requests without creating writeback semantics", async () => {
    const post = await postProcessTurn(
      input({
        text: "I can draft that.",
        actionsRequested: [{ kind: "draft", payload: { target: "email" } }],
        tools: {
          calls: [{ name: "email.search", args: { q: "contract" } }],
          results: [],
        },
      })
    );

    expect(post.actionsRequested).toEqual([
      { kind: "draft", payload: { target: "email" } },
    ]);
    expect(post.flags).toEqual({
      placeholderExecution: false,
      hasActionRequests: true,
      hasToolCalls: true,
    });
    expect(post.writeback).toEqual([{ kind: "none" }]);
    expect(post.queue).toEqual([{ kind: "none" }]);
  });

  await runTest("trace captures stable postprocess provenance", async () => {
    const post = await postProcessTurn(
      input({
        text: "final",
        execution: {
          mode: "stub",
          backend: "none",
          status: "placeholder",
          isPlaceholder: true,
        },
      })
    );

    expect(post.trace?.source).toBe("adapter");
    expect(post.trace?.adapter).toBe("postProcessTurn");
    expect(post.trace?.decision).toEqual({
      intent: "companion",
      sensitivity: "low",
      toolNeed: "none",
      modelTier: "T1",
      responseMode: "text",
    });
    expect(post.trace?.execution).toEqual({
      mode: "stub",
      backend: "none",
      status: "placeholder",
      isPlaceholder: true,
      toolCallCount: 0,
      actionRequestCount: 0,
    });
    expect(post.trace?.outputs).toEqual({
      finalTextLength: 5,
      writebackKinds: ["none"],
      queueKinds: ["none"],
    });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext postProcessTurn tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext postProcessTurn tests passed.");
}

main();
