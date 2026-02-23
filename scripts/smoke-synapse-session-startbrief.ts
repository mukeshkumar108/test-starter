import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

type MutableEnv = Record<string, string | undefined>;

function seedEnv() {
  const required: MutableEnv = {
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
    FEATURE_SYNAPSE_SESSION_INGEST: "true",
    FEATURE_SYNAPSE_BRIEF: "true",
    FEATURE_LIBRARIAN_TRACE: "true",
  };
  for (const [key, value] of Object.entries(required)) {
    process.env[key] = value;
  }
}

function assertTrue(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function main() {
  seedEnv();
  const { env } = await import("../src/env");
  (env as any).FEATURE_SYNAPSE_SESSION_INGEST = "true";
  (env as any).FEATURE_LIBRARIAN_TRACE = "true";

  const { prisma } = await import("../src/lib/prisma");
  const { closeStaleSessionIfAny, ensureActiveSession } = await import(
    "../src/lib/services/session/sessionService"
  );
  const { buildContextFromSynapse } = await import("../src/lib/services/memory/contextBuilder");

  const userId = "smoke-user";
  const personaId = "smoke-persona";
  const staleNow = new Date(Date.now());
  const oldUserTurn = new Date(staleNow.getTime() - 10 * 60 * 1000);

  const sessionStateRecord: { state: Record<string, unknown> } = { state: {} };
  const startedAt = new Date("2026-02-23T09:40:00.000Z");
  let activeSession: any = {
    id: "smoke-session-1",
    userId,
    personaId,
    startedAt,
    lastActivityAt: oldUserTurn,
    endedAt: null,
    turnCount: 1,
  };
  const ingestCalls: Array<{ sessionId: string; ok: boolean }> = [];
  let ingestAttempt = 0;

  const librarianTraces: Array<{ kind?: string | null; memoryQuery?: any }> = [];
  let sessionBriefCalled = 0;

  (prisma.sessionState.findUnique as any) = async () => sessionStateRecord;
  (prisma.sessionState.upsert as any) = async (args: any) => {
    sessionStateRecord.state = (args.update?.state ?? args.create?.state ?? {}) as Record<
      string,
      unknown
    >;
    return sessionStateRecord;
  };

  (prisma.message.findFirst as any) = async () => ({ createdAt: oldUserTurn });
  (prisma.message.findMany as any) = async () => [
    { role: "user", content: "first", createdAt: new Date(startedAt.getTime() + 5_000) },
    { role: "assistant", content: "second", createdAt: new Date(startedAt.getTime() + 10_000) },
  ];

  (prisma.session.findFirst as any) = async (args: any) => {
    const where = args?.where ?? {};
    if (where?.endedAt === null) {
      return activeSession?.endedAt ? null : activeSession;
    }
    return activeSession;
  };
  (prisma.session.update as any) = async (args: any) => {
    if (!activeSession || activeSession.id !== args.where.id) {
      throw new Error("session.update target not found");
    }
    activeSession = { ...activeSession, ...args.data };
    return activeSession;
  };
  (prisma.session.create as any) = async (args: any) => {
    activeSession = {
      id: "smoke-session-2",
      endedAt: null,
      ...args.data,
    };
    return activeSession;
  };

  (prisma.synapseIngestTrace.create as any) = async () => null;
  (prisma.synapseIngestTrace.count as any) = async () => 0;
  (prisma.librarianTrace.create as any) = async (args: any) => {
    librarianTraces.push({
      kind: args?.data?.kind ?? null,
      memoryQuery: args?.data?.memoryQuery ?? null,
    });
    return null;
  };

  (globalThis as any).__synapseSessionIngestWithMetaOverride = async (payload: any) => {
    ingestAttempt += 1;
    if (ingestAttempt === 1) {
      ingestCalls.push({ sessionId: payload.sessionId, ok: false });
      return {
        ok: false,
        status: 500,
        ms: 3,
        url: "https://synapse.test/session/ingest",
        data: null,
        errorBody: "ingest failed once",
        reason: "non_ok",
      };
    }
    ingestCalls.push({ sessionId: payload.sessionId, ok: true });
    return {
      ok: true,
      status: 200,
      ms: 2,
      url: "https://synapse.test/session/ingest",
      data: { ok: true },
      errorBody: null,
      reason: null,
    };
  };

  await closeStaleSessionIfAny(userId, personaId, staleNow);
  await tick();

  const retryStateAfterFailure = (sessionStateRecord.state as any).synapseSessionIngestRetry;
  assertTrue(Array.isArray(retryStateAfterFailure?.pending), "missing pending retry array");
  assertTrue(retryStateAfterFailure.pending.length === 1, "expected one pending retry");
  console.log("SMOKE:STEP1_CLOSE_TRIGGERED");
  console.log("SMOKE:STEP1_RETRY_WRITTEN");

  await ensureActiveSession(userId, personaId, new Date(Date.now() + 2 * 60 * 1000));
  await tick();

  const retryStateAfterEnsure = (sessionStateRecord.state as any).synapseSessionIngestRetry;
  assertTrue(retryStateAfterEnsure?.lastOk === true, "retry did not mark lastOk=true");
  assertTrue(
    Array.isArray(retryStateAfterEnsure?.pending) && retryStateAfterEnsure.pending.length === 0,
    "retry queue not drained"
  );
  assertTrue(ingestCalls.length >= 2, "retry did not call ingest again");
  console.log("SMOKE:STEP2_RETRY_FIRED");

  const tmpDir = join(process.cwd(), "tmp");
  await mkdir(tmpDir, { recursive: true });
  const promptPath = join("tmp", "smoke-startbrief-prompt.txt");
  await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");
  (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
  (prisma.session.findUnique as any) = async () => ({
    startedAt: new Date(Date.now() - 60_000),
    endedAt: null,
  });
  (prisma.message.findMany as any) = async () => [
    { role: "user", content: "hello", createdAt: new Date(Date.now() - 30_000) },
  ];

  (globalThis as any).__synapseStartBriefOverride = async () => ({
    handover_text: " ",
    resume: { use_bridge: true, bridge_text: " " },
    items: [],
    evidence: { summary_content_quality: "none_fetched" },
  });
  (globalThis as any).__synapseBriefOverride = async () => {
    sessionBriefCalled += 1;
    return {
      facts: ["fact"],
      openLoops: ["loop"],
      commitments: [],
      currentFocus: "focus",
    };
  };

  const context = await buildContextFromSynapse(
    userId,
    personaId,
    "hello",
    "smoke-session-2",
    true
  );
  assertTrue(context, "contextBuilder returned null");
  assertTrue(sessionBriefCalled === 1, "session/brief fallback was not called");
  assertTrue(context?.startBrief?.used === false, "startbrief should be rejected");
  assertTrue(context?.startBrief?.fallback === "session/brief", "fallback marker missing");
  console.log("SMOKE:STEP3_STARTBRIEF_WEAK_FALLBACK");

  const startbriefTrace = librarianTraces
    .filter((row) => row.kind === "startbrief")
    .map((row) => row.memoryQuery)
    .find((mq) => mq?.startbrief_quality === "weak_rejected");
  assertTrue(startbriefTrace, "missing weak_rejected startbrief trace");
  assertTrue(
    startbriefTrace.summary_content_quality === "none_fetched",
    "summary_content_quality not captured"
  );
  console.log(`SMOKE:TRACE:startbrief_quality=${startbriefTrace.startbrief_quality}`);
  console.log(`SMOKE:TRACE:summary_content_quality=${startbriefTrace.summary_content_quality}`);

  delete (globalThis as any).__synapseSessionIngestWithMetaOverride;
  delete (globalThis as any).__synapseStartBriefOverride;
  delete (globalThis as any).__synapseBriefOverride;

  console.log("SMOKE:PASS");
}

main().catch((error) => {
  console.error("SMOKE:FAIL", error);
  process.exit(1);
});
