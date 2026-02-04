/**
 * Unit tests for FEATURE_SHADOW_JUDGE flag in /api/chat
 * Run with: pnpm tsx src/app/api/__tests__/chat.shadow-judge-flag.test.ts
 */

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function seedEnv(enabled: boolean) {
  const required = {
    NODE_ENV: "test",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "test",
    CLERK_SECRET_KEY: "test",
    POSTGRES_PRISMA_URL: "postgres://test",
    POSTGRES_URL_NON_POOLING: "postgres://test",
    BLOB_READ_WRITE_TOKEN: "test",
    CLERK_WEBHOOK_SECRET: "test",
    OPENROUTER_API_KEY: "test",
    ELEVENLABS_API_KEY: "test",
    ELEVENLABS_DEFAULT_VOICE_ID: "test",
    LEMONFOX_API_KEY: "test",
    OPENAI_API_KEY: "test",
    FEATURE_SHADOW_JUDGE: enabled ? "true" : "false",
  };
  for (const [key, value] of Object.entries(required)) {
    process.env[key] = value;
  }
}

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function main() {
  await runTest("shadow judge runs when flag enabled", async () => {
    seedEnv(true);
    const route = await import(`../chat/route?case=enabled_${Date.now()}`);
    let calls = 0;
    (globalThis as any).__shadowJudgeFlagOverride = true;
    (globalThis as any).__processShadowPathOverride = async () => {
      calls += 1;
    };

    (route as any).__test__runShadowJudgeIfEnabled({
      userId: "user-1",
      personaId: "persona-1",
      userMessage: "hello",
      assistantResponse: "hi",
      currentSessionState: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    delete (globalThis as any).__processShadowPathOverride;
    delete (globalThis as any).__shadowJudgeFlagOverride;

    expect(calls).toBe(1);
  });

  await runTest("shadow judge skips when flag disabled", async () => {
    seedEnv(false);
    const route = await import(`../chat/route?case=disabled_${Date.now()}`);
    let calls = 0;
    (globalThis as any).__shadowJudgeFlagOverride = false;
    (globalThis as any).__processShadowPathOverride = async () => {
      calls += 1;
    };

    (route as any).__test__runShadowJudgeIfEnabled({
      userId: "user-2",
      personaId: "persona-2",
      userMessage: "hello",
      assistantResponse: "hi",
      currentSessionState: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    delete (globalThis as any).__processShadowPathOverride;
    delete (globalThis as any).__shadowJudgeFlagOverride;

    expect(calls).toBe(0);
  });

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.error("Test failures:");
    for (const f of failed) {
      console.error(`- ${f.name}: ${f.error}`);
    }
    process.exit(1);
  } else {
    console.log(`All ${results.length} tests passed.`);
  }
}

main().catch((error) => {
  console.error("Unhandled test error:", error);
  process.exit(1);
});
