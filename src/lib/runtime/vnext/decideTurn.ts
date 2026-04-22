import type { SessionContext, TurnDecision, TurnEvent } from "./contracts";
import { getTurnTierForSignals, type RoutingMoment } from "../../providers/models";

export const LEGACY_DECISION_SIGNALS_METADATA_KEY = "legacyDecisionSignals";

type LegacyRiskLevel = "LOW" | "MED" | "HIGH" | "CRISIS";
type LegacyPressure = "LOW" | "MED" | "HIGH";
type LegacyIntent = "companion" | "momentum" | "output_task" | "learning";
type LegacyPosture =
  | "COMPANION"
  | "MOMENTUM"
  | "REFLECTION"
  | "RELATIONSHIP"
  | "IDEATION"
  | "RECOVERY"
  | "PRACTICAL";
type LegacyStance =
  | "witness"
  | "excavator"
  | "repair_and_forward"
  | "high_standards_friend"
  | "none";

export type LegacyTurnDecisionSignals = {
  riskLevel?: LegacyRiskLevel;
  intent?: LegacyIntent;
  pressure?: LegacyPressure;
  posture?: LegacyPosture;
  stanceSelected?: LegacyStance;
  moment?: RoutingMoment;
  isDirectRequest?: boolean;
  isUrgent?: boolean;
  memoryQueryEligible?: boolean;
  toolNeed?: "none" | "possible" | "required";
  modelTier?: "T1" | "T2" | "T3";
  routeSafetyOverride?: boolean;
  confidence?: number;
  reasons?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readLegacySignals(event: TurnEvent): LegacyTurnDecisionSignals | null {
  const raw = event.metadata?.[LEGACY_DECISION_SIGNALS_METADATA_KEY];
  if (!isRecord(raw)) return null;

  return {
    riskLevel:
      raw.riskLevel === "LOW" ||
      raw.riskLevel === "MED" ||
      raw.riskLevel === "HIGH" ||
      raw.riskLevel === "CRISIS"
        ? raw.riskLevel
        : undefined,
    intent:
      raw.intent === "companion" ||
      raw.intent === "momentum" ||
      raw.intent === "output_task" ||
      raw.intent === "learning"
        ? raw.intent
        : undefined,
    pressure:
      raw.pressure === "LOW" || raw.pressure === "MED" || raw.pressure === "HIGH"
        ? raw.pressure
        : undefined,
    posture:
      raw.posture === "COMPANION" ||
      raw.posture === "MOMENTUM" ||
      raw.posture === "REFLECTION" ||
      raw.posture === "RELATIONSHIP" ||
      raw.posture === "IDEATION" ||
      raw.posture === "RECOVERY" ||
      raw.posture === "PRACTICAL"
        ? raw.posture
        : undefined,
    stanceSelected:
      raw.stanceSelected === "witness" ||
      raw.stanceSelected === "excavator" ||
      raw.stanceSelected === "repair_and_forward" ||
      raw.stanceSelected === "high_standards_friend" ||
      raw.stanceSelected === "none"
        ? raw.stanceSelected
        : undefined,
    moment:
      raw.moment === "grief" ||
      raw.moment === "relationship_rupture" ||
      raw.moment === "deep_strain" ||
      raw.moment === "shame" ||
      raw.moment === "strain" ||
      raw.moment === "win" ||
      raw.moment === "comeback"
        ? raw.moment
        : undefined,
    isDirectRequest: typeof raw.isDirectRequest === "boolean" ? raw.isDirectRequest : undefined,
    isUrgent: typeof raw.isUrgent === "boolean" ? raw.isUrgent : undefined,
    memoryQueryEligible:
      typeof raw.memoryQueryEligible === "boolean" ? raw.memoryQueryEligible : undefined,
    toolNeed:
      raw.toolNeed === "none" || raw.toolNeed === "possible" || raw.toolNeed === "required"
        ? raw.toolNeed
        : undefined,
    modelTier:
      raw.modelTier === "T1" || raw.modelTier === "T2" || raw.modelTier === "T3"
        ? raw.modelTier
        : undefined,
    routeSafetyOverride:
      typeof raw.routeSafetyOverride === "boolean" ? raw.routeSafetyOverride : undefined,
    confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : undefined,
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.filter((reason): reason is string => typeof reason === "string")
      : undefined,
  };
}

function mapSensitivity(riskLevel?: LegacyRiskLevel): TurnDecision["sensitivity"] {
  if (riskLevel === "CRISIS") return "crisis";
  if (riskLevel === "HIGH") return "high";
  if (riskLevel === "MED") return "medium";
  return "low";
}

function defaultContextNeeds(memory: boolean): TurnDecision["contextNeeds"] {
  return {
    recentTurns: false,
    memory,
    continuity: false,
    calendar: false,
    tasks: false,
    web: false,
    weather: false,
    traffic: false,
  };
}

export async function decideTurn(
  event: TurnEvent,
  session: SessionContext
): Promise<TurnDecision> {
  const legacySignals = readLegacySignals(event);
  const riskLevel = legacySignals?.riskLevel;
  const intent = legacySignals?.intent ?? "unknown";
  const tierDecision = getTurnTierForSignals({
    riskLevel,
    posture: legacySignals?.posture,
    pressure: legacySignals?.pressure,
    stanceSelected: legacySignals?.stanceSelected,
    moment: legacySignals?.moment,
    intent: legacySignals?.intent,
    isDirectRequest: legacySignals?.isDirectRequest,
    isUrgent: legacySignals?.isUrgent,
  });
  // Mirrors the legacy route's post-routing safety override. This is adapter
  // mapping only; it does not change live route behavior.
  const modelTier =
    legacySignals?.modelTier ??
    (riskLevel === "HIGH" || riskLevel === "CRISIS" ? "T1" : tierDecision.tier);
  const memory = legacySignals?.memoryQueryEligible === true;

  return {
    intent,
    sensitivity: mapSensitivity(riskLevel),
    toolNeed: legacySignals?.toolNeed ?? "none",
    contextNeeds: defaultContextNeeds(memory),
    responseMode: event.modality === "voice" ? "text_and_voice" : "text",
    modelTier,
    reasoningEffort: modelTier === "T3" ? "high" : modelTier === "T2" ? "medium" : "low",
    policyFlags: {
      allowTools: legacySignals?.toolNeed === "required" || legacySignals?.toolNeed === "possible",
      allowMemoryWrite: false,
      allowProbing: false,
      continuityMode: session.isNewSession ? "light" : "none",
      requireSafetyTemplate: riskLevel === "HIGH" || riskLevel === "CRISIS",
    },
    trace: {
      source: legacySignals ? "adapter" : "stub",
      confidence: legacySignals?.confidence ?? 0,
      reasons: [
        ...(legacySignals?.reasons ?? []),
        legacySignals ? `model_tier:${tierDecision.reason}` : "missing_legacy_decision_signals",
      ],
      legacy: legacySignals
        ? {
            riskLevel,
            posture: legacySignals.posture ?? null,
            pressure: legacySignals.pressure ?? null,
            stanceSelected: legacySignals.stanceSelected ?? null,
            routeSafetyOverride:
              legacySignals.routeSafetyOverride ??
              (!legacySignals.modelTier && (riskLevel === "HIGH" || riskLevel === "CRISIS")),
          }
        : undefined,
    },
  };
}

export const __test__ = {
  readLegacySignals,
};
