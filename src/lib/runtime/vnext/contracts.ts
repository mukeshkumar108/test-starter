export type TurnModality = "voice" | "text" | "multimodal";

export type TurnIntent = "companion" | "momentum" | "output_task" | "learning" | "unknown";

export type TurnSensitivity = "low" | "medium" | "high" | "crisis";

export type ToolNeed = "none" | "possible" | "required";

export type ResponseMode = "text" | "voice" | "text_and_voice";

export type ModelTier = "T1" | "T2" | "T3";

export type ReasoningEffort = "low" | "medium" | "high";

export type AttachmentKind = "image" | "pdf" | "file";

export type TurnAttachment = {
  id?: string;
  kind: AttachmentKind;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type TurnAudioInput = {
  mimeType?: string;
  sizeBytes?: number;
  durationMs?: number;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type LocalTimeContext = {
  date?: string;
  hour?: number;
  weekday?: string;
};

export type TurnEvent = {
  userId: string;
  personaId: string;
  sessionId?: string;
  modality: TurnModality;
  text?: string;
  transcript?: string;
  audio?: TurnAudioInput;
  attachments?: TurnAttachment[];
  timestampUtc: string;
  timezone?: string;
  localTime?: LocalTimeContext;
  location?: {
    label?: string;
    latitude?: number;
    longitude?: number;
  };
  metadata?: Record<string, unknown>;
};

export type SessionContext = {
  sessionId: string;
  isNewSession: boolean;
  turnCount: number;
  startedAt?: string;
  lastActivityAt?: string;
  metadata?: Record<string, unknown>;
};

export type ContextNeeds = {
  recentTurns: boolean;
  memory: boolean;
  continuity: boolean;
  calendar: boolean;
  tasks: boolean;
  web: boolean;
  weather: boolean;
  traffic: boolean;
};

export type TurnPolicyFlags = {
  allowTools?: boolean;
  allowMemoryWrite?: boolean;
  allowProbing?: boolean;
  requireSafetyTemplate?: boolean;
  continuityMode?: "none" | "light" | "full";
};

export type TurnDecision = {
  intent: TurnIntent;
  sensitivity: TurnSensitivity;
  toolNeed: ToolNeed;
  contextNeeds: ContextNeeds;
  responseMode: ResponseMode;
  modelTier: ModelTier;
  reasoningEffort?: ReasoningEffort;
  policyFlags?: TurnPolicyFlags;
  trace?: {
    source: "stub" | "classifier" | "adapter";
    confidence?: number;
    reasons?: string[];
    legacy?: Record<string, unknown>;
  };
};

export type RetrievalPlan = {
  recentTurns: boolean;
  memory: boolean;
  continuity: boolean;
  calendar: boolean;
  tasks: boolean;
  web: boolean;
  weather: boolean;
  traffic: boolean;
  memoryQuery?: string;
  toolPrefetches?: Array<{
    name: string;
    args?: Record<string, unknown>;
  }>;
  trace?: Record<string, unknown>;
};

export type DialogueTurn = {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type RetrievalOutputs = {
  recentTurns?: DialogueTurn[];
  memory?: {
    facts?: string[];
    entities?: string[];
    raw?: unknown;
  };
  continuity?: {
    handover?: string;
    bridge?: string;
    raw?: unknown;
  };
  calendar?: unknown;
  tasks?: unknown;
  situational?: {
    weather?: unknown;
    traffic?: unknown;
    web?: unknown;
  };
  tools?: {
    prefetches?: Array<{
      name: string;
      args?: Record<string, unknown>;
      result?: unknown;
    }>;
    raw?: unknown;
  };
  trace?: Record<string, unknown>;
};

export type TurnPacketSection = {
  key: string;
  content: string;
  source?: string;
};

export type TurnPacket = {
  runtime: {
    version: "vnext";
    modelTier: ModelTier;
    responseMode: ResponseMode;
  };
  user: {
    userId: string;
    personaId: string;
    modality: TurnModality;
    text: string;
  };
  session: SessionContext;
  context: {
    sections: TurnPacketSection[];
    retrievalPlan?: RetrievalPlan;
    retrievals: RetrievalOutputs;
  };
  policy: {
    decision: TurnDecision;
  };
  dialogue: {
    recentTurns: DialogueTurn[];
    currentTurn: string;
  };
  metadata?: Record<string, unknown>;
};

export type TurnExecutionResult = {
  text: string;
  execution?: {
    mode: "stub" | "direct_model" | "tool_enabled" | "legacy_adapter" | "mastra_adapter";
    backend: string;
    status: "placeholder" | "completed" | "skipped" | "failed";
    isPlaceholder?: boolean;
  };
  model?: {
    provider?: string;
    id?: string;
    tier?: ModelTier;
    reasoningEffort?: ReasoningEffort;
  };
  tools?: {
    calls?: Array<{ name: string; args?: Record<string, unknown> }>;
    results?: Array<{ name: string; ok: boolean; data?: unknown; error?: string }>;
  };
  actionsRequested?: Array<{
    kind: string;
    payload?: Record<string, unknown>;
  }>;
  trace?: Record<string, unknown>;
};

export type WritebackInstruction = {
  kind: "message" | "session_state" | "memory" | "none";
  payload?: Record<string, unknown>;
};

export type QueueInstruction = {
  kind: "session_maintenance" | "memory_ingest" | "notification" | "none";
  payload?: Record<string, unknown>;
};

export type PostProcessResult = {
  finalText: string;
  writeback: WritebackInstruction[];
  queue: QueueInstruction[];
  actionsRequested?: Array<{
    kind: string;
    payload?: Record<string, unknown>;
  }>;
  warnings?: string[];
  flags?: Record<string, boolean>;
  metadata?: Record<string, unknown>;
  debug?: Record<string, unknown>;
  trace?: Record<string, unknown>;
};

export type WritebackAndQueueResult = {
  status: "noop" | "completed" | "skipped" | "failed";
  executed: {
    messagePersistence: boolean;
    sessionStateUpdate: boolean;
    memoryWrite: boolean;
    queueDispatch: boolean;
  };
  instructions: {
    writeback: WritebackInstruction[];
    queue: QueueInstruction[];
  };
  summary: {
    writebackCount: number;
    queueCount: number;
    actionRequestCount: number;
    finalTextLength: number;
  };
  metadata?: Record<string, unknown>;
  debug?: Record<string, unknown>;
  trace?: Record<string, unknown>;
};

export type HandleUserTurnResult = {
  text: string;
  metadata?: Record<string, unknown>;
  debug?: Record<string, unknown>;
};
