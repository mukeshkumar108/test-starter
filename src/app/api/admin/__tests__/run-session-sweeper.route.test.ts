/**
 * Route tests for admin session sweeper auth paths.
 * Run with: pnpm tsx src/app/api/admin/__tests__/run-session-sweeper.route.test.ts
 */

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function seedEnv(adminSecret?: string) {
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
  } as const;
  for (const [key, value] of Object.entries(required)) {
    process.env[key] = value;
  }
  if (typeof adminSecret === "string") {
    process.env.ADMIN_SECRET = adminSecret;
  } else {
    delete process.env.ADMIN_SECRET;
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

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return {
    url,
    headers: new Headers(headers),
  } as any;
}

async function main() {
  seedEnv("secret-123");
  const { env } = await import("../../../../env");
  const { GET } = await import("../run-session-sweeper/route");

  await runTest("accepts x-admin-secret auth", async () => {
    (env as any).ADMIN_SECRET = "secret-123";
    (globalThis as any).__closeInactiveSessionsBatchOverride = async () => ({
      cutoffIso: "2026-02-28T00:00:00.000Z",
      scanned: 2,
      closed: 1,
      skippedRace: 0,
      sessions: [],
    });
    const response = await GET(
      makeRequest("https://example.test/api/admin/run-session-sweeper?inactivityMinutes=10", {
        "x-admin-secret": "secret-123",
      })
    );
    const payload = await response.json();
    delete (globalThis as any).__closeInactiveSessionsBatchOverride;
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.result.closed).toBe(1);
  });

  await runTest("accepts x-vercel-cron auth without admin secret header", async () => {
    (env as any).ADMIN_SECRET = "secret-123";
    (globalThis as any).__closeInactiveSessionsBatchOverride = async () => ({
      cutoffIso: "2026-02-28T00:00:00.000Z",
      scanned: 3,
      closed: 2,
      skippedRace: 0,
      sessions: [],
    });
    const response = await GET(
      makeRequest("https://example.test/api/admin/run-session-sweeper", {
        "x-vercel-cron": "1",
      })
    );
    const payload = await response.json();
    delete (globalThis as any).__closeInactiveSessionsBatchOverride;
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.result.closed).toBe(2);
  });

  await runTest("rejects unauthorized request when admin secret exists", async () => {
    (env as any).ADMIN_SECRET = "secret-123";
    const response = await GET(makeRequest("https://example.test/api/admin/run-session-sweeper"));
    expect(response.status).toBe(401);
  });

  await runTest("returns 404 when no admin secret is configured and no cron header", async () => {
    (env as any).ADMIN_SECRET = undefined;
    const response = await GET(makeRequest("https://example.test/api/admin/run-session-sweeper"));
    expect(response.status).toBe(404);
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

