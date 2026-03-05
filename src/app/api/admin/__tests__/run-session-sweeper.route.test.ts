/**
 * Route tests for admin session sweeper auth paths.
 * Run with: pnpm tsx src/app/api/admin/__tests__/run-session-sweeper.route.test.ts
 */
import crypto from "node:crypto";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function seedEnv(adminSecret?: string, currentSigningKey?: string, nextSigningKey?: string) {
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
  if (typeof currentSigningKey === "string") {
    process.env.QSTASH_CURRENT_SIGNING_KEY = currentSigningKey;
  } else {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  }
  if (typeof nextSigningKey === "string") {
    process.env.QSTASH_NEXT_SIGNING_KEY = nextSigningKey;
  } else {
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
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

function toBase64Url(input: Buffer | string) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function bodyHashBase64Url(body: string) {
  return toBase64Url(crypto.createHash("sha256").update(body).digest());
}

function signQstashToken(url: string, body: string, signingKeyB64: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      nbf: now - 60,
      exp: now + 60,
      body: bodyHashBase64Url(body),
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = toBase64Url(
    crypto.createHmac("sha256", Buffer.from(signingKeyB64, "base64")).update(signingInput).digest()
  );
  return `${signingInput}.${signature}`;
}

function makeRequest(url: string, headers: Record<string, string> = {}, body = "") {
  return {
    url,
    headers: new Headers(headers),
    text: async () => body,
  } as any;
}

async function main() {
  const currentSigningKey = Buffer.from("current-signing-key").toString("base64");
  const nextSigningKey = Buffer.from("next-signing-key").toString("base64");
  seedEnv("secret-123", currentSigningKey, nextSigningKey);
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

  await runTest("accepts Upstash-Signature auth", async () => {
    (env as any).ADMIN_SECRET = "secret-123";
    (env as any).QSTASH_CURRENT_SIGNING_KEY = currentSigningKey;
    (env as any).QSTASH_NEXT_SIGNING_KEY = nextSigningKey;
    (globalThis as any).__closeInactiveSessionsBatchOverride = async () => ({
      cutoffIso: "2026-02-28T00:00:00.000Z",
      scanned: 4,
      closed: 3,
      skippedRace: 0,
      sessions: [],
    });
    const url = "https://example.test/api/admin/run-session-sweeper";
    const token = signQstashToken(url, "", currentSigningKey);
    const response = await GET(
      makeRequest(url, {
        "upstash-signature": token,
      })
    );
    const payload = await response.json();
    delete (globalThis as any).__closeInactiveSessionsBatchOverride;
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.result.closed).toBe(3);
  });

  await runTest("accepts Upstash-Signature when host differs but path/query match", async () => {
    (env as any).ADMIN_SECRET = "secret-123";
    (env as any).QSTASH_CURRENT_SIGNING_KEY = currentSigningKey;
    (env as any).QSTASH_NEXT_SIGNING_KEY = nextSigningKey;
    (globalThis as any).__closeInactiveSessionsBatchOverride = async () => ({
      cutoffIso: "2026-02-28T00:00:00.000Z",
      scanned: 2,
      closed: 2,
      skippedRace: 0,
      sessions: [],
    });
    const signedUrl = "https://test-starter-kappa.vercel.app/api/admin/run-session-sweeper?limit=50";
    const requestUrl = "https://www.example.com/api/admin/run-session-sweeper?limit=50";
    const token = signQstashToken(signedUrl, "", currentSigningKey);
    const response = await GET(
      makeRequest(requestUrl, {
        "upstash-signature": token,
      })
    );
    const payload = await response.json();
    delete (globalThis as any).__closeInactiveSessionsBatchOverride;
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
  });

  await runTest("rejects invalid Upstash-Signature", async () => {
    (env as any).ADMIN_SECRET = "secret-123";
    (env as any).QSTASH_CURRENT_SIGNING_KEY = currentSigningKey;
    (env as any).QSTASH_NEXT_SIGNING_KEY = nextSigningKey;
    const url = "https://example.test/api/admin/run-session-sweeper";
    const token = signQstashToken(url, "", Buffer.from("wrong-key").toString("base64"));
    const response = await GET(
      makeRequest(url, {
        "upstash-signature": token,
      })
    );
    expect(response.status).toBe(401);
  });

  await runTest("rejects unauthorized request when admin secret exists", async () => {
    (env as any).ADMIN_SECRET = "secret-123";
    (env as any).QSTASH_CURRENT_SIGNING_KEY = currentSigningKey;
    (env as any).QSTASH_NEXT_SIGNING_KEY = nextSigningKey;
    const response = await GET(makeRequest("https://example.test/api/admin/run-session-sweeper"));
    expect(response.status).toBe(401);
  });

  await runTest("returns 404 when no admin secret or qstash signing keys are configured and no cron header", async () => {
    (env as any).ADMIN_SECRET = undefined;
    (env as any).QSTASH_CURRENT_SIGNING_KEY = undefined;
    (env as any).QSTASH_NEXT_SIGNING_KEY = undefined;
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
