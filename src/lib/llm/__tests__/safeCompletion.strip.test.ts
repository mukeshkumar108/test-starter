/**
 * Unit test for reasoning leak stripping
 * Run with: pnpm tsx src/lib/llm/__tests__/safeCompletion.strip.test.ts
 */

import { strict as assert } from "assert";

function stripReasoningLeak(text: string) {
  const cleaned = text.replace(/\*\*Breakdown:\*\*[\s\S]*/i, "").trim();
  return { cleaned, stripped: cleaned !== text };
}

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  await runTest("strips breakdown block", () => {
    const input = "Hello there.\n\n**Breakdown:**\n- step one\n- step two";
    const { cleaned, stripped } = stripReasoningLeak(input);
    assert.equal(cleaned, "Hello there.");
    assert.equal(stripped, true);
  });

  await runTest("no change when no breakdown", () => {
    const input = "All good.";
    const { cleaned, stripped } = stripReasoningLeak(input);
    assert.equal(cleaned, input);
    assert.equal(stripped, false);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nSafeCompletion strip tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("SafeCompletion strip tests passed.");
}

main();
