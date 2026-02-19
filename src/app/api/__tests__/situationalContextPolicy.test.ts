/**
 * Unit tests for deterministic situational context policy
 * Run with: pnpm tsx src/app/api/__tests__/situationalContextPolicy.test.ts
 */

import {
  __test__buildDeferredProfileContextLines,
  __test__buildSessionStartSituationalContext,
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
    notToContain(expected: string) {
      if (typeof actual === "string" && actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(expected)}`);
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
  await runTest("session-open companion keeps opener/steering and suppresses threads", () => {
    const text = __test__buildSessionStartSituationalContext({
      handoff: {
        opener: "It's afternoon, and it's been 5 hours since you last spoke; the main thing to hold right now is walk daily in morning.",
        steeringNote: "Start with presence before pressure.",
        steeringConfidence: "high",
        activeThreads: ["Walk daily in morning", "Clear kitchen worktop", "Ignored extra"],
      },
      intent: "companion",
      isDirectRequest: false,
    });
    expect(text).toContain("It's afternoon");
    expect(text).toContain("Steering note:");
    expect(text).notToContain("active threads");
  });

  await runTest("session-open momentum includes max 2 active threads in plain english", () => {
    const text = __test__buildSessionStartSituationalContext({
      handoff: {
        opener: "It's morning, and it's been 2 hours since you last spoke; the main thing to hold right now is finish proposal.",
        steeringNote: "Ask for one verifiable next step.",
        steeringConfidence: "high",
        activeThreads: ["Finish proposal draft", "Reply to Jordan", "Drop this extra"],
      },
      intent: "momentum",
      isDirectRequest: false,
    });
    expect(text).toContain("Right now the active threads are");
    expect(text).toContain("Finish proposal draft; Reply to Jordan");
    expect(text).notToContain("Drop this extra");
    expect(text).notToContain("|");
  });

  await runTest("relationships only inject on relationship posture or explicit name mention", () => {
    const baseProfile = {
      relationshipNames: ["Ashley"],
      relationshipsLine: "People currently in focus include Ashley.",
    };
    const none = __test__buildDeferredProfileContextLines({
      isSessionStart: false,
      profile: baseProfile,
      posture: "COMPANION",
      intent: "companion",
      isDirectRequest: false,
      transcript: "let's just chat",
      avoidanceOrDrift: false,
    });
    expect(none.length).toBe(0);

    const byPosture = __test__buildDeferredProfileContextLines({
      isSessionStart: false,
      profile: baseProfile,
      posture: "RELATIONSHIP",
      intent: "companion",
      isDirectRequest: false,
      transcript: "let's just chat",
      avoidanceOrDrift: false,
    });
    expect(byPosture[0] ?? "").toContain("Ashley");

    const byName = __test__buildDeferredProfileContextLines({
      isSessionStart: false,
      profile: baseProfile,
      posture: "COMPANION",
      intent: "companion",
      isDirectRequest: false,
      transcript: "Ashley texted me today",
      avoidanceOrDrift: false,
    });
    expect(byName[0] ?? "").toContain("Ashley");
  });

  await runTest("patterns and work context follow explicit triggers", () => {
    const lines = __test__buildDeferredProfileContextLines({
      isSessionStart: false,
      profile: {
        patternLine: "Pattern to watch: starts many threads quickly.",
        workContextLine: "Current work context is shipping reliability fixes.",
      },
      posture: "COMPANION",
      intent: "momentum",
      isDirectRequest: false,
      transcript: "what should i focus on now",
      avoidanceOrDrift: true,
    });
    expect(lines.length).toBe(2);
    expect(lines.join("\n")).toContain("Pattern to watch");
    expect(lines.join("\n")).toContain("Current work context");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nSituational context policy tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Situational context policy tests passed.");
}

main();
