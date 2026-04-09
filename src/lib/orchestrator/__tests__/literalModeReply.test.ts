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

const requiredEnvDefaults: Record<string, string> = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_dummy",
  CLERK_SECRET_KEY: "sk_test_dummy",
  POSTGRES_PRISMA_URL: "postgres://user:pass@localhost:5432/db",
  POSTGRES_URL_NON_POOLING: "postgres://user:pass@localhost:5432/db",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_dummy",
  CLERK_WEBHOOK_SECRET: "whsec_dummy",
  OPENROUTER_API_KEY: "or_dummy",
  ELEVENLABS_API_KEY: "el_dummy",
  ELEVENLABS_DEFAULT_VOICE_ID: "voice_dummy",
  LEMONFOX_API_KEY: "lf_dummy",
  OPENAI_API_KEY: "oa_dummy",
};

for (const [key, value] of Object.entries(requiredEnvDefaults)) {
  if (!process.env[key]) process.env[key] = value;
}

async function main() {
  const {
    __test__enforceLiteralModeReply,
    __test__evaluateLiteralModeReply,
    __test__parseCurrentSessionStateBlock,
  } = await import("../runAssistantTurn");

  const outsideState = `[CURRENT_SESSION_STATE]
authoritative_for_current_session=true
prefer_over=bridge,handover,rolling_summary,prior_assistant_assumptions
prefer_latest_literal_user_update=true
do_not_advance_scene=true
first_sentence_anchor_latest_literal_user_update=true
assistant.response_mode=literal
scene.activity=walking
scene.location=outside
scene.phase=just_started`;

  const homeState = `[CURRENT_SESSION_STATE]
authoritative_for_current_session=true
prefer_over=bridge,handover,rolling_summary,prior_assistant_assumptions
prefer_latest_literal_user_update=true
do_not_advance_scene=true
first_sentence_anchor_latest_literal_user_update=true
assistant.response_mode=literal
scene.activity=walking
scene.location=home
scene.phase=arrived_home`;

  await runTest("literal-mode parser enables flags from current session state", () => {
    const flags = __test__parseCurrentSessionStateBlock(outsideState);
    expect(flags.enabled).toBe(true);
    expect(flags.firstSentenceAnchor).toBe(true);
    expect(flags.doNotAdvanceScene).toBe(true);
    expect(flags.state["scene.location"]).toBe("outside");
  });

  await runTest("checker flags interpretive outside reply and repair anchors it", () => {
    const flags = __test__parseCurrentSessionStateBlock(outsideState);
    const check = __test__evaluateLiteralModeReply({
      transcript: "I'm finally outside.",
      assistantText:
        "The air feels different outside, doesn't it? I hope the walk does you good.",
      flags,
    });
    expect(check.failed).toBe(true);
    expect(check.reasons.join("|")).toContain("first_sentence_not_anchored");
    expect(check.reasons.join("|")).toContain("interpretive_first_sentence");

    const repaired = __test__enforceLiteralModeReply({
      transcript: "I'm finally outside.",
      assistantText:
        "The air feels different outside, doesn't it? I hope the walk does you good.",
      currentSessionTruthsBlock: outsideState,
    });
    expect(repaired.repaired).toBe(true);
    expect(repaired.assistantText).toBe("You're outside now. What are you noticing as you start the walk?");
  });

  await runTest("checker flags home reply that advances the scene and repairs it", () => {
    const flags = __test__parseCurrentSessionStateBlock(homeState);
    const check = __test__evaluateLiteralModeReply({
      transcript: "I'm home now.",
      assistantText: "You made it. How was the walk?",
      flags,
    });
    expect(check.failed).toBe(true);
    expect(check.reasons.join("|")).toContain("first_sentence_not_anchored");
    expect(check.reasons.join("|")).toContain("scene_advanced_beyond_evidence");

    const repaired = __test__enforceLiteralModeReply({
      transcript: "I'm home now.",
      assistantText: "You made it. How was the walk?",
      currentSessionTruthsBlock: homeState,
    });
    expect(repaired.repaired).toBe(true);
    expect(repaired.assistantText).toBe("You're home now. How are you feeling?");
  });

  await runTest("checker flags resurfaced overwritten meal fact", () => {
    const mealState = `[CURRENT_SESSION_STATE]
authoritative_for_current_session=true
prefer_over=bridge,handover,rolling_summary,prior_assistant_assumptions
prefer_latest_literal_user_update=true
do_not_advance_scene=true
first_sentence_anchor_latest_literal_user_update=true
assistant.response_mode=literal
meal.today=chicken_broccoli
meal.yesterday=pasta_bake`;
    const flags = __test__parseCurrentSessionStateBlock(mealState);
    const check = __test__evaluateLiteralModeReply({
      transcript: "Pasta bake was yesterday. Chicken and broccoli was today.",
      assistantText: "The pasta bake sounds good for tonight.",
      flags,
    });
    expect(check.failed).toBe(true);
    expect(check.reasons.join("|")).toContain("overwritten_fact_resurfaced");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nLiteral mode reply tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Literal mode reply tests passed.");
}

main();
