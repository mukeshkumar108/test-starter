/**
 * Unit tests for model routing helpers
 * Run with: pnpm tsx src/lib/providers/__tests__/models.test.ts
 */

import {
  MODELS,
  MODEL_TIERS,
  getChatModelForGate,
  getChatModelForPersona,
  getChatModelForTurn,
  getTurnTierForSignals,
} from "../models";

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

  await runTest("witness maps to T2 by default", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "COMPANION",
      pressure: "MED",
      stanceSelected: "witness",
      moment: null,
      intent: "companion",
    });
    expect(decision.tier).toBe("T2");
    expect(getChatModelForTurn({ tier: decision.tier })).toBe(MODEL_TIERS.T2);
  });

  await runTest("witness maps to T3 at high pressure", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "COMPANION",
      pressure: "HIGH",
      stanceSelected: "witness",
      moment: "strain",
      intent: "companion",
    });
    expect(decision.tier).toBe("T3");
    expect(getChatModelForTurn({ tier: decision.tier })).toBe(MODEL_TIERS.T3);
  });

  await runTest("repair_and_forward maps to T3", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "COMPANION",
      pressure: "MED",
      stanceSelected: "repair_and_forward",
      moment: null,
      intent: "companion",
    });
    expect(decision.tier).toBe("T3");
    expect(getChatModelForTurn({ tier: decision.tier })).toBe(MODEL_TIERS.T3);
  });

  await runTest("output_task defaults to T1", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "MOMENTUM",
      pressure: "LOW",
      stanceSelected: "none",
      moment: null,
      intent: "output_task",
    });
    expect(decision.tier).toBe("T1");
    expect(getChatModelForTurn({ tier: decision.tier })).toBe(MODEL_TIERS.T1);
  });

  await runTest("risk HIGH keeps safety model regardless of stance", () => {
    const safetyModel = getChatModelForGate({
      personaId: "mentor",
      gate: { risk_level: "HIGH" },
    });
    const tierDecision = getTurnTierForSignals({
      riskLevel: "HIGH",
      posture: "COMPANION",
      pressure: "LOW",
      stanceSelected: "witness",
      moment: "win",
      intent: "output_task",
    });
    expect(safetyModel).toBe(MODELS.CHAT.SAFETY);
    expect(tierDecision.tier).toBe("T3");
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
