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
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems
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
    timeOfDayLabel: toNullableString(value.timeOfDayLabel),
    timeGapHuman: toNullableString(value.timeGapHuman),
    bridgeText: toNullableString(value.bridgeText),
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
  for (const key of ["tenantId", "userId", "personaId", "sessionId", "timezone", "now"]) {
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
  for (const key of ["tenantId", "userId", "personaId", "domain", "limit"]) {
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
