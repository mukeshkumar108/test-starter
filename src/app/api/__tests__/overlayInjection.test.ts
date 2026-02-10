/**
 * Integration-ish test for overlay injection order
 * Run with: pnpm tsx src/app/api/__tests__/overlayInjection.test.ts
 */

import { __test__buildChatMessages } from "../chat/route";

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
  await runTest("overlay injected after situational + continuity", () => {
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      situationalContext: "FACTS:\n- item",
      continuityBlock: "[CONTINUITY]\nResume",
      overlayBlock: "[OVERLAY]\nOverlay text",
      supplementalContext: "SUPP",
      rollingSummary: "summary",
      recentMessages: [{ role: "assistant", content: "ok" }],
      transcript: "hi",
    });

    const contents = messages.map((message) => message.content);
    const indexPersona = contents.indexOf("PERSONA");
    const indexSituational = contents.findIndex((value) => value.startsWith("SITUATIONAL_CONTEXT"));
    const indexContinuity = contents.findIndex((value) => value.startsWith("[CONTINUITY]"));
    const indexOverlay = contents.findIndex((value) => value.startsWith("[OVERLAY]"));
    const indexSupplemental = contents.findIndex((value) => value.startsWith("[SUPPLEMENTAL_CONTEXT]"));

    expect(indexPersona).toBe(0);
    expect(indexSituational).toBeGreaterThan(indexPersona);
    expect(indexContinuity).toBeGreaterThan(indexSituational);
    expect(indexOverlay).toBeGreaterThan(indexContinuity);
    expect(indexSupplemental).toBeGreaterThan(indexOverlay);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nOverlay injection tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Overlay injection tests passed.");
}

main();
