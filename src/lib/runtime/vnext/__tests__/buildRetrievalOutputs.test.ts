/**
 * Unit tests for vNext RetrievalOutputs builders/adapters.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/buildRetrievalOutputs.test.ts
 */

import type { RetrievalPlan, SessionContext, TurnEvent } from "../contracts";
import {
  buildRetrievalOutputs,
  buildStubRetrievalOutputs,
  mapLegacyRetrievalOutputs,
} from "../buildRetrievalOutputs";

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

const basePlan: RetrievalPlan = {
  recentTurns: false,
  memory: false,
  continuity: false,
  calendar: false,
  tasks: false,
  web: false,
  weather: false,
  traffic: false,
  toolPrefetches: [],
};

const event: TurnEvent = {
  userId: "user-1",
  personaId: "persona-1",
  sessionId: "session-1",
  modality: "text",
  text: "hello",
  timestampUtc: "2026-04-22T12:00:00.000Z",
};

const session: SessionContext = {
  sessionId: "session-1",
  isNewSession: false,
  turnCount: 3,
};

async function main() {
  await runTest("builds conservative empty outputs with stable trace", () => {
    const outputs = buildRetrievalOutputs({
      plan: basePlan,
      event,
      session,
      source: "manual",
    });

    expect(outputs.recentTurns).toBeUndefined();
    expect(outputs.memory).toBeUndefined();
    expect(outputs.continuity).toBeUndefined();
    expect(outputs.trace?.source).toBe("manual");
    expect(outputs.trace?.adapter).toBe("buildRetrievalOutputs");
    expect(outputs.trace?.sections).toEqual({
      recentTurns: "not_requested",
      memory: "not_requested",
      continuity: "not_requested",
      calendar: "not_requested",
      tasks: "not_requested",
      web: "not_requested",
      weather: "not_requested",
      traffic: "not_requested",
      tools: "not_requested",
    });
  });

  await runTest("marks requested sections as mapped or missing without inventing data", () => {
    const outputs = buildRetrievalOutputs({
      plan: {
        ...basePlan,
        recentTurns: true,
        memory: true,
        continuity: true,
        weather: true,
      },
      source: "manual",
      recentTurns: [{ role: "user", content: "previous turn" }],
      memory: { facts: ["prefers concise answers"] },
      situational: { weather: { summary: "rain" } },
    });

    expect(outputs.recentTurns).toEqual([{ role: "user", content: "previous turn" }]);
    expect(outputs.memory).toEqual({ facts: ["prefers concise answers"] });
    expect(outputs.continuity).toBeUndefined();
    expect(outputs.situational).toEqual({ weather: { summary: "rain" } });
    expect(outputs.trace?.sections).toEqual({
      recentTurns: "mapped",
      memory: "mapped",
      continuity: "missing",
      calendar: "not_requested",
      tasks: "not_requested",
      web: "not_requested",
      weather: "mapped",
      traffic: "not_requested",
      tools: "not_requested",
    });
  });

  await runTest("builds safe stub outputs without fetching", () => {
    const outputs = buildStubRetrievalOutputs({
      plan: {
        ...basePlan,
        recentTurns: true,
        memory: true,
        toolPrefetches: [{ name: "calendar.read", args: { window: "today" } }],
      },
      event,
      session,
    });

    expect(outputs.recentTurns).toEqual([]);
    expect(outputs.memory).toBeUndefined();
    expect(outputs.tools).toEqual({
      prefetches: [{ name: "calendar.read", args: { window: "today" } }],
    });
    expect(outputs.trace?.source).toBe("stub");
    expect(outputs.trace?.sections).toEqual({
      recentTurns: "mapped",
      memory: "missing",
      continuity: "not_requested",
      calendar: "not_requested",
      tasks: "not_requested",
      web: "not_requested",
      weather: "not_requested",
      traffic: "not_requested",
      tools: "mapped",
    });
  });

  await runTest("maps partial legacy artifacts and preserves uncertainty", () => {
    const outputs = mapLegacyRetrievalOutputs({
      plan: {
        ...basePlan,
        memory: true,
        continuity: true,
        web: true,
      },
      artifacts: {
        memory: { entities: ["Synapse"], raw: { source: "legacy-memory" } },
        situational: { web: { snippets: ["sample"] } },
        raw: { contextBuilder: "available" },
      },
      event,
      session,
    });

    expect(outputs.memory).toEqual({
      entities: ["Synapse"],
      raw: { source: "legacy-memory" },
    });
    expect(outputs.continuity).toBeUndefined();
    expect(outputs.situational).toEqual({ web: { snippets: ["sample"] } });
    expect(outputs.trace?.source).toBe("legacy_adapter");
    expect(outputs.trace?.legacyRawAvailable).toBe(true);
    expect(outputs.trace?.sections).toEqual({
      recentTurns: "not_requested",
      memory: "mapped",
      continuity: "missing",
      calendar: "not_requested",
      tasks: "not_requested",
      web: "mapped",
      weather: "not_requested",
      traffic: "not_requested",
      tools: "not_requested",
    });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext buildRetrievalOutputs tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext buildRetrievalOutputs tests passed.");
}

main();
