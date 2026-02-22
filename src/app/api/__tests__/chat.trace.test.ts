/**
 * Unit tests for chat trace payload shape
 * Run with: pnpm tsx src/app/api/__tests__/chat.trace.test.ts
 */

process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "test";
process.env.CLERK_SECRET_KEY = "test";
process.env.POSTGRES_PRISMA_URL = "postgres://test";
process.env.POSTGRES_URL_NON_POOLING = "postgres://test";
process.env.BLOB_READ_WRITE_TOKEN = "test";
process.env.CLERK_WEBHOOK_SECRET = "test";
process.env.OPENROUTER_API_KEY = "test";
process.env.ELEVENLABS_API_KEY = "test";
process.env.ELEVENLABS_DEFAULT_VOICE_ID = "test";
process.env.LEMONFOX_API_KEY = "test";
process.env.OPENAI_API_KEY = "test";

import { __test__buildChatTrace } from "../chat/route";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  await runTest("trace payload includes timings map", () => {
    const trace = __test__buildChatTrace({
      traceId: "trace-1",
      requestId: "req-1",
      userId: "user-1",
      personaId: "persona-1",
      sessionId: "session-1",
      chosenModel: "model-x",
      riskLevel: "LOW",
      intent: "companion",
      stanceSelected: "none",
      tacticSelected: "none",
      suppressionReason: null,
      overlaySelected: "none",
      overlaySkipReason: null,
      startbrief: {
        used: true,
        fallback: null,
        items_count: 3,
        bridgeText_chars: 128,
      },
      startbriefRuntime: {
        session_id: "session-1",
        userTurnsSeen: 1,
        handover_injected: true,
        bridge_injected: true,
        ops_injected: false,
        ops_source: null,
        startbrief_fetch: "miss",
        reinjection_used: false,
      },
      systemBlocks: ["persona", "posture", "overlay", "bridge", "handover"],
      counts: {
        recentMessages: 2,
        situationalContext: 1,
        supplementalContext: 0,
        rollingSummary: 1,
      },
      timings: {
        stt_ms: 100,
        context_ms: 50,
        librarian_ms: 75,
        overlay_ms: 20,
        llm_ms: 400,
        tts_ms: 300,
        db_write_ms: 30,
        total_ms: 975,
      },
    });

    expect(typeof trace.timings).toBe("object");
    expect(trace.timings.stt_ms).toBe(100);
    expect(trace.timings.context_ms).toBe(50);
    expect(trace.request_id).toBe("req-1");
    expect(trace.stanceSelected).toBe("none");
    expect(trace.tacticSelected).toBe("none");
    expect(trace.suppressionReason).toBe(null);
    expect(trace.overlaySkipReason).toBe(null);
    expect(trace.startbrief_used).toBe(true);
    expect(trace.startbrief_items_count).toBe(3);
    expect(trace.startbrief_runtime.session_id).toBe("session-1");
    expect(trace.startbrief_runtime.handover_injected).toBe(true);
    expect(trace.system_blocks[0]).toBe("persona");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nChat trace tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Chat trace tests passed.");
}

main();
