type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

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
    SYNAPSE_TENANT_ID: "default",
  };
  for (const [key, value] of Object.entries(required)) {
    process.env[key] = value;
  }
}

function expect<T>(actual: T) {
  return {
    toEqual(expected: T) {
      const actualJson = JSON.stringify(actual);
      const expectedJson = JSON.stringify(expected);
      if (actualJson !== expectedJson) {
        throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
      }
    },
    toContain(expected: string) {
      if (!Array.isArray(actual) || !actual.includes(expected as never)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
      }
    },
    toBe(expected: unknown) {
      if (actual !== (expected as T)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
      }
    },
  };
}

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  seedEnv();
  const {
    extractRelevantUserModelLines,
    routeMemoryIntent,
    runMemoryLookup,
    shouldSoftenMemoryClaims,
    shouldFetchMemoryLoops,
    normalizeMemoryToolQuery,
  } = await import("../memory");

  await runTest("user model extraction surfaces exact profile sentence", () => {
    const lines = extractRelevantUserModelLines({
      query: "Do you remember why I went to hospital?",
      candidates: ["hospital reason", "hospital stay reason"],
      userModel: {
        model: {
          general:
            "Lives alone in Cambridge. Recently out of hospital with kidney stones. Building Sophie.",
        },
      },
    });

    expect(lines[0]).toEqual("Recently out of hospital with kidney stones.");
  });

  await runTest("routeMemoryIntent chooses episodic for continuation-style recall", () => {
    const intent = routeMemoryIntent({ query: "remember that conversation we had about God?" });
    expect(intent).toBe("episodic");
  });

  await runTest("routeMemoryIntent chooses exact for identity/fact prompts", () => {
    const intent = routeMemoryIntent({ query: "who is Ashley?" });
    expect(intent).toBe("exact");
  });

  await runTest("routeMemoryIntent defaults to hybrid for mixed recall prompt", () => {
    const intent = routeMemoryIntent({ query: "what do you remember about Ashley lately?" });
    expect(intent).toBe("hybrid");
  });

  await runTest("runMemoryLookup sends memoryIntent and returns episodic context", async () => {
    const originalFetch = global.fetch;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/user/model?")) {
        calls.push({ url });
        return new Response(JSON.stringify({ model: {} }), { status: 200 });
      }
      if (url.endsWith("/memory/query")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ url, body });
        return new Response(
          JSON.stringify({
            facts: [],
            factItems: [
              { text: "User is planning a memory productization push.", relevance_tier: "recent" },
            ],
            entities: [{ summary: "Ashley is in active relationship context." }],
            episodes: [
              {
                summary: "User explored memory as a moat and rollout strategy.",
                evidence: ["User: what did we decide about memory as a moat?"],
                linkedEntities: ["Ashley", "Bluum"],
              },
            ],
            metadata: { episodicWeakRecall: false },
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as typeof fetch;

    try {
      const result = await runMemoryLookup({
        userId: "user-1",
        requestId: "req-1",
        now: new Date("2026-04-10T09:00:00.000Z"),
        query: "remember that thread from before about memory moat",
      });

      const memoryCall = calls.find((call) => call.url.endsWith("/memory/query"));
      if (!memoryCall?.body) throw new Error("Expected /memory/query call body");

      expect(memoryCall.body.memoryIntent as string).toBe("episodic");
      expect(typeof memoryCall.body.focusQuery).toBe("string");
      expect(result.used).toBe(true);
      expect(result.softenClaims).toBe(false);
      if (!result.supplementalContext?.includes("Episodes:")) {
        throw new Error("Expected episodes block in supplemental context");
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  await runTest("shouldFetchMemoryLoops triggers for next-step procedural prompts", () => {
    const shouldFetch = shouldFetchMemoryLoops({
      query: "what are my next steps from our commitments?",
      memoryIntent: "hybrid",
    });
    expect(shouldFetch).toBe(true);
  });

  await runTest("shouldFetchMemoryLoops skips episodic-only continuation prompts", () => {
    const shouldFetch = shouldFetchMemoryLoops({
      query: "remember that thread from before",
      memoryIntent: "episodic",
    });
    expect(shouldFetch).toBe(false);
  });

  await runTest("runMemoryLookup injects loops for procedural query", async () => {
    const originalFetch = global.fetch;
    const calls: string[] = [];

    global.fetch = (async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push(url);
      if (url.includes("/user/model?")) {
        return new Response(JSON.stringify({ model: {} }), { status: 200 });
      }
      if (url.endsWith("/memory/query")) {
        return new Response(
          JSON.stringify({
            facts: [{ text: "User committed to shipping a roadmap update." }],
            factItems: [{ text: "User committed to shipping a roadmap update.", relevance_tier: "recent" }],
            entities: [],
            episodes: [],
            metadata: { episodicWeakRecall: false },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/memory/loops?")) {
        if (init?.method && init.method !== "GET") {
          throw new Error("Expected GET for /memory/loops");
        }
        return new Response(
          JSON.stringify({
            items: [{ text: "Follow up on roadmap update delivery timeline." }],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    }) as typeof fetch;

    try {
      const result = await runMemoryLookup({
        userId: "user-1",
        requestId: "req-loops",
        now: new Date("2026-04-10T09:00:00.000Z"),
        query: "what are my next steps from our commitments?",
      });
      expect(result.used).toBe(true);
      if (!result.supplementalContext?.includes("Open Loops:")) {
        throw new Error("Expected Open Loops block in supplemental context");
      }
      if (!calls.some((url) => url.includes("/memory/loops?"))) {
        throw new Error("Expected /memory/loops call for procedural query");
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  await runTest("normalizeMemoryToolQuery falls back when query is missing", () => {
    const query = normalizeMemoryToolQuery({
      query: undefined,
      fallbackQuery: "do you remember who Ashley is?",
    });
    expect(query).toBe("do you remember who Ashley is?");
  });

  await runTest("shouldSoftenMemoryClaims softens episodic weak recall", () => {
    const softened = shouldSoftenMemoryClaims({
      memoryIntent: "episodic",
      episodicWeakRecall: true,
      hasStrongFacts: false,
    });
    expect(softened).toBe(true);
  });

  await runTest("shouldSoftenMemoryClaims does not soften hybrid when strong facts exist", () => {
    const softened = shouldSoftenMemoryClaims({
      memoryIntent: "hybrid",
      episodicWeakRecall: true,
      hasStrongFacts: true,
    });
    expect(softened).toBe(false);
  });

  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    if (result.passed) {
      console.log(`PASS ${result.name}`);
    } else {
      console.error(`FAIL ${result.name}: ${result.error}`);
    }
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
