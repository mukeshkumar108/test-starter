/**
 * Unit tests for Synapse-backed context builder
 * Run with: pnpm tsx src/lib/services/memory/__tests__/contextBuilder.synapse.test.ts
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

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
    FEATURE_SYNAPSE_BRIEF: "true",
  };
  for (const [key, value] of Object.entries(required)) {
    process.env[key] = value;
  }
}

seedEnv();

type TestResult = { name: string; passed: boolean; error?: string };
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
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function main() {
  await runTest("buildContextFromSynapse maps brief payload", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  (prisma.personaProfile.findUnique as any) = async () => ({
    promptPath,
  });
  (prisma.message.findMany as any) = async () => [
    { role: "user", content: "Hi there", createdAt: new Date() },
  ];

  (globalThis as any).__synapseBriefOverride = async () => ({
    identity: { name: "Mukesh", timezone: "America/Los_Angeles" },
    semanticContext: [{ text: "Likes hiking" }, { text: "Project Atlas" }],
    activeLoops: [
      { type: "COMMITMENT", salience: 0.9, text: "Finish proposal" },
      { type: "FRICTION", salience: 0.8, text: "Gets stuck on revisions" },
      { type: "THREAD", salience: 0.5, text: "Launch timeline" },
      { type: "COMMITMENT", salience: 0.2, text: "Schedule meeting" },
    ],
    rollingSummary: "User is preparing a proposal.",
  });

  const context = await buildContextFromSynapse(
    "user-1",
    "persona-1",
    "Remember my name",
    "session-1",
    false
  );

  delete (globalThis as any).__synapseBriefOverride;

  if (!context) throw new Error("Expected context, got null");

  expect(context.persona).toBe("TEST PROMPT");
  expect(context.foundationMemories).toEqual([
    "Name: Mukesh | Timezone: America/Los_Angeles",
  ]);
  expect(context.relevantMemories).toEqual(["Likes hiking", "Project Atlas"]);
  expect(context.commitments).toEqual(["Finish proposal", "Schedule meeting"]);
  expect(context.threads).toEqual(["Launch timeline"]);
  expect(context.frictions).toEqual(["Gets stuck on revisions"]);
  expect(context.rollingSummary).toBe("User is preparing a proposal.");
  expect(context.recentMessages.length).toBe(1);
  });

  await runTest("buildContext falls back when brief returns null", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContext } = await import("../contextBuilder");

  (prisma.session.findFirst as any) = async () => ({ id: "session-1" });
  (prisma.message.findFirst as any) = async () => null;

  (globalThis as any).__synapseBriefOverride = async () => null;
  const sentinel = {
    persona: "LOCAL",
    recentMessages: [],
    foundationMemories: [],
    relevantMemories: [],
    commitments: [],
    threads: [],
    frictions: [],
    recentWins: [],
    isSessionStart: true,
  };
  (globalThis as any).__buildContextLocalOverride = async () => sentinel;

  const context = await buildContext("user-1", "persona-1", "hello");

  delete (globalThis as any).__synapseBriefOverride;
  delete (globalThis as any).__buildContextLocalOverride;

  expect(context).toEqual(sentinel);
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
