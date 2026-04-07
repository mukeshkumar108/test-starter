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
  messages: AISDKMessage[];
  chosenModel: string;
  personaSlug: string;
  systemBlockOrder: string[];
  supplementalContext?: string | null;
  rollingSummary?: string | null;
  debugContextBlocks?: {
    persona: string;
    situationalContext: string | null;
    supplementalContext: string | null;
    rollingSummary: string | null;
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
  messages?: AISDKMessage[];
  debugPayload?: Record<string, unknown>;
};

export async function runAssistantTurn(params: {
  executionContext: AssistantExecutionContext;
  prompt: AssistantTurnPromptPayload;
}) {
  const orchestrationStartedAt = Date.now();
  const isCreative = params.prompt.personaSlug === "creative";
  const completion = await aiSdkCompletion(params.prompt.messages, {
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
            messages: params.prompt.messages,
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
      systemBlockOrder: params.prompt.systemBlockOrder,
    },
    ...(params.executionContext.debugPromptEnabled || params.executionContext.tracePromptPacket
      ? { messages: params.prompt.messages }
      : {}),
    ...(debugPayload ? { debugPayload } : {}),
  } satisfies AssistantTurnResult;
}
