import { buildContext } from "@/lib/services/memory/contextBuilder";
import type { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const personaB = await ctx.prisma.personaProfile.findUnique({
    where: { slug: "mentor" },
    select: { id: true },
  });
  if (!personaB) {
    return {
      name: "persona_message_isolation",
      ok: false,
      evidence: { error: "Missing mentor persona" },
    };
  }

  await ctx.prisma.message.createMany({
    data: [
      {
        userId: ctx.userId,
        personaId: ctx.personaId,
        role: "user",
        content: "persona-a-user",
      },
      {
        userId: ctx.userId,
        personaId: ctx.personaId,
        role: "assistant",
        content: "persona-a-assistant",
      },
      {
        userId: ctx.userId,
        personaId: personaB.id,
        role: "user",
        content: "persona-b-user",
      },
      {
        userId: ctx.userId,
        personaId: null,
        role: "user",
        content: "persona-null-user",
      },
    ],
  });

  const context = await buildContext(ctx.userId, ctx.personaId, "hey");
  const contents = context.recentMessages.map((message) => message.content);
  const includesPersonaA =
    contents.includes("persona-a-user") && contents.includes("persona-a-assistant");
  const includesPersonaB = contents.includes("persona-b-user");
  const includesNull = contents.includes("persona-null-user");

  return {
    name: "persona_message_isolation",
    ok: includesPersonaA && !includesPersonaB && !includesNull,
    evidence: {
      recentMessages: contents,
      includesPersonaA,
      includesPersonaB,
      includesNull,
    },
  };
}
