import type {
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
  TurnPacket,
} from "./contracts";

type Presence = "present" | "missing" | "partial";

type PreviewSection = {
  key: string;
  presence: Presence;
  source?: string;
  summary: Record<string, unknown>;
  text?: string;
};

export type PromptPreview = {
  kind: "vnext_prompt_preview";
  version: "2026-04-22";
  text: string;
  sections: {
    runtime: PreviewSection;
    session: PreviewSection;
    decision: PreviewSection;
    context: PreviewSection;
    dialogue: PreviewSection;
    policy: PreviewSection;
  };
  contextSections: Array<{
    key: string;
    presence: Presence;
    source?: string;
    length: number;
    preview: string;
  }>;
  missing: string[];
  trace: Record<string, unknown>;
};

type RenderPromptPreviewInput = {
  event: TurnEvent;
  session: SessionContext;
  decision: TurnDecision;
  retrievalPlan: RetrievalPlan;
  retrievals: RetrievalOutputs;
  packet: TurnPacket;
};

function previewText(value: string, maxLength = 240): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function hasObjectFields(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).length > 0;
}

function getRetrievalPresence(retrievals: RetrievalOutputs) {
  return {
    recentTurns: Array.isArray(retrievals.recentTurns) && retrievals.recentTurns.length > 0,
    memory: hasObjectFields(retrievals.memory),
    continuity: hasObjectFields(retrievals.continuity),
    calendar: retrievals.calendar !== undefined && retrievals.calendar !== null,
    tasks: retrievals.tasks !== undefined && retrievals.tasks !== null,
    situational: hasObjectFields(retrievals.situational),
    tools: hasObjectFields(retrievals.tools),
  };
}

function buildContextSectionPreview(packet: TurnPacket): PromptPreview["contextSections"] {
  return packet.context.sections.map((section) => ({
    key: section.key,
    presence: "present",
    source: section.source,
    length: section.content.length,
    preview: previewText(section.content),
  }));
}

function buildMissingSections(retrievals: RetrievalOutputs, packet: TurnPacket): string[] {
  const presentPacketSections = new Set(packet.context.sections.map((section) => section.key));
  const retrievalPresence = getRetrievalPresence(retrievals);
  const missing: string[] = [];

  if (!retrievalPresence.recentTurns) missing.push("recent_turns");
  if (!retrievalPresence.memory) missing.push("memory");
  if (!retrievalPresence.continuity) missing.push("continuity");
  if (!retrievalPresence.calendar) missing.push("calendar");
  if (!retrievalPresence.tasks) missing.push("tasks");
  if (!retrievalPresence.situational) missing.push("situational");
  if (!retrievalPresence.tools) missing.push("tools");
  if (packet.context.sections.length === 0) missing.push("context.sections");

  return missing.filter((key) => !presentPacketSections.has(key));
}

function renderReadablePreview(input: {
  packet: TurnPacket;
  contextSections: PromptPreview["contextSections"];
  missing: string[];
}) {
  const lines = [
    "VNEXT PROMPT PREVIEW - NON EXECUTING",
    `runtime: modelTier=${input.packet.runtime.modelTier}; responseMode=${input.packet.runtime.responseMode}`,
    `session: id=${input.packet.session.sessionId}; turnCount=${input.packet.session.turnCount}; isNew=${input.packet.session.isNewSession}`,
    `decision: intent=${input.packet.policy.decision.intent}; sensitivity=${input.packet.policy.decision.sensitivity}; toolNeed=${input.packet.policy.decision.toolNeed}`,
    `dialogue.currentTurn: ${input.packet.dialogue.currentTurn ? "present" : "missing"}`,
    `dialogue.recentTurns: ${input.packet.dialogue.recentTurns.length}`,
    "context.sections:",
  ];

  if (input.contextSections.length === 0) {
    lines.push("- [missing] context.sections");
  } else {
    for (const section of input.contextSections) {
      lines.push(`- [present] ${section.key} (${section.length} chars)`);
    }
  }

  lines.push(`missing: ${input.missing.length > 0 ? input.missing.join(", ") : "none"}`);
  lines.push("note: preview only; no prompt execution; no generation");

  return lines.join("\n");
}

export function renderPromptPreview(input: RenderPromptPreviewInput): PromptPreview {
  const { event, session, decision, retrievalPlan, retrievals, packet } = input;
  const contextSections = buildContextSectionPreview(packet);
  const missing = buildMissingSections(retrievals, packet);
  const retrievalPresence = getRetrievalPresence(retrievals);
  const text = renderReadablePreview({ packet, contextSections, missing });

  return {
    kind: "vnext_prompt_preview",
    version: "2026-04-22",
    text,
    sections: {
      runtime: {
        key: "runtime",
        presence: "present",
        summary: {
          version: packet.runtime.version,
          modelTier: packet.runtime.modelTier,
          responseMode: packet.runtime.responseMode,
        },
      },
      session: {
        key: "session",
        presence: "present",
        summary: {
          sessionId: session.sessionId,
          isNewSession: session.isNewSession,
          turnCount: session.turnCount,
        },
      },
      decision: {
        key: "decision",
        presence: "present",
        summary: {
          intent: decision.intent,
          sensitivity: decision.sensitivity,
          toolNeed: decision.toolNeed,
          modelTier: decision.modelTier,
          responseMode: decision.responseMode,
        },
      },
      context: {
        key: "context",
        presence: contextSections.length > 0 ? "present" : "missing",
        summary: {
          sectionCount: contextSections.length,
          sectionKeys: contextSections.map((section) => section.key),
          retrievalPresence,
        },
      },
      dialogue: {
        key: "dialogue",
        presence: packet.dialogue.currentTurn ? "present" : "partial",
        summary: {
          currentTurnPresent: Boolean(packet.dialogue.currentTurn),
          currentTurnLength: packet.dialogue.currentTurn.length,
          recentTurnCount: packet.dialogue.recentTurns.length,
        },
      },
      policy: {
        key: "policy",
        presence: "present",
        summary: {
          flags: decision.policyFlags ?? {},
          reasoningEffort: decision.reasoningEffort ?? null,
        },
      },
    },
    contextSections,
    missing,
    trace: {
      source: "adapter",
      adapter: "renderPromptPreview",
      noExecution: true,
      noGeneration: true,
      noLegacyPromptAssembly: true,
      event: {
        modality: event.modality,
        timestampUtc: event.timestampUtc,
      },
      session: {
        sessionId: session.sessionId,
        turnCount: session.turnCount,
      },
      retrievalPlan: {
        recentTurns: retrievalPlan.recentTurns,
        memory: retrievalPlan.memory,
        continuity: retrievalPlan.continuity,
        calendar: retrievalPlan.calendar,
        tasks: retrievalPlan.tasks,
        web: retrievalPlan.web,
        weather: retrievalPlan.weather,
        traffic: retrievalPlan.traffic,
      },
      packet: {
        sectionCount: packet.context.sections.length,
        sectionKeys: packet.context.sections.map((section) => section.key),
      },
      missing,
      notes: [
        "parity_preview_only",
        "not_the_legacy_prompt",
        "not_used_for_execution",
      ],
    },
  };
}

export const renderContextPreview = renderPromptPreview;

export const __test__ = {
  buildContextSectionPreview,
  buildMissingSections,
  getRetrievalPresence,
};
