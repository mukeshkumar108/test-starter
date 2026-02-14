/**
 * Unit tests for daily focus policy helpers in /api/chat
 * Run with: pnpm tsx src/app/api/__tests__/dailyFocusPolicy.test.ts
 */

import {
  __test__extractTodayFocus,
  __test__isMorningLocalWindow,
  __test__shouldTriggerDailyFocus,
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
  await runTest("morning window true at 08:00 local", () => {
    expect(__test__isMorningLocalWindow(new Date("2026-02-14T08:00:00"))).toBe(true);
  });

  await runTest("morning window false at 15:00 local", () => {
    expect(__test__isMorningLocalWindow(new Date("2026-02-14T15:00:00"))).toBe(false);
  });

  await runTest("daily focus triggers for momentum morning session start", () => {
    const trigger = __test__shouldTriggerDailyFocus({
      isSessionStart: true,
      now: new Date("2026-02-14T08:30:00"),
      intent: "momentum",
      posture: "COMPANION",
      riskLevel: "LOW",
      energy: "MED",
      hasTodayFocus: false,
    });
    expect(trigger).toBe(true);
  });

  await runTest("daily focus blocked in afternoon", () => {
    const trigger = __test__shouldTriggerDailyFocus({
      isSessionStart: true,
      now: new Date("2026-02-14T15:30:00"),
      intent: "momentum",
      posture: "MOMENTUM",
      riskLevel: "LOW",
      energy: "HIGH",
      hasTodayFocus: false,
    });
    expect(trigger).toBe(false);
  });

  await runTest("daily focus blocked when energy is LOW", () => {
    const trigger = __test__shouldTriggerDailyFocus({
      isSessionStart: true,
      now: new Date("2026-02-14T08:30:00"),
      intent: "momentum",
      posture: "MOMENTUM",
      riskLevel: "LOW",
      energy: "LOW",
      hasTodayFocus: false,
    });
    expect(trigger).toBe(false);
  });

  await runTest("extract focus supports hold", () => {
    const parsed = __test__extractTodayFocus("hold");
    expect(parsed?.status ?? null).toBe("hold");
  });

  await runTest("extract focus trims to 12 words", () => {
    const parsed = __test__extractTodayFocus(
      "Ship onboarding checklist and follow ups with product design legal finance and ops"
    );
    expect(parsed?.focus ?? "").toBe(
      "Ship onboarding checklist and follow ups with product design legal finance and"
    );
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nDaily focus policy tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Daily focus policy tests passed.");
}

main();
