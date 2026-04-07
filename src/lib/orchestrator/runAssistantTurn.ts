import { aiSdkCompletion, type AISDKMessage } from "@/lib/llm/aiSdkCompletion";

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
  };
  parityMode: {
    enabled: boolean;
  };
};

export type AssistantTurnPromptPayload = {
  persona: string;
  momentumGuardBlock?: string | null;
  styleGuardBlock?: string | null;
  crisisResponseTemplateBlock?: string | null;
  userContextBlock?: string | null;
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
    contextGovernor: {
      used: true;
      budget_chars: number;
      candidates_total: number;
      selected_total: number;
      selected_by_source: Record<string, number>;
      dropped_by_reason: Record<string, number>;
      selected_keys: string[];
    };
  };
};

export type AssistantTurnResult = {
  assistantText: string;
  chosenModel: string;
  timings: {
    orchestration_ms: number;
    llm_ms: number;
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
  messages?: AISDKMessage[];
  debugPayload?: Record<string, unknown>;
};

function buildChatMessages(params: {
  persona: string;
  momentumGuardBlock?: string | null;
  styleGuardBlock?: string | null;
  crisisResponseTemplateBlock?: string | null;
  userContextBlock?: string | null;
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
    ...(params.overlayBlock ? [{ role: "system" as const, content: params.overlayBlock }] : []),
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
    ...(conversationHistoryBlock
      ? [{ role: "system" as const, content: conversationHistoryBlock }]
      : params.recentMessages),
    { role: "user" as const, content: params.transcript },
  ] satisfies AISDKMessage[];
}

function buildSystemBlockOrder(params: AssistantTurnPromptPayload) {
  return [
    "persona",
    ...(params.crisisResponseTemplateBlock ? ["crisis_response_template"] : []),
    ...(params.userContextBlock ? ["user_context"] : []),
    ...(params.signalPackBlock ? ["signal_pack"] : []),
    ...(params.stanceOverlayBlock ? ["stance_overlay"] : []),
    ...(params.tacticOverlayBlock ? ["overlay"] : []),
    ...(params.bridgeBlock ? ["bridge"] : []),
    ...(params.userNarrativeBlock ? ["user_narrative"] : []),
    ...(params.handoverBlock ? ["handover"] : []),
    ...((params.entityProfileBlocks?.length ?? 0) > 0 ? ["entity_profile"] : []),
    ...(params.opsSnippetBlock ? ["ops"] : []),
    ...(params.supplementalContext ? ["supplemental"] : []),
    ...(params.rollingSummary ? ["conversation_history"] : []),
  ];
}

export async function runAssistantTurn(params: {
  executionContext: AssistantExecutionContext;
  prompt: AssistantTurnPromptPayload;
}) {
  const orchestrationStartedAt = Date.now();
  const messages = buildChatMessages(params.prompt);
  const systemBlockOrder = buildSystemBlockOrder(params.prompt);
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
      orchestration_ms: Math.max(0, Date.now() - orchestrationStartedAt - completion.llm_ms),
      llm_ms: completion.llm_ms,
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
      context_governor_used: params.prompt.traceMetadata.contextGovernor.used,
      context_governor_budget_chars: params.prompt.traceMetadata.contextGovernor.budget_chars,
      context_governor_candidates_total:
        params.prompt.traceMetadata.contextGovernor.candidates_total,
      context_governor_selected_total:
        params.prompt.traceMetadata.contextGovernor.selected_total,
      context_governor_selected_by_source:
        params.prompt.traceMetadata.contextGovernor.selected_by_source,
      context_governor_dropped_by_reason:
        params.prompt.traceMetadata.contextGovernor.dropped_by_reason,
      context_governor_selected_keys:
        params.prompt.traceMetadata.contextGovernor.selected_keys,
    },
    ...(params.executionContext.debugPromptEnabled || params.executionContext.tracePromptPacket
      ? { messages }
      : {}),
    ...(debugPayload ? { debugPayload } : {}),
  } satisfies AssistantTurnResult;
}
