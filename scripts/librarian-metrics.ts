import { prisma } from "@/lib/prisma";
import { writeFileSync } from "node:fs";

type Args = {
  days: number | null;
  since: Date | null;
  maxRows: number;
  alert: boolean;
  json: boolean;
  jsonPath: string | null;
  minSegmentSize: number;
  thresholdRegret: number;
  thresholdCooldown: number;
  thresholdRouterFallback: number;
  thresholdTriageParseFallback: number;
};

type JsonObject = Record<string, unknown>;

type TurnRecord = {
  requestId: string;
  userId: string | null;
  personaId: string | null;
  sessionId: string | null;
  createdAt: Date;
  kind: string;
  sessionStart: boolean;
  timeBucket: "morning" | "afternoon" | "evening" | "night";
  overlaySkipReason: string | null;
  stanceSelected: string;
  tacticSelected: string;
  triggerReason: string | null;
  suppressionReason: string | null;
  overlayExitReason: string | null;
  riskLevel: string | null;
  triageOutput: JsonObject | null;
  routerRunReason: string | null;
  routerOutput: JsonObject | null;
  routerModel: string | null;
  routerUsedFallbackModel: boolean;
  cooldownTurnsRemaining: number | null;
  cooldownActivatedReason: string | null;
  tacticEligibilityAllowed: boolean | null;
  tacticEligibilityVetoReasons: string[];
  tacticRegretCandidate: boolean;
  curiosityContinuationAttempted: boolean;
  curiosityContinuationBlockedByEligibility: boolean;
};

type RateResult = {
  numerator: number;
  denominator: number;
  rate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
};

const PROBING_TACTICS = new Set(["curiosity_spiral", "accountability_tug"]);

function parseArgs(argv: string[]): Args {
  const out: Args = {
    days: 7,
    since: null,
    maxRows: 50_000,
    alert: false,
    json: false,
    jsonPath: null,
    minSegmentSize: 200,
    thresholdRegret: 0.08,
    thresholdCooldown: 0.12,
    thresholdRouterFallback: 0.02,
    thresholdTriageParseFallback: 0.005,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--days" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) out.days = parsed;
      i += 1;
      continue;
    }
    if (token === "--since" && next) {
      const date = new Date(next);
      if (!Number.isNaN(date.getTime())) {
        out.since = date;
        out.days = null;
      }
      i += 1;
      continue;
    }
    if (token === "--maxRows" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) out.maxRows = parsed;
      i += 1;
      continue;
    }
    if (token === "--alert") {
      out.alert = true;
      continue;
    }
    if (token === "--json") {
      out.json = true;
      continue;
    }
    if (token === "--jsonPath" && next) {
      out.jsonPath = next;
      i += 1;
      continue;
    }
    if (token === "--minSegmentSize" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) out.minSegmentSize = parsed;
      i += 1;
      continue;
    }
    if (token === "--thresholdRegret" && next) {
      const parsed = Number.parseFloat(next);
      if (Number.isFinite(parsed) && parsed >= 0) out.thresholdRegret = parsed;
      i += 1;
      continue;
    }
    if (token === "--thresholdCooldown" && next) {
      const parsed = Number.parseFloat(next);
      if (Number.isFinite(parsed) && parsed >= 0) out.thresholdCooldown = parsed;
      i += 1;
      continue;
    }
    if (token === "--thresholdRouterFallback" && next) {
      const parsed = Number.parseFloat(next);
      if (Number.isFinite(parsed) && parsed >= 0) out.thresholdRouterFallback = parsed;
      i += 1;
      continue;
    }
    if (token === "--thresholdTriageParseFallback" && next) {
      const parsed = Number.parseFloat(next);
      if (Number.isFinite(parsed) && parsed >= 0) out.thresholdTriageParseFallback = parsed;
      i += 1;
    }
  }

  return out;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function bucketHour(date: Date): "morning" | "afternoon" | "evening" | "night" {
  const hour = date.getUTCHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

function wilsonInterval(successes: number, trials: number, z = 1.96) {
  if (trials <= 0) {
    return { low: null, high: null } as const;
  }
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin =
    (z / denom) *
    Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  } as const;
}

