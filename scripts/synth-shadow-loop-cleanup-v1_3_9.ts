import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser } from "./regress/helpers";

async function main() {
  const user = await createQaUser("qa_shadow_loop_cleanup_");
  const personaId = await getPersonaIdBySlug("creative");

  const turn1 = "I wake up, I go on the computer, I get stuck there, I don't get out for a walk until 2-3. If I don't go on a walk, mentally I get stuck.";
  const turn2 = "Daily I need 15 minutes tidying. I want to add 20 minutes exercise daily.";
  const turn3 = "Tomorrow morning: I must do a walk before midday. Home by 11am.";

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

    const commitmentCount = todos.filter((todo) => todo.kind === "COMMITMENT").length;
    const habitCount = todos.filter((todo) => todo.kind === "HABIT").length;
    const frictionCount = todos.filter((todo) => todo.kind === "FRICTION").length;
    const hasVagueFriction = todos.some((todo) =>
      /things need to be addressed|address some things/i.test(todo.content)
    );
    const hasPeopleMemory = memories.some((memory) => memory.type === "PEOPLE");

    console.log("Extracted loops (todos):");
    console.log(JSON.stringify(todos, null, 2));
    console.log("Memories:");
    console.log(JSON.stringify(memories, null, 2));

    const ok =
      commitmentCount >= 1 &&
      habitCount >= 2 &&
      frictionCount >= 1 &&
      !hasVagueFriction &&
      !hasPeopleMemory;

    if (!ok) {
      console.error("QA FAILED", {
        commitmentCount,
        habitCount,
        frictionCount,
        hasVagueFriction,
        hasPeopleMemory,
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
