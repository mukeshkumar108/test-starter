/**
 * Unit tests for vNext executeTurn adapter contract.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/executeTurn.test.ts
 */

import type { TurnDecision, TurnPacket } from "../contracts";
import { executeTurn } from "../executeTurn";

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
  modelTier: "T2",
  reasoningEffort: "medium",
};

function packet(currentTurn = "hello"): TurnPacket {
  return {
    runtime: {
      version: "vnext",
      modelTier: "T2",
      responseMode: "text",
    },
    user: {
      userId: "user-1",
      personaId: "persona-1",
      modality: "text",
      text: currentTurn,
    },
    session: {
      sessionId: "session-1",
      isNewSession: false,
      turnCount: 3,
    },
    context: {
      sections: [
        {
          key: "memory",
          content: "fact",
          source: "test",
        },
      ],
      retrievals: {
        memory: {
          facts: ["fact"],
        },
      },
    },
    policy: {
      decision,
    },
    dialogue: {
      recentTurns: [{ role: "assistant", content: "previous" }],
      currentTurn,
    },
  };
}

async function main() {
  await runTest("returns the canonical placeholder TurnExecutionResult shape", async () => {
    const result = await executeTurn(packet(), decision);

    expect(result.text).toBe("vNext runtime skeleton is not wired to generation yet.");
    expect(result.execution).toEqual({
      mode: "stub",
      backend: "none",
      status: "placeholder",
      isPlaceholder: true,
    });
    expect(result.model).toEqual({
      tier: "T2",
      reasoningEffort: "medium",
    });
    expect(result.tools).toEqual({
      calls: [],
      results: [],
    });
    expect(result.actionsRequested).toEqual([]);
  });

  await runTest("returns an explicit empty-turn placeholder", async () => {
    const result = await executeTurn(packet(""), decision);

    expect(result.text).toBe("vNext runtime skeleton received an empty turn.");
    expect(result.execution?.status).toBe("placeholder");
    expect(result.execution?.isPlaceholder).toBe(true);
  });

  await runTest("trace captures stable adapter, decision, and packet provenance", async () => {
    const result = await executeTurn(packet(), decision);

    expect(result.trace?.source).toBe("adapter");
    expect(result.trace?.adapter).toBe("vnext.stubExecutionAdapter");
    expect(result.trace?.status).toBe("placeholder");
    expect(result.trace?.decision).toEqual({
      intent: "companion",
      sensitivity: "low",
      toolNeed: "none",
      modelTier: "T2",
      responseMode: "text",
    });
    expect(result.trace?.packet).toEqual({
      sectionCount: 1,
      sectionKeys: ["memory"],
      recentTurnCount: 1,
      hasCurrentTurn: true,
    });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext executeTurn tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext executeTurn tests passed.");
}

main();
