import { prisma } from "@/lib/prisma";
import { closeStaleSessionIfAny } from "@/lib/services/session/sessionService";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "session_summary_non_blocking";
  const now = new Date();
  const session = await prisma.session.create({
    data: {
      userId: ctx.userId,
      personaId: ctx.personaId,
      startedAt: new Date(now.getTime() - 45 * 60 * 1000),
      lastActivityAt: new Date(now.getTime() - 31 * 60 * 1000),
      turnCount: 1,
    },
  });

  await prisma.message.create({
    data: {
      userId: ctx.userId,
      personaId: ctx.personaId,
      role: "user",
      content: "Test message for summary stall.",
      createdAt: new Date(now.getTime() - 40 * 60 * 1000),
    },
  });

  const previousStall = process.env.FEATURE_SUMMARY_TEST_STALL;
  process.env.FEATURE_SUMMARY_TEST_STALL = "true";

  const start = Date.now();
  const updated = await closeStaleSessionIfAny(ctx.userId, ctx.personaId, now);
  const elapsedMs = Date.now() - start;

  if (previousStall === undefined) {
    delete process.env.FEATURE_SUMMARY_TEST_STALL;
  } else {
    process.env.FEATURE_SUMMARY_TEST_STALL = previousStall;
  }

  const maxElapsedMs = 1500;
  return {
    name,
    ok: Boolean(updated?.endedAt) && elapsedMs < maxElapsedMs,
    evidence: {
      sessionId: session.id,
      endedAt: updated?.endedAt ?? null,
      elapsedMs,
      maxElapsedMs,
    },
  };
}
