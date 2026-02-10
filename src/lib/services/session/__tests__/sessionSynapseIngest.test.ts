/**
 * Unit tests for session-only Synapse ingest
 * Run with: pnpm tsx src/lib/services/session/__tests__/sessionSynapseIngest.test.ts
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
    SYNAPSE_TENANT_ID: "default",
    FEATURE_SYNAPSE_SESSION_INGEST: enabled ? "true" : "false",
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
  await runTest("session ingest runs when flag enabled", async () => {
    seedEnv(true);
    const { env } = await import("../../../../env");
    (env as any).FEATURE_SYNAPSE_SESSION_INGEST = "true";
    const { prisma } = await import("../../../prisma");
    const { closeStaleSessionIfAny } = await import("../sessionService");

    const session = {
      id: "sess-1",
      userId: "user-1",
      personaId: "persona-1",
      startedAt: new Date("2026-02-04T18:00:00Z"),
      lastActivityAt: new Date("2026-02-04T18:10:00Z"),
      endedAt: null,
    };

    (prisma.session.findFirst as any) = async () => session;
    (prisma.session.update as any) = async () => ({
      ...session,
      endedAt: new Date("2026-02-04T18:10:00Z"),
    });
    (prisma.message.findFirst as any) = async () => ({
      createdAt: new Date("2026-02-04T18:10:00Z"),
    });
    (prisma.message.findMany as any) = async () => [
      {
        role: "user",
        content: "hello",
        createdAt: new Date("2026-02-04T18:00:01Z"),
      },
      {
        role: "assistant",
        content: "hi",
        createdAt: new Date("2026-02-04T18:00:02Z"),
      },
    ];
    (prisma.synapseIngestTrace.create as any) = async () => null;
    (prisma.synapseIngestTrace.count as any) = async () => 0;

    let called = 0;
    let payloadSessionId: string | null = null;
    (globalThis as any).__synapseSessionIngestWithMetaOverride = async (payload: any) => {
      called += 1;
      payloadSessionId = payload.sessionId;
      return { ok: true, status: 200, ms: 1, url: "https://synapse.test/session/ingest", data: null };
    };

    await closeStaleSessionIfAny("user-1", "persona-1", new Date("2026-02-04T19:00:00Z"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    delete (globalThis as any).__synapseSessionIngestWithMetaOverride;

    expect(called).toBe(1);
    expect(payloadSessionId).toBe("sess-1");
  });

  await runTest("session ingest skips when flag disabled", async () => {
    seedEnv(false);
    const { env } = await import("../../../../env");
    (env as any).FEATURE_SYNAPSE_SESSION_INGEST = "false";
    const { prisma } = await import("../../../prisma");
    const { closeStaleSessionIfAny } = await import("../sessionService");

    const session = {
      id: "sess-2",
      userId: "user-2",
      personaId: "persona-2",
      startedAt: new Date("2026-02-04T18:00:00Z"),
      lastActivityAt: new Date("2026-02-04T18:10:00Z"),
      endedAt: null,
    };

    (prisma.session.findFirst as any) = async () => session;
    (prisma.session.update as any) = async () => ({
      ...session,
      endedAt: new Date("2026-02-04T18:10:00Z"),
    });
    (prisma.message.findFirst as any) = async () => ({
      createdAt: new Date("2026-02-04T18:10:00Z"),
    });
    (prisma.message.findMany as any) = async () => [];
    (prisma.synapseIngestTrace.create as any) = async () => null;
    (prisma.synapseIngestTrace.count as any) = async () => 0;

    let called = 0;
    (globalThis as any).__synapseSessionIngestWithMetaOverride = async () => {
      called += 1;
      return { ok: true, status: 200, ms: 1, url: "https://synapse.test/session/ingest", data: null };
    };

    await closeStaleSessionIfAny("user-2", "persona-2", new Date("2026-02-04T19:00:00Z"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    delete (globalThis as any).__synapseSessionIngestWithMetaOverride;

    expect(called).toBe(0);
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
