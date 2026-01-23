import { buildContext } from "@/lib/services/memory/contextBuilder";
import { searchMemories } from "@/lib/services/memory/memoryStore";
import { seedMemory, seedTodo } from "../helpers";
import { MemoryType } from "@prisma/client";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "context_caps";
  for (let i = 0; i < 12; i += 1) {
    await seedMemory(
      ctx.userId,
      i % 3 === 0 ? MemoryType.PROFILE : i % 3 === 1 ? MemoryType.PEOPLE : MemoryType.PROJECT,
      `Seed memory ${i}`,
      { source: "seeded_profile" }
    );
  }

  for (let i = 0; i < 4; i += 1) {
    await seedTodo(ctx.userId, ctx.personaId, `Commitment ${i}`, "PENDING", "COMMITMENT");
  }
  for (let i = 0; i < 4; i += 1) {
    await seedTodo(ctx.userId, ctx.personaId, `Thread ${i}`, "PENDING", "THREAD");
  }
  for (let i = 0; i < 4; i += 1) {
    await seedTodo(ctx.userId, ctx.personaId, `Friction ${i}`, "PENDING", "FRICTION");
  }

  const context = await buildContext(ctx.userId, ctx.personaId, "hello");
  const relevant = await searchMemories(ctx.userId, ctx.personaId, "hello", 12);
  const allowedTypes = new Set(["PROFILE", "PEOPLE", "PROJECT"]);
  const onlyAllowedTypes = relevant.every((memory) => allowedTypes.has(memory.type));

  const ok =
    context.relevantMemories.length <= 8 &&
    context.commitments.length <= 5 &&
    context.threads.length <= 3 &&
    context.frictions.length <= 3 &&
    onlyAllowedTypes;

  return {
    name,
    ok,
    evidence: {
      relevantCount: context.relevantMemories.length,
      commitmentsCount: context.commitments.length,
      threadsCount: context.threads.length,
      frictionsCount: context.frictions.length,
      relevantTypes: relevant.map((memory) => memory.type),
    },
  };
}
