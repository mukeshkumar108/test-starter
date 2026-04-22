/**
 * Unit tests for vNext retrieval planning adapter.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/runRetrievalPlan.test.ts
 */

import type { SessionContext, TurnDecision, TurnEvent } from "../contracts";
import { runRetrievalPlan } from "../runRetrievalPlan";

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
    toBeUndefined() {
      if (actual !== undefined) {
        throw new Error(`Expected undefined, got ${JSON.stringify(actual)}`);
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

const baseEvent: TurnEvent = {
  userId: "user-1",
  personaId: "persona-1",
  modality: "text",
  text: "what should I remember from yesterday?",
  timestampUtc: "2026-04-22T12:00:00.000Z",
};

const baseSession: SessionContext = {
  sessionId: "session-1",
  isNewSession: false,
  turnCount: 4,
};

function decision(overrides: Partial<TurnDecision> = {}): TurnDecision {
  return {
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
    ...overrides,
  };
}

async function main() {
  await runTest("defaults conservatively when no context needs are requested", async () => {
    const plan = await runRetrievalPlan(decision(), baseEvent, baseSession);

    expect(plan.recentTurns).toBe(false);
    expect(plan.memory).toBe(false);
    expect(plan.continuity).toBe(false);
    expect(plan.calendar).toBe(false);
    expect(plan.tasks).toBe(false);
    expect(plan.web).toBe(false);
    expect(plan.weather).toBe(false);
    expect(plan.traffic).toBe(false);
    expect(plan.toolPrefetches).toEqual([]);
    expect(plan.memoryQuery).toBeUndefined();
    expect(plan.trace?.source).toBe("adapter");
    expect(plan.trace?.adapter).toBe("TurnDecision.contextNeeds");
  });

  await runTest("maps explicit memory, recent-turns, and continuity needs", async () => {
    const plan = await runRetrievalPlan(
      decision({
        contextNeeds: {
          recentTurns: true,
          memory: true,
          continuity: true,
          calendar: false,
          tasks: false,
          web: false,
          weather: false,
          traffic: false,
        },
      }),
      baseEvent,
      baseSession
    );

    expect(plan.recentTurns).toBe(true);
    expect(plan.memory).toBe(true);
    expect(plan.continuity).toBe(true);
    expect(plan.calendar).toBe(false);
    expect(plan.trace?.requested).toEqual({
      recentTurns: true,
      memory: true,
      continuity: true,
      calendar: false,
      tasks: false,
      web: false,
      weather: false,
      traffic: false,
    });
  });

  await runTest("maps explicit tool-context needs without executing tools", async () => {
    const plan = await runRetrievalPlan(
      decision({
        toolNeed: "required",
        contextNeeds: {
          recentTurns: false,
          memory: false,
          continuity: false,
          calendar: true,
          tasks: true,
          web: true,
          weather: true,
          traffic: true,
        },
      }),
      baseEvent,
      baseSession
    );

    expect(plan.calendar).toBe(true);
    expect(plan.tasks).toBe(true);
    expect(plan.web).toBe(true);
    expect(plan.weather).toBe(true);
    expect(plan.traffic).toBe(true);
    expect(plan.toolPrefetches).toEqual([]);
    expect(plan.trace?.decision).toEqual({
      intent: "unknown",
      sensitivity: "low",
      toolNeed: "required",
      modelTier: "T1",
    });
  });

  await runTest("trace captures event and session provenance only", async () => {
    const plan = await runRetrievalPlan(
      decision({ intent: "momentum", sensitivity: "medium", modelTier: "T2" }),
      {
        ...baseEvent,
        modality: "multimodal",
        attachments: [{ kind: "image", filename: "sketch.png" }],
      },
      { ...baseSession, isNewSession: true, turnCount: 1 }
    );

    expect(plan.trace?.event).toEqual({
      modality: "multimodal",
      hasText: true,
      attachmentCount: 1,
    });
    expect(plan.trace?.session).toEqual({
      sessionId: "session-1",
      isNewSession: true,
      turnCount: 1,
    });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext runRetrievalPlan tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext runRetrievalPlan tests passed.");
}

main();
