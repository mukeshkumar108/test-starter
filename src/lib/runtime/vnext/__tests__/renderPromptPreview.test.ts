/**
 * Unit tests for vNext prompt/context preview rendering.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/renderPromptPreview.test.ts
 */

import type {
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
} from "../contracts";
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
      if (typeof actual !== "string" || !actual.includes(expected)) {
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
  text: "what did we discuss?",
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

async function previewFor(retrievals: RetrievalOutputs, plan: RetrievalPlan = retrievalPlan) {
  const packet = await composeTurnPacket({
    event,
    session,
    decision,
    retrievalPlan: plan,
    retrievals,
  });

  return renderPromptPreview({
    event,
    session,
    decision,
    retrievalPlan: plan,
    retrievals,
    packet,
  });
}

async function main() {
  await runTest("renders stable sparse preview without inventing context", async () => {
    const preview = await previewFor({});

    expect(preview.kind).toBe("vnext_prompt_preview");
    expect(preview.version).toBe("2026-04-22");
    expect(preview.sections.runtime.presence).toBe("present");
    expect(preview.sections.context.presence).toBe("missing");
    expect(preview.contextSections).toEqual([]);
    expect(preview.missing).toEqual([
      "recent_turns",
      "memory",
      "continuity",
      "calendar",
      "tasks",
      "situational",
      "tools",
      "context.sections",
    ]);
    expect(preview.text).toContain("- [missing] context.sections");
    expect(preview.trace.noExecution).toBe(true);
    expect(preview.trace.noGeneration).toBe(true);
  });

  await runTest("renders recent turns, memory, and continuity only when present", async () => {
    const preview = await previewFor(
      {
        recentTurns: [{ role: "assistant", content: "previous answer" }],
        memory: { facts: ["likes concise answers"] },
        continuity: { handover: "Continue lightly." },
      },
      {
        ...retrievalPlan,
        recentTurns: true,
        memory: true,
        continuity: true,
      }
    );

    expect(preview.sections.context.presence).toBe("present");
    expect(preview.contextSections.map((section) => section.key)).toEqual([
      "recent_turns",
      "memory",
      "continuity",
    ]);
    expect(preview.missing).toEqual(["calendar", "tasks", "situational", "tools"]);
    expect(preview.text).toContain("- [present] memory");
  });

  await runTest("renders situational and tool context when supplied", async () => {
    const preview = await previewFor(
      {
        situational: { weather: { summary: "rain" } },
        tools: {
          prefetches: [{ name: "weather.read", args: { location: "London" } }],
        },
      },
      {
        ...retrievalPlan,
        weather: true,
        toolPrefetches: [{ name: "weather.read", args: { location: "London" } }],
      }
    );

    expect(preview.contextSections.map((section) => section.key)).toEqual([
      "situational",
      "tools",
    ]);
    expect(preview.sections.context.summary.retrievalPresence).toEqual({
      recentTurns: false,
      memory: false,
      continuity: false,
      calendar: false,
      tasks: false,
      situational: true,
      tools: true,
    });
    expect(preview.trace.packet).toEqual({
      sectionCount: 2,
      sectionKeys: ["situational", "tools"],
    });
  });

  await runTest("trace clearly identifies parity-only usage", async () => {
    const preview = await previewFor({});

    expect(preview.trace).toEqual({
      source: "adapter",
      adapter: "renderPromptPreview",
      noExecution: true,
      noGeneration: true,
      noLegacyPromptAssembly: true,
      event: {
        modality: "text",
        timestampUtc: "2026-04-22T12:00:00.000Z",
      },
      session: {
        sessionId: "session-1",
        turnCount: 4,
      },
      retrievalPlan: {
        recentTurns: false,
        memory: false,
        continuity: false,
        calendar: false,
        tasks: false,
        web: false,
        weather: false,
        traffic: false,
      },
      packet: {
        sectionCount: 0,
        sectionKeys: [],
      },
      missing: [
        "recent_turns",
        "memory",
        "continuity",
        "calendar",
        "tasks",
        "situational",
        "tools",
        "context.sections",
      ],
      notes: [
        "parity_preview_only",
        "not_the_legacy_prompt",
        "not_used_for_execution",
      ],
    });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext renderPromptPreview tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext renderPromptPreview tests passed.");
}

main();
