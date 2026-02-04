/**
 * Unit tests for Synapse query router selection
 * Run with: pnpm tsx src/lib/services/memory/__tests__/queryRouter.synapse.test.ts
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function seedEnv(routerEnabled: boolean) {
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
    FEATURE_QUERY_ROUTER: routerEnabled ? "true" : "false",
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

async function setupPersona() {
  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "query-router-prompt.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  const { prisma } = await import("../../../prisma");
  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.message.findMany as any) = async () => [
    { role: "assistant", content: "Last reply", createdAt: new Date() },
  ];
}

async function main() {
  await runTest("heuristic triggers query without router call", async () => {
    seedEnv(true);
    await setupPersona();
    const { buildContextFromSynapse } = await import("../contextBuilder");
    let routerCalls = 0;
    let briefQuery: string | null = null;

    (globalThis as any).__queryRouterOverride = async () => {
      routerCalls += 1;
      return { should_query: true, query: "ignored", confidence: 0.9 };
    };
    (globalThis as any).__synapseBriefOverride = async (payload: any) => {
      briefQuery = payload.query ?? null;
      return { semanticContext: [], activeLoops: [] };
    };

    await buildContextFromSynapse(
      "user-1",
      "persona-1",
      "remember what we decided",
      "session-1",
      false
    );

    delete (globalThis as any).__queryRouterOverride;
    delete (globalThis as any).__synapseBriefOverride;

    expect(routerCalls).toBe(0);
    expect(briefQuery).toBe("remember what we decided");
  });

  await runTest("router suggests query for relational message", async () => {
    seedEnv(true);
    await setupPersona();
    const { buildContextFromSynapse } = await import("../contextBuilder");
    let briefQuery: string | null = null;

    (globalThis as any).__queryRouterOverride = async () => ({
      should_query: true,
      query: "my brother",
      confidence: 0.7,
    });
    (globalThis as any).__synapseBriefOverride = async (payload: any) => {
      briefQuery = payload.query ?? null;
      return { semanticContext: [], activeLoops: [] };
    };

    await buildContextFromSynapse(
      "user-2",
      "persona-2",
      "my brother is stressing me out",
      "session-2",
      false
    );

    delete (globalThis as any).__queryRouterOverride;
    delete (globalThis as any).__synapseBriefOverride;

    expect(briefQuery).toBe("my brother");
  });

  await runTest("router returns null for small talk", async () => {
    seedEnv(true);
    await setupPersona();
    const { buildContextFromSynapse } = await import("../contextBuilder");
    let briefQuery: string | null = "unset";

    (globalThis as any).__queryRouterOverride = async () => ({
      should_query: false,
      query: null,
      confidence: 0.2,
    });
    (globalThis as any).__synapseBriefOverride = async (payload: any) => {
      briefQuery = payload.query ?? null;
      return { semanticContext: [], activeLoops: [] };
    };

    await buildContextFromSynapse(
      "user-3",
      "persona-3",
      "hello how are you",
      "session-3",
      false
    );

    delete (globalThis as any).__queryRouterOverride;
    delete (globalThis as any).__synapseBriefOverride;

    expect(briefQuery).toBe(null);
  });

  await runTest("messy transcript produces person relationship query", async () => {
    seedEnv(true);
    await setupPersona();
    const { buildContextFromSynapse } = await import("../contextBuilder");
    let briefQuery: string | null = null;

    (globalThis as any).__queryRouterOverride = async () => ({
      should_query: false,
      query: null,
      confidence: 0.1,
    });
    (globalThis as any).__synapseBriefOverride = async (payload: any) => {
      briefQuery = payload.query ?? null;
      return { semanticContext: [], activeLoops: [] };
    };

    await buildContextFromSynapse(
      "user-4",
      "persona-4",
      "my girlfriend Ashley in Guatemala has 3 kids",
      "session-4",
      false
    );

    delete (globalThis as any).__queryRouterOverride;
    delete (globalThis as any).__synapseBriefOverride;

    const acceptable = new Set(["Ashley kids", "Ashley Guatemala"]);
    if (!briefQuery || !acceptable.has(briefQuery)) {
      throw new Error(`Expected Ashley kids or Ashley Guatemala, got ${briefQuery ?? "null"}`);
    }
  });

  await runTest("invalid router query falls back to candidates", async () => {
    seedEnv(true);
    await setupPersona();
    const { buildContextFromSynapse } = await import("../contextBuilder");
    let briefQuery: string | null = null;

    (globalThis as any).__queryRouterOverride = async () => ({
      should_query: true,
      query: "A few other things I want you to",
      confidence: 0.9,
    });
    (globalThis as any).__synapseBriefOverride = async (payload: any) => {
      briefQuery = payload.query ?? null;
      return { semanticContext: [], activeLoops: [] };
    };

    await buildContextFromSynapse(
      "user-5",
      "persona-5",
      "my girlfriend Ashley in Guatemala has 3 kids",
      "session-5",
      false
    );

    delete (globalThis as any).__queryRouterOverride;
    delete (globalThis as any).__synapseBriefOverride;

    const acceptable = new Set(["Ashley kids", "Ashley Guatemala"]);
    if (!briefQuery || !acceptable.has(briefQuery)) {
      throw new Error(`Expected Ashley kids or Ashley Guatemala, got ${briefQuery ?? "null"}`);
    }
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