function computeRate(numerator: number, denominator: number): RateResult {
  if (denominator <= 0) {
    return {
      numerator,
      denominator,
      rate: null,
      ciLow: null,
      ciHigh: null,
    };
  }
  const rate = numerator / denominator;
  const ci = wilsonInterval(numerator, denominator);
  return {
    numerator,
    denominator,
    rate,
    ciLow: ci.low,
    ciHigh: ci.high,
  };
}

function pct(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function fmtRate(label: string, data: RateResult) {
  return `${label.padEnd(46)} ${String(data.numerator).padStart(6)} / ${String(
    data.denominator
  ).padStart(6)}  ${pct(data.rate).padStart(8)}  CI[${pct(data.ciLow)}, ${pct(data.ciHigh)}]`;
}

function topN(map: Map<string, number>, limit = 8) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function ensureCounter(map: Map<string, number>, key: string, inc = 1) {
  map.set(key, (map.get(key) ?? 0) + inc);
}

function deriveRouterStatus(turn: TurnRecord) {
  const reason = turn.routerRunReason ?? "none";
  const ran =
    reason === "ran_should_run_router" ||
    reason === "ran_harm_low_confidence" ||
    reason === "ran_sensitive_boundary";
  if (!ran) return "skipped" as const;
  if (turn.routerOutput) {
    if (turn.routerUsedFallbackModel) return "failed_primary_used_fallback" as const;
    return "ran" as const;
  }
  return "failed_all" as const;
}

function deriveRouterModelFamily(turn: TurnRecord) {
  if (!turn.routerModel) return "none" as const;
  if (turn.routerModel.includes("gpt-oss")) return "oss" as const;
  if (turn.routerModel.includes("llama-3.1-8b")) return "llama_fallback" as const;
  return "none" as const;
}

function parseTurn(record: {
  requestId: string;
  userId: string;
  personaId: string;
  sessionId: string | null;
  createdAt: Date;
  kind: string;
  memoryQuery: unknown;
}): TurnRecord {
  const mq = asObject(record.memoryQuery);
  const triageOutput = asObject(mq?.triage_output);
  const routerOutput = asObject(mq?.router_output);
  const riskLevel = asString(triageOutput?.risk_level) ?? asString(mq?.risk_level);
  const overlaySkipReason = asString(mq?.overlaySkipReason);
  const stanceSelected = asString(mq?.stanceSelected) ?? "none";
  const tacticSelected = asString(mq?.tacticSelected) ?? "none";
  const cooldownTurnsRemaining = asNumber(mq?.cooldown_turns_remaining);
  const cooldownActivatedReason = asString(mq?.cooldown_activated_reason);
  const sessionStart = overlaySkipReason === "session_warmup";

  return {
    requestId: record.requestId,
    userId: record.userId,
    personaId: record.personaId,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    kind: record.kind,
    sessionStart,
    timeBucket: bucketHour(record.createdAt),
    overlaySkipReason,
    stanceSelected,
    tacticSelected,
    triggerReason: asString(mq?.triggerReason),
    suppressionReason: asString(mq?.suppressionReason),
    overlayExitReason: asString(mq?.overlayExitReason),
    riskLevel,
    triageOutput,
    routerRunReason: asString(mq?.router_run_reason),
    routerOutput,
    routerModel: asString(mq?.router_model),
    routerUsedFallbackModel: asBoolean(mq?.router_used_fallback_model) === true,
    cooldownTurnsRemaining,
    cooldownActivatedReason,
    tacticEligibilityAllowed: asBoolean(mq?.tactic_eligibility_allowed),
    tacticEligibilityVetoReasons: asStringArray(mq?.tactic_eligibility_veto_reasons),
    tacticRegretCandidate: asBoolean(mq?.tactic_regret_candidate) === true,
    curiosityContinuationAttempted: asBoolean(mq?.curiosity_continuation_attempted) === true,
    curiosityContinuationBlockedByEligibility:
      asBoolean(mq?.curiosity_continuation_blocked_by_eligibility) === true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const since = args.since ?? (args.days ? new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000) : null);

  const rows = await prisma.librarianTrace.findMany({
    where: since ? { createdAt: { gte: since } } : undefined,
    select: {
      id: true,
      userId: true,
      personaId: true,
      sessionId: true,
      requestId: true,
      kind: true,
      createdAt: true,
      memoryQuery: true,
    },
    orderBy: { createdAt: "desc" },
    take: args.maxRows,
  });

  const rowsByKind = new Map<string, number>();
  const rowsWithRequestId = rows.filter((row) => typeof row.requestId === "string" && row.requestId.length > 0);
  for (const row of rows) ensureCounter(rowsByKind, row.kind || "unknown");

  const byRequest = new Map<string, typeof rows>();
  for (const row of rowsWithRequestId) {
    const requestId = row.requestId as string;
    const existing = byRequest.get(requestId);
    if (existing) {
      existing.push(row);
    } else {
      byRequest.set(requestId, [row]);
    }
  }

  let requestIdsWithPrompt = 0;
  let requestIdsWithOverlay = 0;
  let requestIdsWithBoth = 0;
  let requestIdWithMultipleUserIds = 0;
  let requestIdWithMultipleSessionIds = 0;

  const turns: TurnRecord[] = [];

  for (const [requestId, group] of byRequest.entries()) {
    const userIds = new Set(group.map((r) => r.userId));
    const sessionIds = new Set(group.map((r) => r.sessionId ?? "null"));
    if (userIds.size > 1) requestIdWithMultipleUserIds += 1;
    if (sessionIds.size > 1) requestIdWithMultipleSessionIds += 1;

    const prompt = group.find((r) => r.kind === "prompt_packet");
    const overlay = group.find((r) => r.kind === "overlay");
    if (prompt) requestIdsWithPrompt += 1;
    if (overlay) requestIdsWithOverlay += 1;
    if (prompt && overlay) requestIdsWithBoth += 1;

    if (!prompt) continue;
    turns.push(
      parseTurn({
        requestId,
        userId: prompt.userId,
        personaId: prompt.personaId,
        sessionId: prompt.sessionId,
        createdAt: prompt.createdAt,
        kind: prompt.kind,
        memoryQuery: prompt.memoryQuery,
      })
    );
  }

  const totalTurns = turns.length;

  let missingTriageOutput = 0;
  let missingRouterRunReason = 0;
  let missingTacticSelected = 0;
  let missingCooldownFields = 0;
  let missingVetoReasons = 0;

  let overlayEligible = 0;
  let overlayFired = 0;
  let tacticEligible = 0;
  let probingFired = 0;
  let probingFiredEligible = 0;
  let regretCandidate = 0;
  let cooldownActivation = 0;
  let routerRuns = 0;
  let routerFallbackRuns = 0;
  let triageFailedParse = 0;
  let safeClamp = 0;
  let probingBlockedByAppetite = 0;
  let probingEligibleWithoutAppetite = 0;

  let continuationAttempts = 0;
  let continuationBlockedByEligibility = 0;
  let continuationExitedDueToCooldownOrPolicy = 0;

  const vetoReasonCounts = new Map<string, number>();
  const routerRunReasonCounts = new Map<string, number>();
  const cooldownReasonCounts = new Map<string, number>();
  const routerStatusCounts = new Map<string, number>();
  const routerModelFamilyCounts = new Map<string, number>();

  const segments = new Map<string, TurnRecord[]>();
  const pushSegment = (key: string, turn: TurnRecord) => {
    const arr = segments.get(key);
    if (arr) arr.push(turn);
    else segments.set(key, [turn]);
  };

  for (const turn of turns) {
    pushSegment(`sessionStart:${turn.sessionStart ? "yes" : "no"}`, turn);
    pushSegment(`timeBucket:${turn.timeBucket}`, turn);

    if (!turn.triageOutput) missingTriageOutput += 1;
    if (!turn.routerRunReason) missingRouterRunReason += 1;
    if (!turn.tacticSelected) missingTacticSelected += 1;
    if (turn.cooldownTurnsRemaining === null && turn.cooldownActivatedReason === null) {
      missingCooldownFields += 1;
    }
    if (turn.tacticEligibilityVetoReasons.length === 0) missingVetoReasons += 1;

    const triageRisk = asString(turn.triageOutput?.risk_level);
    const triageCapacity = asString(turn.triageOutput?.capacity);
    const triagePermission = asString(turn.triageOutput?.permission);
    const triagePressure = asString(turn.triageOutput?.pressure);
    const triageAppetite = asString(turn.triageOutput?.tactic_appetite);

    const isOverlayEligible =
      turn.overlaySkipReason === null && triageRisk !== "HIGH" && triageRisk !== "CRISIS";
    if (isOverlayEligible) overlayEligible += 1;

    const firedOverlay = turn.stanceSelected !== "none" || turn.tacticSelected !== "none";
    if (firedOverlay) overlayFired += 1;

    const isTacticEligible =
      triageCapacity === "HIGH" &&
      triagePermission !== "NONE" &&
      triageAppetite === "HIGH" &&
      triageRisk === "LOW" &&
      triagePressure !== "HIGH" &&
      (turn.cooldownTurnsRemaining ?? 0) === 0;
    if (isTacticEligible) tacticEligible += 1;

    const probing = PROBING_TACTICS.has(turn.tacticSelected);
    if (probing) probingFired += 1;
    if (probing && isTacticEligible) probingFiredEligible += 1;

    const eligibleWithoutAppetite =
      triageCapacity === "HIGH" &&
      triagePermission !== "NONE" &&
      triageRisk === "LOW" &&
      triagePressure !== "HIGH" &&
      (turn.cooldownTurnsRemaining ?? 0) === 0;
    if (eligibleWithoutAppetite) {
      probingEligibleWithoutAppetite += 1;
      if (triageAppetite !== "HIGH") probingBlockedByAppetite += 1;
    }

    if (turn.tacticRegretCandidate) regretCandidate += 1;
    if (turn.cooldownActivatedReason) {
      cooldownActivation += 1;
      ensureCounter(cooldownReasonCounts, turn.cooldownActivatedReason);
    }

    if (
      (turn.cooldownTurnsRemaining ?? 0) > 0 ||
      triageRisk === "HIGH" ||
      triageRisk === "CRISIS" ||
      triageCapacity !== "HIGH"
    ) {
      safeClamp += 1;
    }

    if (turn.curiosityContinuationAttempted) continuationAttempts += 1;
    if (turn.curiosityContinuationBlockedByEligibility) continuationBlockedByEligibility += 1;
    if (
      turn.overlayExitReason === "policy" &&
      turn.tacticEligibilityVetoReasons.some((reason) =>
        reason === "cooldown_active" || reason === "pressure_high" || reason === "risk_not_low"
      )
    ) {
      continuationExitedDueToCooldownOrPolicy += 1;
    }

    if (turn.routerRunReason) {
      ensureCounter(routerRunReasonCounts, turn.routerRunReason);
      if (turn.routerRunReason === "triage_failed_parse") triageFailedParse += 1;
    }
    const routerStatus = deriveRouterStatus(turn);
    ensureCounter(routerStatusCounts, routerStatus);
    if (routerStatus === "ran" || routerStatus === "failed_primary_used_fallback" || routerStatus === "failed_all") {
      routerRuns += 1;
    }
    if (routerStatus === "failed_primary_used_fallback") {
      routerFallbackRuns += 1;
    }
    ensureCounter(routerModelFamilyCounts, deriveRouterModelFamily(turn));

    for (const reason of turn.tacticEligibilityVetoReasons) ensureCounter(vetoReasonCounts, reason);
  }

  const coreRates = {
    overlayFiredOverOverlayEligible: computeRate(overlayFired, overlayEligible),
    probingFiredOverProbingEligible: computeRate(probingFired, tacticEligible),
    probingFiredAndEligibleOverProbingEligible: computeRate(probingFiredEligible, tacticEligible),
    regretOverProbingFired: computeRate(regretCandidate, probingFired),
    cooldownOverTotal: computeRate(cooldownActivation, totalTurns),
    routerFallbackOverRouterRuns: computeRate(routerFallbackRuns, routerRuns),
    triageFailedParseOverTotal: computeRate(triageFailedParse, totalTurns),
    safeClampOverTotal: computeRate(safeClamp, totalTurns),
    probingBlockedByAppetiteOverEligibleWithoutAppetite: computeRate(
      probingBlockedByAppetite,
      probingEligibleWithoutAppetite
    ),
    continuationBlockedByEligibilityOverAttempts: computeRate(
      continuationBlockedByEligibility,
      continuationAttempts
    ),
    continuationExitedCooldownOrPolicyOverAttempts: computeRate(
      continuationExitedDueToCooldownOrPolicy,
      continuationAttempts
    ),
  };

  const segmentsOutput: Record<string, unknown> = {};
  for (const [key, sample] of segments.entries()) {
    if (sample.length < args.minSegmentSize) continue;
    let segTacticEligible = 0;
    let segProbingFired = 0;
    let segCooldownActivation = 0;
    for (const turn of sample) {
      const triage = turn.triageOutput;
      const triageRisk = asString(triage?.risk_level);
      const triageCapacity = asString(triage?.capacity);
      const triagePermission = asString(triage?.permission);
      const triagePressure = asString(triage?.pressure);
      const triageAppetite = asString(triage?.tactic_appetite);
      const isEligible =
        triageCapacity === "HIGH" &&
        triagePermission !== "NONE" &&
        triageAppetite === "HIGH" &&
        triageRisk === "LOW" &&
        triagePressure !== "HIGH" &&
        (turn.cooldownTurnsRemaining ?? 0) === 0;
      if (isEligible) segTacticEligible += 1;
      if (PROBING_TACTICS.has(turn.tacticSelected)) segProbingFired += 1;
      if (turn.cooldownActivatedReason) segCooldownActivation += 1;
    }
    segmentsOutput[key] = {
      turns: sample.length,
      probing_fired_over_probing_eligible: computeRate(segProbingFired, segTacticEligible),
      cooldown_over_total: computeRate(segCooldownActivation, sample.length),
    };
  }

  const alertMessages: string[] = [];
  if (args.alert) {
    const regretRate = coreRates.regretOverProbingFired.rate ?? 0;
    const cooldownRate = coreRates.cooldownOverTotal.rate ?? 0;
    const routerFallbackRate = coreRates.routerFallbackOverRouterRuns.rate ?? 0;
    const triageFailedParseRate = coreRates.triageFailedParseOverTotal.rate ?? 0;
    if (regretRate > args.thresholdRegret) {
      alertMessages.push(`WARN regret/probing_fired ${pct(regretRate)} > ${pct(args.thresholdRegret)}`);
    }
    if (cooldownRate > args.thresholdCooldown) {
      alertMessages.push(`WARN cooldown/total ${pct(cooldownRate)} > ${pct(args.thresholdCooldown)}`);
    }
    if (routerFallbackRate > args.thresholdRouterFallback) {
      alertMessages.push(
        `WARN router_fallback/router_runs ${pct(routerFallbackRate)} > ${pct(args.thresholdRouterFallback)}`
      );
    }
    if (triageFailedParseRate > args.thresholdTriageParseFallback) {
      alertMessages.push(
        `WARN triage_failed_parse/total ${pct(triageFailedParseRate)} > ${pct(args.thresholdTriageParseFallback)}`
      );
    }
  }

  const output = {
    header: {
      now: now.toISOString(),
      query_since: since?.toISOString() ?? null,
      query_until: now.toISOString(),
      max_rows: args.maxRows,
      rows_scanned: rows.length,
      rows_total: rows.length,
      rows_by_kind: Object.fromEntries(rowsByKind.entries()),
      unique_request_ids_total: byRequest.size,
      request_ids_with_prompt_packet: requestIdsWithPrompt,
      request_ids_with_overlay: requestIdsWithOverlay,
      request_ids_with_both: requestIdsWithBoth,
      join_success_rate: computeRate(requestIdsWithBoth, byRequest.size),
    },
    data_quality: {
      missing_triage_output: missingTriageOutput,
      missing_router_run_reason: missingRouterRunReason,
      missing_tactic_selected: missingTacticSelected,
      missing_cooldown_fields: missingCooldownFields,
      missing_veto_reasons: missingVetoReasons,
      request_id_with_multiple_userIds: requestIdWithMultipleUserIds,
      request_id_with_multiple_sessionIds: requestIdWithMultipleSessionIds,
    },
    core_rates: coreRates,
    distributions: {
      top_veto_reasons: topN(vetoReasonCounts),
      top_router_run_reasons: topN(routerRunReasonCounts),
      top_cooldown_reasons: topN(cooldownReasonCounts),
      router_status: topN(routerStatusCounts),
      router_model_family: topN(routerModelFamilyCounts),
    },
    continuation_metrics: {
      curiosity_continuation_attempts: continuationAttempts,
      curiosity_continuation_blocked_by_eligibility: continuationBlockedByEligibility,
      curiosity_continuation_exited_due_to_cooldown_or_policy: continuationExitedDueToCooldownOrPolicy,
      blocked_over_attempts: coreRates.continuationBlockedByEligibilityOverAttempts,
      exited_over_attempts: coreRates.continuationExitedCooldownOrPolicyOverAttempts,
    },
    segments: segmentsOutput,
    alerts: {
      enabled: args.alert,
      warnings: alertMessages,
      thresholds: {
        regret_over_probing_fired: args.thresholdRegret,
        cooldown_over_total: args.thresholdCooldown,
        router_fallback_over_router_runs: args.thresholdRouterFallback,
        triage_failed_parse_over_total: args.thresholdTriageParseFallback,
      },
    },
  };

  console.log("\n=== Librarian Metrics ===");
  console.log(`Window: ${since?.toISOString() ?? "(none)"} -> ${now.toISOString()}`);
  console.log(`Rows scanned: ${rows.length} (maxRows=${args.maxRows})`);
  console.log(`Kinds: ${JSON.stringify(Object.fromEntries(rowsByKind.entries()))}`);
  console.log(
    `Request coverage: total=${byRequest.size} prompt=${requestIdsWithPrompt} overlay=${requestIdsWithOverlay} both=${requestIdsWithBoth} join=${pct(
      (output.header.join_success_rate.rate ?? 0)
    )}`
  );

  console.log("\n--- Data Quality ---");
  console.log(`missing_triage_output: ${missingTriageOutput}`);
  console.log(`missing_router_run_reason: ${missingRouterRunReason}`);
  console.log(`missing_tactic_selected: ${missingTacticSelected}`);
  console.log(`missing_cooldown_fields: ${missingCooldownFields}`);
  console.log(`missing_veto_reasons: ${missingVetoReasons}`);
  console.log(`request_id_with_multiple_userIds: ${requestIdWithMultipleUserIds}`);
  console.log(`request_id_with_multiple_sessionIds: ${requestIdWithMultipleSessionIds}`);

  console.log("\n--- Core Rates ---");
  console.log(fmtRate("overlay fired / overlay eligible", coreRates.overlayFiredOverOverlayEligible));
  console.log(fmtRate("probing fired / probing eligible", coreRates.probingFiredOverProbingEligible));
  console.log(
    fmtRate(
      "probing fired & eligible / probing eligible",
      coreRates.probingFiredAndEligibleOverProbingEligible
    )
  );
  console.log(fmtRate("regret candidate / probing fired", coreRates.regretOverProbingFired));
  console.log(fmtRate("cooldown activation / total turns", coreRates.cooldownOverTotal));
  console.log(fmtRate("router fallback / router runs", coreRates.routerFallbackOverRouterRuns));
  console.log(fmtRate("triage failed_parse / total turns", coreRates.triageFailedParseOverTotal));
  console.log(fmtRate("safe clamp / total turns", coreRates.safeClampOverTotal));
  console.log(
    fmtRate(
      "probing blocked by appetite / eligible w/o appetite",
      coreRates.probingBlockedByAppetiteOverEligibleWithoutAppetite
    )
  );

  console.log("\n--- Distributions ---");
  console.log(`top veto reasons: ${JSON.stringify(topN(vetoReasonCounts))}`);
  console.log(`top router run reasons: ${JSON.stringify(topN(routerRunReasonCounts))}`);
  console.log(`top cooldown reasons: ${JSON.stringify(topN(cooldownReasonCounts))}`);
  console.log(`router status: ${JSON.stringify(topN(routerStatusCounts))}`);
  console.log(`router model family: ${JSON.stringify(topN(routerModelFamilyCounts))}`);

  console.log("\n--- Continuation Metrics ---");
  console.log(`curiosity continuation attempts: ${continuationAttempts}`);
  console.log(`curiosity continuation blocked by eligibility: ${continuationBlockedByEligibility}`);
  console.log(
    `curiosity continuation exited due to cooldown/policy: ${continuationExitedDueToCooldownOrPolicy}`
  );
  console.log(
    fmtRate(
      "continuation blocked by eligibility / attempts",
      coreRates.continuationBlockedByEligibilityOverAttempts
    )
  );
  console.log(
    fmtRate(
      "continuation exited cooldown/policy / attempts",
      coreRates.continuationExitedCooldownOrPolicyOverAttempts
    )
  );

  console.log(`\n--- Segments (denominator >= ${args.minSegmentSize}) ---`);
  const segmentKeys = Object.keys(segmentsOutput);
  if (segmentKeys.length === 0) {
    console.log("No segments met minimum sample size.");
  } else {
    for (const key of segmentKeys) {
      const segment = segmentsOutput[key] as {
        turns: number;
        probing_fired_over_probing_eligible: RateResult;
        cooldown_over_total: RateResult;
      };
      console.log(`\n${key} (turns=${segment.turns})`);
      console.log(
        fmtRate(
          "probing fired / probing eligible",
          segment.probing_fired_over_probing_eligible
        )
      );
      console.log(fmtRate("cooldown activation / total turns", segment.cooldown_over_total));
    }
  }

  if (args.alert) {
    console.log("\n--- Alerts ---");
    if (alertMessages.length === 0) {
      console.log("No warnings.");
    } else {
      for (const message of alertMessages) {
        console.log(message);
      }
    }
  }

  if (args.jsonPath) {
    writeFileSync(args.jsonPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`\nJSON written: ${args.jsonPath}`);
  }
  if (args.json) {
    console.log("\n--- JSON ---");
    console.log(JSON.stringify(output, null, 2));
  }
}

main()
  .catch((error) => {
    console.error("[librarian-metrics] failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
