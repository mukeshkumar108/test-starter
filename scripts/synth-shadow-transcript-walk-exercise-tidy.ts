import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser } from "./regress/helpers";

async function main() {
  const user = await createQaUser("qa_shadow_transcript_");
  const personaId = await getPersonaIdBySlug("creative");

  const turn1 = "I wake up, I go on the computer, I get stuck there, I don't get out for a walk until 2-3. If I don't go on a walk, mentally I get stuck.";
  const turn2 = "Daily I need 15 minutes tidying. I want to add 30 minutes exercise.";
  const turn3 = "Tomorrow morning: I must do a walk before midday. Home by 11am. Before end of day: 20 minutes exercise + 15 minutes tidying.";

  try {
    process.env.FEATURE_JUDGE_TEST_MODE = "false";

    await prisma.message.createMany({
      data: [
        { userId: user.id, personaId, role: "user", content: turn1 },
        { userId: user.id, personaId, role: "user", content: turn2 },
        { userId: user.id, personaId, role: "user", content: turn3 },
      ],
    });

    await processShadowPath({
      userId: user.id,
      personaId,
      userMessage: turn1,
      assistantResponse: "ok",
    });

    await processShadowPath({
      userId: user.id,
      personaId,
      userMessage: turn2,
      assistantResponse: "ok",
    });

    await processShadowPath({
      userId: user.id,
      personaId,
      userMessage: turn3,
      assistantResponse: "ok",
    });

    const todos = await prisma.todo.findMany({
      where: { userId: user.id, personaId },
      select: { content: true, kind: true, status: true, dedupeKey: true },
      orderBy: { createdAt: "asc" },
    });

    const memories = await prisma.memory.findMany({
      where: { userId: user.id },
      select: { type: true, content: true },
      orderBy: { createdAt: "asc" },
    });

    const hasCommitment = todos.some((todo) => todo.kind === "COMMITMENT");
    const hasHabit = todos.some((todo) => todo.kind === "HABIT");
    const hasFriction = todos.some((todo) => todo.kind === "FRICTION");
    const hasVagueFriction = todos.some((todo) =>
      /things to address/i.test(todo.content)
    );
    const hasJohnMemory = memories.some((memory) => /john/i.test(memory.content));

    console.log("Todos:");
    console.log(JSON.stringify(todos, null, 2));
    console.log("Memories:");
    console.log(JSON.stringify(memories, null, 2));

    const ok = hasCommitment && hasHabit && hasFriction && !hasVagueFriction && !hasJohnMemory;
    if (!ok) {
      console.error("QA FAILED", {
        hasCommitment,
        hasHabit,
        hasFriction,
        hasVagueFriction,
        hasJohnMemory,
      });
      process.exitCode = 1;
    } else {
      console.log("QA PASSED");
    }
  } finally {
    await cleanupQaUser(user.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
