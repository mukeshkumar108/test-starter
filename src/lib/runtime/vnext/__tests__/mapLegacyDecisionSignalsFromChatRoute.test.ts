/**
 * Unit tests for the temporary chat route -> legacyDecisionSignals bridge.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/mapLegacyDecisionSignalsFromChatRoute.test.ts
 */

import type { SessionContext, TurnEvent } from "../contracts";
import { decideTurn, LEGACY_DECISION_SIGNALS_METADATA_KEY } from "../decideTurn";
import { mapLegacyDecisionSignalsFromChatRoute } from "../mapLegacyDecisionSignalsFromChatRoute";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

const session: SessionContext = {
  sessionId: "session-bridge",
  isNewSession: false,
  turnCount: 3,
};

function event(signals: Record<string, unknown>): TurnEvent {
  return {
    userId: "user-bridge",
    personaId: "persona-bridge",
    modality: "text",
    text: "bridge test",
    timestampUtc: "2026-04-22T12:00:00.000Z",
    metadata: {
      [LEGACY_DECISION_SIGNALS_METADATA_KEY]: signals,
    },
  };
}

async function main() {
  await runTest("maps present legacy route signals into stable shape", () => {
    const signals = mapLegacyDecisionSignalsFromChatRoute({
      riskLevel: "MED",
      intent: "momentum",
      pressure: "LOW",
      posture: "MOMENTUM",
      stanceSelected: "none",
      moment: "win",
      isDirectRequest: true,
      isUrgent: false,
      gateAction: "memory_query",
      gateConfidence: 0.83,
      tierSelected: "T1",
      routingReason: "intent_momentum",
      safetyModelOverride: false,
    });

    expect(signals).toEqual({
      riskLevel: "MED",
      intent: "momentum",
      pressure: "LOW",
      posture: "MOMENTUM",
      stanceSelected: "none",
      moment: "win",
      isDirectRequest: true,
      isUrgent: false,
      memoryQueryEligible: true,
      modelTier: "T1",
      routeSafetyOverride: false,
      confidence: 0.83,
      reasons: ["chat_route_legacy_decision_bridge", "legacy_routing:intent_momentum"],
    });
  });

  await runTest("handles absent route signals without inventing policy", () => {
    const signals = mapLegacyDecisionSignalsFromChatRoute({});

    expect(signals.riskLevel).toBe(undefined);
    expect(signals.intent).toBe(undefined);
    expect(signals.memoryQueryEligible).toBe(undefined);
    expect(signals.modelTier).toBe(undefined);
    expect(signals.reasons).toEqual(["chat_route_legacy_decision_bridge"]);
  });

  await runTest("omits clarity stance until that policy domain migrates", () => {
    const signals = mapLegacyDecisionSignalsFromChatRoute({
      stanceSelected: "clarity",
    });

    expect(signals.stanceSelected).toBe(undefined);
  });

  await runTest("decideTurn consumes mapped signal object", async () => {
    const signals = mapLegacyDecisionSignalsFromChatRoute({
      riskLevel: "HIGH",
      intent: "companion",
      pressure: "HIGH",
      gateAction: "none",
      tierSelected: "T1",
      routingReason: "risk_high_or_crisis",
      safetyModelOverride: true,
    });
    const decision = await decideTurn(event(signals), session);

    expect(decision.intent).toBe("companion");
    expect(decision.sensitivity).toBe("high");
    expect(decision.contextNeeds.memory).toBe(false);
    expect(decision.modelTier).toBe("T1");
    expect(decision.trace?.source).toBe("adapter");
    expect(decision.trace?.legacy?.routeSafetyOverride).toBe(true);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext legacyDecisionSignals bridge tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext legacyDecisionSignals bridge tests passed.");
}

main();

