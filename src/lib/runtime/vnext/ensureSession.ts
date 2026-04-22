import type { SessionContext, TurnEvent } from "./contracts";
import { ensureActiveSession } from "../../services/session/sessionService";
import { mapLegacySessionToSessionContext } from "./sessionMapping";

export async function ensureSession(event: TurnEvent): Promise<SessionContext> {
  // TODO(vNext): keep this as a temporary adapter until session policy has a
  // native vNext boundary. The legacy service owns stale-session closure,
  // active-session lookup, and turn-count mutation.
  const now = new Date(event.timestampUtc);
  const safeNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const session = await ensureActiveSession(event.userId, event.personaId, safeNow);

  return mapLegacySessionToSessionContext(session, event.sessionId);
}
