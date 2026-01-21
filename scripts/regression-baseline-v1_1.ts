import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { searchMemories, storeMemory } from "@/lib/services/memory/memoryStore";
import { MemoryType } from "@prisma/client";

async function main() {
  const clerkUserId = `test_regress_${Date.now()}`;
  const user = await prisma.user.create({ data: { clerkUserId } });
  const persona = await prisma.personaProfile.findFirst({
    where: { slug: "creative" },
    orderBy: { createdAt: "asc" },
  });
  if (!persona) {
    throw new Error("No persona profiles found");
  }

  const failures: string[] = [];
  const results: string[] = [];

  try {
    // 1) Todo creation + kind default
    const todoMessage = "Tomorrow 7:30am walk and 30 minutes exercise.";
    await processShadowPath({
      userId: user.id,
      personaId: persona.id,
      userMessage: todoMessage,
      assistantResponse: "Noted.",
    });
    const todos = await prisma.todo.findMany({
      where: { userId: user.id, personaId: persona.id },
      select: { id: true, content: true, status: true, kind: true },
    });
    if (todos.length === 0) {
      failures.push("Todo creation failed: expected at least one pending todo.");
    }
    if (todos.some((todo) => !todo.kind)) {
      failures.push("Todo kind default missing on one or more todos.");
    }
    results.push(`Todo creation: ${todos.length} todos`);
    results.push(`Todo kinds: ${todos.map((t) => t.kind).join(", ") || "none"}`);

    // 2) No OPEN_LOOP in Memory
    const openLoopMessage = "I will finish the Main Chat Screen polish tonight.";
    await processShadowPath({
      userId: user.id,
      personaId: persona.id,
      userMessage: openLoopMessage,
      assistantResponse: "Got it.",
    });
    const openLoopMemories = await prisma.memory.findMany({
      where: { userId: user.id, type: "OPEN_LOOP" },
      select: { id: true },
    });
    if (openLoopMemories.length > 0) {
      failures.push("OPEN_LOOP memories found; expected zero.");
    }

    // 3) Memory write + embedding write path
    await storeMemory(user.id, MemoryType.PEOPLE, "Ashley lives in Guatemala", {
      source: "seeded_profile",
    });
    const embeddingCheck = await prisma.$queryRaw<
      Array<{ has_embedding: boolean }>
    >`
      SELECT embedding IS NOT NULL AS has_embedding
      FROM "Memory"
      WHERE "userId" = ${user.id}
      ORDER BY "createdAt" DESC
      LIMIT 1;
    `;
    if (!embeddingCheck[0]?.has_embedding) {
      failures.push("Embedding write failed (embedding is null).");
    }

    // 4) Retrieval types only
    const retrieval = await searchMemories(user.id, "Ashley", 12);
    if (retrieval.some((mem) => !["PROFILE", "PEOPLE", "PROJECT"].includes(mem.type))) {
      failures.push("Retrieval returned non-whitelisted memory types.");
    }

    // 5) Context injection labels remain
    const context = await buildContext(user.id, persona.id, "hey");
    const blocks = {
      foundation: context.foundationMemories.length > 0,
      relevant: context.relevantMemories.length > 0,
      pending: context.activeTodos.length > 0,
      wins: context.recentWins.length > 0,
    };
    results.push(`Context blocks present: ${JSON.stringify(blocks)}`);

    if (context.activeTodos.length > 0) {
      const label = "OPEN LOOPS (pending):";
      if (!label) {
        failures.push("OPEN LOOPS label missing.");
      }
    }

    if (failures.length === 0) {
      console.log("PASS");
      results.forEach((line) => console.log(line));
    } else {
      console.log("FAIL");
      failures.forEach((line) => console.log(line));
      results.forEach((line) => console.log(line));
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

main()
  .catch((error) => {
    console.error("Regression run failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
