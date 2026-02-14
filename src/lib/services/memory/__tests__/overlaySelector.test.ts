/**
 * Unit tests for overlay selection heuristics
 * Run with: pnpm tsx src/lib/services/memory/__tests__/overlaySelector.test.ts
 */

import type { OverlayDecision } from "../overlaySelector";
import {
  selectOverlay,
  normalizeTopicKey,
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
  await runTest("help me write an email -> output_task blocks overlays", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "output_task",
      isDirectRequest: true,
      isUrgent: false,
    });
    expect(policy).toMatchObject({ skip: true, reason: "output_task" });
  });

  await runTest("help me plan my day -> momentum allows overlays", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "momentum",
      isDirectRequest: true,
      isUrgent: false,
    });
    expect(policy).toMatchObject({ skip: false, reason: "allowed" });
  });

  await runTest("urgent I can't cope -> urgent blocks overlays", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "companion",
      isDirectRequest: true,
      isUrgent: true,
    });
    expect(policy).toMatchObject({ skip: true, reason: "urgent" });
  });

  await runTest("can you summarise this -> output_task blocks overlays", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "output_task",
      isDirectRequest: true,
      isUrgent: false,
    });
    expect(policy).toMatchObject({ skip: true, reason: "output_task" });
  });

  await runTest("casual help that was funny -> not urgent, not output_task", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "companion",
      isDirectRequest: false,
      isUrgent: false,
    });
    expect(policy).toMatchObject({ skip: false, reason: "allowed" });
  });

  await runTest("what should I focus on today? -> momentum allows overlays", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "momentum",
      isDirectRequest: true,
      isUrgent: false,
    });
    expect(policy).toMatchObject({ skip: false, reason: "allowed" });
  });

  await runTest("teach me stoicism -> learning allows overlays", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "learning",
      isDirectRequest: true,
      isUrgent: false,
    });
    expect(policy).toMatchObject({ skip: false, reason: "allowed" });
  });

  await runTest("relationship vent -> companion, curiosity possibly allowed", () => {
    const policy = shouldSkipOverlaySelection({
      intent: "companion",
      isDirectRequest: false,
      isUrgent: false,
    });
    expect(policy).toMatchObject({ skip: false, reason: "allowed" });
    const decision = selectOverlay({
      transcript: "I argued with my girlfriend and it got messy",
      overlayUsed: {},
    });
    expect(decision.overlayType).toBe("curiosity_spiral");
  });

  await runTest("curiosity triggers on narrative marker", () => {
    const decision = selectOverlay({
      transcript: "you won't believe what happened next",
      overlayUsed: {},
    });
    expect(decision.overlayType).toBe("curiosity_spiral");
  });

  await runTest("curiosity does not retrigger once already used", () => {
    const decision = selectOverlay({
      transcript: "can you draft an email",
      overlayUsed: { curiositySpiral: true },
    });
    expect(decision.overlayType).toBe("none");
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
