import { aiSdkCompletion, type AISDKMessage } from "@/lib/llm/aiSdkCompletion";
import { loadCreativeKernelByFiles } from "@/lib/prompts/personaPromptLoader";
import type { SynapseStartBriefResponse } from "@/lib/services/synapseClient";
import { runMastraTurn } from "@/mastra/runMastraTurn";

const CONTEXT_GOVERNOR_MAX_CHARS = 999999;

type ContextGovernorSource = "user_context" | "handover" | "bridge" | "signal_pack" | "ops";
type ContextGovernorDropReason = "budget" | "redundant" | "precedence" | "low_relevance";

type ContextGovernorRuntime = {
  used: true;
  budget_chars: number;
  candidates_total: number;
  selected_total: number;
  selected_by_source: Record<ContextGovernorSource, number>;
  dropped_by_reason: Record<ContextGovernorDropReason, number>;
  selected_keys: string[];
};

type ContextGovernorCandidate = {
  key: string;
  source: ContextGovernorSource;
  line: string;
  normalized: string;
  className?: string | null;
  score: number;
  charLen: number;
};

export type AssistantExecutionContext = {
  requestId: string;
  traceId: string;
  now: Date;
  requestStartedAtMs: number;
  debugContextEnabled: boolean;
  debugPromptEnabled: boolean;
  tracePromptPacket: boolean;
  featureFlags: {
    contextDebugEnabled: boolean;
    librarianTraceEnabled: boolean;
    chatOrchestratorV2Enabled: boolean;
    chatOrchestratorV2ParityEnabled: boolean;
    mastraEnabled: boolean;
  };
  parityMode: {
    enabled: boolean;
  };
};

export type AssistantTurnPromptPayload = {
  persona: string;
  riskLevel: string;
  intent: string;
  posture: string;
  pressure: string;
  stanceSelected: string;
  localHour: number;
  isSessionStart: boolean;
  isUrgent: boolean;
  endearmentCooldownTurns: number;
  cooldownActive: boolean;
  userContextLines?: string[];
  currentSessionTruthsBlock?: string | null;
  signalPackSourceBlock?: string | null;
  stanceOverlayBlock?: string | null;
  tacticOverlayBlock?: string | null;
  bridgeBlock?: string | null;
  userNarrativeBlock?: string | null;
  handoverBlock?: string | null;
  opsSnippetBlock?: string | null;
  startbriefPacket?: SynapseStartBriefResponse | null;
  supplementalContext?: string | null;
  rollingSummary?: string | null;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string;
  chosenModel: string;
  personaSlug: string;
  debugContextBlocks?: {
    persona: string;
    situationalContext: string | null;
    supplementalContext: string | null;
    rollingSummary: string | null;
  };
  promptWarningMeta: {
    userId: string;
    personaId: string;
    riskLevel: string;
    intent: string;
    stanceSelected: string;
    tacticSelected: string;
    overlaySelected: string;
    unknownEntityDetected: boolean;
    unknownEntityName: string | null;
    entityIntroFired: boolean;
    clarityStanceFired: boolean;
    clarityBurstActive: boolean;
    clarityResolved: boolean;
    overlaySkipReason: string | null;
    suppressionReason: string | null;
  };
  traceMetadata: {
    startbriefUsed: boolean;
    startbriefFallback: "session/brief" | null;
    startbriefItemsCount: number;
    bridgeTextChars: number;
  };
};

export type AssistantTurnResult = {
  assistantText: string;
  chosenModel: string;
  timings: {
    orchestration_ms: number;
    llm_ms: number;
    mastra_total_ms?: number;
    prefetch_ms?: number;
    memory_prefetch_ms?: number;
    web_prefetch_ms?: number;
    final_generation_ms?: number;
  };
  generation: {
    providerUsed: "openrouter" | "openai" | "safe_text";
    modelUsed: string;
    fallbackUsed: boolean;
    emergencyUsed: boolean;
    finalSafeTextUsed: boolean;
  };
  promptMetadata: {
    systemBlockOrder: string[];
  };
  tracePromptMetadata: {
    system_blocks: string[];
    startbrief_used: boolean;
    startbrief_fallback: "session/brief" | null;
    startbrief_items_count: number;
    bridgeText_chars: number;
    context_governor_used: boolean;
    context_governor_budget_chars: number;
    context_governor_candidates_total: number;
    context_governor_selected_total: number;
    context_governor_selected_by_source: Record<string, number>;
    context_governor_dropped_by_reason: Record<string, number>;
    context_governor_selected_keys: string[];
  };
  mastra: {
    used: boolean;
    modelUsed: string | null;
    memoryToolUsed: boolean;
    memoryToolQuery: string | null;
    webToolUsed: boolean;
    webToolQuery: string | null;
  };
  messages?: AISDKMessage[];
  debugPayload?: Record<string, unknown>;
};

