import type { SessionContext } from "./contracts";

type LegacySessionLike = {
  id: string;
  turnCount: number;
  startedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
};

function toIso(value?: Date | string | null) {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function mapLegacySessionToSessionContext(
  session: LegacySessionLike,
  requestedSessionId?: string
): SessionContext {
  return {
    sessionId: session.id,
    // TODO(vNext): legacy session service does not expose create-vs-reuse
    // directly, so this currently infers new-session from turnCount.
    isNewSession: session.turnCount <= 1,
    turnCount: session.turnCount,
    startedAt: toIso(session.startedAt),
    lastActivityAt: toIso(session.lastActivityAt),
    metadata: {
      adapter: "legacy.ensureActiveSession",
      requestedSessionId: requestedSessionId ?? null,
    },
  };
}

