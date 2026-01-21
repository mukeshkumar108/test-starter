import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { prisma } from "@/lib/prisma";
import { MemoryType } from "@prisma/client";
import { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "stoplist_profile";
  const message = "Hey Sophie, it's Mukesh.";

  await prisma.message.create({
    data: {
      userId: ctx.userId,
      personaId: ctx.personaId,
      role: "user",
      content: message,
    },
  });

  await processShadowPath({
    userId: ctx.userId,
    personaId: ctx.personaId,
    userMessage: message,
    assistantResponse: "ok",
  });

  const profiles = await prisma.memory.findMany({
    where: { userId: ctx.userId, type: MemoryType.PROFILE },
    select: { content: true },
  });

  const profileContents = profiles.map((profile) => profile.content.toLowerCase());
  const hasSophie = profileContents.some((content) => content.trim() === "sophie");
  const hasMukesh = profileContents.some((content) => content.includes("mukesh"));

  return {
    name,
    ok: !hasSophie && hasMukesh,
    evidence: {
      profiles,
      hasSophie,
      hasMukesh,
    },
  };
}
