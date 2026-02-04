/**
 * Unit tests for Synapse ingest wiring in /api/chat
 * Run with: pnpm tsx src/app/api/__tests__/chat.synapse-ingest.test.ts
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
    SYNAPSE_BASE_URL: "https://synapse.test",
    SYNAPSE_TENANT_ID: "tenant-test",
    FEATURE_SYNAPSE_INGEST: enabled ? "true" : "false",
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
  await runTest("ingest called twice when feature enabled", async () => {
    seedEnv(true);
    const route = await import("../chat/route");
    const calls: Array<{ role: string; text: string }> = [];

    (globalThis as any).__synapseIngestOverride = async (payload: any) => {
      calls.push({ role: payload.role, text: payload.text });
      return { status: 200 };
    };

    (route as any).__test__fireAndForgetSynapseIngest({
      requestId: "req-1",
      userId: "user-1",
      personaId: "persona-1",
      sessionId: "session-1",
      transcript: "hello",
      assistantText: "hi there",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    delete (globalThis as any).__synapseIngestOverride;

    expect(calls.length).toBe(2);
  });

  await runTest("ingest not called when feature disabled", async () => {
    seedEnv(false);
    const route = await import("../chat/route");
    const calls: Array<{ role: string; text: string }> = [];

    (globalThis as any).__synapseIngestOverride = async (payload: any) => {
      calls.push({ role: payload.role, text: payload.text });
      return { status: 200 };
    };

    if (process.env.FEATURE_SYNAPSE_INGEST === "true") {
      (route as any).__test__fireAndForgetSynapseIngest({
        requestId: "req-2",
        userId: "user-2",
        personaId: "persona-2",
        sessionId: "session-2",
        transcript: "hello",
        assistantText: "hi there",
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    delete (globalThis as any).__synapseIngestOverride;

    expect(calls.length).toBe(0);
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
