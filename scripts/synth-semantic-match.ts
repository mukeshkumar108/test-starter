/**
 * Synth test for Curator V1: Semantic Commitment Matching
 *
 * Verifies:
 * - When deterministic keyword matching fails (score == 0)
 * - Semantic LLM fallback is used
 * - Commitment is completed with completionMethod == "semantic"
 *
 * Run with: pnpm synth:semantic-match
 */

import { prisma } from "@/lib/prisma";
import { curatorCompleteCommitment } from "@/lib/services/memory/memoryCurator";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser, seedTodo } from "./regress/helpers";
import { TodoKind } from "@prisma/client";

async function main() {
  const user = await createQaUser("qa_semantic_match_");
  const personaId = await getPersonaIdBySlug("creative");
  const errors: string[] = [];

  console.log("\n=== Semantic Commitment Matching Synth Test ===\n");
  console.log(`User ID: ${user.id}`);
  console.log(`Persona ID: ${personaId}`);

  // Enable curator and semantic test mode
  const originalCuratorFlag = process.env.FEATURE_MEMORY_CURATOR;
  const originalSemanticTestFlag = process.env.FEATURE_CURATOR_SEMANTIC_TEST;
  const originalSemanticMatch = process.env.CURATOR_SEMANTIC_TEST_MATCH;
  const originalSemanticConfidence = process.env.CURATOR_SEMANTIC_TEST_CONFIDENCE;

  process.env.FEATURE_MEMORY_CURATOR = "true";
  process.env.FEATURE_CURATOR_SEMANTIC_TEST = "true";

  try {
    // Seed multiple commitments (semantic fallback only triggers when score==0 AND multiple commitments)
    console.log("\nSeeding test data...");
    const targetTodo = await seedTodo(
      user.id,
      personaId,
      "Go for a walk",
      "PENDING",
      TodoKind.COMMITMENT
    );
    console.log(`  - Seeded: COMMITMENT 'Go for a walk' (id: ${targetTodo.id})`);

    // Add a second commitment so semantic fallback triggers (deterministic only auto-completes when single)
    await seedTodo(
      user.id,
      personaId,
      "Read a book",
      "PENDING",
      TodoKind.COMMITMENT
    );
    console.log("  - Seeded: COMMITMENT 'Read a book' (decoy for multi-commitment scenario)");

    // Set up semantic test stub to return the target commitment
    process.env.CURATOR_SEMANTIC_TEST_MATCH = targetTodo.id;
    process.env.CURATOR_SEMANTIC_TEST_CONFIDENCE = "0.9";
    console.log(`  - Configured semantic stub to match id: ${targetTodo.id} with confidence 0.9`);

    // User message that won't match deterministically
    // "Took a stroll around the block" has no keyword overlap with "Go for a walk"
    // (stroll != walk, block doesn't appear in commitment)
    const userMessage = "Took a stroll around the block";
    console.log(`\nUser message: "${userMessage}"`);
    console.log("  (No keyword overlap with 'Go for a walk' - should trigger semantic fallback)");

    // Alias for backward compatibility with rest of test
    const seededTodo = targetTodo;

    // Call curator directly (not via shadow path) for deterministic testing
    console.log("\nCalling curatorCompleteCommitment...");
    const result = await curatorCompleteCommitment(user.id, personaId, userMessage);

    console.log("\n--- Results ---");
    console.log(`completed: ${result.completed}`);
    console.log(`commitmentId: ${result.commitmentId}`);
    console.log(`completionMethod: ${result.completionMethod}`);
    console.log(`completionConfidence: ${result.completionConfidence}`);

    // Assert: Commitment was completed
    if (!result.completed) {
      errors.push("Commitment was not completed");
      console.log("[FAIL] Commitment was not completed");
    } else {
      console.log("[PASS] Commitment was completed");
    }

    // Assert: Completion method is semantic
    if (result.completionMethod !== "semantic") {
      errors.push(`Expected completionMethod='semantic', got '${result.completionMethod}'`);
      console.log(`[FAIL] Expected completionMethod='semantic', got '${result.completionMethod}'`);
    } else {
      console.log("[PASS] completionMethod is 'semantic'");
    }

    // Assert: Confidence is 0.9 (from stub)
    if (result.completionConfidence !== 0.9) {
      errors.push(`Expected completionConfidence=0.9, got ${result.completionConfidence}`);
      console.log(`[FAIL] Expected completionConfidence=0.9, got ${result.completionConfidence}`);
    } else {
      console.log("[PASS] completionConfidence is 0.9");
    }

    // Assert: CommitmentId matches seeded todo
    if (result.commitmentId !== seededTodo.id) {
      errors.push(`Expected commitmentId='${seededTodo.id}', got '${result.commitmentId}'`);
      console.log(`[FAIL] Expected commitmentId='${seededTodo.id}', got '${result.commitmentId}'`);
    } else {
      console.log("[PASS] commitmentId matches seeded todo");
    }

    // Verify the todo is actually COMPLETED in DB
    const updatedTodo = await prisma.todo.findUnique({
      where: { id: seededTodo.id },
      select: { status: true, completedAt: true },
    });

    if (updatedTodo?.status !== "COMPLETED") {
      errors.push(`Todo status in DB is '${updatedTodo?.status}', expected 'COMPLETED'`);
      console.log(`[FAIL] Todo status in DB is '${updatedTodo?.status}'`);
    } else {
      console.log("[PASS] Todo status in DB is 'COMPLETED'");
    }

    if (!updatedTodo?.completedAt) {
      errors.push("completedAt not set in DB");
      console.log("[FAIL] completedAt not set in DB");
    } else {
      console.log(`[PASS] completedAt set in DB: ${updatedTodo.completedAt.toISOString()}`);
    }

    // Check diagnostics in SessionState
    const sessionState = await prisma.sessionState.findUnique({
      where: { userId_personaId: { userId: user.id, personaId } },
      select: { state: true },
    });
    const state = sessionState?.state as Record<string, unknown> | null;

    console.log("\n--- SessionState Diagnostics ---");
    console.log(`lastCuratorSemanticAttemptAt: ${state?.lastCuratorSemanticAttemptAt ?? "not set"}`);
    console.log(`lastCuratorSemanticMatch: ${state?.lastCuratorSemanticMatch ?? "not set"}`);
    console.log(`lastCuratorSemanticConfidence: ${state?.lastCuratorSemanticConfidence ?? "not set"}`);

    if (!state?.lastCuratorSemanticAttemptAt) {
      errors.push("Diagnostic lastCuratorSemanticAttemptAt not set");
      console.log("[FAIL] lastCuratorSemanticAttemptAt not set");
    } else {
      console.log("[PASS] Diagnostics recorded in SessionState");
    }

    // Summary
    console.log("\n=== Summary ===\n");
    if (errors.length > 0) {
      console.log(`[FAIL] Semantic Match Test FAILED with ${errors.length} error(s):`);
      for (const error of errors) {
        console.log(`  - ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log("[PASS] Semantic Match Test PASSED");
    }
  } finally {
    // Restore original flags
    if (originalCuratorFlag === undefined) {
      delete process.env.FEATURE_MEMORY_CURATOR;
    } else {
      process.env.FEATURE_MEMORY_CURATOR = originalCuratorFlag;
    }
    if (originalSemanticTestFlag === undefined) {
      delete process.env.FEATURE_CURATOR_SEMANTIC_TEST;
    } else {
      process.env.FEATURE_CURATOR_SEMANTIC_TEST = originalSemanticTestFlag;
    }
    if (originalSemanticMatch === undefined) {
      delete process.env.CURATOR_SEMANTIC_TEST_MATCH;
    } else {
      process.env.CURATOR_SEMANTIC_TEST_MATCH = originalSemanticMatch;
    }
    if (originalSemanticConfidence === undefined) {
      delete process.env.CURATOR_SEMANTIC_TEST_CONFIDENCE;
    } else {
      process.env.CURATOR_SEMANTIC_TEST_CONFIDENCE = originalSemanticConfidence;
    }
    await cleanupQaUser(user.id);
    console.log("\nCleanup complete.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
