/**
 * Synth test for Curator V1: Habit Promotion
 *
 * Verifies:
 * - When user says "I want to walk every day", a HABIT is created
 * - No duplicate COMMITMENT remains
 *
 * Run with: pnpm synth:curator-v1-habits
 */

import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser, seedTodo } from "./regress/helpers";
import { TodoKind } from "@prisma/client";

async function main() {
  const user = await createQaUser("qa_curator_habits_");
  const personaId = await getPersonaIdBySlug("creative");
  const errors: string[] = [];

  console.log("\n=== Curator V1 Habits Synth Test ===\n");
  console.log(`User ID: ${user.id}`);
  console.log(`Persona ID: ${personaId}`);

  // Enable curator for this test
  const originalFlag = process.env.FEATURE_MEMORY_CURATOR;
  process.env.FEATURE_MEMORY_CURATOR = "true";

  try {
    // Seed a commitment that will be promoted to habit
    console.log("\nSeeding test data...");
    await seedTodo(
      user.id,
      personaId,
      "Go for a walk",
      "PENDING",
      TodoKind.COMMITMENT
    );
    console.log("  - Seeded: COMMITMENT 'Go for a walk'");

    // Create message history for shadow path
    await prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "user",
        content: "I want to walk every day",
      },
    });
    console.log("  - Created message: 'I want to walk every day'");

    // Process shadow path with recurrence signal
    console.log("\nProcessing shadow path with recurrence signal...");
    await processShadowPath({
      userId: user.id,
      personaId,
      userMessage: "I want to walk every day",
      assistantResponse: "That's a great goal!",
    });

    // Wait for async curator to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Get all todos
    const todos = await prisma.todo.findMany({
      where: { userId: user.id, personaId },
      select: { id: true, content: true, kind: true, status: true, dedupeKey: true },
      orderBy: { createdAt: "asc" },
    });

    console.log("\n--- Results ---");
    console.log("All todos:");
    for (const todo of todos) {
      console.log(`  [${todo.kind}/${todo.status}] ${todo.content}`);
    }

    // Assert: A HABIT exists
    const habits = todos.filter((t) => t.kind === "HABIT");
    if (habits.length === 0) {
      errors.push("No HABIT was created");
      console.log("[FAIL] No HABIT was created");
    } else {
      console.log(`[PASS] HABIT created: ${habits.map((h) => h.content).join(", ")}`);
    }

    // Assert: Original COMMITMENT is not still pending
    const pendingCommitments = todos.filter(
      (t) => t.kind === "COMMITMENT" && t.status === "PENDING" && t.content === "Go for a walk"
    );
    if (pendingCommitments.length > 0) {
      errors.push("Original COMMITMENT still pending (should be COMPLETED)");
      console.log("[FAIL] Original COMMITMENT still pending");
    } else {
      console.log("[PASS] Original COMMITMENT is not pending");
    }

    // Assert: No duplicate habits
    const walkHabits = habits.filter((h) =>
      h.content.toLowerCase().includes("walk")
    );
    if (walkHabits.length > 1) {
      errors.push("Duplicate HABIT entries created");
      console.log("[FAIL] Duplicate HABIT entries");
    } else if (walkHabits.length === 1) {
      console.log("[PASS] No duplicate HABIT entries");
    }

    // Summary
    console.log("\n=== Summary ===\n");
    console.log(`Total todos: ${todos.length}`);
    console.log(`Habits: ${habits.length}`);

    if (errors.length > 0) {
      console.log(`\n[FAIL] Curator V1 Habits Test FAILED with ${errors.length} error(s):`);
      for (const error of errors) {
        console.log(`  - ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n[PASS] Curator V1 Habits Test PASSED");
    }
  } finally {
    // Restore original flag
    if (originalFlag === undefined) {
      delete process.env.FEATURE_MEMORY_CURATOR;
    } else {
      process.env.FEATURE_MEMORY_CURATOR = originalFlag;
    }
    await cleanupQaUser(user.id);
    console.log("\nCleanup complete.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
