/**
 * Unit test for Librarian Reflex (bouncer + supplemental context injection)
 * Run with: pnpm tsx src/synapse/librarian.test.ts
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
process.env.SYNAPSE_BASE_URL = "https://synapse.test";
process.env.SYNAPSE_TENANT_ID = "tenant-test";

import {
  __test__runLibrarianReflex,
  __test__buildChatMessages,
} from "@/app/api/chat/route";

function expect(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function testBouncerTriggers() {
  const transcript = "What did I say about the protein shake?";
  const dummyFacts = [{ text: "User loves vegan cinnamon protein shake." }];
  const dummyEntities = [
    { summary: "Cinnamon Pea Protein: 9/10 flavor, slightly chalky." },
  ];

  let bouncerCalled = false;
  let queryCalled = false;

  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      bouncerCalled = true;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "memory_query",
                  search_string: "protein shake memory",
                  confidence: 0.9,
                }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/memory/query")) {
      queryCalled = true;
      return new Response(
        JSON.stringify({ facts: dummyFacts, entities: dummyEntities }),
        { status: 200 }
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const supplemental = await __test__runLibrarianReflex({
      requestId: "req-test",
      userId: "user-1",
      personaId: "persona-1",
      sessionId: "session-1",
      transcript,
      recentMessages: [
        { role: "user", content: "I was talking about protein shakes." },
        { role: "assistant", content: "Tell me more." },
      ],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    expect(bouncerCalled, "Expected bouncer to be called");
    expect(queryCalled, "Expected memory query to be called");
    expect(
      supplemental?.includes("Recall Sheet"),
      "Expected recall sheet header in supplemental context"
    );
    expect(
      supplemental?.includes("User loves vegan cinnamon protein shake"),
      "Expected supplemental context to include dummy facts"
    );

    const messages = __test__buildChatMessages({
      persona: "Persona",
      situationalContext: "Brief",
      supplementalContext: supplemental,
      rollingSummary: "",
      recentMessages: [],
      transcript,
    });

    const supplementalBlock = messages.find((msg) =>
      msg.content.startsWith("[SUPPLEMENTAL_CONTEXT]")
    );
    expect(Boolean(supplementalBlock), "Expected supplemental context block");
    expect(
      supplementalBlock?.content.includes(
        "Cinnamon Pea Protein: 9/10 flavor, slightly chalky."
      ) ?? false,
      "Expected supplemental block to include entity summary"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testFallbackWhenEmpty() {
  const transcript = "Do you remember my protein shake?";

  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "memory_query",
                  search_string: "protein shake memory",
                  confidence: 0.9,
                }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/memory/query")) {
      return new Response(
        JSON.stringify({ facts: [], entities: [] }),
        { status: 200 }
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const supplemental = await __test__runLibrarianReflex({
      requestId: "req-test-2",
      userId: "user-2",
      personaId: "persona-2",
      sessionId: "session-2",
      transcript,
      recentMessages: [{ role: "user", content: "Hey." }],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    expect(
      supplemental?.includes('No matching memories found for "protein shake memory".'),
      "Expected fallback no-memory message"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  await test("Librarian bouncer triggers memory query + injects supplemental context", testBouncerTriggers);
  await test("Librarian returns fallback when no memories found", testFallbackWhenEmpty);
  console.log("All tests passed.");
}

run().catch((error) => {
  console.error("Unhandled test error:", error);
  process.exit(1);
});
