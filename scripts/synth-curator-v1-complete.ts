/**
 * Synth test for Curator V1: Commitment Completion + Win Extraction
 *
 * Verifies:
 * - When user says "I did my walk today", the COMMITMENT is marked COMPLETED
 * - A Win record is created
 * - No duplicate Todos created
 *
 * Run with: pnpm synth:curator-v1-complete
 */

import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser, seedTodo } from "./regress/helpers";
import { TodoKind } from "@prisma/client";

async function main() {
  const user = await createQaUser("qa_curator_complete_");
  const personaId = await getPersonaIdBySlug("creative");
  const errors: string[] = [];

  console.log("\n=== Curator V1 Completion Synth Test ===\n");
  console.log(`User ID: ${user.id}`);
  console.log(`Persona ID: ${personaId}`);

  // Enable curator for this test
  const originalFlag = process.env.FEATURE_MEMORY_CURATOR;
  process.env.FEATURE_MEMORY_CURATOR = "true";

  try {
    // Seed a commitment to be completed
    console.log("\nSeeding test data...");
    await seedTodo(
      user.id,
      personaId,
      "Go for a walk",
      "PENDING",
      TodoKind.COMMITMENT
    );
    console.log("  - Seeded: COMMITMENT 'Go for a walk'");

    // Create message history
    await prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "user",
        content: "I did my walk today",
      },
    });
    console.log("  - Created message: 'I did my walk today'");

    // Process shadow path with completion signal
    console.log("\nProcessing shadow path with completion signal...");
    await processShadowPath({
      userId: user.id,
      personaId,
      userMessage: "I did my walk today",
      assistantResponse: "Great job!",
    });

    // Small delay to ensure async curator completes
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Get all todos
    const todos = await prisma.todo.findMany({
      where: { userId: user.id, personaId },
      select: { id: true, content: true, kind: true, status: true, dedupeKey: true, completedAt: true },
      orderBy: { createdAt: "asc" },
    });

    console.log("\n--- Results ---");
    console.log("All todos:");
    for (const todo of todos) {
      const completedInfo = todo.completedAt ? ` (completed: ${todo.completedAt.toISOString()})` : "";
      console.log(`  [${todo.kind}/${todo.status}] ${todo.content}${completedInfo}`);
    }

    // Assert: Original COMMITMENT is COMPLETED
    const completedCommitments = todos.filter(
      (t) => t.kind === "COMMITMENT" && t.status === "COMPLETED" && t.content === "Go for a walk"
    );
    if (completedCommitments.length === 0) {
      errors.push("COMMITMENT was not marked COMPLETED");
      console.log("[FAIL] COMMITMENT was not marked COMPLETED");
    } else {
      console.log("[PASS] COMMITMENT marked COMPLETED");
    }

    // Assert: A Win record exists (marked with ✓ prefix or has win dedupe key)
    const winRecords = todos.filter(
      (t) => t.content.startsWith("✓") || (t.dedupeKey && t.dedupeKey.startsWith("win:"))
    );
    if (winRecords.length === 0) {
      errors.push("No Win record was created");
      console.log("[FAIL] No Win record was created");
    } else {
      console.log(`[PASS] Win record created: ${winRecords.map((w) => w.content).join(", ")}`);
    }

    // Assert: No pending commitment for "Go for a walk" remains
    const pendingWalkCommitments = todos.filter(
      (t) =>
        t.kind === "COMMITMENT" &&
        t.status === "PENDING" &&
        t.content.toLowerCase().includes("walk")
    );
    if (pendingWalkCommitments.length > 0) {
      errors.push("PENDING walk commitment still exists");
      console.log("[FAIL] PENDING walk commitment still exists");
    } else {
      console.log("[PASS] No PENDING walk commitment remains");
    }

    // Assert: No duplicate wins
    const walkWins = winRecords.filter((w) =>
      w.content.toLowerCase().includes("walk")
    );
    if (walkWins.length > 1) {
      errors.push("Duplicate Win records created");
      console.log("[FAIL] Duplicate Win records");
    } else if (walkWins.length === 1) {
      console.log("[PASS] No duplicate Win records");
    }

    // Summary
    console.log("\n=== Summary ===\n");
    console.log(`Total todos: ${todos.length}`);
    console.log(`Completed commitments: ${completedCommitments.length}`);
    console.log(`Win records: ${winRecords.length}`);

    if (errors.length > 0) {
      console.log(`\n[FAIL] Curator V1 Completion Test FAILED with ${errors.length} error(s):`);
      for (const error of errors) {
        console.log(`  - ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n[PASS] Curator V1 Completion Test PASSED");
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
