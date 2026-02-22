/**
 * Unit tests for overlay family selection heuristics
 * Run with: pnpm tsx src/lib/services/memory/__tests__/overlaySelector.test.ts
 */

import {
  normalizeTopicKey,
  selectOverlay,
  shouldSkipOverlaySelection,
} from "../overlaySelector";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toMatchObject(expected: Partial<T>) {
      for (const [key, value] of Object.entries(expected)) {
        if ((actual as any)[key] !== value) {
          throw new Error(`Expected ${key} to be ${JSON.stringify(value)}, got ${JSON.stringify((actual as any)[key])}`);
        }
      }
    },
  };
}

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  await runTest("output_task intent blocks overlay selection at policy layer", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "output_task",
      isDirectRequest: true,
      isUrgent: false,
    });
    expect(policy).toMatchObject({ skip: true, reason: "output_task" });
  });

  await runTest("witness selected on grief/high-pressure text", () => {
    const decision = selectOverlay({
      transcript: "I can't stop thinking about the funeral and I miss her",
      posture: "COMPANION",
      conflictSignals: {
        pressure: "HIGH",
        riskLevel: "MED",
      },
      openLoops: ["finish portfolio"],
      commitments: [],
      overlayUsed: {},
      now: new Date("2026-02-22T12:00:00Z"),
    });
    expect(decision.stanceOverlay).toBe("witness");
    expect(decision.tacticOverlay).toBe("none");
  });

  await runTest("repair_and_forward selected for relationship repair intent", () => {
    const decision = selectOverlay({
      transcript: "How do I fix things with my daughter after that argument?",
      posture: "RELATIONSHIP",
      conflictSignals: { pressure: "MED", riskLevel: "LOW" },
      overlayUsed: {},
      openLoops: ["call daughter"],
      commitments: [],
      now: new Date("2026-02-22T12:00:00Z"),
    });
    expect(decision.stanceOverlay).toBe("repair_and_forward");
  });

  await runTest("excavator selected on circling/unsaid signal", () => {
    const decision = selectOverlay({
      transcript: "idk why I keep doing this, part of me wants out but part of me doesn't",
      posture: "COMPANION",
      conflictSignals: { pressure: "LOW", riskLevel: "LOW" },
      overlayUsed: {},
      openLoops: [],
      commitments: [],
      now: new Date("2026-02-22T12:00:00Z"),
    });
    expect(decision.stanceOverlay).toBe("excavator");
  });

  await runTest("high_standards_friend selected on explicit standards ask", () => {
    const decision = selectOverlay({
      transcript: "Push me and hold me accountable this week",
      posture: "MOMENTUM",
      conflictSignals: { pressure: "MED", riskLevel: "LOW" },
      overlayUsed: {},
      openLoops: ["finish portfolio"],
      commitments: [],
      now: new Date("2026-02-22T12:00:00Z"),
    });
    expect(decision.stanceOverlay).toBe("high_standards_friend");
  });

  await runTest("witness suppresses accountability_tug", () => {
    const decision = selectOverlay({
      transcript: "I feel overwhelmed and can we just sit with this for a minute",
      posture: "COMPANION",
      conflictSignals: { pressure: "HIGH", riskLevel: "MED" },
      overlayUsed: {},
      openLoops: ["finish portfolio"],
      commitments: [],
      now: new Date("2026-02-22T12:00:00Z"),
    });
    expect(decision.stanceOverlay).toBe("witness");
    expect(decision.tacticOverlay).toBe("none");
    expect(decision.suppressionReason ?? "").toBe("witness_high_pressure");
  });

  await runTest("high_standards_friend allows accountability_tug", () => {
    const decision = selectOverlay({
      transcript: "Push me and hold me accountable. I keep avoiding the proposal.",
      posture: "MOMENTUM",
      conflictSignals: { pressure: "MED", riskLevel: "LOW" },
      overlayUsed: {},
      openLoops: ["finish proposal"],
      commitments: [],
      now: new Date("2026-02-22T12:00:00Z"),
    });
    expect(decision.stanceOverlay).toBe("high_standards_friend");
    expect(decision.tacticOverlay).toBe("accountability_tug");
    expect(normalizeTopicKey(decision.topicKey ?? "")).toBe("finish proposal");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nOverlay selector tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Overlay selector tests passed.");
}

main();
