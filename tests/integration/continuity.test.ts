/**
 * Integration test: Orchestrator <-> Synapse "Bookend Memory"
 * Run with: pnpm tsx tests/integration/continuity.test.ts
 *
 * Note: This test hits the real Synapse container.
 */

import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
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
    SYNAPSE_BASE_URL: requireEnv("SYNAPSE_BASE_URL"),
    SYNAPSE_TENANT_ID: process.env.SYNAPSE_TENANT_ID || `test_${Date.now()}`,
    SYNAPSE_TIMEOUT_MS: "30000",
    FEATURE_SYNAPSE_BRIEF: "true",
    FEATURE_SYNAPSE_SESSION_INGEST: "true",
    FEATURE_QUERY_ROUTER: "false",
    FEATURE_SHADOW_JUDGE: "false",
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
    toContain(expected: string) {
      if (typeof actual !== "string" || !actual.includes(expected)) {
        throw new Error(`Expected to contain ${expected}, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function main() {
  seedEnv();

  await runTest("Continuity handshake with Synapse", async () => {
    const { prisma } = await import("../../src/lib/prisma");
    const { closeStaleSessionIfAny, ensureActiveSession } = await import("../../src/lib/services/session/sessionService");
    const { buildContextFromSynapse } = await import("../../src/lib/services/memory/contextBuilder");
    const synapseClient = await import("../../src/lib/services/synapseClient");

    const tmpDir = join(process.cwd(), "tmp");
    await mkdir(tmpDir, { recursive: true });
    const promptPath = join("tmp", "continuity-prompt.txt");
    await writeFile(join(process.cwd(), promptPath), "TEST PROMPT", "utf-8");

    const userId = "user-continuity";
    const personaId = "persona-continuity";
    const sessionId = `sess_${Date.now()}`;
    const startedAt = new Date("2026-02-04T18:00:00Z");
    const lastUserMessageAt = new Date("2026-02-04T18:01:00Z");
    const nowAfterGap = new Date("2026-02-04T18:20:01Z");

    const messageStore = [
      {
        role: "user",
        content: "I'm frustrated with the database migration for Sophie.",
        createdAt: lastUserMessageAt,
      },
      {
        role: "assistant",
        content: "That sounds painful. Want to walk through it?",
        createdAt: new Date("2026-02-04T18:01:05Z"),
      },
    ];

    (prisma.personaProfile.findUnique as any) = async () => ({ promptPath });
    (prisma.message.findMany as any) = async () => messageStore;
    (prisma.message.findFirst as any) = async () => ({ createdAt: lastUserMessageAt });
    (prisma.sessionSummary.findUnique as any) = async () => null;
    (prisma.sessionSummary.upsert as any) = async () => null;
    (prisma.session.findFirst as any) = async () => ({
      id: sessionId,
      userId,
      personaId,
      startedAt,
      lastActivityAt: lastUserMessageAt,
      endedAt: null,
    });
    (prisma.session.update as any) = async () => ({
      id: sessionId,
      userId,
      personaId,
      startedAt,
      lastActivityAt: lastUserMessageAt,
      endedAt: lastUserMessageAt,
    });
    let createdSessionId: string | null = null;
    (prisma.session.create as any) = async (args: any) => {
      createdSessionId = `sess_${Date.now()}_new`;
      return {
        id: createdSessionId,
        userId: args.data.userId,
        personaId: args.data.personaId,
        startedAt: args.data.startedAt,
        lastActivityAt: args.data.lastActivityAt,
        endedAt: null,
      };
    };

    let ingestedPayload: any = null;
    (globalThis as any).__synapseSessionIngestOverride = async (payload: any) => {
      ingestedPayload = payload;
      return synapseClient.sessionIngest(payload);
    };

    const cleanup = async () => {
      // Best-effort cleanup: ignore failures if endpoint doesn't exist.
      try {
        await fetch(`${process.env.SYNAPSE_BASE_URL}/session/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: process.env.SYNAPSE_TENANT_ID,
            userId,
            personaId,
            sessionId,
          }),
        });
      } catch {
        // ignore
      }
    };

    try {
      await closeStaleSessionIfAny(userId, personaId, nowAfterGap);
      if (!ingestedPayload) {
        throw new Error("Expected session ingest payload, got null");
      }
      expect(ingestedPayload.messages.length).toBe(2);
      expect(ingestedPayload.messages[0].text).toContain("database migration");
      // Give Synapse time to process the ingested session.
      await new Promise((resolve) => setTimeout(resolve, 5000));

      await ensureActiveSession(userId, personaId, nowAfterGap);
      if (!createdSessionId) {
        throw new Error("Expected a new sessionId to be created");
      }

      let briefCalled = false;
      let lastBriefResponse: any = null;
      (globalThis as any).__queryRouterOverride = async () => ({
        should_query: true,
        query: "database migration",
        confidence: 0.9,
      });
      process.env.FEATURE_QUERY_ROUTER = "true";
      (globalThis as any).__synapseBriefOverride = async (payload: any) => {
        briefCalled = true;
        const response = await synapseClient.sessionBrief(payload);
        lastBriefResponse = response;
        return response;
      };

      let context = null as Awaited<ReturnType<typeof buildContextFromSynapse>> | null;
      const maxAttempts = 10;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        context = await buildContextFromSynapse(
          userId,
          personaId,
          "Hey",
          sessionId,
          true
        );
        if (context?.situationalContext) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      delete (globalThis as any).__queryRouterOverride;
      delete (globalThis as any).__synapseBriefOverride;

      if (!briefCalled) {
        throw new Error("Expected sessionBrief to be called");
      }

      if (!context?.situationalContext) {
        throw new Error(
          `Expected situationalContext from Synapse brief. Response: ${JSON.stringify(
            lastBriefResponse
          )}`
        );
      }
      const lowered = context.situationalContext.toLowerCase();
      if (!lowered.includes("database") && !lowered.includes("migration")) {
        throw new Error("Expected situationalContext to reference database migration");
      }
    } finally {
      delete (globalThis as any).__synapseSessionIngestOverride;
      await cleanup();
      await rm(tmpDir, { recursive: true, force: true });
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
