/**
 * Integration-ish tests for router fallback + probing guard behavior.
 * Run with: pnpm tsx src/app/api/__tests__/chat.router-fallback-probing-guard.integration.test.ts
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
process.env.SYNAPSE_BASE_URL = "https://synapse.test";
process.env.SYNAPSE_TENANT_ID = "tenant-test";

import {
  __test__applyCooldownPolicy,
  __test__evaluateTacticEligibility,
  __test__runLibrarianReflex,
  __test__resetPostureStateCache,
  __test__resetUserStateCache,
  __test__resetOverlayStateCache,
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

async function testRouterFailureDoesNotOpenProbing() {
  const originalFetch = global.fetch;
  __test__resetPostureStateCache();
  __test__resetUserStateCache();
  __test__resetOverlayStateCache();

  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate TRIAGE")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    risk_level: "LOW",
                    pressure: "LOW",
                    capacity: "HIGH",
                    decision_paralysis: false,
                    permission: "EXPLICIT",
                    tactic_appetite: "HIGH",
                    rupture: "NONE",
                    rupture_confidence: 0.1,
                    should_run_router: true,
                    memory_query_eligible: false,
                    confidence: 0.9,
                    harm_if_wrong: "LOW",
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (prompt.includes("You are ROUTER")) {
        return new Response("router unavailable", { status: 503 });
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await __test__runLibrarianReflex({
      requestId: "req-fallback-guard",
      userId: "user-fallback-guard",
      personaId: "persona-fallback-guard",
      sessionId: "session-fallback-guard",
      transcript: "Help me unpack this pattern.",
      recentMessages: [],
      now: new Date("2026-02-27T10:00:00Z"),
      shouldTrace: false,
    });

    expect(Boolean(result), "Expected librarian result");
    expect(result?.postureSource === "fallback", "Expected fallback posture source when router fails");

    const cooldown = __test__applyCooldownPolicy({
      previousCooldownTurnsRemaining: 0,
      previousCooldownLastReason: null,
      triage: result!.triage,
      routerRunReason: result!.routerRunReason,
      routerOutput: result!.routerOutput,
    });

    const probingEligibility = __test__evaluateTacticEligibility({
      tactic: "curiosity_spiral",
      triage: result!.triage,
      cooldownTurnsRemaining: cooldown.cooldownTurnsRemaining,
    });

    expect(!probingEligibility.allowed, "Expected probing tactic blocked after router failure");
    expect(
      probingEligibility.vetoReasons.includes("cooldown_active"),
      "Expected cooldown_active veto after router failure"
    );

    const eligibleWithoutCooldown = __test__evaluateTacticEligibility({
      tactic: "curiosity_spiral",
      triage: result!.triage,
      cooldownTurnsRemaining: 0,
    });
    expect(
      eligibleWithoutCooldown.allowed,
      "Expected probing to remain policy-eligible when cooldown is removed"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testShouldRunRouterFalseSkipsRouterCall() {
  const originalFetch = global.fetch;
  __test__resetPostureStateCache();
  __test__resetUserStateCache();
  __test__resetOverlayStateCache();

  let routerCalls = 0;
  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate TRIAGE")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    risk_level: "LOW",
                    pressure: "MED",
                    capacity: "HIGH",
                    decision_paralysis: false,
                    permission: "IMPLICIT",
                    tactic_appetite: "NONE",
                    rupture: "NONE",
                    rupture_confidence: 0.1,
                    should_run_router: false,
                    memory_query_eligible: false,
                    confidence: 0.4,
                    harm_if_wrong: "HIGH",
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (prompt.includes("You are ROUTER")) {
        routerCalls += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "companion",
                    posture: "witness",
                    posture_confidence: 0.7,
                    explicit_topic_shift: false,
                    state_confidence: 0.5,
                    reason: "router should not run in this test",
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await __test__runLibrarianReflex({
      requestId: "req-router-skip",
      userId: "user-router-skip",
      personaId: "persona-router-skip",
      sessionId: "session-router-skip",
      transcript: "I feel unclear, I don't know where to start.",
      recentMessages: [],
      now: new Date("2026-02-27T11:00:00Z"),
      shouldTrace: false,
    });

    expect(Boolean(result), "Expected librarian result");
    expect(routerCalls === 0, "Expected no router call when should_run_router=false");
    expect(result?.routerRunReason === "skipped_triage_false", "Expected router run reason skipped_triage_false");
    expect(result?.routerOutput === null, "Expected no router output");
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  await runTest("router fallback path does not make probing tactics eager", testRouterFailureDoesNotOpenProbing);
  await runTest("should_run_router=false fully skips router call", testShouldRunRouterFalseSkipsRouterCall);
  console.log("Router fallback probing guard integration tests passed.");
}

main().catch((error) => {
  console.error("Unhandled test error:", error);
  process.exit(1);
});
