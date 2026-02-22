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
  await runTest("user context and overlay injected in expected order", () => {
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      userContextBlock: "[USER_CONTEXT]\n- Daily anchors: steps goal 10,000.",
      stanceOverlayBlock: "[STANCE_OVERLAY]\nWitness stance",
      tacticOverlayBlock: "[OVERLAY]\nTactic text",
      overlayBlock: "[OVERLAY]\nOverlay text",
      bridgeBlock: "BRIDGE",
      handoverBlock: "HANDOVER",
      opsSnippetBlock: "OPS",
      supplementalContext: "SUPP",
      recentMessages: [{ role: "assistant", content: "ok" }],
      transcript: "hi",
    });

    const contents = messages.map((message) => message.content);
    const indexPersona = contents.indexOf("PERSONA");
    const indexUserContext = contents.findIndex((value) => value.startsWith("[USER_CONTEXT]"));
    const indexStance = contents.findIndex((value) => value.startsWith("[STANCE_OVERLAY]"));
    const indexTactic = contents.findIndex((value) => value === "[OVERLAY]\nTactic text");
    const indexOverlay = contents.findIndex((value) => value.startsWith("[OVERLAY]"));
    const indexBridge = contents.indexOf("BRIDGE");
    const indexHandover = contents.indexOf("HANDOVER");
    const indexOps = contents.indexOf("OPS");
    const indexSupplemental = contents.findIndex((value) => value.startsWith("[SUPPLEMENTAL_CONTEXT]"));

    expect(indexPersona).toBe(0);
    expect(indexUserContext).toBeGreaterThan(indexPersona);
    expect(indexStance).toBeGreaterThan(indexUserContext);
    expect(indexTactic).toBeGreaterThan(indexStance);
    expect(indexOverlay).toBeGreaterThan(indexUserContext);
    expect(indexOverlay).toBeGreaterThan(indexPersona);
    expect(indexBridge).toBeGreaterThan(indexOverlay);
    expect(indexHandover).toBeGreaterThan(indexBridge);
    expect(indexOps).toBeGreaterThan(indexHandover);
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
