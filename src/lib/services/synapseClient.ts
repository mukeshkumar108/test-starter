import { env } from "@/env";

export type SynapseBriefResponse = {
  briefContext?: string | null;
  temporalVibe?: string | null;
  timeGapDescription?: string | null;
  timeOfDayLabel?: string | null;
  narrativeSummary?: Array<{ summary?: string; reference_time?: string }> | string[];
  facts?: string[] | null;
  openLoops?: string[] | null;
  commitments?: string[] | null;
  contextAnchors?: {
    timeOfDayLabel?: string | null;
    timeGapDescription?: string | null;
    lastInteraction?: string | null;
  } | null;
  currentVibe?: { mood?: string | null; energyLevel?: string | null } | null;
  activeLoops?: Array<{ text?: string; label?: string }> | string[];
  currentFocus?: string | null;
};

export type SynapseStartBriefResponse = {
  handover_text?: string | null;
  handover_depth?: "continuation" | "today" | "yesterday" | "multi_day" | null;
  time_context?: {
    local_time?: string | null;
    time_of_day?: string | null;
    gap_minutes?: number | null;
    sessions_today?: number | null;
    first_session_today?: boolean | null;
  } | null;
  resume?: {
    use_bridge?: boolean | null;
    bridge_text?: string | null;
  } | null;
  ops_context?: {
    top_loops_today?: Array<{
      text?: string | null;
      type?: string | null;
      time_horizon?: string | null;
      salience?: number | null;
    }> | null;
    waiting_on?: Array<{ text?: string | null }> | null;
    user_model_hints?: Array<{ text?: string | null } | string> | null;
    yesterday_themes?: Array<{ text?: string | null } | string> | null;
    steering_note?: string | null;
  } | null;
  evidence?: {
    session_summary_ids_used?: string[] | null;
    session_summary_ids_fetched?: string[] | null;
    summary_fetch_count?: number | null;
    summary_used_count?: number | null;
    summary_content_quality?: "ok" | "empty_after_normalization" | "none_fetched" | null;
    fallback_used?: boolean | null;
    fallback_success?: boolean | null;
    daily_analysis_date_used?: string | null;
  } | null;
  timeOfDayLabel?: string | null;
  timeGapHuman?: string | null;
  bridgeText?: string | null;
  items?: Array<{
    kind?: string | null;
    text?: string | null;
    type?: string | null;
    timeHorizon?: string | null;
    dueDate?: string | null;
    salience?: number | null;
    lastSeenAt?: string | null;
  }> | null;
};

export type SynapseMemoryLoopItem = {
  id?: string | null;
  type?: string | null;
  text?: string | null;
  status?: string | null;
  salience?: number | null;
  timeHorizon?: string | null;
  dueDate?: string | null;
  lastSeenAt?: string | null;
  domain?: string | null;
  importance?: number | null;
  urgency?: number | null;
  tags?: string[] | null;
  personaId?: string | null;
};

export type SynapseMemoryLoopsResponse = {
  items?: SynapseMemoryLoopItem[] | null;
  metadata?: {
    count?: number;
    limit?: number;
    sort?: string | null;
    domainFilter?: string | null;
    personaId?: string | null;
  } | null;
};

export type SynapseUserModelResponse = {
  tenantId?: string | null;
  userId?: string | null;
  model?: {
    north_star?: unknown;
    current_focus?: unknown;
    key_relationships?: unknown[];
    work_context?: unknown;
    patterns?: unknown[];
    preferences?: Record<string, unknown> | null;
    daily_anchors?: unknown;
    recent_signals?: unknown[];
    health?: unknown;
    spirituality?: unknown;
  } | null;
  completenessScore?: Record<string, number> | null;
  version?: number | null;
  exists?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastSource?: string | null;
};

