/**
 * Unit test for Librarian Reflex (gate/spec/relevance + supplemental context)
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
process.env.LIBRARIAN_TIMEOUT_MS = "5000";

import {
  __test__runLibrarianReflex,
  __test__buildChatMessages,
  __test__resetPostureStateCache,
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

async function testExplicitRecall() {
  const transcript = "What did I say about the protein shake?";
  const dummyFacts = [{ text: "User loves vegan cinnamon protein shake." }];
  const dummyEntities = [
    { summary: "Cinnamon Pea Protein: 9/10 flavor, slightly chalky." },
  ];

  let gateCalled = false;
  let specCalled = false;
  let relevanceCalled = false;
  let queryCalled = false;

  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate")) {
        gateCalled = true;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "memory_query",
                    confidence: 0.8,
                    explicit: true,
                    posture: "MOMENTUM",
                    pressure: "MED",
                    posture_confidence: 0.9,
                    explicit_topic_shift: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (prompt.includes("Memory Query Specifier")) {
        specCalled = true;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    entities: ["protein shake"],
                    topics: ["nutrition"],
                    time_hint: null,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (prompt.includes("Recall Relevance Judge")) {
        relevanceCalled = true;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    use: true,
                    confidence: 0.9,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
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

    const supplementalText = supplemental?.supplementalContext ?? null;
    expect(gateCalled, "Expected gate to be called");
    expect(specCalled, "Expected spec to be called");
    expect(relevanceCalled, "Expected relevance check to be called");
    expect(queryCalled, "Expected memory query to be called");
    expect(
      supplementalText?.includes("Recall Sheet"),
      "Expected recall sheet header in supplemental context"
    );

    const messages = __test__buildChatMessages({
      persona: "Persona",
      situationalContext: "Brief",
      supplementalContext: supplementalText,
      rollingSummary: "",
      recentMessages: [],
      transcript,
      posture: supplemental?.posture,
      pressure: supplemental?.pressure,
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

async function testAmbientRequiresHighConfidence() {
  const transcript = "Ashley was really helpful today.";
  let queryCalled = false;
  const originalFetch = global.fetch;

  __test__resetPostureStateCache();
  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "memory_query",
                    confidence: 0.7,
                    explicit: false,
                    posture: "REFLECTION",
                    pressure: "LOW",
                    posture_confidence: 0.6,
                    explicit_topic_shift: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
    }
    if (url.endsWith("/memory/query")) {
      queryCalled = true;
      return new Response(JSON.stringify({ facts: [], entities: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const supplemental = await __test__runLibrarianReflex({
      requestId: "req-test-ambient",
      userId: "user-ambient",
      personaId: "persona-ambient",
      sessionId: "session-ambient",
      transcript,
      recentMessages: [{ role: "user", content: "Hey." }],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    expect(!queryCalled, "Did not expect memory query for low-confidence ambient recall");
    expect(
      supplemental?.supplementalContext === null,
      "Expected no supplemental context for low-confidence ambient recall"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testIrrelevantRejected() {
  const transcript = "Ashley was really helpful today.";
  const originalFetch = global.fetch;

  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "memory_query",
                    confidence: 0.9,
                    explicit: false,
                    posture: "RELATIONSHIP",
                    pressure: "MED",
                    posture_confidence: 0.8,
                    explicit_topic_shift: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (prompt.includes("Memory Query Specifier")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    entities: ["Ashley"],
                    topics: [],
                    time_hint: null,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (prompt.includes("Recall Relevance Judge")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    use: false,
                    confidence: 0.4,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
    }
    if (url.endsWith("/memory/query")) {
      return new Response(
        JSON.stringify({ facts: [{ text: "Old memory about someone else." }], entities: [] }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const supplemental = await __test__runLibrarianReflex({
      requestId: "req-test-irrelevant",
      userId: "user-irrelevant",
      personaId: "persona-irrelevant",
      sessionId: "session-irrelevant",
      transcript,
      recentMessages: [{ role: "user", content: "Hey." }],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    expect(
      supplemental?.supplementalContext === null,
      "Expected irrelevant retrieval to be rejected"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testNoNoMemoriesForAmbient() {
  const transcript = "Ashley was really helpful today.";
  const originalFetch = global.fetch;

  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "memory_query",
                    confidence: 0.9,
                    explicit: false,
                    posture: "IDEATION",
                    pressure: "MED",
                    posture_confidence: 0.8,
                    explicit_topic_shift: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (prompt.includes("Memory Query Specifier")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    entities: ["Ashley"],
                    topics: [],
                    time_hint: null,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (prompt.includes("Recall Relevance Judge")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    use: true,
                    confidence: 0.9,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
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
      requestId: "req-test-ambient-empty",
      userId: "user-ambient-empty",
      personaId: "persona-ambient-empty",
      sessionId: "session-ambient-empty",
      transcript,
      recentMessages: [{ role: "user", content: "Hey." }],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    expect(
      supplemental?.supplementalContext === null,
      "Expected no supplemental context for ambient no-memory"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testPostureBlockPresentWhenActionNone() {
  const transcript = "Hey there.";
  const originalFetch = global.fetch;
  __test__resetPostureStateCache();

  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "none",
                    confidence: 0.2,
                    explicit: false,
                    posture: "REFLECTION",
                    pressure: "LOW",
                    posture_confidence: 0.4,
                    explicit_topic_shift: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await __test__runLibrarianReflex({
      requestId: "req-test-posture",
      userId: "user-posture",
      personaId: "persona-posture",
      sessionId: "session-posture",
      transcript,
      recentMessages: [],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    const messages = __test__buildChatMessages({
      persona: "Persona",
      situationalContext: "",
      supplementalContext: null,
      rollingSummary: "",
      recentMessages: [],
      transcript,
      posture: result?.posture,
      pressure: result?.pressure,
    });

    expect(
      messages[0]?.content.startsWith("[CONVERSATION_POSTURE]"),
      "Expected posture block to be first"
    );
    expect(
      messages[1]?.content === "Persona",
      "Expected persona prompt to be second"
    );
  } finally {
    global.fetch = originalFetch;
  }
}

async function testPostureSwitchesOnHighConfidence() {
  const transcript = "Let's go crush it.";
  const originalFetch = global.fetch;
  __test__resetPostureStateCache();

  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "none",
                    confidence: 0.2,
                    explicit: false,
                    posture: "MOMENTUM",
                    pressure: "HIGH",
                    posture_confidence: 0.8,
                    explicit_topic_shift: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await __test__runLibrarianReflex({
      requestId: "req-test-posture-high",
      userId: "user-posture-high",
      personaId: "persona-posture-high",
      sessionId: "session-posture-high",
      transcript,
      recentMessages: [],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    expect(result?.posture === "MOMENTUM", "Expected posture to switch on high confidence");
  } finally {
    global.fetch = originalFetch;
  }
}

async function testPostureHysteresisHoldLowConfidence() {
  const transcript = "I'm not sure.";
  const originalFetch = global.fetch;
  __test__resetPostureStateCache();

  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "none",
                    confidence: 0.2,
                    explicit: false,
                    posture: "RECOVERY",
                    pressure: "LOW",
                    posture_confidence: 0.6,
                    explicit_topic_shift: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await __test__runLibrarianReflex({
      requestId: "req-test-posture-low",
      userId: "user-posture-low",
      personaId: "persona-posture-low",
      sessionId: "session-posture-low",
      transcript,
      recentMessages: [],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    expect(result?.posture === "COMPANION", "Expected posture to hold on low confidence");
  } finally {
    global.fetch = originalFetch;
  }
}

async function testPostureSwitchesOnRepeatedSuggestion() {
  const transcript = "Still feeling tired.";
  const originalFetch = global.fetch;
  __test__resetPostureStateCache();

  global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt = body?.messages?.[0]?.content ?? "";
      if (prompt.includes("Memory Gate")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "none",
                    confidence: 0.2,
                    explicit: false,
                    posture: "RECOVERY",
                    pressure: "LOW",
                    posture_confidence: 0.6,
                    explicit_topic_shift: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const first = await __test__runLibrarianReflex({
      requestId: "req-test-posture-repeat-1",
      userId: "user-posture-repeat",
      personaId: "persona-posture-repeat",
      sessionId: "session-posture-repeat",
      transcript,
      recentMessages: [],
      now: new Date("2026-02-06T10:15:00Z"),
      shouldTrace: false,
    });

    const second = await __test__runLibrarianReflex({
      requestId: "req-test-posture-repeat-2",
      userId: "user-posture-repeat",
      personaId: "persona-posture-repeat",
      sessionId: "session-posture-repeat",
      transcript,
      recentMessages: [],
      now: new Date("2026-02-06T10:16:00Z"),
      shouldTrace: false,
    });

    expect(first?.posture === "COMPANION", "Expected first suggestion to hold");
    expect(second?.posture === "RECOVERY", "Expected switch on repeated suggestion");
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  await test("Explicit recall triggers query and injects supplemental context", testExplicitRecall);
  await test("Ambient mention requires high confidence", testAmbientRequiresHighConfidence);
  await test("Irrelevant retrieval rejected by relevance check", testIrrelevantRejected);
  await test("No 'no memories' text for ambient recall", testNoNoMemoriesForAmbient);
  await test("Posture block present even when action=none", testPostureBlockPresentWhenActionNone);
  await test("Posture switches on high confidence", testPostureSwitchesOnHighConfidence);
  await test("Posture hysteresis holds on low confidence", testPostureHysteresisHoldLowConfidence);
  await test("Posture switches on repeated suggestion", testPostureSwitchesOnRepeatedSuggestion);
  console.log("All tests passed.");
}

run().catch((error) => {
  console.error("Unhandled test error:", error);
  process.exit(1);
});
