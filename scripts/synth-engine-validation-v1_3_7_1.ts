import { prisma } from "@/lib/prisma";
import { MemoryType } from "@prisma/client";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { createQaUser, getPersonaIdBySlug, seedMemory, cleanupQaUser } from "./regress/helpers";

async function main() {
  const user = await createQaUser("qa_engine_validation_");
  const personaId = await getPersonaIdBySlug("creative");

  try {
    await seedMemory(
      user.id,
      MemoryType.PROJECT,
      "Project: Momentum AI App",
      { source: "seeded_profile" }
    );

    const turns = [
      "Sophie, I'm feeling stuck on the visual polish for the app. The colors feel off.",
      "I think I need to talk to John about the design tokens.",
      "Actually, I'll just message him tonight at 8pm.",
      "Actually, I just messaged John. Done.",
    ];

    for (const content of turns.slice(0, 3)) {
      await prisma.message.create({
        data: {
          userId: user.id,
          personaId,
          role: "user",
          content,
        },
      });
    }

    await processShadowPath({
      userId: user.id,
      personaId,
      userMessage: turns[2],
      assistantResponse: "ok",
    });

    const todosAfterTurn3 = await prisma.todo.findMany({
      where: { userId: user.id, personaId },
      select: { content: true, kind: true, status: true },
      orderBy: { createdAt: "asc" },
    });

    const memoriesAfterTurn3 = await prisma.memory.findMany({
      where: { userId: user.id },
      select: { type: true, content: true },
      orderBy: { createdAt: "asc" },
    });

    console.log("Todos after turn 3:");
    console.log(JSON.stringify(todosAfterTurn3, null, 2));
    console.log("Memories after turn 3:");
    console.log(JSON.stringify(memoriesAfterTurn3, null, 2));

    await prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "user",
        content: turns[3],
      },
    });

    await processShadowPath({
      userId: user.id,
      personaId,
      userMessage: turns[3],
      assistantResponse: "ok",
    });

    const todosAfterTurn4 = await prisma.todo.findMany({
      where: { userId: user.id, personaId },
      select: { content: true, kind: true, status: true, completedAt: true },
      orderBy: { createdAt: "asc" },
    });

    console.log("Todos after turn 4:");
    console.log(JSON.stringify(todosAfterTurn4, null, 2));

    const context = await buildContext(user.id, personaId, turns[3]);

    const blocks = {
      commitments: context.commitments.join("\n"),
      threads: context.threads.join("\n"),
      frictions: context.frictions.join("\n"),
      recentWins: context.recentWins.join("\n"),
    };

    console.log("Injected context blocks:");
    console.log(JSON.stringify(blocks, null, 2));
  } finally {
    await cleanupQaUser(user.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
