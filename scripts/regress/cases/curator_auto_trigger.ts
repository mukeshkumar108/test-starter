import { prisma } from "@/lib/prisma";
import { autoCurateMaybe } from "@/lib/services/memory/memoryCurator";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "curator_auto_trigger";

  await prisma.todo.create({
    data: {
      userId: ctx.userId,
      personaId: ctx.personaId,
      content: "Commitment should remain",
      status: "PENDING",
      kind: "COMMITMENT",
    },
  });

  const now = new Date();
  const seededContent = "Seeded profile truth";

  await prisma.memory.create({
    data: {
      userId: ctx.userId,
      type: "PROFILE",
      content: seededContent,
      metadata: { source: "seeded_profile" },
    },
  });

  for (let i = 0; i < 30; i += 1) {
    await prisma.memory.create({
      data: {
        userId: ctx.userId,
        type: "PEOPLE",
        content: i % 2 === 0 ? "Ashley is stressed" : "Ashley is stressed",
        metadata: { source: "shadow_extraction", entity: "Ashley" },
      },
    });
  }

  await prisma.memory.create({
    data: {
      userId: ctx.userId,
      type: "PROFILE",
      content: seededContent,
      metadata: { source: "shadow_extraction" },
    },
  });

  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId: ctx.userId, personaId: ctx.personaId } },
    update: { state: { curator: { lastRunAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() } } },
    create: {
      userId: ctx.userId,
      personaId: ctx.personaId,
      state: { curator: { lastRunAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() } },
    },
  });

  const todosBefore = await prisma.todo.count({ where: { userId: ctx.userId } });
  const result = await autoCurateMaybe(ctx.userId, ctx.personaId);
  const todosAfter = await prisma.todo.count({ where: { userId: ctx.userId } });

  const archivedCandidates = await prisma.memory.findMany({
    where: { userId: ctx.userId },
    select: { id: true, content: true, metadata: true },
  });
  const archived = archivedCandidates.filter((memory) => {
    const meta = memory.metadata as { status?: string; source?: string } | null;
    return meta?.status === "ARCHIVED";
  });

  const seededArchived = archived.some((memory) => memory.content === seededContent && (memory.metadata as any)?.source === "seeded_profile");

  return {
    name,
    ok: todosBefore === todosAfter && !seededArchived,
    evidence: {
      result,
      todosBefore,
      todosAfter,
      archivedCount: archived.length,
      seededArchived,
    },
  };
}
