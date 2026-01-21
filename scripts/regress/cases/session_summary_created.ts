import { prisma } from "@/lib/prisma";
import { ensureActiveSession } from "@/lib/services/session/sessionService";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "session_summary_created";
  const previousFlag = process.env.FEATURE_SESSION_SUMMARY;
  process.env.FEATURE_SESSION_SUMMARY = "true";
  const now = new Date();
  const initial = await ensureActiveSession(ctx.userId, ctx.personaId, now);

  const startedAt = new Date(Date.now() - 40 * 60 * 1000);
  const lastActivityAt = new Date(Date.now() - 31 * 60 * 1000);

  await prisma.session.update({
    where: { id: initial.id },
    data: { startedAt, lastActivityAt },
  });

  const messageTimes = [
    new Date(Date.now() - 39 * 60 * 1000),
    new Date(Date.now() - 38 * 60 * 1000),
    new Date(Date.now() - 37 * 60 * 1000),
    new Date(Date.now() - 36 * 60 * 1000),
  ];

  const messages = [
    { role: "user" as const, content: "Text Ashley about the fight." },
    { role: "assistant" as const, content: "Ok." },
    { role: "user" as const, content: "Tomorrow 7:30am walk." },
    { role: "assistant" as const, content: "Got it." },
  ];

  for (let i = 0; i < messages.length; i += 1) {
    await prisma.message.create({
      data: {
        userId: ctx.userId,
        personaId: ctx.personaId,
        role: messages[i].role,
        content: messages[i].content,
        createdAt: messageTimes[i],
      },
    });
  }

  await ensureActiveSession(ctx.userId, ctx.personaId, new Date());

  let summary = await prisma.sessionSummary.findUnique({
    where: { sessionId: initial.id },
  });

  const start = Date.now();
  while (!summary && Date.now() - start < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    summary = await prisma.sessionSummary.findUnique({
      where: { sessionId: initial.id },
    });
  }

  if (previousFlag === undefined) {
    delete process.env.FEATURE_SESSION_SUMMARY;
  } else {
    process.env.FEATURE_SESSION_SUMMARY = previousFlag;
  }

  const context = await buildContext(ctx.userId, ctx.personaId, "hey");

  const ok = Boolean(summary?.summary) && Boolean(context.sessionSummary);

  return {
    name,
    ok,
    evidence: {
      sessionId: initial.id,
      summary: summary?.summary ?? null,
      injectedSessionSummary: context.sessionSummary ?? null,
      waitedMs: Date.now() - start,
    },
  };
}
