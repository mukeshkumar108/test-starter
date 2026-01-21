import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "loop_semantics";
  const venting = "I am just venting about the kitchen mess.";
  const commitment = "I will clean the breakfast bar tonight.";

  await prisma.message.createMany({
    data: [
      {
        userId: ctx.userId,
        personaId: ctx.personaId,
        role: "user",
        content: venting,
      },
      {
        userId: ctx.userId,
        personaId: ctx.personaId,
        role: "user",
        content: commitment,
      },
    ],
  });

  await processShadowPath({
    userId: ctx.userId,
    personaId: ctx.personaId,
    userMessage: commitment,
    assistantResponse: "ok",
  });

  const todos = await prisma.todo.findMany({
    where: { userId: ctx.userId, personaId: ctx.personaId },
    select: { content: true, kind: true },
  });

  const commitmentTodo = todos.find((todo) => todo.content.toLowerCase().includes("clean the breakfast bar"));
  const ventingTodo = todos.find((todo) => todo.content.toLowerCase().includes("kitchen mess"));
  const hasCommitment = commitmentTodo?.kind === "COMMITMENT";
  const ventingIsNonCommitment = ventingTodo ? ventingTodo.kind !== "COMMITMENT" : true;

  return {
    name,
    ok: Boolean(hasCommitment) && ventingIsNonCommitment,
    evidence: {
      todos,
      commitmentTodo: commitmentTodo ?? null,
      ventingTodo: ventingTodo ?? null,
    },
  };
}
