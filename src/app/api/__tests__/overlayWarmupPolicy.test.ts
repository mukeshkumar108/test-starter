/**
 * Unit tests for overlay warmup/runway guards.
 * Run with: pnpm tsx src/app/api/__tests__/overlayWarmupPolicy.test.ts
 */

import {
  __test__shouldForceSessionWarmupOverlaySkip,
  __test__shouldHoldOverlayUntilRunway,
} from "../chat/route";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
  await runTest("session start first-turn companion opener skips overlays", () => {
    const skip = __test__shouldForceSessionWarmupOverlaySkip({
      isSessionStart: true,
      recentMessageCount: 0,
      intent: "companion",
      isUrgent: false,
      isDirectRequest: false,
    });
    expect(skip).toBe(true);
  });

  await runTest("session start first-turn momentum direct request does not force warmup skip", () => {
    const skip = __test__shouldForceSessionWarmupOverlaySkip({
      isSessionStart: true,
      recentMessageCount: 0,
      intent: "momentum",
      isUrgent: false,
      isDirectRequest: true,
    });
    expect(skip).toBe(false);
  });

  await runTest("non-first turn does not force warmup skip", () => {
    const skip = __test__shouldForceSessionWarmupOverlaySkip({
      isSessionStart: true,
      recentMessageCount: 2,
      intent: "companion",
      isUrgent: false,
      isDirectRequest: false,
    });
    expect(skip).toBe(false);
  });

  await runTest("holds accountability_tug until one back-and-forth exists", () => {
    const hold = __test__shouldHoldOverlayUntilRunway({
      overlayType: "accountability_tug",
      recentMessageCount: 1,
    });
    expect(hold).toBe(true);
  });

  await runTest("allows accountability_tug after runway", () => {
    const hold = __test__shouldHoldOverlayUntilRunway({
      overlayType: "accountability_tug",
      recentMessageCount: 2,
    });
    expect(hold).toBe(false);
  });

  await runTest("does not hold curiosity_spiral overlay", () => {
    const hold = __test__shouldHoldOverlayUntilRunway({
      overlayType: "curiosity_spiral",
      recentMessageCount: 0,
    });
    expect(hold).toBe(false);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nOverlay warmup policy tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Overlay warmup policy tests passed.");
}

main();