export type SynapseDailyAnalysisResponse = {
  exists?: boolean | null;
  steeringNote?: string | null;
  themes?: string[] | Array<{ text?: string | null; theme?: string | null }> | null;
  scores?: {
    curiosity?: number | null;
    warmth?: number | null;
    usefulness?: number | null;
    forward_motion?: number | null;
  } | null;
  metadata?: {
    quality_flag?: string | null;
  } | null;
};

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeSynapseStartBriefResponse(
  payload: unknown
): SynapseStartBriefResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      timeOfDayLabel: null,
      timeGapHuman: null,
      bridgeText: null,
      items: [],
    };
  }
  const value = payload as Record<string, unknown>;
  const timeContext =
    value.time_context && typeof value.time_context === "object" && !Array.isArray(value.time_context)
      ? (value.time_context as Record<string, unknown>)
      : null;
  const resume =
    value.resume && typeof value.resume === "object" && !Array.isArray(value.resume)
      ? (value.resume as Record<string, unknown>)
      : null;
  const ops =
    value.ops_context && typeof value.ops_context === "object" && !Array.isArray(value.ops_context)
      ? (value.ops_context as Record<string, unknown>)
      : null;
  const evidence =
    value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
      ? (value.evidence as Record<string, unknown>)
      : null;
  const topLoops = Array.isArray(ops?.top_loops_today) ? ops?.top_loops_today : [];
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const mappedTopLoops = topLoops
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const text = toNullableString(row.text)?.trim() ?? "";
      if (!text) return null;
      return {
        kind: "loop",
        text,
        type: toNullableString(row.type),
        timeHorizon: toNullableString(row.time_horizon),
        dueDate: null,
        salience: toNullableNumber(row.salience),
        lastSeenAt: null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const items = (rawItems.length > 0 ? rawItems : mappedTopLoops)
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const text = toNullableString(row.text)?.trim() ?? "";
      const kind = toNullableString(row.kind);
      if (!text || !kind) return null;
      return {
        kind,
        text,
        type: toNullableString(row.type),
        timeHorizon: toNullableString(row.timeHorizon),
        dueDate: toNullableString(row.dueDate),
        salience: toNullableNumber(row.salience),
        lastSeenAt: toNullableString(row.lastSeenAt),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return {
    handover_text: toNullableString(value.handover_text),
    handover_depth:
      value.handover_depth === "continuation" ||
      value.handover_depth === "today" ||
      value.handover_depth === "yesterday" ||
      value.handover_depth === "multi_day"
        ? value.handover_depth
        : null,
    time_context: {
      local_time: toNullableString(timeContext?.local_time),
      time_of_day: toNullableString(timeContext?.time_of_day),
      gap_minutes: toNullableNumber(timeContext?.gap_minutes),
      sessions_today: toNullableNumber(timeContext?.sessions_today),
      first_session_today:
        typeof timeContext?.first_session_today === "boolean"
          ? timeContext.first_session_today
          : null,
    },
    resume: {
      use_bridge: typeof resume?.use_bridge === "boolean" ? resume.use_bridge : null,
      bridge_text: toNullableString(resume?.bridge_text),
    },
    ops_context: {
      top_loops_today: mappedTopLoops.map((loop) => ({
        text: loop.text,
        type: loop.type ?? null,
        time_horizon: loop.timeHorizon ?? null,
        salience: loop.salience ?? null,
      })),
      waiting_on: Array.isArray(ops?.waiting_on)
        ? ops.waiting_on
            .map((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return null;
              const text = toNullableString((item as Record<string, unknown>).text);
              return text ? { text } : null;
            })
            .filter((item): item is { text: string } => Boolean(item))
        : [],
      user_model_hints: Array.isArray(ops?.user_model_hints) ? (ops.user_model_hints as any[]) : [],
      yesterday_themes: Array.isArray(ops?.yesterday_themes) ? (ops.yesterday_themes as any[]) : [],
      steering_note: toNullableString(ops?.steering_note),
    },
    evidence: {
      session_summary_ids_used: Array.isArray(evidence?.session_summary_ids_used)
        ? (evidence.session_summary_ids_used as unknown[]).filter(
            (item): item is string => typeof item === "string"
          )
        : [],
      session_summary_ids_fetched: Array.isArray(evidence?.session_summary_ids_fetched)
        ? (evidence.session_summary_ids_fetched as unknown[]).filter(
            (item): item is string => typeof item === "string"
          )
        : [],
      summary_fetch_count: toNullableNumber(evidence?.summary_fetch_count),
      summary_used_count: toNullableNumber(evidence?.summary_used_count),
      summary_content_quality:
        evidence?.summary_content_quality === "ok" ||
        evidence?.summary_content_quality === "empty_after_normalization" ||
        evidence?.summary_content_quality === "none_fetched"
          ? evidence.summary_content_quality
          : null,
      fallback_used:
        typeof evidence?.fallback_used === "boolean" ? evidence.fallback_used : null,
      fallback_success:
        typeof evidence?.fallback_success === "boolean" ? evidence.fallback_success : null,
      daily_analysis_date_used: toNullableString(evidence?.daily_analysis_date_used),
    },
    timeOfDayLabel:
      toNullableString(value.timeOfDayLabel) ??
      toNullableString(timeContext?.time_of_day),
    timeGapHuman:
      toNullableString(value.timeGapHuman) ??
      (toNullableNumber(timeContext?.gap_minutes) !== null
        ? `${toNullableNumber(timeContext?.gap_minutes)} minutes since last spoke`
        : null),
    bridgeText:
      toNullableString(value.bridgeText) ??
      toNullableString(resume?.bridge_text),
    items,
  };
}

function normalizeSynapseMemoryLoopsResponse(payload: unknown): SynapseMemoryLoopsResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { items: [], metadata: null };
  }
  const value = payload as Record<string, unknown>;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const text = toNullableString(row.text)?.trim() ?? "";
      if (!text) return null;
      return {
        id: toNullableString(row.id),
        type: toNullableString(row.type),
        text,
        status: toNullableString(row.status),
        salience: toNullableNumber(row.salience),
        timeHorizon: toNullableString(row.timeHorizon),
        dueDate: toNullableString(row.dueDate),
        lastSeenAt: toNullableString(row.lastSeenAt),
        domain: toNullableString(row.domain),
        importance: toNullableNumber(row.importance),
        urgency: toNullableNumber(row.urgency),
        tags: Array.isArray(row.tags)
          ? row.tags.filter((tag): tag is string => typeof tag === "string")
          : null,
        personaId: toNullableString(row.personaId),
      } as SynapseMemoryLoopItem;
    })
    .filter((item): item is SynapseMemoryLoopItem => Boolean(item));
  const metadata =
    value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as SynapseMemoryLoopsResponse["metadata"])
      : null;
  return { items, metadata };
}

