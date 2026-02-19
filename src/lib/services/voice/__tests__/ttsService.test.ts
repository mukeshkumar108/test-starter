/**
 * Unit tests for TTS voice profile helpers.
 * Run with: pnpm tsx src/lib/services/voice/__tests__/ttsService.test.ts
 */

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
  };
  for (const [key, value] of Object.entries(required)) {
    process.env[key] = value;
  }
}

seedEnv();

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (!(Number(actual) > expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be > ${expected}`);
      }
    },
    toBeLessThan(expected: number) {
      if (!(Number(actual) < expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be < ${expected}`);
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
  const { __test__isNightVoiceWindow, __test__resolveVoiceSettings } = await import("../ttsService");

  await runTest("night window true at 23:00", () => {
    expect(__test__isNightVoiceWindow(23)).toBe(true);
  });

  await runTest("night window true at 02:00", () => {
    expect(__test__isNightVoiceWindow(2)).toBe(true);
  });

  await runTest("night window false at 10:00", () => {
    expect(__test__isNightVoiceWindow(10)).toBe(false);
  });

  await runTest("night profile is calmer than day profile", () => {
    const day = __test__resolveVoiceSettings({ text: "hello there", localHour: 14 });
    const night = __test__resolveVoiceSettings({ text: "hello there", localHour: 1 });
    expect(night.stability).toBeGreaterThan(day.stability);
    expect(night.style).toBeLessThan(day.style);
  });

  await runTest("day baseline matches calmer profile defaults", () => {
    const day = __test__resolveVoiceSettings({ text: "hello there", localHour: 14 });
    expect(day.stability).toBe(0.56);
    expect(day.similarity_boost).toBe(0.76);
    expect(day.style).toBe(0.16);
  });

  await runTest("laugh handling still applies at night", () => {
    const nightPlain = __test__resolveVoiceSettings({ text: "hello there", localHour: 1 });
    const nightLaugh = __test__resolveVoiceSettings({ text: "haha hello there", localHour: 1 });
    expect(nightLaugh.style).toBeGreaterThan(nightPlain.style);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nTTS voice profile tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("TTS voice profile tests passed.");
}

main();
