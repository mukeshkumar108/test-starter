import { getUserByClerkId } from "@/lib/user";
import { closeSessionOnExplicitEnd } from "@/lib/services/session/sessionService";

export async function closeCurrentSessionForClerkUser(params: {
  clerkUserId: string;
  personaId: string;
  now?: Date;
}) {
  const user = await getUserByClerkId(params.clerkUserId);
  if (!user) {
    return {
      ok: true as const,
      closed: false,
      reason: "user_not_found" as const,
      sessionId: null,
      endedAt: null,
    };
  }

  const closed = await closeSessionOnExplicitEnd(
    user.id,
    params.personaId,
    params.now ?? new Date()
  );

  return {
    ok: true as const,
    closed: Boolean(closed),
    reason: closed ? null : ("no_active_session" as const),
    sessionId: closed?.id ?? null,
    endedAt: closed?.endedAt?.toISOString() ?? null,
    userId: user.id,
  };
}
