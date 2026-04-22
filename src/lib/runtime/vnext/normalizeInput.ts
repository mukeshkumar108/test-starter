import type { TurnEvent } from "./contracts";

export type NormalizeInputParams = Omit<TurnEvent, "timestampUtc"> & {
  timestampUtc?: string;
};

export function normalizeInput(params: NormalizeInputParams): TurnEvent {
  // TODO(vNext): normalize route-specific voice/text/attachment payloads before harness entry.
  return {
    ...params,
    timestampUtc: params.timestampUtc ?? new Date().toISOString(),
  };
}

