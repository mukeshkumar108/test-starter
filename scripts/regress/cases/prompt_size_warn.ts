import { buildContext } from "@/lib/services/memory/contextBuilder";
import { getChatModelForPersona } from "@/lib/providers/models";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "prompt_size_warn";
  const context = await buildContext(ctx.userId, ctx.personaId, "hey");
  const model = getChatModelForPersona("creative");

  const messages = [
    { role: "system" as const, content: context.persona },
    ...(context.situationalContext
      ? [
          {
            role: "system" as const,
            content: `SITUATIONAL_CONTEXT:\n${context.situationalContext}`,
          },
        ]
      : []),
    ...(context.rollingSummary
      ? [
          {
            role: "system" as const,
            content: `CURRENT SESSION SUMMARY: ${context.rollingSummary}`,
          },
        ]
      : []),
    ...context.recentMessages,
    { role: "user" as const, content: "hey" },
  ];

  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const ok = totalChars <= 20_000;

  return {
    name,
    ok,
    evidence: {
      model,
      totalChars,
      messageCount: messages.length,
      warning: ok ? null : "Prompt exceeds 20,000 chars",
    },
  };
}
