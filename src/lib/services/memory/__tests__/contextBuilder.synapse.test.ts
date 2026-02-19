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
  await runTest("buildContextFromSynapse maps startbrief payload", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  (prisma.personaProfile.findUnique as any) = async () => ({
    promptPath,
  });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
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
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-1" });

  (globalThis as any).__synapseStartBriefOverride = async () => ({
    timeOfDayLabel: "AFTERNOON",
    timeGapHuman: "12 minutes since last session",
    bridgeText: "Last session: you were preparing the proposal and blocked on revisions.",
    items: [
      { kind: "loop", text: "Reply to Jordan about security questionnaire before lunch", type: "OPEN_LOOP" },
      { kind: "loop", text: "Finish proposal draft and send to legal", type: "COMMITMENT" },
      { kind: "loop", text: "Plan Q3 roadmap alignment with design and product", type: "OPEN_LOOP" },
      { kind: "loop", text: "This should be dropped after cap", type: "OPEN_LOOP" },
      { kind: "tension", text: "Pressure between speed and quality in revisions", type: "TENSION" },
    ],
  });
  (globalThis as any).__synapseMemoryLoopsOverride = async () => ({
    items: [
      {
        id: "l-1",
        type: "commitment",
        text: "Set 6 AM alarm for walk routine",
        salience: 5,
        importance: 5,
        urgency: 4,
      },
      { id: "l-2", type: "thread", text: "Complete portfolio refresh and model rollout", salience: 5 },
    ],
    metadata: { count: 2, sort: "priority_desc" },
  });

  const context = await buildContextFromSynapse(
    "user-1",
    "persona-1",
    "Remember my name",
    "session-1",
    true
  );

  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseMemoryLoopsOverride;

  if (!context) throw new Error("Expected context, got null");

  expect(context.persona).toBe("TEST PROMPT");
  if (!context.situationalContext) {
    throw new Error("Expected situationalContext to be set");
  }
  if (!context.situationalContext.includes("Session start context: AFTERNOON")) {
    throw new Error("Expected session start time line in situationalContext");
  }
  if (!context.situationalContext.includes("Last session: you were preparing the proposal")) {
    throw new Error("Expected bridge text in situationalContext");
  }
  const openLoops = context.overlayContext?.openLoops ?? [];
  const commitments = context.overlayContext?.commitments ?? [];
  expect(openLoops.length).toBe(2);
  expect(commitments.length).toBe(1);
  expect(openLoops[0]).toBe("Set 6 AM alarm for walk routine");
  expect(commitments[0]).toBe("Set 6 AM alarm for walk routine");
  expect(context.overlayContext?.hasHighPriorityLoop ?? false).toBe(true);
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
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
  });
  (prisma.message.findFirst as any) = async () => null;
  (prisma.sessionState.findUnique as any) = async () => null;
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-2" });

  (globalThis as any).__synapseStartBriefOverride = async () => null;
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

  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseBriefOverride;
  delete (globalThis as any).__buildContextLocalOverride;

  expect(context).toEqual(sentinel);
  });

  await runTest("buildContextFromSynapse surfaces local today focus in situational context", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt-focus.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  const today = new Date();
  const dayParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Zagreb",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(today);
  const dayPart = (type: Intl.DateTimeFormatPartTypes) =>
    dayParts.find((part) => part.type === type)?.value ?? "";
  const dayKey = `${dayPart("year")}-${dayPart("month")}-${dayPart("day")}`;
  const weekday = today
    .toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/Zagreb" })
    .toLowerCase();
  const weekdayIndex = new Map<string, number>([
    ["monday", 0],
    ["tuesday", 1],
    ["wednesday", 2],
    ["thursday", 3],
    ["friday", 4],
    ["saturday", 5],
    ["sunday", 6],
  ]).get(weekday) ?? 0;
  const utcMidnight = new Date(Date.UTC(Number.parseInt(dayPart("year"), 10), Number.parseInt(dayPart("month"), 10) - 1, Number.parseInt(dayPart("day"), 10)));
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - weekdayIndex);
  const weekStartKey = `${utcMidnight.getUTCFullYear()}-${String(utcMidnight.getUTCMonth() + 1).padStart(2, "0")}-${String(utcMidnight.getUTCDate()).padStart(2, "0")}`;

  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
  });
  (prisma.message.findMany as any) = async () => [{ role: "user", content: "Morning", createdAt: new Date() }];
  (prisma.sessionState.findUnique as any) = async () => ({
    rollingSummary: null,
    state: {
      overlayState: {
        user: {
          todayFocus: "Finish proposal draft",
          todayFocusDate: dayKey,
          weeklyNorthStar: "Build resilient momentum across Body Mind Freedom Experience",
          weeklyNorthStarWeekStartDate: weekStartKey,
        },
      },
    },
  });
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-3" });

  (globalThis as any).__synapseStartBriefOverride = async () => ({
    timeOfDayLabel: "MORNING",
    timeGapHuman: "5 minutes since last session",
    bridgeText: "Last session: proposal drafting remained active.",
    items: [],
  });

  const context = await buildContextFromSynapse(
    "user-2",
    "persona-2",
    "hello",
    "session-2",
    true
  );
  delete (globalThis as any).__synapseStartBriefOverride;

  if (!context?.situationalContext?.includes("CURRENT_FOCUS:\n- Finish proposal draft")) {
    throw new Error("Expected local today focus to be included in situational context");
  }
  if (!context?.situationalContext?.includes("WEEKLY_NORTH_STAR:")) {
    throw new Error("Expected weekly north star to be included in situational context");
  }
  expect(context?.overlayContext?.currentFocus ?? null).toBe("Finish proposal draft");
  expect(context?.overlayContext?.weeklyNorthStar ?? null).toBe(
    "Build resilient momentum across Body Mind Freedom Experience"
  );
  });

  await runTest("buildContextFromSynapse keeps rolling summary only for matching session", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt-rolling-match.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
  });
  (prisma.message.findMany as any) = async () => [{ role: "user", content: "hello", createdAt: new Date() }];
  (prisma.sessionState.findUnique as any) = async () => ({
    rollingSummary: "same-session-summary",
    state: {
      rollingSummarySessionId: "session-match",
    },
  });
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-4" });
  (globalThis as any).__synapseStartBriefOverride = async () => ({
    timeOfDayLabel: "MORNING",
    timeGapHuman: "2 minutes",
    bridgeText: null,
    items: [],
  });

  const context = await buildContextFromSynapse(
    "user-3",
    "persona-3",
    "hello",
    "session-match",
    true
  );
  delete (globalThis as any).__synapseStartBriefOverride;

  expect(context?.rollingSummary ?? null).toBe("same-session-summary");
  });

  await runTest("buildContextFromSynapse drops rolling summary for different session", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt-rolling-mismatch.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
  });
  (prisma.message.findMany as any) = async () => [{ role: "user", content: "hello", createdAt: new Date() }];
  (prisma.sessionState.findUnique as any) = async () => ({
    rollingSummary: "old-session-summary",
    state: {
      rollingSummarySessionId: "session-old",
    },
  });
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-5" });
  (globalThis as any).__synapseStartBriefOverride = async () => ({
    timeOfDayLabel: "MORNING",
    timeGapHuman: "2 minutes",
    bridgeText: null,
    items: [],
  });

  const context = await buildContextFromSynapse(
    "user-4",
    "persona-4",
    "hello",
    "session-new",
    true
  );
  delete (globalThis as any).__synapseStartBriefOverride;

  expect(context?.rollingSummary ?? null).toBe(null);
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
