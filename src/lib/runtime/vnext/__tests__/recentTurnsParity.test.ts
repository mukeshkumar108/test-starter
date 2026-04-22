/**
 * Unit tests for vNext fixture-backed recent_turns parity bridge.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/recentTurnsParity.test.ts
 */

import type {
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
} from "../contracts";
import { buildRetrievalOutputs, mapRecentTurnFixtures } from "../buildRetrievalOutputs";
import { composeTurnPacket } from "../composeTurnPacket";
import { renderPromptPreview } from "../renderPromptPreview";

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
    toContain(expected: string) {
      if (typeof actual === "string") {
        if (!actual.includes(expected)) {
          throw new Error(`Expected ${JSON.stringify(actual)} to contain ${expected}`);
        }
        return;
      }
      if (!Array.isArray(actual) || !actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${expected}`);
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
  text: "where were we?",
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
    recentTurns: true,
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
  recentTurns: true,
  memory: false,
  continuity: false,
  calendar: false,
  tasks: false,
  web: false,
  weather: false,
  traffic: false,
};

async function main() {
  await runTest("maps recent-turn fixtures into canonical DialogueTurn rows", () => {
    const turns = mapRecentTurnFixtures([
      { role: "user", text: "first", createdAt: "2026-04-22T10:00:00.000Z" },
      { role: "assistant", content: "second", metadata: { source: "fixture" } },
      { role: "invalid", content: "ignored" },
      { role: "user" },
      "ignored",
    ]);

    expect(turns).toEqual([
      {
        role: "user",
        content: "first",
        createdAt: "2026-04-22T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "second",
        metadata: { source: "fixture" },
      },
    ]);
  });

  await runTest("includes fixture recent turns in RetrievalOutputs", () => {
    const recentTurns = mapRecentTurnFixtures([
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ]);
    const retrievals = buildRetrievalOutputs({
      plan: retrievalPlan,
      event,
      session,
      source: "replay_fixture",
      recentTurns,
    });

    expect(retrievals.recentTurns).toEqual(recentTurns);
    expect(retrievals.trace?.sections).toEqual({
      recentTurns: "mapped",
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

  await runTest("TurnPacket includes recent_turns only when provided", async () => {
    const emptyRetrievals = buildRetrievalOutputs({
      plan: retrievalPlan,
      event,
      session,
      source: "replay_fixture",
    });
    const populatedRetrievals = buildRetrievalOutputs({
      plan: retrievalPlan,
      event,
      session,
      source: "replay_fixture",
      recentTurns: [{ role: "user", content: "previous question" }],
    });
    const emptyPacket = await composeTurnPacket({
      event,
      session,
      decision,
      retrievalPlan,
      retrievals: emptyRetrievals,
    });
    const populatedPacket = await composeTurnPacket({
      event,
      session,
      decision,
      retrievalPlan,
      retrievals: populatedRetrievals,
    });

    expect(emptyPacket.context.sections.map((section) => section.key)).toEqual([]);
    expect(populatedPacket.context.sections.map((section) => section.key)).toEqual([
      "recent_turns",
    ]);
    expect(populatedPacket.dialogue.recentTurns).toEqual([
      { role: "user", content: "previous question" },
    ]);
  });

  await runTest("preview marks recent_turns present when packet section exists", async () => {
    const retrievals = buildRetrievalOutputs({
      plan: retrievalPlan,
      event,
      session,
      source: "replay_fixture",
      recentTurns: [
        { role: "user", content: "previous question" },
        { role: "assistant", content: "previous answer" },
      ],
    });
    const packet = await composeTurnPacket({ event, session, decision, retrievalPlan, retrievals });
    const preview = renderPromptPreview({ event, session, decision, retrievalPlan, retrievals, packet });

    expect(preview.contextSections.map((section) => section.key)).toEqual(["recent_turns"]);
    expect(preview.sections.context.summary.retrievalPresence).toEqual({
      recentTurns: true,
      memory: false,
      continuity: false,
      calendar: false,
      tasks: false,
      situational: false,
      tools: false,
    });
    expect(preview.missing).toEqual(["memory", "continuity", "calendar", "tasks", "situational", "tools"]);
    expect(preview.text).toContain("- [present] recent_turns");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext recent_turns parity tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext recent_turns parity tests passed.");
}

main();
