import { env } from "@/env";

export const DEFAULT_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_ACTIVE_WINDOW_MINUTES = DEFAULT_ACTIVE_WINDOW_MS / 60_000;

function parsePositiveInt(raw: string | undefined, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getActiveWindowMs() {
  return parsePositiveInt(env.SESSION_ACTIVE_WINDOW_MS, DEFAULT_ACTIVE_WINDOW_MS);
}

export function getActiveWindowMinutes() {
  return Math.max(1, Math.floor(getActiveWindowMs() / 60_000));
}
