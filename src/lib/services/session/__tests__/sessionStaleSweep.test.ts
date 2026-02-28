/**
 * Unit tests for batch stale-session close sweeper.
 * Run with: pnpm tsx src/lib/services/session/__tests__/sessionStaleSweep.test.ts
 */

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function seedEnv() {
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
    FEATURE_SYNAPSE_SESSION_INGEST: "true",
    FEATURE_SESSION_SUMMARY: "false",
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
  seedEnv();
  const { prisma } = await import("../../../prisma");
  const { closeInactiveSessionsBatch } = await import("../sessionService");

  await runTest("closeInactiveSessionsBatch closes and triggers ingest", async () => {
    const sessions = [
      {
        id: "sess-close-1",
        userId: "user-1",
        personaId: "persona-1",
        startedAt: new Date("2026-02-04T18:00:00Z"),
        lastActivityAt: new Date("2026-02-04T18:10:00Z"),
      },
    ];

    (prisma.session.findMany as any) = async () => sessions;
    (prisma.session.updateMany as any) = async () => ({ count: 1 });
    (prisma.message.findMany as any) = async () => [];
    (prisma.synapseIngestTrace.create as any) = async () => null;
    (prisma.synapseIngestTrace.count as any) = async () => 0;
    (prisma.sessionState.findUnique as any) = async () => ({ state: {} });
    (prisma.sessionState.upsert as any) = async () => ({});

    let ingestCalls = 0;
    (globalThis as any).__synapseSessionIngestWithMetaOverride = async () => {
      ingestCalls += 1;
      return { ok: true, status: 200, ms: 1, url: "https://synapse.test/session/ingest", data: null };
    };

    const result = await closeInactiveSessionsBatch({
      now: new Date("2026-02-04T19:00:00Z"),
      inactivityMs: 10 * 60 * 1000,
      limit: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    delete (globalThis as any).__synapseSessionIngestWithMetaOverride;

    expect(result.scanned).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.skippedRace).toBe(0);
    expect(ingestCalls).toBe(1);
  });

  await runTest("closeInactiveSessionsBatch skips when update race loses", async () => {
    const sessions = [
      {
        id: "sess-race-1",
        userId: "user-2",
        personaId: "persona-2",
        startedAt: new Date("2026-02-04T18:00:00Z"),
        lastActivityAt: new Date("2026-02-04T18:10:00Z"),
      },
    ];

    (prisma.session.findMany as any) = async () => sessions;
    (prisma.session.updateMany as any) = async () => ({ count: 0 });

    let ingestCalls = 0;
    (globalThis as any).__synapseSessionIngestWithMetaOverride = async () => {
      ingestCalls += 1;
      return { ok: true, status: 200, ms: 1, url: "https://synapse.test/session/ingest", data: null };
    };

    const result = await closeInactiveSessionsBatch({
      now: new Date("2026-02-04T19:00:00Z"),
      inactivityMs: 10 * 60 * 1000,
      limit: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    delete (globalThis as any).__synapseSessionIngestWithMetaOverride;

    expect(result.scanned).toBe(1);
    expect(result.closed).toBe(0);
    expect(result.skippedRace).toBe(1);
    expect(ingestCalls).toBe(0);
  });

  await runTest("closeInactiveSessionsBatch dryRun does not mutate or ingest", async () => {
    const sessions = [
      {
        id: "sess-dry-1",
        userId: "user-3",
        personaId: "persona-3",
        startedAt: new Date("2026-02-04T18:00:00Z"),
        lastActivityAt: new Date("2026-02-04T18:10:00Z"),
      },
    ];

    let updateManyCalls = 0;
    (prisma.session.findMany as any) = async () => sessions;
    (prisma.session.updateMany as any) = async () => {
      updateManyCalls += 1;
      return { count: 1 };
    };

    let ingestCalls = 0;
    (globalThis as any).__synapseSessionIngestWithMetaOverride = async () => {
      ingestCalls += 1;
      return { ok: true, status: 200, ms: 1, url: "https://synapse.test/session/ingest", data: null };
    };

    const result = await closeInactiveSessionsBatch({
      now: new Date("2026-02-04T19:00:00Z"),
      inactivityMs: 10 * 60 * 1000,
      limit: 10,
      dryRun: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    delete (globalThis as any).__synapseSessionIngestWithMetaOverride;

    expect(result.scanned).toBe(1);
    expect(result.closed).toBe(0);
    expect(updateManyCalls).toBe(0);
    expect(ingestCalls).toBe(0);
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

