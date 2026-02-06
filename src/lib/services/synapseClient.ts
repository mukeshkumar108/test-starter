import { env } from "@/env";

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
