/**
 * Unit tests for synapseClient
 * Run with: pnpm tsx src/lib/services/__tests__/synapseClient.test.ts
 */

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

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
    SYNAPSE_TENANT_ID: "tenant-test",
  };
  for (const [key, value] of Object.entries(required)) {
    process.env[key] = value;
  }
}

seedEnv();

async function main() {
  await runTest("brief() hits correct URL", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const { brief } = await import("../synapseClient");
  await brief({ hello: "world" });

  globalThis.fetch = originalFetch;

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://synapse.test/brief");
  });

  await runTest("ingest() hits correct URL", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const { ingest } = await import("../synapseClient");
  await ingest({ hello: "world" });

  globalThis.fetch = originalFetch;

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://synapse.test/ingest");
  });

  await runTest("timeout handled gracefully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: RequestInfo, init?: RequestInit) =>
    new Promise((_, reject) => {
      if (init?.signal) {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }
    })) as typeof fetch;

  const { brief } = await import("../synapseClient");
  const result = await brief({ slow: true });

  globalThis.fetch = originalFetch;

  expect(result).toBe(null);
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