function buildChatMessages(params: {
  persona: string;
  momentumGuardBlock?: string | null;
  styleGuardBlock?: string | null;
  crisisResponseTemplateBlock?: string | null;
  userContextBlock?: string | null;
  currentSessionTruthsBlock?: string | null;
  signalPackBlock?: string | null;
  stanceOverlayBlock?: string | null;
  tacticOverlayBlock?: string | null;
  overlayBlock?: string | null;
  bridgeBlock?: string | null;
  userNarrativeBlock?: string | null;
  handoverBlock?: string | null;
  entityProfileBlocks?: string[] | null;
  opsSnippetBlock?: string | null;
  supplementalContext?: string | null;
  rollingSummary?: string | null;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string;
}) {
  const trimmedRollingSummary = (params.rollingSummary ?? "").trim();
  const cappedRollingSummary =
    trimmedRollingSummary.length > 800
      ? `${trimmedRollingSummary.slice(0, 800)}...`
      : trimmedRollingSummary;
  const historyTurns = params.recentMessages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const conversationHistoryBlock =
    cappedRollingSummary && historyTurns
      ? `[CONVERSATION_HISTORY]\n${cappedRollingSummary}\n---\n${historyTurns}`
      : cappedRollingSummary
        ? `[CONVERSATION_HISTORY]\n${cappedRollingSummary}`
        : null;

  return [
    { role: "system" as const, content: params.persona },
    ...(params.crisisResponseTemplateBlock
      ? [{ role: "system" as const, content: params.crisisResponseTemplateBlock }]
      : []),
    ...(params.userContextBlock ? [{ role: "system" as const, content: params.userContextBlock }] : []),
    ...(params.signalPackBlock ? [{ role: "system" as const, content: params.signalPackBlock }] : []),
    ...(params.stanceOverlayBlock ? [{ role: "system" as const, content: params.stanceOverlayBlock }] : []),
    ...(params.tacticOverlayBlock ? [{ role: "system" as const, content: params.tacticOverlayBlock }] : []),
    ...(params.bridgeBlock ? [{ role: "system" as const, content: params.bridgeBlock }] : []),
    ...(params.userNarrativeBlock
      ? [{ role: "system" as const, content: params.userNarrativeBlock }]
      : []),
    ...(params.handoverBlock ? [{ role: "system" as const, content: params.handoverBlock }] : []),
    ...((params.entityProfileBlocks ?? []).map((block) => ({
      role: "system" as const,
      content: block,
    }))),
    ...(params.opsSnippetBlock ? [{ role: "system" as const, content: params.opsSnippetBlock }] : []),
    ...(params.supplementalContext
      ? [
          {
            role: "system" as const,
            content: `[SUPPLEMENTAL_CONTEXT]\n${params.supplementalContext}`,
          },
        ]
      : []),
    ...(params.currentSessionTruthsBlock
      ? [{ role: "system" as const, content: params.currentSessionTruthsBlock }]
      : []),
    ...(conversationHistoryBlock
      ? [{ role: "system" as const, content: conversationHistoryBlock }]
      : params.recentMessages),
    { role: "user" as const, content: params.transcript },
  ] satisfies AISDKMessage[];
}

function buildSystemBlockOrder(params: AssistantTurnPromptPayload) {
  return [
    "persona",
  ];
}

