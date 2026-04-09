/**
 * Unit tests for correction memory and cooldown guards.
 * Run with: pnpm tsx src/app/api/__tests__/correctionGuards.test.ts
 */

import {
  __test__buildChatMessages,
  __test__buildCorrectionGuardBlock,
  __test__buildCurrentSessionTruthsBlock,
  __test__extractCorrectionFactClaims,
  __test__extractCurrentSessionTruthClaims,
  __test__mergeCorrectionFacts,
  __test__mergeCurrentSessionTruths,
  __test__nextCorrectionOverlayCooldownTurns,
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
    toBeGreaterThan(expected: number) {
      if (!(Number(actual) > expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be > ${expected}`);
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
  await runTest("extracts correction claims from movie-time correction", () => {
    const claims = __test__extractCorrectionFactClaims(
      "What movie? It's not movie time, stop making shit up."
    );
    expect(claims.length).toBeGreaterThan(1);
    expect(claims.join(" ")).toContain("Do not assume user is watching a movie");
  });

  await runTest("merges correction facts with dedupe + cap", () => {
    const existing = ["A", "B", "C", "D", "E", "F"];
    const merged = __test__mergeCorrectionFacts(existing, ["F", "G", "A"]);
    expect(merged.length).toBe(6);
    expect(merged.join("|")).toContain("G");
  });

  await runTest("cooldown runs for 2 turns after correction", () => {
    const t0 = __test__nextCorrectionOverlayCooldownTurns(0, true);
    const t1 = __test__nextCorrectionOverlayCooldownTurns(t0, false);
    const t2 = __test__nextCorrectionOverlayCooldownTurns(t1, false);
    expect(t0).toBe(2);
    expect(t1).toBe(1);
    expect(t2).toBe(0);
  });

  await runTest("builds correction guard block when corrections exist", () => {
    const block = __test__buildCorrectionGuardBlock([
      "Do not assume user is watching a movie unless confirmed this session.",
    ]);
    expect(block ?? "").toContain("[SESSION_FACT_CORRECTIONS]");
    expect(block ?? "").toContain("Do not reintroduce corrected assumptions");
  });

  await runTest("extracts current session truths from literal scene updates", () => {
    const truths = __test__extractCurrentSessionTruthClaims(
      "I'm finally outside. The pasta bake was yesterday. Today was chicken and broccoli."
    );
    expect(truths.join(" | ")).toContain("I'm finally outside.");
    expect(truths.join(" | ")).toContain("The pasta bake was yesterday.");
  });

  await runTest("merges current session truths with dedupe + cap", () => {
    const existing = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const merged = __test__mergeCurrentSessionTruths(existing, ["H", "I", "A"]);
    expect(merged.length).toBe(8);
    expect(merged.join("|")).toContain("I");
  });

  await runTest("injects current session truths block into prompt stack", () => {
    const currentSessionTruthsBlock = __test__buildCurrentSessionTruthsBlock({
      truths: ["Today was chicken and broccoli.", "I'm finally outside."],
      corrections: ["Do not reintroduce pasta bake as today's meal."],
    });
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      currentSessionTruthsBlock,
      overlayBlock: null,
      supplementalContext: null,
      recentMessages: [],
      transcript: "Sophie are you there",
    });

    const contents = messages.map((message) => message.content);
    const truthIndex = contents.findIndex((value) =>
      value.startsWith("[CURRENT_SESSION_TRUTHS]")
    );
    expect(truthIndex).toBe(1);
    expect(contents[truthIndex] ?? "").toContain("Today was chicken and broccoli.");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nCorrection guard tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Correction guard tests passed.");
}

main();
