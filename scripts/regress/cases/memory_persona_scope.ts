import { MemoryType } from "@prisma/client";
import { storeMemory, searchMemories } from "@/lib/services/memory/memoryStore";
import type { RegressContext, RegressResult } from "../types";

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const personaB = await ctx.prisma.personaProfile.findUnique({
    where: { slug: "mentor" },
    select: { id: true },
  });
  if (!personaB) {
    return {
      name: "memory_persona_scope",
      ok: false,
      evidence: { error: "Missing mentor persona" },
    };
  }

  const sharedContent = "Shared memory for personas";

  await storeMemory(
    ctx.userId,
    MemoryType.PROJECT,
    sharedContent,
    { source: "seeded_profile" },
    ctx.personaId
  );
  await storeMemory(
    ctx.userId,
    MemoryType.PROJECT,
    sharedContent,
    { source: "seeded_profile" }
  );
  await storeMemory(
    ctx.userId,
    MemoryType.PROJECT,
    sharedContent,
    { source: "seeded_profile" },
    personaB.id
  );

  const results = await searchMemories(
    ctx.userId,
    ctx.personaId,
    sharedContent,
    12
  );
  const personaIds = results.map((memory) => memory.personaId ?? null);
  const includesGlobal = personaIds.includes(null);
  const includesPersonaA = personaIds.includes(ctx.personaId);
  const includesPersonaB = personaIds.includes(personaB.id);

  return {
    name: "memory_persona_scope",
    ok: includesGlobal && includesPersonaA && !includesPersonaB,
    evidence: {
      personaIds,
      includesGlobal,
      includesPersonaA,
      includesPersonaB,
      resultCount: results.length,
    },
  };
}
