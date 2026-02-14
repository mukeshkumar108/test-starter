/**
 * Unit tests for model routing helpers
 * Run with: pnpm tsx src/lib/providers/__tests__/models.test.ts
 */

import { MODELS, getChatModelForGate, getChatModelForPersona } from "../models";

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
  await runTest("risk HIGH routes to safety model", () => {
    const model = getChatModelForGate({
      personaId: "creative",
      gate: { risk_level: "HIGH" },
    });
    expect(model).toBe(MODELS.CHAT.SAFETY);
  });

  await runTest("risk CRISIS routes to safety model", () => {
    const model = getChatModelForGate({
      personaId: "mentor",
      gate: { risk_level: "CRISIS" },
    });
    expect(model).toBe(MODELS.CHAT.SAFETY);
  });

  await runTest("risk LOW routes to persona model", () => {
    const model = getChatModelForGate({
      personaId: "creative",
      gate: { risk_level: "LOW" },
    });
    expect(model).toBe(getChatModelForPersona("creative"));
  });

  await runTest("unknown persona still falls back to mentor model", () => {
    const model = getChatModelForGate({
      personaId: "unknown-persona",
      gate: { risk_level: "LOW" },
    });
    expect(model).toBe(MODELS.CHAT.MENTOR);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nModel routing tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Model routing tests passed.");
}

main();
