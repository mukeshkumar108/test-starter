/**
 * Unit tests for correction memory and cooldown guards.
 * Run with: pnpm tsx src/app/api/__tests__/correctionGuards.test.ts
 */

import {
  __test__buildChatMessages,
  __test__buildCorrectionGuardBlock,
  __test__buildCurrentSessionTruthsBlock,
  __test__extractCorrectionFactClaims,
  __test__extractCurrentSessionStatePatch,
  __test__mergeCorrectionFacts,
  __test__mergeCurrentSessionState,
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

  await runTest("extracts structured current session state from literal scene updates", () => {
    const patch = __test__extractCurrentSessionStatePatch(
      "I'm finally outside. The pasta bake was yesterday. Today was chicken and broccoli."
    );
    expect(patch["scene.location"]).toBe("outside");
    expect(patch["scene.phase"]).toBe("just_started");
    expect(patch["meal.yesterday"]).toBe("pasta_bake");
    expect(patch["meal.today"]).toBe("chicken_broccoli");
  });

  await runTest("merges current session state by slot overwrite", () => {
    const merged = __test__mergeCurrentSessionState(
      { "scene.location": "outside", "meal.today": "chicken" },
      { "scene.location": "home", "meal.yesterday": "pasta_bake" }
    );
    expect(merged["scene.location"]).toBe("home");
    expect(merged["meal.today"]).toBe("chicken");
    expect(merged["meal.yesterday"]).toBe("pasta_bake");
  });

  await runTest("injects structured current session state block into prompt stack", () => {
    const currentSessionTruthsBlock = __test__buildCurrentSessionTruthsBlock({
      state: {
        "meal.today": "chicken_broccoli",
        "scene.location": "outside",
      },
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
      value.startsWith("[CURRENT_SESSION_STATE]")
    );
    expect(truthIndex).toBe(1);
    expect(contents[truthIndex] ?? "").toContain("meal.today=chicken_broccoli");
    expect(contents[truthIndex] ?? "").toContain("scene.location=outside");
  });

  await runTest("latest scene location overwrites prior contradictory value", () => {
    const merged = __test__mergeCurrentSessionState(
      __test__extractCurrentSessionStatePatch("I'm outside."),
      __test__extractCurrentSessionStatePatch("I'm home now.")
    );
    expect(merged["scene.location"]).toBe("home");
  });

  await runTest("current session state block renders without contradictory slot duplicates", () => {
    const block = __test__buildCurrentSessionTruthsBlock({
      state: {
        "scene.location": "home",
        "meal.today": "chicken_broccoli",
      },
    });
    expect(block ?? "").toContain("scene.location=home");
    expect(block ?? "").toContain("meal.today=chicken_broccoli");
  });

  await runTest("current session state block does not duplicate legacy constraint keys", () => {
    const block = __test__buildCurrentSessionTruthsBlock({
      state: {
        "assistant.response_mode": "literal",
        "scene.location": "outside",
      },
    });
    expect(block ?? "").toContain("assistant.response_mode=literal");
    if ((block ?? "").includes("constraints.do_not_advance_scene")) {
      throw new Error("Unexpected duplicate constraints.do_not_advance_scene key");
    }
    if ((block ?? "").includes("constraints.first_sentence_anchor_latest_literal_user_update")) {
      throw new Error("Unexpected duplicate constraints.first_sentence_anchor_latest_literal_user_update key");
    }
    if ((block ?? "").includes("constraints.prefer_latest_literal_user_update")) {
      throw new Error("Unexpected duplicate constraints.prefer_latest_literal_user_update key");
    }
  });

  await runTest("scene-phase discipline block explicitly forbids advancing the scene", () => {
    const patch = __test__extractCurrentSessionStatePatch("I'm finally outside.");
    const block = __test__buildCurrentSessionTruthsBlock({ state: patch });
    expect(block ?? "").toContain("scene.phase=just_started");
    expect(block ?? "").toContain("do_not_advance_scene=true");
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