function normalizeSynapseDailyAnalysisResponse(payload: unknown): SynapseDailyAnalysisResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      exists: false,
      steeringNote: null,
      themes: [],
      scores: null,
      metadata: null,
    };
  }
  const value = payload as Record<string, unknown>;
  const rawThemes = Array.isArray(value.themes) ? value.themes : [];
  const themes = rawThemes
    .map((theme) => {
      if (typeof theme === "string") return theme.trim();
      if (!theme || typeof theme !== "object" || Array.isArray(theme)) return null;
      const row = theme as Record<string, unknown>;
      const text = toNullableString(row.text)?.trim() ?? "";
      if (text) return text;
      return toNullableString(row.theme)?.trim() ?? null;
    })
    .filter((item): item is string => Boolean(item));
  const scores =
    value.scores && typeof value.scores === "object" && !Array.isArray(value.scores)
      ? {
          curiosity: toNullableNumber((value.scores as Record<string, unknown>).curiosity),
          warmth: toNullableNumber((value.scores as Record<string, unknown>).warmth),
          usefulness: toNullableNumber((value.scores as Record<string, unknown>).usefulness),
          forward_motion: toNullableNumber((value.scores as Record<string, unknown>).forward_motion),
        }
      : null;
  const metadata =
    value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? {
          quality_flag: toNullableString((value.metadata as Record<string, unknown>).quality_flag),
        }
      : null;
  return {
    exists: typeof value.exists === "boolean" ? value.exists : null,
    steeringNote: toNullableString(value.steeringNote),
    themes,
    scores,
    metadata,
  };
}

const DEFAULT_TIMEOUT_MS = 3000;

