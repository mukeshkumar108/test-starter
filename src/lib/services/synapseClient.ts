import { env } from "@/env";

const DEFAULT_TIMEOUT_MS = 800;

async function postJson<TPayload, TResponse>(
  path: string,
  payload: TPayload
): Promise<TResponse | null> {
  const requestId = crypto.randomUUID();

  if (!env.SYNAPSE_BASE_URL) {
    console.warn("[synapse.client] missing SYNAPSE_BASE_URL", { requestId });
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.SYNAPSE_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn("[synapse.client] request failed", {
        requestId,
        path,
        status: response.status,
      });
      return null;
    }

    return (await response.json()) as TResponse;
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "exception";
    console.warn("[synapse.client] request error", {
      requestId,
      path,
      reason,
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function brief<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  return postJson<TPayload, TResponse>("/brief", payload);
}

export async function ingest<TPayload = unknown, TResponse = unknown>(
  payload: TPayload
): Promise<TResponse | null> {
  return postJson<TPayload, TResponse>("/ingest", payload);
}
