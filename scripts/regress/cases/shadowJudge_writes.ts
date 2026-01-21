import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { prisma } from "@/lib/prisma";
import { MemoryType } from "@prisma/client";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "shadowJudge_writes";
  const messages = [
    "Tomorrow 7:30am walk.",
    "Also 30 minutes exercise.",
    "I will finish the Main Chat Screen polish tonight.",
  ];

  for (const message of messages) {
    await prisma.message.create({
      data: {
        userId: ctx.userId,
        personaId: ctx.personaId,
        role: "user",
        content: message,
      },
    });
  }

  await processShadowPath({
    userId: ctx.userId,
    personaId: ctx.personaId,
    userMessage: messages[messages.length - 1],
    assistantResponse: "ok",
  });

  const todos = await prisma.todo.findMany({
    where: { userId: ctx.userId, personaId: ctx.personaId },
    select: { id: true, content: true, status: true },
  });

  const openLoopMemories = await prisma.memory.findMany({
    where: { userId: ctx.userId, type: MemoryType.OPEN_LOOP },
    select: { id: true, content: true },
  });

  const ok = todos.length >= 1 && openLoopMemories.length === 0;
  return {
    name,
    ok,
    evidence: {
      todoCount: todos.length,
      todos,
      openLoopMemoryCount: openLoopMemories.length,
      openLoopMemories,
    },
  };
}
