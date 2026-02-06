import { buildContext } from "@/lib/services/memory/contextBuilder";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "context_blocks";
  const context = await buildContext(ctx.userId, ctx.personaId, "hey");

  const ok =
    typeof context.persona === "string" &&
    context.persona.length > 0 &&
    Array.isArray(context.recentMessages) &&
    context.recentMessages.length <= 6;

  return {
    name,
    ok,
    evidence: {
      recentMessages: context.recentMessages.length,
      situationalContext: context.situationalContext ?? null,
      rollingSummary: context.rollingSummary ?? null,
    },
  };
}
