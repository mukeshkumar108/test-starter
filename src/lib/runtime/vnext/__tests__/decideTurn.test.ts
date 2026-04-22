/**
 * Unit tests for vNext TurnDecision adapter.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/decideTurn.test.ts
 */

import type { SessionContext, TurnEvent } from "../contracts";
import { decideTurn, LEGACY_DECISION_SIGNALS_METADATA_KEY } from "../decideTurn";

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

const baseSession: SessionContext = {
  sessionId: "session-1",
  isNewSession: false,
  turnCount: 2,
};

function event(metadata?: Record<string, unknown>, modality: TurnEvent["modality"] = "text"): TurnEvent {
  return {
    userId: "user-1",
    personaId: "persona-1",
    modality,
    text: "hello",
    timestampUtc: "2026-04-22T12:00:00.000Z",
    metadata,
  };
}

async function main() {
  await runTest("defaults conservatively when legacy signals are absent", async () => {
    const decision = await decideTurn(event(), baseSession);

    expect(decision.intent).toBe("unknown");
    expect(decision.sensitivity).toBe("low");
    expect(decision.toolNeed).toBe("none");
    expect(decision.contextNeeds.memory).toBe(false);
    expect(decision.modelTier).toBe("T1");
    expect(decision.trace?.source).toBe("stub");
    expect(decision.trace?.reasons ?? []).toContain("missing_legacy_decision_signals");
  });

  await runTest("adapts explicit legacy intent, memory, and model routing signals", async () => {
    const decision = await decideTurn(
      event({
        [LEGACY_DECISION_SIGNALS_METADATA_KEY]: {
          riskLevel: "MED",
          intent: "momentum",
          pressure: "LOW",
          posture: "MOMENTUM",
          memoryQueryEligible: true,
          confidence: 0.7,
          reasons: ["legacy_triage"],
        },
      }),
      baseSession
    );

    expect(decision.intent).toBe("momentum");
    expect(decision.sensitivity).toBe("medium");
    expect(decision.contextNeeds.memory).toBe(true);
    expect(decision.modelTier).toBe("T1");
    expect(decision.trace?.source).toBe("adapter");
    expect(decision.trace?.confidence).toBe(0.7);
    expect(decision.trace?.reasons ?? []).toContain("legacy_triage");
  });

  await runTest("mirrors legacy high-risk safety override to T1", async () => {
    const decision = await decideTurn(
      event({
        [LEGACY_DECISION_SIGNALS_METADATA_KEY]: {
          riskLevel: "HIGH",
          intent: "companion",
          pressure: "HIGH",
        },
      }),
      baseSession
    );

    expect(decision.sensitivity).toBe("high");
    expect(decision.modelTier).toBe("T1");
    expect(decision.policyFlags?.requireSafetyTemplate).toBe(true);
    expect(decision.trace?.legacy?.routeSafetyOverride).toBe(true);
  });

  await runTest("keeps explicit legacy model tier when provided", async () => {
    const decision = await decideTurn(
      event({
        [LEGACY_DECISION_SIGNALS_METADATA_KEY]: {
          riskLevel: "LOW",
          intent: "companion",
          modelTier: "T3",
        },
      }),
      baseSession
    );

    expect(decision.modelTier).toBe("T3");
    expect(decision.reasoningEffort).toBe("high");
    expect(decision.trace?.legacy?.routeSafetyOverride).toBe(false);
  });

  await runTest("uses voice response mode for voice modality and session continuity flag", async () => {
    const decision = await decideTurn(
      event(undefined, "voice"),
      { ...baseSession, isNewSession: true, turnCount: 1 }
    );

    expect(decision.responseMode).toBe("text_and_voice");
    expect(decision.policyFlags?.continuityMode).toBe("light");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext decideTurn tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext decideTurn tests passed.");
}

main();