function resolveTimeoutMs() {
  const raw = env.SYNAPSE_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

type RequestResult<TResponse> = {
  ok: boolean;
  status: number | null;
  ms: number;
  url: string;
  data: TResponse | null;
};

type RequestResultWithError<TResponse> = RequestResult<TResponse> & {
  errorBody?: string | null;
  reason?: "timeout" | "exception" | "non_ok" | "missing_base_url";
};

async function requestJson<TPayload, TResponse>(
  method: "GET" | "POST",
  path: string,
  payload?: TPayload
): Promise<RequestResult<TResponse> | null> {
  const requestId = crypto.randomUUID();

  if (!env.SYNAPSE_BASE_URL) {
    console.warn("[synapse.client] missing SYNAPSE_BASE_URL", { requestId });
    return null;
  }

  const url = `${env.SYNAPSE_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeoutMs = resolveTimeoutMs();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}),
      signal: controller.signal,
    });
    const ms = Date.now() - start;

    if (!response.ok) {
      console.warn("[synapse.client] request failed", {
        requestId,
        path,
        url,
        status: response.status,
        ms,
      });
      return {
        ok: false,
        status: response.status,
        ms,
        url,
        data: null,
      };
    }

    const data = (await response.json()) as TResponse;
    return {
      ok: true,
      status: response.status,
      ms,
      url,
      data,
    };
  } catch (error) {
    const ms = Date.now() - start;
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "exception";
    console.warn("[synapse.client] request error", {
      requestId,
      path,
      url,
      reason,
      ms,
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function brief<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  const result = await requestJson<TPayload, TResponse>("POST", "/brief", payload);
  if (!result?.ok) return null;
  return result.data;
}

export async function sessionBrief<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  const params = new URLSearchParams();
  const asRecord = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["tenantId", "userId", "personaId", "sessionId", "now"]) {
    const value = asRecord[key];
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  const path = `/session/brief${params.toString() ? `?${params.toString()}` : ""}`;
  const result = await requestJson<undefined, TResponse>("GET", path);
  if (!result?.ok) return null;
  return result.data;
}

export async function sessionStartBrief<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  const params = new URLSearchParams();
  const asRecord = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["tenantId", "userId", "sessionId", "timezone", "now"]) {
    const value = asRecord[key];
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  const path = `/session/startbrief${params.toString() ? `?${params.toString()}` : ""}`;
  const result = await requestJson<undefined, TResponse>("GET", path);
  if (!result?.ok) return null;
  return normalizeSynapseStartBriefResponse(result.data) as TResponse;
}

export async function memoryLoops<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  const params = new URLSearchParams();
  const asRecord = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["tenantId", "userId", "domain", "limit"]) {
    const value = asRecord[key];
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      params.set(key, String(value));
    }
  }
  const path = `/memory/loops${params.toString() ? `?${params.toString()}` : ""}`;
  const result = await requestJson<undefined, TResponse>("GET", path);
  if (!result?.ok) return null;
  return normalizeSynapseMemoryLoopsResponse(result.data) as TResponse;
}

export async function userModel<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  const params = new URLSearchParams();
  const asRecord = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["tenantId", "userId"]) {
    const value = asRecord[key];
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  const path = `/user/model${params.toString() ? `?${params.toString()}` : ""}`;
  const result = await requestJson<undefined, TResponse>("GET", path);
  if (!result?.ok) return null;
  return result.data;
}

export async function dailyAnalysis<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  const params = new URLSearchParams();
  const asRecord = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["tenantId", "userId", "date"]) {
    const value = asRecord[key];
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  const path = `/analysis/daily${params.toString() ? `?${params.toString()}` : ""}`;
  const result = await requestJson<undefined, TResponse>("GET", path);
  if (!result?.ok) return null;
  return normalizeSynapseDailyAnalysisResponse(result.data) as TResponse;
}

export async function ingest<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  const result = await requestJson<TPayload, TResponse>("POST", "/ingest", payload);
  if (!result?.ok) return null;
  return result.data;
}

export async function health(): Promise<{
  ok: boolean;
  status: number | null;
  ms: number;
  url: string;
} | null> {
  const result = await requestJson<undefined, unknown>("GET", "/health");
  if (!result) return null;
  return {
    ok: result.ok,
    status: result.status,
    ms: result.ms,
    url: result.url,
  };
}

export async function sessionIngest<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  const result = await requestJson<TPayload, TResponse>("POST", "/session/ingest", payload);
  if (!result?.ok) return null;
  return result.data;
}

export async function sessionIngestWithMeta<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<RequestResultWithError<TResponse> | null> {
  const requestId = crypto.randomUUID();

  if (!env.SYNAPSE_BASE_URL) {
    console.warn("[synapse.client] missing SYNAPSE_BASE_URL", { requestId });
    return {
      ok: false,
      status: null,
      ms: 0,
      url: "/session/ingest",
      data: null,
      errorBody: null,
      reason: "missing_base_url",
    };
  }

  const url = `${env.SYNAPSE_BASE_URL}/session/ingest`;
  const controller = new AbortController();
  const timeoutOverride = Number.parseInt(env.SYNAPSE_SESSION_INGEST_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(timeoutOverride) ? timeoutOverride : 60_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    const ms = Date.now() - start;

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn("[synapse.client] request failed", {
        requestId,
        path: "/session/ingest",
        url,
        status: response.status,
        ms,
      });
      return {
        ok: false,
        status: response.status,
        ms,
        url,
        data: null,
        errorBody,
        reason: "non_ok",
      };
    }

    const data = (await response.json()) as TResponse;
    return {
      ok: true,
      status: response.status,
      ms,
      url,
      data,
    };
  } catch (error) {
    const ms = Date.now() - start;
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "exception";
    console.warn("[synapse.client] request error", {
      requestId,
      path: "/session/ingest",
      url,
      reason,
      ms,
    });
    return {
      ok: false,
      status: null,
      ms,
      url,
      data: null,
      errorBody: reason,
      reason,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
