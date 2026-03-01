/**
 * Unit tests for unknown-entity detection helpers.
 * Run with: pnpm tsx src/app/api/__tests__/entityIntroDetection.test.ts
 */

import {
  __test__buildKnownEntitySet,
  __test__detectTurnEntities,
} from "../chat/route";

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
  await runTest("detects meaningful project entity from first-person work framing", () => {
    const entities = __test__detectTurnEntities("I'm working on Bluum and shipping a fix today.");
    expect(entities.length > 0).toBe(true);
    expect(entities[0]?.name).toBe("Bluum");
    expect(entities[0]?.type).toBe("project");
    expect(entities[0]?.meaningful).toBe(true);
    expect(entities[0]?.evidencePhrase.length > 0).toBe(true);
  });

  await runTest("marks generic media references as non-meaningful", () => {
    const entities = __test__detectTurnEntities("I was reading about dinosaurs last night.");
    const meaningful = entities.some((entity) => entity.meaningful);
    expect(meaningful).toBe(false);
  });

  await runTest("builds known entity set from startbrief, relationships, and context text", () => {
    const known = __test__buildKnownEntitySet({
      startbriefPacket: {
        entity_profiles: [{ name: "Jasmine", profile_text: "x", facts: [] }],
      } as any,
      relationshipNames: ["Ashley"],
      handoverBlock: "People currently in focus include Marcus and Jasmine.",
      signalPackBlock: "Signal Pack (private):\n- [trajectory] Thread: Repair relationship with Jasmine",
    });
    expect(known.has("jasmine")).toBe(true);
    expect(known.has("ashley")).toBe(true);
    expect(known.has("marcus")).toBe(true);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nEntity intro detection tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Entity intro detection tests passed.");
}

main();
