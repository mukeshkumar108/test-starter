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
  const { extractRelevantUserModelLines } = await import("../memory");

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
