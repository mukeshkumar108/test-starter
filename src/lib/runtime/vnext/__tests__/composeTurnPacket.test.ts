/**
 * Unit tests for vNext TurnPacket composition.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/composeTurnPacket.test.ts
 */

import type {
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
} from "../contracts";
import { composeTurnPacket } from "../composeTurnPacket";

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
  sessionId: "session-1",
  modality: "text",
  text: "what did we discuss?",
  timestampUtc: "2026-04-22T12:00:00.000Z",
  timezone: "Europe/London",
};

const session: SessionContext = {
  sessionId: "session-1",
  isNewSession: false,
  turnCount: 5,
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
  toolPrefetches: [],
};

async function main() {
  await runTest("builds the canonical packet shape from sparse inputs", async () => {
    const retrievals: RetrievalOutputs = {};
    const packet = await composeTurnPacket({
      event,
      session,
      decision,
      retrievalPlan,
      retrievals,
    });

    expect(packet.runtime).toEqual({
      version: "vnext",
      modelTier: "T1",
      responseMode: "text",
    });
    expect(packet.user).toEqual({
      userId: "user-1",
      personaId: "persona-1",
      modality: "text",
      text: "what did we discuss?",
    });
    expect(packet.session).toBe(session);
    expect(packet.policy.decision).toBe(decision);
    expect(packet.context.retrievalPlan).toBe(retrievalPlan);
    expect(packet.context.retrievals).toBe(retrievals);
    expect(packet.context.sections).toEqual([]);
    expect(packet.dialogue).toEqual({
      recentTurns: [],
      currentTurn: "what did we discuss?",
    });
    expect(packet.metadata?.source).toBe("vnext_packet_builder");
    expect((packet.metadata?.trace as Record<string, unknown>)?.adapter).toBe("composeTurnPacket");
  });

  await runTest("uses transcript over text for voice-derived turns", async () => {
    const packet = await composeTurnPacket({
      event: {
        ...event,
        modality: "voice",
        text: "raw fallback",
        transcript: "clean transcript",
        audio: { mimeType: "audio/webm" },
      },
      session,
      decision: { ...decision, responseMode: "text_and_voice" },
      retrievalPlan,
      retrievals: {},
    });

    expect(packet.user.text).toBe("clean transcript");
    expect(packet.dialogue.currentTurn).toBe("clean transcript");
    expect((packet.metadata?.trace as Record<string, any>)?.event).toEqual({
      modality: "voice",
      timestampUtc: "2026-04-22T12:00:00.000Z",
      timezone: "Europe/London",
      hasAudio: true,
      attachmentCount: 0,
    });
  });

  await runTest("includes recent turns, memory, and continuity only when present", async () => {
    const retrievals: RetrievalOutputs = {
      recentTurns: [{ role: "assistant", content: "previous answer" }],
      memory: { facts: ["likes direct answers"], entities: ["Sophie"] },
      continuity: { handover: "Continue the thread lightly." },
    };
    const packet = await composeTurnPacket({
      event,
      session,
      decision,
      retrievalPlan: {
        ...retrievalPlan,
        recentTurns: true,
        memory: true,
        continuity: true,
      },
      retrievals,
    });

    expect(packet.dialogue.recentTurns).toEqual([
      { role: "assistant", content: "previous answer" },
    ]);
    expect(packet.context.sections.map((section) => section.key)).toEqual([
      "recent_turns",
      "memory",
      "continuity",
    ]);
    expect((packet.metadata?.trace as Record<string, any>)?.sections).toEqual({
      recentTurns: "populated",
      memory: "populated",
      continuity: "populated",
      calendar: "absent",
      tasks: "absent",
      situational: "absent",
      tools: "absent",
    });
  });

  await runTest("includes situational and tool sections when provided without executing them", async () => {
    const packet = await composeTurnPacket({
      event,
      session,
      decision: { ...decision, toolNeed: "possible" },
      retrievalPlan: {
        ...retrievalPlan,
        weather: true,
        toolPrefetches: [{ name: "weather.read", args: { location: "London" } }],
      },
      retrievals: {
        situational: { weather: { summary: "rain" } },
        tools: {
          prefetches: [{ name: "weather.read", args: { location: "London" } }],
        },
      },
    });

    expect(packet.context.sections.map((section) => section.key)).toEqual([
      "situational",
      "tools",
    ]);
    expect((packet.metadata?.trace as Record<string, any>)?.retrievalPlan).toEqual({
      recentTurns: false,
      memory: false,
      continuity: false,
      calendar: false,
      tasks: false,
      web: false,
      weather: true,
      traffic: false,
      toolPrefetchCount: 1,
    });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext composeTurnPacket tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext composeTurnPacket tests passed.");
}

main();
