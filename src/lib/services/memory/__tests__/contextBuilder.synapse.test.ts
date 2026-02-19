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

  let startBriefPayload: any = null;
  let loopsPayload: any = null;
  let userModelPayload: any = null;
  let dailyAnalysisPayload: any = null;

  (globalThis as any).__synapseStartBriefOverride = async (payload: any) => {
    startBriefPayload = payload;
    return {
    timeOfDayLabel: "AFTERNOON",
    timeGapHuman: "12 minutes since last session",
    bridgeText: "Steering note: Stay practical and verify assumptions before nudging.",
    items: [
      { kind: "loop", text: "Reply to Jordan about security questionnaire before lunch", type: "OPEN_LOOP" },
      { kind: "loop", text: "Finish proposal draft and send to legal", type: "COMMITMENT" },
      { kind: "loop", text: "Plan Q3 roadmap alignment with design and product", type: "OPEN_LOOP" },
      { kind: "loop", text: "This should be dropped after cap", type: "OPEN_LOOP" },
      { kind: "tension", text: "Pressure between speed and quality in revisions", type: "TENSION" },
    ],
  };
  };
  (globalThis as any).__synapseMemoryLoopsOverride = async (payload: any) => {
    loopsPayload = payload;
    return {
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
  };
  };
  (globalThis as any).__synapseUserModelOverride = async (payload: any) => {
    userModelPayload = payload;
    return {
      exists: true,
      completenessScore: {
        relationships: 70,
        work: 90,
        north_star: 85,
        health: 0,
        spirituality: 0,
        general: 65,
      },
      model: {
        north_star: {
          work: {
            vision: null,
            goal: "Ship memory reliability improvements this month",
            status: "active",
            goal_source: "inferred",
            goal_confidence: 0.72,
          },
          general: {
            vision: "Build a meaningful AI product that improves daily life",
            goal: null,
            status: "active",
            vision_source: "user_stated",
            vision_confidence: 0.95,
          },
        },
        current_focus: {
          text: "Stabilize memory integration",
          source: "user_stated",
          confidence: 0.92,
        },
        work_context: {
          text: "Shipping reliability improvements this week",
          source: "user_stated",
          confidence: 0.9,
        },
        key_relationships: [
          { name: "Ashley", who: "partner", source: "user_stated", confidence: 0.9 },
        ],
        patterns: [{ text: "Moves fast and then overcommits", source: "inferred", confidence: 0.7 }],
        preferences: { tone: "direct, warm", avoid: ["therapy-style"] },
      },
    };
  };
  (globalThis as any).__synapseDailyAnalysisOverride = async (payload: any) => {
    dailyAnalysisPayload = payload;
    return {
      exists: true,
      steeringNote: "Keep nudges practical and explicit.",
      themes: ["follow-through", "clarity over assumption"],
      scores: { curiosity: 3, warmth: 4, usefulness: 5, forward_motion: 4 },
      metadata: { quality_flag: "ok" },
    };
  };

  const context = await buildContextFromSynapse(
    "user-1",
    "persona-1",
    "Remember my name",
    "session-1",
    true
  );

  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseMemoryLoopsOverride;
  delete (globalThis as any).__synapseUserModelOverride;
  delete (globalThis as any).__synapseDailyAnalysisOverride;

  if (!context) throw new Error("Expected context, got null");

  expect(context.persona).toBe("TEST PROMPT");
  if (!context.situationalContext) {
    throw new Error("Expected situationalContext to be set");
  }
  if (!context.situationalContext.includes("Session start context: AFTERNOON")) {
    throw new Error("Expected session start time line in situationalContext");
  }
  if (!context.situationalContext.includes("Steering note: Stay practical and verify assumptions before nudging.")) {
    throw new Error("Expected steering-note bridge text in situationalContext");
  }
  if (!context.situationalContext.includes("Active threads:")) {
    throw new Error("Expected active threads line in situationalContext");
  }
  if (!context.situationalContext.includes("This should be dropped after cap")) {
    throw new Error("Expected startbrief to render up to top 5 loop items");
  }
  if (!context.situationalContext.includes("Long-term direction (general): Build a meaningful AI product")) {
    throw new Error("Expected additive user model north-star direction line");
  }
  if (context.situationalContext.includes("Likely goal (work): Ship memory reliability improvements this month")) {
    throw new Error("Expected user_stated vision to be preferred over inferred goal");
  }
  if (!context.situationalContext.includes("Current focus: Stabilize memory integration")) {
    throw new Error("Expected additive user model current focus/work line");
  }
  if (!context.situationalContext.includes("Important relationships: Ashley")) {
    throw new Error("Expected additive user model relationships line");
  }
  const openLoops = context.overlayContext?.openLoops ?? [];
  const commitments = context.overlayContext?.commitments ?? [];
  expect(openLoops.length).toBe(2);
  expect(commitments.length).toBe(1);
  expect(openLoops[0]).toBe("Set 6 AM alarm for walk routine");
  expect(commitments[0]).toBe("Set 6 AM alarm for walk routine");
  expect(context.overlayContext?.hasHighPriorityLoop ?? false).toBe(true);
  expect(startBriefPayload?.personaId ?? null).toBe(null);
  expect(loopsPayload?.personaId ?? null).toBe(null);
  expect(userModelPayload?.personaId ?? null).toBe(null);
  expect(dailyAnalysisPayload?.personaId ?? null).toBe(null);
  for (const item of [...openLoops, ...commitments]) {
    const words = item.split(/\s+/).filter(Boolean).length;
    if (words > 12) {
      throw new Error(`Expected overlay item to be <= 12 words, got ${words}: ${item}`);
    }
  }
  expect(context.recentMessages.length).toBe(2);
  });

  await runTest("buildContextFromSynapse appends daily analysis when bridge text missing", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt-daily-analysis.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
  });
  (prisma.message.findMany as any) = async () => [{ role: "user", content: "hello", createdAt: new Date() }];
  (prisma.sessionState.findUnique as any) = async () => null;
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-da-1" });

  (globalThis as any).__synapseStartBriefOverride = async () => ({
    timeOfDayLabel: "MORNING",
    timeGapHuman: "8 minutes",
    bridgeText: null,
    items: [],
  });
  (globalThis as any).__synapseMemoryLoopsOverride = async () => ({ items: [], metadata: { count: 0 } });
  (globalThis as any).__synapseUserModelOverride = async () => ({ exists: false });
  (globalThis as any).__synapseDailyAnalysisOverride = async () => ({
    exists: true,
    steeringNote: "Lead with one practical step.",
    themes: ["clarity", "execution"],
    scores: { curiosity: 3, warmth: 4, usefulness: 4, forward_motion: 3 },
    metadata: { quality_flag: "ok" },
  });

  const context = await buildContextFromSynapse(
    "user-da-1",
    "persona-da-1",
    "hello",
    "session-da-1",
    true
  );

  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseMemoryLoopsOverride;
  delete (globalThis as any).__synapseUserModelOverride;
  delete (globalThis as any).__synapseDailyAnalysisOverride;

  if (!context?.situationalContext?.includes("Daily steering: Lead with one practical step.")) {
    throw new Error("Expected daily steering line when bridge text missing");
  }
  if (!context?.situationalContext?.includes("Today's patterns: clarity; execution")) {
    throw new Error("Expected compact theme line in daily analysis block");
  }
  if (
    context?.situationalContext?.includes("Quality:") ||
    context?.situationalContext?.includes("C/W/U/F:")
  ) {
    throw new Error("Did not expect quality/score lines in model-facing daily analysis block");
  }
  });

  await runTest("buildContextFromSynapse down-ranks low-confidence daily analysis", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt-daily-analysis-low-confidence.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
  });
  (prisma.message.findMany as any) = async () => [{ role: "user", content: "hello", createdAt: new Date() }];
  (prisma.sessionState.findUnique as any) = async () => null;
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-da-2" });

  (globalThis as any).__synapseStartBriefOverride = async () => ({
    timeOfDayLabel: "MORNING",
    timeGapHuman: "8 minutes",
    bridgeText: "Brief recap",
    items: [],
  });
  (globalThis as any).__synapseMemoryLoopsOverride = async () => ({ items: [], metadata: { count: 0 } });
  (globalThis as any).__synapseUserModelOverride = async () => ({ exists: false });
  (globalThis as any).__synapseDailyAnalysisOverride = async () => ({
    exists: true,
    steeringNote: "Push one next step only.",
    themes: ["consistency"],
    metadata: { quality_flag: "needs_review" },
  });

  const context = await buildContextFromSynapse(
    "user-da-2",
    "persona-da-2",
    "hello",
    "session-da-2",
    true
  );

  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseMemoryLoopsOverride;
  delete (globalThis as any).__synapseUserModelOverride;
  delete (globalThis as any).__synapseDailyAnalysisOverride;

  if (!context?.situationalContext?.includes("Daily steering (low confidence): Push one next step only.")) {
    throw new Error("Expected low-confidence qualifier for needs_review analysis");
  }
  if (
    context?.situationalContext?.includes("Quality:") ||
    context?.situationalContext?.includes("C/W/U/F:")
  ) {
    throw new Error("Did not expect quality/score lines in low-confidence daily analysis block");
  }
  });

  await runTest("buildContextFromSynapse skips daily analysis when exists=false and on fetch errors", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt-daily-analysis-fallback.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
  });
  (prisma.message.findMany as any) = async () => [{ role: "user", content: "hello", createdAt: new Date() }];
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-da-3" });

  (prisma.sessionState.findUnique as any) = async () => null;
  (globalThis as any).__synapseStartBriefOverride = async () => ({
    timeOfDayLabel: "MORNING",
    timeGapHuman: "8 minutes",
    bridgeText: "Bridge stays primary.",
    items: [],
  });
  (globalThis as any).__synapseMemoryLoopsOverride = async () => ({ items: [], metadata: { count: 0 } });
  (globalThis as any).__synapseUserModelOverride = async () => ({ exists: false });
  (globalThis as any).__synapseDailyAnalysisOverride = async () => ({ exists: false });

  const contextWithNoAnalysis = await buildContextFromSynapse(
    "user-da-3",
    "persona-da-3",
    "hello",
    "session-da-3",
    true
  );

  if (contextWithNoAnalysis?.situationalContext?.includes("Daily steering:")) {
    throw new Error("Did not expect daily analysis lines when exists=false");
  }

  (prisma.sessionState.findUnique as any) = async () => null;
  (globalThis as any).__synapseDailyAnalysisOverride = async () => {
    throw new Error("daily endpoint unavailable");
  };

  const contextWithError = await buildContextFromSynapse(
    "user-da-4",
    "persona-da-4",
    "hello",
    "session-da-4",
    true
  );

  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseMemoryLoopsOverride;
  delete (globalThis as any).__synapseUserModelOverride;
  delete (globalThis as any).__synapseDailyAnalysisOverride;

  if (!contextWithError?.situationalContext?.includes("Bridge stays primary.")) {
    throw new Error("Expected startbrief context to remain when daily analysis fails");
  }
  if (contextWithError?.situationalContext?.includes("Daily steering:")) {
    throw new Error("Did not expect daily analysis lines when endpoint errors");
  }
  });

  await runTest("buildContextFromSynapse supports legacy north_star.text fallback", async () => {
  const { prisma } = await import("../../../prisma");
  const { buildContextFromSynapse } = await import("../contextBuilder");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "synapse-prompt-legacy-north-star.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endedAt: null,
  });
  (prisma.message.findMany as any) = async () => [{ role: "user", content: "hello", createdAt: new Date() }];
  (prisma.sessionState.findUnique as any) = async () => null;
  (prisma.sessionState.upsert as any) = async () => ({ id: "state-legacy" });

  (globalThis as any).__synapseStartBriefOverride = async () => ({
    timeOfDayLabel: "MORNING",
    timeGapHuman: "2 minutes",
    bridgeText: null,
    items: [],
  });
  (globalThis as any).__synapseMemoryLoopsOverride = async () => ({ items: [], metadata: { count: 0 } });
  (globalThis as any).__synapseUserModelOverride = async () => ({
    exists: true,
    completenessScore: {
      relationships: 0,
      work: 0,
      north_star: 70,
      health: 0,
      spirituality: 0,
      general: 40,
    },
    model: {
      north_star: {
        text: "Build something durable with real user impact",
      },
    },
  });

  const context = await buildContextFromSynapse(
    "user-legacy",
    "persona-legacy",
    "hello",
    "session-legacy",
    true
  );

  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseMemoryLoopsOverride;
  delete (globalThis as any).__synapseUserModelOverride;

  if (!context?.situationalContext?.includes("Likely goal (general): Build something durable with real user impact")) {
    throw new Error("Expected legacy north_star.text to map to general goal fallback");
  }
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
  (globalThis as any).__synapseUserModelOverride = async () => ({ exists: false });

  const context = await buildContextFromSynapse(
    "user-2",
    "persona-2",
    "hello",
    "session-2",
    true
  );
  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseUserModelOverride;

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
  (globalThis as any).__synapseUserModelOverride = async () => ({ exists: false });

  const context = await buildContextFromSynapse(
    "user-3",
    "persona-3",
    "hello",
    "session-match",
    true
  );
  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseUserModelOverride;

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
  (globalThis as any).__synapseUserModelOverride = async () => ({ exists: false });

  const context = await buildContextFromSynapse(
    "user-4",
    "persona-4",
    "hello",
    "session-new",
    true
  );
  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseUserModelOverride;

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
