import { ensureActiveSession } from "@/lib/services/session/sessionService";
import { prisma } from "@/lib/prisma";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "session_lifecycle";
  const now = new Date();

  const first = await ensureActiveSession(ctx.userId, ctx.personaId, now);
  const second = await ensureActiveSession(ctx.userId, ctx.personaId, new Date(now.getTime() + 1000));

  await prisma.session.update({
    where: { id: second.id },
    data: { lastActivityAt: new Date(Date.now() - 31 * 60 * 1000) },
  });

  const third = await ensureActiveSession(ctx.userId, ctx.personaId, new Date());

  const sessions = await prisma.session.findMany({
    where: { userId: ctx.userId, personaId: ctx.personaId },
    orderBy: { startedAt: "asc" },
    select: { id: true, endedAt: true, lastActivityAt: true, turnCount: true },
  });

  const endedCount = sessions.filter((session) => session.endedAt).length;
  const ok = sessions.length >= 2 && endedCount >= 1 && third.id !== first.id;

  return {
    name,
    ok,
    evidence: {
      firstId: first.id,
      secondId: second.id,
      thirdId: third.id,
      sessions,
    },
  };
}
