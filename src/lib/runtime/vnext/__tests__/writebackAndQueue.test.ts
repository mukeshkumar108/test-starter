/**
 * Unit tests for vNext writebackAndQueue no-op executor.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/writebackAndQueue.test.ts
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
import { writebackAndQueue } from "../writebackAndQueue";

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
  turnCount: 3,
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

const execution: TurnExecutionResult = {
  text: "final text",
  execution: {
    mode: "stub",
    backend: "none",
    status: "placeholder",
    isPlaceholder: true,
  },
};

function input(post: PostProcessResult) {
  return {
    event,
    session,
    decision,
    retrievalPlan,
    retrievals,
    packet,
    execution,
    post,
  };
}

async function main() {
  await runTest("returns noop result for explicit none instructions", async () => {
    const result = await writebackAndQueue(
      input({
        finalText: "final text",
        writeback: [{ kind: "none" }],
        queue: [{ kind: "none" }],
      })
    );

    expect(result.status).toBe("noop");
    expect(result.executed).toEqual({
      messagePersistence: false,
      sessionStateUpdate: false,
      memoryWrite: false,
      queueDispatch: false,
    });
    expect(result.instructions).toEqual({
      writeback: [{ kind: "none" }],
      queue: [{ kind: "none" }],
    });
    expect(result.summary).toEqual({
      writebackCount: 0,
      queueCount: 0,
      actionRequestCount: 0,
      finalTextLength: 10,
    });
  });

  await runTest("normalizes sparse postprocess instructions safely", async () => {
    const result = await writebackAndQueue(
      input({
        finalText: "",
        writeback: [],
        queue: [],
      })
    );

    expect(result.status).toBe("noop");
    expect(result.instructions).toEqual({
      writeback: [{ kind: "none" }],
      queue: [{ kind: "none" }],
    });
    expect(result.summary.finalTextLength).toBe(0);
  });

  await runTest("skips active instructions without performing side effects", async () => {
    const result = await writebackAndQueue(
      input({
        finalText: "remember this",
        writeback: [
          { kind: "message", payload: { role: "assistant" } },
          { kind: "memory", payload: { fact: "sample" } },
        ],
        queue: [{ kind: "memory_ingest", payload: { source: "test" } }],
        actionsRequested: [{ kind: "draft", payload: { target: "email" } }],
      })
    );

    expect(result.status).toBe("skipped");
    expect(result.executed).toEqual({
      messagePersistence: false,
      sessionStateUpdate: false,
      memoryWrite: false,
      queueDispatch: false,
    });
    expect(result.summary).toEqual({
      writebackCount: 2,
      queueCount: 1,
      actionRequestCount: 1,
      finalTextLength: 13,
    });
  });

  await runTest("trace captures stable writeback provenance", async () => {
    const result = await writebackAndQueue(
      input({
        finalText: "final text",
        writeback: [{ kind: "none" }],
        queue: [{ kind: "none" }],
        warnings: ["placeholder_execution"],
      })
    );

    expect(result.trace?.source).toBe("adapter");
    expect(result.trace?.adapter).toBe("writebackAndQueue");
    expect(result.trace?.sideEffects).toEqual({
      dbWrites: false,
      sessionMutation: false,
      memoryWrites: false,
      queueDispatch: false,
    });
    expect(result.trace?.post).toEqual({
      finalTextLength: 10,
      writebackKinds: ["none"],
      queueKinds: ["none"],
      warningCount: 1,
    });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext writebackAndQueue tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext writebackAndQueue tests passed.");
}

main();
