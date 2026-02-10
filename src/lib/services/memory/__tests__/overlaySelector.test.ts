/**
 * Unit tests for overlay selection heuristics
 * Run with: pnpm tsx src/lib/services/memory/__tests__/overlaySelector.test.ts
 */

import type { OverlayDecision } from "../overlaySelector";
import {
  selectOverlay,
  normalizeTopicKey,
  isDirectTaskRequest,
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
  await runTest("curiosity triggers on narrative marker", () => {
    const decision = selectOverlay({
      transcript: "you won't believe what happened next",
      overlayUsed: {},
    });
    expect(decision.overlayType).toBe("curiosity_spiral");
  });

  await runTest("curiosity does not trigger on direct task request", () => {
    const decision = selectOverlay({
      transcript: "can you draft an email",
      overlayUsed: {},
    });
    expect(decision.overlayType).toBe("none");
    expect(isDirectTaskRequest("can you draft an email")).toBe(true);
  });

  await runTest("accountability tug triggers on casual opener + open loop", () => {
    const decision = selectOverlay({
      transcript: "hey",
      openLoops: ["finish portfolio"],
      commitments: [],
      overlayUsed: {},
      now: new Date("2026-02-10T10:00:00Z"),
    });
    expect(decision).toMatchObject({
      overlayType: "accountability_tug",
      triggerReason: "accountability_tug",
    });
    expect(normalizeTopicKey(decision.topicKey ?? "")).toBe("finish portfolio");
  });

  await runTest("accountability tug respects backoff", () => {
    const now = new Date("2026-02-10T10:00:00Z");
    const decision = selectOverlay({
      transcript: "hey",
      openLoops: ["finish portfolio"],
      commitments: [],
      overlayUsed: {},
      now,
      tugBackoff: { "finish portfolio": new Date(now.getTime() + 1000).toISOString() },
    });
    expect(decision.overlayType).toBe("none");
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
