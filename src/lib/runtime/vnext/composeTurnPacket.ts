import type {
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnDecision,
  TurnEvent,
  TurnPacket,
  TurnPacketSection,
} from "./contracts";

type ComposeTurnPacketInput = {
  event: TurnEvent;
  session: SessionContext;
  decision: TurnDecision;
  retrievalPlan?: RetrievalPlan;
  retrievals: RetrievalOutputs;
};

function getUserText(event: TurnEvent) {
  return event.transcript ?? event.text ?? "";
}

function hasArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasObjectFields(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).length > 0;
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function pushSection(
  sections: TurnPacketSection[],
  key: string,
  value: unknown,
  source: string
) {
  if (!hasValue(value)) return;
  sections.push({
    key,
    source,
    content: typeof value === "string" ? value : stableJson(value),
  });
}

function buildContextSections(retrievals: RetrievalOutputs): TurnPacketSection[] {
  const sections: TurnPacketSection[] = [];

  pushSection(sections, "recent_turns", retrievals.recentTurns, "retrievals.recentTurns");
  pushSection(sections, "memory", retrievals.memory, "retrievals.memory");
  pushSection(sections, "continuity", retrievals.continuity, "retrievals.continuity");
  pushSection(sections, "calendar", retrievals.calendar, "retrievals.calendar");
  pushSection(sections, "tasks", retrievals.tasks, "retrievals.tasks");
  pushSection(sections, "situational", retrievals.situational, "retrievals.situational");
  pushSection(sections, "tools", retrievals.tools, "retrievals.tools");

  return sections;
}

function buildSectionTrace(sections: TurnPacketSection[], retrievals: RetrievalOutputs) {
  const populated = new Set(sections.map((section) => section.key));

  return {
    recentTurns: populated.has("recent_turns")
      ? "populated"
      : hasArrayItems(retrievals.recentTurns)
        ? "present_unsectioned"
        : "absent",
    memory: populated.has("memory") ? "populated" : hasObjectFields(retrievals.memory) ? "present_unsectioned" : "absent",
    continuity: populated.has("continuity")
      ? "populated"
      : hasObjectFields(retrievals.continuity)
        ? "present_unsectioned"
        : "absent",
    calendar: populated.has("calendar") ? "populated" : hasValue(retrievals.calendar) ? "present_unsectioned" : "absent",
    tasks: populated.has("tasks") ? "populated" : hasValue(retrievals.tasks) ? "present_unsectioned" : "absent",
    situational: populated.has("situational")
      ? "populated"
      : hasObjectFields(retrievals.situational)
        ? "present_unsectioned"
        : "absent",
    tools: populated.has("tools") ? "populated" : hasObjectFields(retrievals.tools) ? "present_unsectioned" : "absent",
  };
}

export async function composeTurnPacket({
  event,
  session,
  decision,
  retrievalPlan,
  retrievals,
}: ComposeTurnPacketInput): Promise<TurnPacket> {
  // TODO(vNext): migrate legacy prompt/context assembly into deterministic packet
  // sections before any final system prompt is built.
  const currentTurn = getUserText(event);
  const sections = buildContextSections(retrievals);

  return {
    runtime: {
      version: "vnext",
      modelTier: decision.modelTier,
      responseMode: decision.responseMode,
    },
    user: {
      userId: event.userId,
      personaId: event.personaId,
      modality: event.modality,
      text: currentTurn,
    },
    session,
    context: {
      sections,
      retrievalPlan,
      retrievals,
    },
    policy: {
      decision,
    },
    dialogue: {
      recentTurns: retrievals.recentTurns ?? [],
      currentTurn,
    },
    metadata: {
      source: "vnext_packet_builder",
      trace: {
        source: "adapter",
        adapter: "composeTurnPacket",
        event: {
          modality: event.modality,
          timestampUtc: event.timestampUtc,
          timezone: event.timezone ?? null,
          hasAudio: Boolean(event.audio),
          attachmentCount: event.attachments?.length ?? 0,
        },
        session: {
          sessionId: session.sessionId,
          isNewSession: session.isNewSession,
          turnCount: session.turnCount,
        },
        decision: {
          intent: decision.intent,
          sensitivity: decision.sensitivity,
          toolNeed: decision.toolNeed,
          modelTier: decision.modelTier,
          responseMode: decision.responseMode,
        },
        retrievalPlan: retrievalPlan
          ? {
              recentTurns: retrievalPlan.recentTurns,
              memory: retrievalPlan.memory,
              continuity: retrievalPlan.continuity,
              calendar: retrievalPlan.calendar,
              tasks: retrievalPlan.tasks,
              web: retrievalPlan.web,
              weather: retrievalPlan.weather,
              traffic: retrievalPlan.traffic,
              toolPrefetchCount: retrievalPlan.toolPrefetches?.length ?? 0,
            }
          : undefined,
        sections: buildSectionTrace(sections, retrievals),
        notes: ["packet_only_no_prompt_assembly"],
      },
    },
  };
}

export const __test__ = {
  buildContextSections,
  buildSectionTrace,
};
