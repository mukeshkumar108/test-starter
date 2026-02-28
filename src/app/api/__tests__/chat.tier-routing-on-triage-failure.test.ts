/**
 * Unit tests for base tier routing on triage failures.
 * Run with: pnpm tsx src/app/api/__tests__/chat.tier-routing-on-triage-failure.test.ts
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

import { __test__resolveBaseTierDecision } from "../chat/route";

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

async function testFallbackForcesT1() {
  const decision = __test__resolveBaseTierDecision({
    triageSource: "fallback",
    riskLevel: "MED",
    posture: "RECOVERY",
    pressure: "LOW",
    stanceSelected: "none",
    moment: null,
    intent: "companion",
    isDirectRequest: false,
    isUrgent: false,
  });

  expect(decision.tier === "T1", "Expected fallback triage source to force T1");
  expect(decision.reason === "triage_failure_force_t1", "Expected triage failure T1 reason");
}

async function testModelSourceUsesNormalTiering() {
  const decision = __test__resolveBaseTierDecision({
    triageSource: "model",
    riskLevel: "LOW",
    posture: "RELATIONSHIP",
    pressure: "LOW",
    stanceSelected: "none",
    moment: null,
    intent: "companion",
    isDirectRequest: false,
    isUrgent: false,
  });

  expect(decision.tier === "T2", "Expected normal model source to preserve depth routing");
  expect(decision.reason === "companion_depth", "Expected companion_depth reason for relationship posture");
}

async function main() {
  await runTest("triage fallback forces T1 base tier", testFallbackForcesT1);
  await runTest("model triage source keeps normal depth routing", testModelSourceUsesNormalTiering);
  console.log("Tier routing on triage failure tests passed.");
}

main().catch((error) => {
  console.error("Unhandled test error:", error);
  process.exit(1);
});

