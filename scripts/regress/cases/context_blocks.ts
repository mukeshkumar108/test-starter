import { buildContext } from "@/lib/services/memory/contextBuilder";
import { seedTodo } from "../helpers";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "context_blocks";
  await seedTodo(ctx.userId, ctx.personaId, "Commitment A", "PENDING", "COMMITMENT");
  await seedTodo(ctx.userId, ctx.personaId, "Thread A", "PENDING", "THREAD");
  await seedTodo(ctx.userId, ctx.personaId, "Friction A", "PENDING", "FRICTION");

  const context = await buildContext(ctx.userId, ctx.personaId, "hey");

  const commitmentHasThread = context.commitments.some((item) => item.toLowerCase().includes("thread"));
  const commitmentHasFriction = context.commitments.some((item) => item.toLowerCase().includes("friction"));

  const ok =
    context.commitments.length <= 5 &&
    context.threads.length <= 3 &&
    context.frictions.length <= 3 &&
    !commitmentHasThread &&
    !commitmentHasFriction;

  return {
    name,
    ok,
    evidence: {
      commitments: context.commitments,
      threads: context.threads,
      frictions: context.frictions,
    },
  };
}
