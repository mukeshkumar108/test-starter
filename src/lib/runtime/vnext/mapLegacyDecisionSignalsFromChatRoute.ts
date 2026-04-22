import type { RoutingMoment, TurnTier } from "../../providers/models";
import type { LegacyTurnDecisionSignals } from "./decideTurn";

type RouteRiskLevel = "LOW" | "MED" | "HIGH" | "CRISIS";
type RoutePressure = "LOW" | "MED" | "HIGH";
type RouteIntent = "companion" | "momentum" | "output_task" | "learning";
type RoutePosture =
  | "COMPANION"
  | "MOMENTUM"
  | "REFLECTION"
  | "RELATIONSHIP"
  | "IDEATION"
  | "RECOVERY"
  | "PRACTICAL";
type RouteStance =
  | "witness"
  | "excavator"
  | "repair_and_forward"
  | "high_standards_friend"
  | "clarity"
  | "none";

export type MapLegacyDecisionSignalsFromChatRouteParams = {
  riskLevel?: RouteRiskLevel;
  intent?: RouteIntent;
  pressure?: RoutePressure;
  posture?: RoutePosture;
  stanceSelected?: RouteStance;
  moment?: RoutingMoment | null;
  isDirectRequest?: boolean;
  isUrgent?: boolean;
  gateAction?: "memory_query" | "none";
  gateConfidence?: number;
  tierSelected?: TurnTier;
  routingReason?: string;
  safetyModelOverride?: boolean;
};

function mapStance(stance?: RouteStance): LegacyTurnDecisionSignals["stanceSelected"] {
  // TODO(vNext): clarity is currently a route-specific stance override. Keep it
  // out of the generic vNext decision signal until that policy domain migrates.
  return stance === "clarity" ? undefined : stance;
}

export function mapLegacyDecisionSignalsFromChatRoute(
  params: MapLegacyDecisionSignalsFromChatRouteParams
): LegacyTurnDecisionSignals {
  const reasons = [
    "chat_route_legacy_decision_bridge",
    params.routingReason ? `legacy_routing:${params.routingReason}` : null,
    params.safetyModelOverride ? "legacy_safety_model_override" : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    riskLevel: params.riskLevel,
    intent: params.intent,
    pressure: params.pressure,
    posture: params.posture,
    stanceSelected: mapStance(params.stanceSelected),
    moment: params.moment ?? undefined,
    isDirectRequest: params.isDirectRequest,
    isUrgent: params.isUrgent,
    memoryQueryEligible:
      params.gateAction === undefined ? undefined : params.gateAction === "memory_query",
    modelTier: params.tierSelected,
    routeSafetyOverride: params.safetyModelOverride,
    confidence:
      typeof params.gateConfidence === "number" && Number.isFinite(params.gateConfidence)
        ? Math.max(0, Math.min(1, params.gateConfidence))
        : undefined,
    reasons,
  };
}

