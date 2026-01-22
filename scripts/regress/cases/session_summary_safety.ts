import { prisma } from "@/lib/prisma";
import { ensureActiveSession } from "@/lib/services/session/sessionService";
import { RegressContext, RegressResult } from "../types";

function buildLongCommitments(count: number) {
  return Array.from({ length: count }, (_, i) => `Commitment ${i + 1}`).join(", ");
}

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "session_summary_safety";
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

  const longCommitments = buildLongCommitments(40);
  const messages = [
    { role: "user" as const, content: `Here are my commitments: ${longCommitments}.` },
    { role: "assistant" as const, content: "Sophie here. Got it." },
    { role: "user" as const, content: "I need to keep momentum." },
  ];

  const messageTimes = [
    new Date(Date.now() - 39 * 60 * 1000),
    new Date(Date.now() - 38 * 60 * 1000),
    new Date(Date.now() - 37 * 60 * 1000),
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

  let parsed: any = null;
  let parseOk = false;
  let hasSophie = false;
  let oneLinerOk = false;

  if (summary?.summary) {
    try {
      parsed = JSON.parse(summary.summary);
      parseOk = true;
      const people = Array.isArray(parsed?.people) ? parsed.people : [];
      hasSophie = people.some((person: string) => /\bsophie\b/i.test(person));
      const oneLiner = typeof parsed?.one_liner === "string" ? parsed.one_liner : "";
      oneLinerOk = Boolean(oneLiner) && !/^[{\[]/.test(oneLiner.trim());
    } catch {
      parseOk = false;
    }
  }

  const ok = Boolean(summary?.summary) && parseOk && !hasSophie && oneLinerOk;

  return {
    name,
    ok,
    evidence: {
      sessionId: initial.id,
      summary: summary?.summary ?? null,
      parseOk,
      hasSophie,
      oneLinerOk,
    },
  };
}
