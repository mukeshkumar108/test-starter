/**
 * Integration-ish tests for cooldown + probing guard behavior.
 * Run with: pnpm tsx src/app/api/__tests__/chat.cooldown.integration.test.ts
 */

process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "test";
process.env.CLERK_SECRET_KEY = "test";
process.env.POSTGRES_PRISMA_URL = "postgres://test";
process.env.POSTGRES_URL_NON_POOLING = "postgres://test";
process.env.BLOB_READ_WRITE_TOKEN = "test";
process.env.CLERK_WEBHOOK_SECRET = "test";
process.env.OPENROUTER_API_KEY = "test";
process.env.ELEVENLABS_API_KEY = "test";
process.env.ELEVENLABS_DEFAULT_VOICE_ID = "test";
process.env.LEMONFOX_API_KEY = "test";
process.env.OPENAI_API_KEY = "test";

import {
  __test__applyCooldownPolicy,
  __test__evaluateTacticEligibility,
} from "../chat/route";

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const lowRiskHighRunwayTriage = {
  risk_level: "LOW",
  pressure: "LOW",
  capacity: "HIGH",
  permission: "EXPLICIT",
  tactic_appetite: "HIGH",
  rupture: "NONE",
  rupture_confidence: 0,
  should_run_router: true,
  memory_query_eligible: false,
  confidence: 0.9,
  harm_if_wrong: "LOW",
};

async function testCooldownActivationAndDecay() {
  const strongRupture = __test__applyCooldownPolicy({
    previousCooldownTurnsRemaining: 0,
    previousCooldownLastReason: null,
    triage: {
      ...lowRiskHighRunwayTriage,
      rupture: "STRONG",
      rupture_confidence: 0.9,
      harm_if_wrong: "HIGH",
    },
    routerRunReason: "skipped_triage_false",
    routerOutput: null,
  });

  expect(strongRupture.cooldownTurnsRemaining === 3, "Expected 3-turn cooldown on strong rupture");
  expect(strongRupture.cooldownActivatedReason === "rupture_strong", "Expected strong rupture activation");

  const nextTurn = __test__applyCooldownPolicy({
    previousCooldownTurnsRemaining: strongRupture.cooldownTurnsRemaining,
    previousCooldownLastReason: strongRupture.cooldownLastReason,
    triage: lowRiskHighRunwayTriage,
    routerRunReason: "skipped_triage_false",
    routerOutput: null,
  });

  expect(nextTurn.cooldownTurnsRemaining === 2, "Expected cooldown to decrement by 1");

  const eligibility = __test__evaluateTacticEligibility({
    tactic: "curiosity_spiral",
    triage: lowRiskHighRunwayTriage,
    cooldownTurnsRemaining: nextTurn.cooldownTurnsRemaining,
  });

  expect(!eligibility.allowed, "Expected probing tactic to be blocked while cooldown active");
  expect(
    eligibility.vetoReasons.includes("cooldown_active"),
    "Expected cooldown_active veto reason"
  );
}

async function main() {
  await runTest("cooldown activates on strong rupture and blocks probing tactics", testCooldownActivationAndDecay);
  console.log("Cooldown integration tests passed.");
}

main().catch((error) => {
  console.error("Unhandled test error:", error);
  process.exit(1);
});
