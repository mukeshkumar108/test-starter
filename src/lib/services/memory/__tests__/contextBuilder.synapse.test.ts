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
    {
      role: "user",
      content: "I need to reply to Jordan about security questionnaire before lunch.",
      createdAt: new Date(),
    },
    { role: "assistant", content: "Noted.", createdAt: new Date() },
  ];
  (prisma.sessionState.findUnique as any) = async () => null;

  (globalThis as any).__synapseBriefOverride = async () => ({
    facts: ["User is preparing a proposal.", "User is blocked on revisions."],
    openLoops: [
      "Finish proposal",
      "Reply to Jordan about security questionnaire before lunch",
      "Plan the Q3 roadmap alignment with design, product, and growth stakeholders",
      "This should be dropped after cap",
    ],
    commitments: [
      "Send proposal draft to legal team for review before noon tomorrow",
      "Prepare meeting notes for cross functional standup and sync",
      "Ask Maya for budget approval and attach latest spreadsheet revisions",
      "Drop me due to cap",
    ],
    activeLoops: ["Finish proposal", "Gets stuck on revisions"],
    timeGapDescription: "12 minutes since last spoke",
    timeOfDayLabel: "AFTERNOON",
    currentFocus: "Finish proposal draft",
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
  if (!context.situationalContext) {
    throw new Error("Expected situationalContext to be set");
  }
  if (!context.situationalContext.includes("FACTS:")) {
    throw new Error("Expected FACTS in situationalContext");
  }
  if (!context.situationalContext.includes("Time Gap: 12 minutes since last spoke")) {
    throw new Error("Expected time gap in situationalContext");
  }
  if (!context.situationalContext.includes("Time: AFTERNOON")) {
    throw new Error("Expected time label in situationalContext");
  }
  if (!context.situationalContext.includes("CURRENT_FOCUS:")) {
    throw new Error("Expected CURRENT_FOCUS in situationalContext");
  }
  const openLoops = context.overlayContext?.openLoops ?? [];
  const commitments = context.overlayContext?.commitments ?? [];
  expect(openLoops.length).toBe(3);
  expect(commitments.length).toBe(3);
  expect(openLoops[0]).toBe("Reply to Jordan about security questionnaire before lunch");
  for (const item of [...openLoops, ...commitments]) {
    const words = item.split(/\s+/).filter(Boolean).length;
    if (words > 12) {
      throw new Error(`Expected overlay item to be <= 12 words, got ${words}: ${item}`);
    }
  }
  expect(context.recentMessages.length).toBe(2);
  });

  await runTest("buildContext falls back when brief returns null", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContext } = await import("../contextBuilder");

  (prisma.session.findFirst as any) = async () => ({ id: "session-2" });
  (prisma.message.findFirst as any) = async () => null;
  (prisma.sessionState.findUnique as any) = async () => null;

  (globalThis as any).__synapseBriefOverride = async () => null;
  const sentinel = {
    persona: "LOCAL",
    situationalContext: undefined,
    rollingSummary: undefined,
    recentMessages: [],
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
