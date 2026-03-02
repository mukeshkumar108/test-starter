/**
 * Integration-ish tests for clarity stance burst behavior.
 * Run with: pnpm tsx src/app/api/__tests__/chat.clarity.integration.test.ts
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

import { __test__applyClarityBurstPolicy } from "../chat/route";

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

async function testClarityFiresAndPersistsThenResolves() {
  const fired = __test__applyClarityBurstPolicy({
    transcript: "I don't know what to focus on. I have too many things.",
    overlayPolicySkip: false,
    safetyRiskOverride: false,
    decisionParalysis: true,
    capacity: "MED",
    rupture: "NONE",
    clarityBurstActive: false,
    clarityPhase: 1,
  });

  expect(fired.shouldApply, "Expected clarity to fire when decision_paralysis=true");
  expect(fired.nextBurstActive, "Expected clarity burst to activate");
  expect(!fired.resolved, "Expected clarity not resolved on first stuck turn");

  const continued = __test__applyClarityBurstPolicy({
    transcript: "The real blocker is I keep avoiding the first hard part.",
    overlayPolicySkip: false,
    safetyRiskOverride: false,
    decisionParalysis: false,
    capacity: "MED",
    rupture: "NONE",
    clarityBurstActive: fired.nextBurstActive,
    clarityPhase: fired.nextPhase,
  });

  expect(continued.shouldApply, "Expected clarity to persist across turns while burst active");
  expect(continued.nextBurstActive, "Expected clarity burst to stay active");
  expect(!continued.resolved, "Expected clarity unresolved before commitment");

  const resolved = __test__applyClarityBurstPolicy({
    transcript: "I will send the project brief by tomorrow at 10am.",
    overlayPolicySkip: false,
    safetyRiskOverride: false,
    decisionParalysis: false,
    capacity: "MED",
    rupture: "NONE",
    clarityBurstActive: continued.nextBurstActive,
    clarityPhase: continued.nextPhase,
  });

  expect(!resolved.shouldApply, "Expected clarity stance to stop after concrete commitment");
  expect(!resolved.nextBurstActive, "Expected clarity burst to deactivate on resolution");
  expect(resolved.resolved, "Expected clarity_resolved signal on commitment detection");
}

async function main() {
  await runTest(
    "clarity firing, persistence, and resolution on commitment detection",
    testClarityFiresAndPersistsThenResolves
  );
  console.log("Clarity integration tests passed.");
}

main().catch((error) => {
  console.error("Unhandled test error:", error);
  process.exit(1);
});
