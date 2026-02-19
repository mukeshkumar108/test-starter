/**
 * Unit tests for memory query response normalization.
 * Run with: pnpm tsx src/app/api/__tests__/memoryQueryNormalization.test.ts
 */

import { __test__normalizeMemoryQueryResponse } from "../chat/route";

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
  await runTest("handles facts as string[] and entities summaries", () => {
    const parsed = __test__normalizeMemoryQueryResponse({
      facts: ["  one  ", "two"],
      entities: [{ summary: "  Entity summary  " }],
    });
    expect(parsed.facts.length).toBe(2);
    expect(parsed.facts[0]).toBe("one");
    expect(parsed.entities[0]).toBe("Entity summary");
  });

  await runTest("handles facts as object[] and ignores malformed rows", () => {
    const parsed = __test__normalizeMemoryQueryResponse({
      facts: [{ text: " object fact " }, { text: "" }, {}],
      entities: [{ summary: "ok" }, {}],
    });
    expect(parsed.facts.length).toBe(1);
    expect(parsed.facts[0]).toBe("object fact");
    expect(parsed.entities.length).toBe(1);
  });

  await runTest("handles null payload safely", () => {
    const parsed = __test__normalizeMemoryQueryResponse(null as any);
    expect(parsed.facts.length).toBe(0);
    expect(parsed.entities.length).toBe(0);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nMemory query normalization tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Memory query normalization tests passed.");
}

main();