function buildUserContextBlock(lines?: string[]) {
  if (!lines || lines.length === 0) return null;
  return `[USER_CONTEXT]\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function normalizeGovernorText(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function parseLabeledLines(block: string, header: string) {
  const raw = block.trim();
  if (!raw) return [] as string[];
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const body = lines[0] === header ? lines.slice(1) : lines;
  return body
    .map((line) => line.replace(/^-+\s*/, "").trim())
    .filter(Boolean);
}

function createEmptyGovernorSourceCounts(): Record<ContextGovernorSource, number> {
  return {
    user_context: 0,
    handover: 0,
    bridge: 0,
    signal_pack: 0,
    ops: 0,
  };
}

function createEmptyGovernorDropCounts(): Record<ContextGovernorDropReason, number> {
  return {
    budget: 0,
    redundant: 0,
    precedence: 0,
    low_relevance: 0,
  };
}

function buildMomentumGuardBlock(params: {
  intent: string;
  posture: string;
  localHour: number;
}) {
  if (params.intent !== "momentum") return null;
  const postureAllows =
    params.posture === "MOMENTUM" ||
    params.posture === "IDEATION" ||
    params.posture === "PRACTICAL";
  if (!postureAllows) return null;
  const lines = [
    "[MOMENTUM_GUARD]",
    "- Stay action-oriented, but do not repeat the same setup/check question on consecutive turns.",
    "- If user confirms a step, acknowledge it and move to one next concrete step or close the loop.",
  ];
  if (params.localHour >= 0 && params.localHour < 5) {
    lines.push(
      "- Late-night mode (00:00-05:00 local): soften pressure, ask at most one check question, then step back."
    );
  }
  return lines.join("\n");
}

function buildContextGovernorSelection(params: {
  userContextBlock?: string | null;
  signalPackBlock?: string | null;
  bridgeBlock?: string | null;
  handoverBlock?: string | null;
  opsSnippetBlock?: string | null;
  intent: string;
  posture: string;
  pressure: string;
  stance: string;
  riskLevel: string;
}) {
  const candidates: ContextGovernorCandidate[] = [];
  const droppedByReason = createEmptyGovernorDropCounts();
  const hasHandover = Boolean(params.handoverBlock?.trim());
  const isTaskTurn =
    params.intent === "momentum" || params.intent === "output_task" || params.posture === "PRACTICAL";
  const isRelationalTurn =
    params.intent === "companion" ||
    params.posture === "COMPANION" ||
    params.posture === "RELATIONSHIP" ||
    params.posture === "REFLECTION";

  const pushCandidate = (candidate: Omit<ContextGovernorCandidate, "normalized" | "charLen">) => {
    const line = candidate.line.trim();
    if (!line) return;
    const normalized = normalizeGovernorText(line);
    if (!normalized) return;
    candidates.push({
      ...candidate,
      line,
      normalized,
      charLen: line.length,
    });
  };

  const userLines = params.userContextBlock
    ? parseLabeledLines(params.userContextBlock, "[USER_CONTEXT]")
    : [];
  userLines.forEach((line, index) => {
    pushCandidate({
      key: `user_context:${index}`,
      source: "user_context",
      className: null,
      line,
      score: 100,
    });
  });

  const handover = params.handoverBlock?.trim();
  if (handover) {
    pushCandidate({
      key: "handover:0",
      source: "handover",
      className: null,
      line: handover,
      score: 95,
    });
  }

  const bridge = params.bridgeBlock?.trim();
  if (bridge) {
    pushCandidate({
      key: "bridge:0",
      source: "bridge",
      className: null,
      line: bridge,
      score: 85,
    });
  }

  const ops = params.opsSnippetBlock?.trim();
  if (ops) {
    let score = 60;
    if (isTaskTurn) score += 20;
    if (isRelationalTurn) score -= 10;
    if (params.stance === "witness" && params.pressure === "HIGH") score -= 15;
    if (params.riskLevel === "HIGH" || params.riskLevel === "CRISIS") score -= 20;
    pushCandidate({
      key: "ops:0",
      source: "ops",
      className: null,
      line: ops,
      score,
    });
  }

  const signalLines = params.signalPackBlock
    ? parseLabeledLines(params.signalPackBlock, "Signal Pack (private):")
    : [];
  signalLines.forEach((line, index) => {
    const classMatch = line.match(/^\[([a-z_]+)\]\s+/i);
    const className = classMatch?.[1]?.toLowerCase() ?? null;
    if (hasHandover && (className === "open_loops" || className === "today" || className === "momentum")) {
      droppedByReason.precedence += 1;
      return;
    }
    let score = 70;
    if (isTaskTurn) {
      if (className === "open_loops" || className === "today" || className === "trajectory") score += 15;
      if (className === "momentum") score -= 12;
      if (className === "state" || className === "relationships") score -= 5;
    }
    if (isRelationalTurn) {
      if (className === "state" || className === "relationships" || className === "identity") score += 15;
      if (className === "momentum") score -= 12;
      if (className === "today") score -= 8;
    }
    if (params.stance === "witness" && params.pressure === "HIGH") {
      if (className === "open_loops" || className === "today") score -= 10;
    }
    pushCandidate({
      key: `signal_pack:${className ?? "unknown"}:${index}`,
      source: "signal_pack",
      className,
      line,
      score,
    });
  });

  const sorted = candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.source !== b.source) {
      const precedence: Record<ContextGovernorSource, number> = {
        user_context: 5,
        handover: 4,
        bridge: 3,
        signal_pack: 2,
        ops: 1,
      };
      return precedence[b.source] - precedence[a.source];
    }
    return a.key.localeCompare(b.key);
  });

  const selected: ContextGovernorCandidate[] = [];
  const seenNormalized = new Set<string>();
  let usedChars = 0;
  for (const candidate of sorted) {
    const isMandatory = candidate.source === "handover";
    if (!isMandatory && candidate.score < 40) {
      droppedByReason.low_relevance += 1;
      continue;
    }
    if (!isMandatory && seenNormalized.has(candidate.normalized)) {
      droppedByReason.redundant += 1;
      continue;
    }
    const projected = usedChars + candidate.charLen;
    if (!isMandatory && projected > CONTEXT_GOVERNOR_MAX_CHARS) {
      droppedByReason.budget += 1;
      continue;
    }
    selected.push(candidate);
    seenNormalized.add(candidate.normalized);
    usedChars = projected;
  }

  const selectedBySource = createEmptyGovernorSourceCounts();
  for (const candidate of selected) {
    selectedBySource[candidate.source] += 1;
  }

  const selectedUserLines = selected
    .filter((candidate) => candidate.source === "user_context")
    .map((candidate) => candidate.line);
  const selectedSignalLines = selected
    .filter((candidate) => candidate.source === "signal_pack")
    .map((candidate) => candidate.line);
  const selectedBridge = selected.find((candidate) => candidate.source === "bridge")?.line ?? null;
  const selectedHandover = selected.find((candidate) => candidate.source === "handover")?.line ?? null;
  const selectedOps = selected.find((candidate) => candidate.source === "ops")?.line ?? null;

  const runtime: ContextGovernorRuntime = {
    used: true,
    budget_chars: CONTEXT_GOVERNOR_MAX_CHARS,
    candidates_total: candidates.length,
    selected_total: selected.length,
    selected_by_source: selectedBySource,
    dropped_by_reason: droppedByReason,
    selected_keys: selected.map((candidate) => candidate.key),
  };

  return {
    userContextBlock:
      selectedUserLines.length > 0
        ? `[USER_CONTEXT]\n${selectedUserLines.map((line) => `- ${line}`).join("\n")}`
        : null,
    signalPackBlock:
      selectedSignalLines.length > 0
        ? `Signal Pack (private):\n${selectedSignalLines.map((line) => `- ${line}`).join("\n")}`
        : null,
    bridgeBlock: selectedBridge,
    handoverBlock: selectedHandover,
    opsSnippetBlock: selectedOps,
    runtime,
  };
}

function shouldInjectSignalPack(params: {
  signalPackBlock?: string | null;
  isSessionStart: boolean;
  intent: string;
  posture: string;
  pressure: string;
  stance: string;
  riskLevel: string;
  isUrgent: boolean;
}) {
  if (!params.signalPackBlock) return false;
  if (params.isSessionStart) return false;
  if (params.isUrgent) return false;
  if (params.riskLevel === "HIGH" || params.riskLevel === "CRISIS") return false;
  if (params.stance === "witness" && params.pressure === "HIGH") return false;

  const isTaskingTurn =
    params.intent === "momentum" || params.intent === "output_task" || params.posture === "PRACTICAL";
  if (isTaskingTurn) return true;

  const isRelationalTurn =
    params.intent === "companion" ||
    params.posture === "COMPANION" ||
    params.posture === "RELATIONSHIP" ||
    params.posture === "REFLECTION";
  if (isRelationalTurn) return true;

  return params.posture === "IDEATION" || params.posture === "MOMENTUM";
}

async function loadClarityPersonaKernel() {
  return loadCreativeKernelByFiles({
    files: ["00_model_kernel.md", "10_identity_kernel.md", "30_product_kernel.md"],
  });
}

function buildStyleGuardBlock(params: {
  stance: string;
  endearmentCooldownTurns: number;
  cooldownActive?: boolean;
}) {
  const lines = ["[STYLE_GUARD]"];
  lines.push('- Ban robotic phrases: "you shared that", "tentative glimmer", "want to name one small thing".');
  if (params.cooldownActive) {
    lines.push("- Keep this turn short, present, and non-probing unless safety requires a check-in.");
  }
  if (params.stance === "witness") {
    lines.push("- No endearments in this turn.");
    lines.push('- Ban phrases: "must feel", "that must feel", "that sounds", "all ears", "so heavy", "so jumbled", "you shared that", "tentative glimmer".');
    return lines.join("\n");
  }
  if (params.endearmentCooldownTurns > 0) {
    lines.push("- Do not use endearments in this turn.");
    return lines.join("\n");
  }
  lines.push("- If used, allow at most one endearment this turn.");
  return lines.join("\n");
}

function buildCrisisResponseTemplateBlock(params: { riskLevel: string }) {
  if (params.riskLevel !== "HIGH" && params.riskLevel !== "CRISIS") return null;
  return [
    "[CRISIS_RESPONSE_TEMPLATE]",
    "- Acknowledge presence first in grounded language.",
    "- Do not problem-solve or give tactical plans in this turn.",
    "- Keep the response short, steady, and non-judgmental.",
    "- If genuine danger signals are present (self-harm intent, plan, means, or immediate danger), explicitly encourage immediate local emergency support and reaching a trusted person now.",
  ].join("\n");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildEntityProfileBlocks(params: {
  packet?: SynapseStartBriefResponse | null;
  handoverBlock?: string | null;
  signalPackBlock?: string | null;
}) {
  const profiles = Array.isArray(params.packet?.entity_profiles) ? params.packet.entity_profiles : [];
  if (profiles.length === 0) return [] as string[];
  const searchable = `${params.handoverBlock ?? ""}\n${params.signalPackBlock ?? ""}`;
  if (!searchable.trim()) return [] as string[];
  const lowered = searchable.toLowerCase();
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const profile of profiles) {
    const name = typeof profile?.name === "string" ? profile.name.trim() : "";
    const profileText = typeof profile?.profile_text === "string" ? profile.profile_text.trim() : "";
    if (!name || !profileText) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const pattern = new RegExp(`\\b${escapeRegex(key)}\\b`, "i");
    if (!pattern.test(lowered)) continue;
    seen.add(key);
    blocks.push(`[ENTITY_PROFILE: ${name}]\n${profileText}`);
  }
  return blocks;
}

async function runCustomAssistantTurn(params: {
  executionContext: AssistantExecutionContext;
  prompt: AssistantTurnPromptPayload;
}) {
  const orchestrationStartedAt = Date.now();
  const userContextBlock = buildUserContextBlock(params.prompt.userContextLines);
  const signalPackBlock = shouldInjectSignalPack({
    signalPackBlock: params.prompt.signalPackSourceBlock ?? null,
    isSessionStart: params.prompt.isSessionStart,
    intent: params.prompt.intent,
    posture: params.prompt.posture,
    pressure: params.prompt.pressure,
    stance: params.prompt.stanceSelected,
    riskLevel: params.prompt.riskLevel,
    isUrgent: params.prompt.isUrgent,
  })
    ? params.prompt.signalPackSourceBlock ?? null
    : null;
  const governedContext = buildContextGovernorSelection({
    userContextBlock,
    signalPackBlock,
    bridgeBlock: params.prompt.bridgeBlock,
    handoverBlock: params.prompt.handoverBlock,
    opsSnippetBlock: params.prompt.opsSnippetBlock,
    intent: params.prompt.intent,
    posture: params.prompt.posture,
    pressure: params.prompt.pressure,
    stance: params.prompt.stanceSelected,
    riskLevel: params.prompt.riskLevel,
  });
  const entityProfileBlocks = buildEntityProfileBlocks({
    packet: params.prompt.startbriefPacket,
    handoverBlock: governedContext.handoverBlock,
    signalPackBlock: governedContext.signalPackBlock,
  });
  const personaKernelForTurn =
    params.prompt.stanceSelected === "clarity" && params.prompt.personaSlug === "creative"
      ? await loadClarityPersonaKernel()
      : params.prompt.persona;
  const momentumGuardBlock = buildMomentumGuardBlock({
    intent: params.prompt.intent,
    posture: params.prompt.posture,
    localHour: params.prompt.localHour,
  });
  const styleGuardBlock =
    params.prompt.stanceSelected === "clarity"
      ? null
      : buildStyleGuardBlock({
          stance: params.prompt.stanceSelected,
          endearmentCooldownTurns: params.prompt.endearmentCooldownTurns,
          cooldownActive: params.prompt.cooldownActive,
        });
  const crisisResponseTemplateBlock = buildCrisisResponseTemplateBlock({
    riskLevel: params.prompt.riskLevel,
  });
  const promptForMessages = {
    ...params.prompt,
    persona: personaKernelForTurn,
    momentumGuardBlock,
    styleGuardBlock,
    crisisResponseTemplateBlock,
    userContextBlock: governedContext.userContextBlock,
    signalPackBlock: governedContext.signalPackBlock,
    bridgeBlock: governedContext.bridgeBlock,
    handoverBlock: governedContext.handoverBlock,
    entityProfileBlocks,
    opsSnippetBlock: governedContext.opsSnippetBlock,
  };
  const messages = buildChatMessages(promptForMessages);
  const systemBlockOrder = [
    "persona",
    ...(crisisResponseTemplateBlock ? ["crisis_response_template"] : []),
    ...(governedContext.userContextBlock ? ["user_context"] : []),
    ...(governedContext.signalPackBlock ? ["signal_pack"] : []),
    ...(params.prompt.stanceOverlayBlock ? ["stance_overlay"] : []),
    ...(params.prompt.tacticOverlayBlock ? ["overlay"] : []),
    ...(governedContext.bridgeBlock ? ["bridge"] : []),
    ...(params.prompt.userNarrativeBlock ? ["user_narrative"] : []),
    ...(governedContext.handoverBlock ? ["handover"] : []),
    ...(entityProfileBlocks.length > 0 ? ["entity_profile"] : []),
    ...(governedContext.opsSnippetBlock ? ["ops"] : []),
    ...(params.prompt.supplementalContext ? ["supplemental"] : []),
    ...(params.prompt.currentSessionTruthsBlock ? ["current_session_truths"] : []),
    ...(params.prompt.rollingSummary ? ["conversation_history"] : []),
  ];
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars > 20000) {
    console.warn(
      "[chat.prompt.warn]",
      JSON.stringify({
        trace_id: params.executionContext.traceId,
        userId: params.prompt.promptWarningMeta.userId,
        personaId: params.prompt.promptWarningMeta.personaId,
        totalChars,
        messageCount: messages.length,
        counts: {
          recentMessages: params.prompt.recentMessages.length,
          situationalContext: 0,
          supplementalContext: params.prompt.supplementalContext ? 1 : 0,
          rollingSummary: params.prompt.rollingSummary ? 1 : 0,
        },
        chosenModel: params.prompt.chosenModel,
        risk_level: params.prompt.promptWarningMeta.riskLevel,
        intent: params.prompt.promptWarningMeta.intent,
        stanceSelected: params.prompt.promptWarningMeta.stanceSelected,
        tacticSelected: params.prompt.promptWarningMeta.tacticSelected,
        overlaySelected: params.prompt.promptWarningMeta.overlaySelected,
        unknown_entity_detected: params.prompt.promptWarningMeta.unknownEntityDetected,
        unknown_entity_name: params.prompt.promptWarningMeta.unknownEntityName,
        entity_intro_fired: params.prompt.promptWarningMeta.entityIntroFired,
        clarity_stance_fired: params.prompt.promptWarningMeta.clarityStanceFired,
        clarity_burst_active: params.prompt.promptWarningMeta.clarityBurstActive,
        clarity_resolved: params.prompt.promptWarningMeta.clarityResolved,
        overlaySkipReason: params.prompt.promptWarningMeta.overlaySkipReason,
        suppressionReason: params.prompt.promptWarningMeta.suppressionReason,
      })
    );
  }
  const isCreative = params.prompt.personaSlug === "creative";
  const completion = await aiSdkCompletion(messages, {
    model: params.prompt.chosenModel,
    maxTokens: isCreative ? 350 : 1000,
    temperature: isCreative ? 1.0 : 0.7,
    ...(isCreative
      ? {
          topP: 0.93,
          topK: 40,
          repetitionPenalty: 1.05,
          presencePenalty: 0.1,
        }
      : {}),
  });

  let debugPayload: Record<string, unknown> | undefined;
  if (params.executionContext.debugContextEnabled) {
    debugPayload = {
      contextBlocks: params.prompt.debugContextBlocks ?? null,
      composedPrompt: params.executionContext.debugPromptEnabled
        ? {
            chosenModel: params.prompt.chosenModel,
            messages,
          }
        : undefined,
    };
  }

  return {
    assistantText: completion.content,
    chosenModel: params.prompt.chosenModel,
    timings: {
      orchestration_ms: Math.max(0, Date.now() - orchestrationStartedAt),
      llm_ms: completion.llm_ms,
      mastra_total_ms: undefined,
      prefetch_ms: undefined,
      memory_prefetch_ms: undefined,
      web_prefetch_ms: undefined,
      final_generation_ms: undefined,
    },
    generation: {
      providerUsed: completion.providerUsed,
      modelUsed: completion.modelUsed,
      fallbackUsed: completion.fallbackUsed,
      emergencyUsed: completion.emergencyUsed,
      finalSafeTextUsed: completion.finalSafeTextUsed,
    },
    promptMetadata: {
      systemBlockOrder,
    },
    tracePromptMetadata: {
      system_blocks: systemBlockOrder,
      startbrief_used: params.prompt.traceMetadata.startbriefUsed,
      startbrief_fallback: params.prompt.traceMetadata.startbriefFallback,
      startbrief_items_count: params.prompt.traceMetadata.startbriefItemsCount,
      bridgeText_chars: params.prompt.traceMetadata.bridgeTextChars,
      context_governor_used: governedContext.runtime.used,
      context_governor_budget_chars: governedContext.runtime.budget_chars,
      context_governor_candidates_total: governedContext.runtime.candidates_total,
      context_governor_selected_total: governedContext.runtime.selected_total,
      context_governor_selected_by_source: governedContext.runtime.selected_by_source,
      context_governor_dropped_by_reason: governedContext.runtime.dropped_by_reason,
      context_governor_selected_keys: governedContext.runtime.selected_keys,
    },
    mastra: {
      used: false,
      modelUsed: null,
      memoryToolUsed: false,
      memoryToolQuery: null,
      webToolUsed: false,
      webToolQuery: null,
    },
    ...(params.executionContext.debugPromptEnabled || params.executionContext.tracePromptPacket
      ? { messages }
      : {}),
    ...(debugPayload ? { debugPayload } : {}),
  } satisfies AssistantTurnResult;
}

export async function runAssistantTurn(params: {
  executionContext: AssistantExecutionContext;
  prompt: AssistantTurnPromptPayload;
}) {
  const orchestrationStartedAt = Date.now();
  const userContextBlock = buildUserContextBlock(params.prompt.userContextLines);
  const signalPackBlock = shouldInjectSignalPack({
    signalPackBlock: params.prompt.signalPackSourceBlock ?? null,
    isSessionStart: params.prompt.isSessionStart,
    intent: params.prompt.intent,
    posture: params.prompt.posture,
    pressure: params.prompt.pressure,
    stance: params.prompt.stanceSelected,
    riskLevel: params.prompt.riskLevel,
    isUrgent: params.prompt.isUrgent,
  })
    ? params.prompt.signalPackSourceBlock ?? null
    : null;
  const governedContext = buildContextGovernorSelection({
    userContextBlock,
    signalPackBlock,
    bridgeBlock: params.prompt.bridgeBlock,
    handoverBlock: params.prompt.handoverBlock,
    opsSnippetBlock: params.prompt.opsSnippetBlock,
    intent: params.prompt.intent,
    posture: params.prompt.posture,
    pressure: params.prompt.pressure,
    stance: params.prompt.stanceSelected,
    riskLevel: params.prompt.riskLevel,
  });
  const entityProfileBlocks = buildEntityProfileBlocks({
    packet: params.prompt.startbriefPacket,
    handoverBlock: governedContext.handoverBlock,
    signalPackBlock: governedContext.signalPackBlock,
  });
  const personaKernelForTurn =
    params.prompt.stanceSelected === "clarity" && params.prompt.personaSlug === "creative"
      ? await loadClarityPersonaKernel()
      : params.prompt.persona;
  const momentumGuardBlock = buildMomentumGuardBlock({
    intent: params.prompt.intent,
    posture: params.prompt.posture,
    localHour: params.prompt.localHour,
  });
  const styleGuardBlock =
    params.prompt.stanceSelected === "clarity"
      ? null
      : buildStyleGuardBlock({
          stance: params.prompt.stanceSelected,
          endearmentCooldownTurns: params.prompt.endearmentCooldownTurns,
          cooldownActive: params.prompt.cooldownActive,
        });
  const crisisResponseTemplateBlock = buildCrisisResponseTemplateBlock({
    riskLevel: params.prompt.riskLevel,
  });
  const promptForMessages = {
    ...params.prompt,
    persona: personaKernelForTurn,
    momentumGuardBlock,
    styleGuardBlock,
    crisisResponseTemplateBlock,
    userContextBlock: governedContext.userContextBlock,
    signalPackBlock: governedContext.signalPackBlock,
    bridgeBlock: governedContext.bridgeBlock,
    handoverBlock: governedContext.handoverBlock,
    entityProfileBlocks,
    opsSnippetBlock: governedContext.opsSnippetBlock,
  };
  const messages = buildChatMessages(promptForMessages);
  const systemBlockOrder = [
    "persona",
    ...(crisisResponseTemplateBlock ? ["crisis_response_template"] : []),
    ...(governedContext.userContextBlock ? ["user_context"] : []),
    ...(governedContext.signalPackBlock ? ["signal_pack"] : []),
    ...(params.prompt.stanceOverlayBlock ? ["stance_overlay"] : []),
    ...(params.prompt.tacticOverlayBlock ? ["overlay"] : []),
    ...(governedContext.bridgeBlock ? ["bridge"] : []),
    ...(params.prompt.userNarrativeBlock ? ["user_narrative"] : []),
    ...(governedContext.handoverBlock ? ["handover"] : []),
    ...(entityProfileBlocks.length > 0 ? ["entity_profile"] : []),
    ...(governedContext.opsSnippetBlock ? ["ops"] : []),
    ...(params.prompt.supplementalContext ? ["supplemental"] : []),
    ...(params.prompt.currentSessionTruthsBlock ? ["current_session_truths"] : []),
    ...(params.prompt.rollingSummary ? ["conversation_history"] : []),
  ];

  if (params.executionContext.featureFlags.mastraEnabled) {
    try {
      const mastraTurn = await runMastraTurn({
        userId: params.prompt.promptWarningMeta.userId,
        requestId: params.executionContext.requestId,
        now: params.executionContext.now,
        chosenModel: params.prompt.chosenModel,
        instructions: personaKernelForTurn,
        messages,
      });

      let debugPayload: Record<string, unknown> | undefined;
      if (params.executionContext.debugContextEnabled) {
        debugPayload = {
          contextBlocks: params.prompt.debugContextBlocks ?? null,
          composedPrompt: params.executionContext.debugPromptEnabled
            ? {
                chosenModel: params.prompt.chosenModel,
                messages,
              }
            : undefined,
          mastra: {
            used: true,
            toolCalls: mastraTurn.toolCalls,
            toolResults: mastraTurn.toolResults,
          },
        };
      }

      return {
        assistantText: mastraTurn.assistantText,
        chosenModel: params.prompt.chosenModel,
        timings: {
          orchestration_ms: Math.max(0, Date.now() - orchestrationStartedAt),
          llm_ms: mastraTurn.llm_ms,
          mastra_total_ms: mastraTurn.timings.mastra_total_ms,
          prefetch_ms: mastraTurn.timings.prefetch_ms,
          memory_prefetch_ms: mastraTurn.timings.memory_prefetch_ms,
          web_prefetch_ms: mastraTurn.timings.web_prefetch_ms,
          final_generation_ms: mastraTurn.timings.final_generation_ms,
        },
        generation: {
          providerUsed: "openrouter",
          modelUsed: params.prompt.chosenModel,
          fallbackUsed: false,
          emergencyUsed: false,
          finalSafeTextUsed: false,
        },
        promptMetadata: {
          systemBlockOrder,
        },
        tracePromptMetadata: {
          system_blocks: systemBlockOrder,
          startbrief_used: params.prompt.traceMetadata.startbriefUsed,
          startbrief_fallback: params.prompt.traceMetadata.startbriefFallback,
          startbrief_items_count: params.prompt.traceMetadata.startbriefItemsCount,
          bridgeText_chars: params.prompt.traceMetadata.bridgeTextChars,
          context_governor_used: governedContext.runtime.used,
          context_governor_budget_chars: governedContext.runtime.budget_chars,
          context_governor_candidates_total: governedContext.runtime.candidates_total,
          context_governor_selected_total: governedContext.runtime.selected_total,
          context_governor_selected_by_source: governedContext.runtime.selected_by_source,
          context_governor_dropped_by_reason: governedContext.runtime.dropped_by_reason,
          context_governor_selected_keys: governedContext.runtime.selected_keys,
        },
        mastra: {
          used: true,
          modelUsed: mastraTurn.modelUsed,
          memoryToolUsed: mastraTurn.memoryToolUsed,
          memoryToolQuery: mastraTurn.memoryToolQuery,
          webToolUsed: mastraTurn.webToolUsed,
          webToolQuery: mastraTurn.webToolQuery,
        },
        ...(params.executionContext.debugPromptEnabled || params.executionContext.tracePromptPacket
          ? { messages }
          : {}),
        ...(debugPayload ? { debugPayload } : {}),
      } satisfies AssistantTurnResult;
    } catch (error) {
      console.warn("[mastra.turn.error]", {
        requestId: params.executionContext.requestId,
        traceId: params.executionContext.traceId,
        model: params.prompt.chosenModel,
        error,
      });
    }
  }

  return runCustomAssistantTurn(params);
}

