/**
 * Unit tests for model routing helpers
 * Run with: pnpm tsx src/lib/providers/__tests__/models.test.ts
 */

import {
  applyT3BurstRouting,
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
    expect(model).toBe(MODEL_TIERS.T1);
  });

  await runTest("risk CRISIS routes to safety model", () => {
    const model = getChatModelForGate({
      personaId: "mentor",
      gate: { risk_level: "CRISIS" },
    });
    expect(model).toBe(MODEL_TIERS.T1);
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

  await runTest("witness stays at T2 even at high pressure", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "COMPANION",
      pressure: "HIGH",
      stanceSelected: "witness",
      moment: "strain",
      intent: "companion",
    });
    expect(decision.tier).toBe("T2");
    expect(getChatModelForTurn({ tier: decision.tier })).toBe(MODEL_TIERS.T2);
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

  await runTest("depth signal routes to T2 with companion_depth reason", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "RELATIONSHIP",
      pressure: "LOW",
      stanceSelected: "none",
      moment: null,
      intent: "companion",
    });
    expect(decision.tier).toBe("T2");
    expect(decision.reason).toBe("companion_depth");
  });

  await runTest("default fallback routes to T1 when no depth/direct signals", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "IDEATION",
      pressure: "LOW",
      stanceSelected: "none",
      moment: null,
      intent: "companion",
      isDirectRequest: false,
      isUrgent: false,
    });
    expect(decision.tier).toBe("T1");
    expect(decision.reason).toBe("default_balanced");
  });

  await runTest("pressure MED without depth signals now defaults to T1", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "COMPANION",
      pressure: "MED",
      stanceSelected: "none",
      moment: null,
      intent: "companion",
      isDirectRequest: false,
      isUrgent: false,
    });
    expect(decision.tier).toBe("T1");
    expect(decision.reason).toBe("default_balanced");
  });

  await runTest("high strain moment maps to T2 in base routing", () => {
    const decision = getTurnTierForSignals({
      riskLevel: "LOW",
      posture: "COMPANION",
      pressure: "LOW",
      stanceSelected: "none",
      moment: "grief",
      intent: "companion",
    });
    expect(decision.tier).toBe("T2");
    expect(decision.reason).toBe("moment_grief");
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
    expect(safetyModel).toBe(MODEL_TIERS.T1);
    expect(tierDecision.tier).toBe("T3");
  });

  await runTest("peak turn starts burst and uses T3", () => {
    const burst = applyT3BurstRouting({
      baseTier: "T2",
      baseReason: "stance_witness",
      burstState: { activeId: null, remaining: 0, lastUsedAt: 0 },
      stanceSelected: "witness",
      moment: "strain",
      intent: "companion",
      topicHint: "relationship",
      nowMs: 1000,
    });
    expect(burst.tier).toBe("T3");
    expect(burst.burstWasStarted).toBe(true);
    expect(burst.burstRemainingBefore).toBe(0);
    expect(burst.burstRemainingAfter).toBe(1);
  });

  await runTest("second peak turn same event uses T3 and reaches remaining 0", () => {
    const first = applyT3BurstRouting({
      baseTier: "T2",
      baseReason: "stance_witness",
      burstState: { activeId: null, remaining: 0, lastUsedAt: 0 },
      stanceSelected: "witness",
      moment: "strain",
      intent: "companion",
      topicHint: "relationship",
      nowMs: 1000,
    });
    const second = applyT3BurstRouting({
      baseTier: "T2",
      baseReason: "stance_witness",
      burstState: first.burstState,
      stanceSelected: "witness",
      moment: "strain",
      intent: "companion",
      topicHint: "relationship",
      nowMs: 2000,
    });
    expect(second.tier).toBe("T3");
    expect(second.burstRemainingBefore).toBe(1);
    expect(second.burstRemainingAfter).toBe(0);
  });

  await runTest("third turn same peak event is capped and forced to T2", () => {
    const capped = applyT3BurstRouting({
      baseTier: "T2",
      baseReason: "stance_witness",
      burstState: {
        activeId: "stance:witness|intent:companion|topic:relationship",
        remaining: 0,
        lastUsedAt: 2000,
      },
      stanceSelected: "witness",
      moment: "strain",
      intent: "companion",
      topicHint: "relationship",
      nowMs: 3000,
    });
    expect(capped.tier).toBe("T2");
    expect(capped.routingReason).toBe("burst_capped_force_t2");
  });

  await runTest("new peak event starts a new burst and re-escalates to T3", () => {
    const next = applyT3BurstRouting({
      baseTier: "T2",
      baseReason: "stance_witness",
      burstState: {
        activeId: "stance:witness|intent:companion|topic:relationship",
        remaining: 0,
        lastUsedAt: 3000,
      },
      stanceSelected: "repair_and_forward",
      moment: "relationship_rupture",
      intent: "companion",
      topicHint: "relationship",
      nowMs: 4000,
    });
    expect(next.tier).toBe("T3");
    expect(next.burstWasStarted).toBe(true);
    expect(next.burstRemainingAfter).toBe(1);
  });

  await runTest("non-peak turn does not start burst and keeps base tier", () => {
    const nonPeak = applyT3BurstRouting({
      baseTier: "T1",
      baseReason: "intent_output_task",
      burstState: { activeId: null, remaining: 0, lastUsedAt: 0 },
      stanceSelected: "none",
      moment: null,
      intent: "output_task",
      topicHint: "work",
      nowMs: 5000,
    });
    expect(nonPeak.tier).toBe("T1");
    expect(nonPeak.burstEventId).toBe(null);
    expect(nonPeak.burstWasStarted).toBe(false);
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
