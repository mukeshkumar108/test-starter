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

  for (let i = 0; i < 10; i += 1) {
    await seedTodo(ctx.userId, ctx.personaId, `Todo item ${i}`);
  }

  const context = await buildContext(ctx.userId, ctx.personaId, "hello");
  const relevant = await searchMemories(ctx.userId, "hello", 12);
  const allowedTypes = new Set(["PROFILE", "PEOPLE", "PROJECT"]);
  const onlyAllowedTypes = relevant.every((memory) => allowedTypes.has(memory.type));

  const ok =
    context.relevantMemories.length <= 8 &&
    context.activeTodos.length <= 5 &&
    onlyAllowedTypes;

  return {
    name,
    ok,
    evidence: {
      relevantCount: context.relevantMemories.length,
      activeTodosCount: context.activeTodos.length,
      relevantTypes: relevant.map((memory) => memory.type),
    },
  };
}
