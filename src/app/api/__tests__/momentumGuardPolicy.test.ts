/**
 * Unit tests for momentum guard block injection.
 * Run with: pnpm tsx src/app/api/__tests__/momentumGuardPolicy.test.ts
 */

import {
  __test__buildChatMessages,
  __test__buildMomentumGuardBlock,
  __test__isLateNightMomentumWindow,
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
    toContain(expected: string) {
      if (typeof actual !== "string" || !actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
      }
    },
    toBeTrue() {
      if (actual !== true) {
        throw new Error(`Expected true, got ${JSON.stringify(actual)}`);
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
  await runTest("late-night window true at 01:00", () => {
    expect(__test__isLateNightMomentumWindow(1)).toBe(true);
  });

  await runTest("late-night window false at 08:00", () => {
    expect(__test__isLateNightMomentumWindow(8)).toBe(false);
  });

  await runTest("momentum guard block includes late-night softening", () => {
    const block = __test__buildMomentumGuardBlock({ intent: "momentum", localHour: 1 });
    expect(block ?? "").toContain("Late-night mode");
    expect(block ?? "").toContain("do not repeat the same setup/check question");
  });

  await runTest("non-momentum intent does not inject momentum guard", () => {
    const block = __test__buildMomentumGuardBlock({ intent: "companion", localHour: 1 });
    expect(block).toBe(null);
  });

  await runTest("buildChatMessages inserts momentum guard after posture", () => {
    const block = __test__buildMomentumGuardBlock({ intent: "momentum", localHour: 1 });
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      momentumGuardBlock: block,
      recentMessages: [],
      transcript: "hello",
    });
    const contents = messages.map((message) => message.content);
    const postureIndex = contents.findIndex((value) => value.startsWith("[CONVERSATION_POSTURE]"));
    const guardIndex = contents.findIndex((value) => value.includes("[MOMENTUM_GUARD]"));
    expect(postureIndex >= 0).toBeTrue();
    expect(guardIndex).toBe(postureIndex);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nMomentum guard tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Momentum guard tests passed.");
}

main();
