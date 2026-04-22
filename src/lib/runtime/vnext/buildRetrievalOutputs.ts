import type {
  DialogueTurn,
  RetrievalOutputs,
  RetrievalPlan,
  SessionContext,
  TurnEvent,
} from "./contracts";

type RetrievalOutputSource = "stub" | "legacy_adapter" | "replay_fixture" | "manual";

type RetrievalSectionKey =
  | "recentTurns"
  | "memory"
  | "continuity"
  | "calendar"
  | "tasks"
  | "web"
  | "weather"
  | "traffic"
  | "tools";

type SectionStatus = "mapped" | "missing" | "not_requested" | "provided_unrequested";

type BuildRetrievalOutputsInput = {
  plan: RetrievalPlan;
  event?: Pick<TurnEvent, "userId" | "sessionId" | "modality">;
  session?: Pick<SessionContext, "sessionId" | "turnCount" | "isNewSession">;
  source?: RetrievalOutputSource;
  recentTurns?: DialogueTurn[];
  memory?: RetrievalOutputs["memory"];
  continuity?: RetrievalOutputs["continuity"];
  calendar?: unknown;
  tasks?: unknown;
  situational?: RetrievalOutputs["situational"];
  tools?: RetrievalOutputs["tools"];
  trace?: Record<string, unknown>;
};

type LegacyRetrievalArtifacts = {
  recentTurns?: DialogueTurn[];
  memory?: RetrievalOutputs["memory"];
  continuity?: RetrievalOutputs["continuity"];
  calendar?: unknown;
  tasks?: unknown;
  situational?: RetrievalOutputs["situational"];
  tools?: RetrievalOutputs["tools"];
  raw?: unknown;
};

type RecentTurnFixtureInput = {
  role?: unknown;
  content?: unknown;
  text?: unknown;
  createdAt?: unknown;
  metadata?: unknown;
};

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isDialogueRole(value: unknown): value is DialogueTurn["role"] {
  return value === "user" || value === "assistant" || value === "system";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapRecentTurnFixtureItem(item: RecentTurnFixtureInput): DialogueTurn | null {
  if (!isDialogueRole(item.role)) return null;

  const content = typeof item.content === "string"
    ? item.content
    : typeof item.text === "string"
      ? item.text
      : null;
  if (content === null) return null;

  return {
    role: item.role,
    content,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    metadata: isRecord(item.metadata) ? item.metadata : undefined,
  };
}

export function mapRecentTurnFixtures(input: unknown): DialogueTurn[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item) => (isRecord(item) ? mapRecentTurnFixtureItem(item) : null))
    .filter((turn): turn is DialogueTurn => turn !== null);
}

function requestedFromPlan(plan: RetrievalPlan) {
  return {
    recentTurns: plan.recentTurns,
    memory: plan.memory,
    continuity: plan.continuity,
    calendar: plan.calendar,
    tasks: plan.tasks,
    web: plan.web,
    weather: plan.weather,
    traffic: plan.traffic,
    tools: Boolean(plan.toolPrefetches?.length),
  };
}

function sectionStatus(requested: boolean, value: unknown): SectionStatus {
  if (requested && hasValue(value)) return "mapped";
  if (requested) return "missing";
  if (hasValue(value)) return "provided_unrequested";
  return "not_requested";
}

function sectionStatuses(
  requested: ReturnType<typeof requestedFromPlan>,
  input: Pick<
    BuildRetrievalOutputsInput,
    "recentTurns" | "memory" | "continuity" | "calendar" | "tasks" | "situational" | "tools"
  >
): Record<RetrievalSectionKey, SectionStatus> {
  return {
    recentTurns: sectionStatus(requested.recentTurns, input.recentTurns),
    memory: sectionStatus(requested.memory, input.memory),
    continuity: sectionStatus(requested.continuity, input.continuity),
    calendar: sectionStatus(requested.calendar, input.calendar),
    tasks: sectionStatus(requested.tasks, input.tasks),
    web: sectionStatus(requested.web, input.situational?.web),
    weather: sectionStatus(requested.weather, input.situational?.weather),
    traffic: sectionStatus(requested.traffic, input.situational?.traffic),
    tools: sectionStatus(requested.tools, input.tools),
  };
}

export function buildRetrievalOutputs(input: BuildRetrievalOutputsInput): RetrievalOutputs {
  const requested = requestedFromPlan(input.plan);
  const sections = sectionStatuses(requested, input);

  return {
    recentTurns: input.recentTurns,
    memory: input.memory,
    continuity: input.continuity,
    calendar: input.calendar,
    tasks: input.tasks,
    situational: input.situational,
    tools: input.tools,
    trace: {
      source: input.source ?? "manual",
      adapter: "buildRetrievalOutputs",
      requested,
      sections,
      event: input.event
        ? {
            userId: input.event.userId,
            sessionId: input.event.sessionId ?? null,
            modality: input.event.modality,
          }
        : undefined,
      session: input.session
        ? {
            sessionId: input.session.sessionId,
            isNewSession: input.session.isNewSession,
            turnCount: input.session.turnCount,
          }
        : undefined,
      notes: ["canonical_shape_only_no_fetch"],
      ...input.trace,
    },
  };
}

export function buildStubRetrievalOutputs(input: {
  plan: RetrievalPlan;
  event?: Pick<TurnEvent, "userId" | "sessionId" | "modality">;
  session?: Pick<SessionContext, "sessionId" | "turnCount" | "isNewSession">;
}): RetrievalOutputs {
  return buildRetrievalOutputs({
    ...input,
    source: "stub",
    recentTurns: input.plan.recentTurns ? [] : undefined,
    tools: input.plan.toolPrefetches?.length
      ? { prefetches: input.plan.toolPrefetches.map((prefetch) => ({ ...prefetch })) }
      : undefined,
    trace: {
      notes: [
        "stub_outputs_only",
        "requested_sections_without_stub_data_are_left_missing",
      ],
    },
  });
}

export function mapLegacyRetrievalOutputs(input: {
  plan: RetrievalPlan;
  artifacts?: LegacyRetrievalArtifacts | null;
  event?: Pick<TurnEvent, "userId" | "sessionId" | "modality">;
  session?: Pick<SessionContext, "sessionId" | "turnCount" | "isNewSession">;
}): RetrievalOutputs {
  // TODO(vNext): replace this loose artifact shape with concrete adapters for
  // contextBuilder, memory recall, continuity, and tool-context outputs.
  const artifacts = input.artifacts ?? {};

  return buildRetrievalOutputs({
    plan: input.plan,
    event: input.event,
    session: input.session,
    source: "legacy_adapter",
    recentTurns: artifacts.recentTurns,
    memory: artifacts.memory,
    continuity: artifacts.continuity,
    calendar: artifacts.calendar,
    tasks: artifacts.tasks,
    situational: artifacts.situational,
    tools: artifacts.tools,
    trace: {
      legacyRawAvailable: hasValue(artifacts.raw),
      notes: ["legacy_artifacts_partial_mapping"],
    },
  });
}

export const __test__ = {
  mapRecentTurnFixtureItem,
  requestedFromPlan,
  sectionStatus,
};
