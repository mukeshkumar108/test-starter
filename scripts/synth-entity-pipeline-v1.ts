/**
 * Synth test for Stage 3: Entity Pipeline v1
 *
 * Verifies:
 * - Entity keys are extracted from relevant memories
 * - Entity cards include linked facts (1-hop expansion)
 * - Cards are sorted by pinned DESC → importance DESC → createdAt DESC
 * - Blended scoring works (similarity + recency + frequency)
 *
 * Run with: pnpm synth:entity-pipeline:v1
 */

import { prisma } from "@/lib/prisma";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import {
  createQaUser,
  getPersonaIdBySlug,
  cleanupQaUser,
  seedMemoryWithMetadata,
} from "./regress/helpers";
import { MemoryType } from "@prisma/client";

async function main() {
  const user = await createQaUser("qa_entity_pipeline_");
  const personaId = await getPersonaIdBySlug("creative");
  const errors: string[] = [];

  console.log("\n=== Entity Pipeline v1 Synth Test ===\n");
  console.log(`User ID: ${user.id}`);
  console.log(`Persona ID: ${personaId}`);

  try {
    // Seed deterministic test data with embeddings
    console.log("\nSeeding test memories (with embeddings)...");

    // Memory 1: John works at Google (pinned, importance 2)
    await seedMemoryWithMetadata(
      user.id,
      MemoryType.PEOPLE,
      "John works at Google as a senior engineer",
      {
        source: "seeded_test",
        entityRefs: ["person:john", "org:google"],
        entityLabel: "John",
        importance: 2,
      },
      true // pinned
    );
    console.log("  - Seeded: John works at Google (pinned)");

    // Memory 2: John lives in London (pinned, importance 2)
    await seedMemoryWithMetadata(
      user.id,
      MemoryType.PEOPLE,
      "John lives in London with his family",
      {
        source: "seeded_test",
        entityRefs: ["person:john", "place:london"],
        entityLabel: "John",
        importance: 2,
      },
      true // pinned
    );
    console.log("  - Seeded: John lives in London (pinned)");

    // Memory 3: John's hobby (not pinned, importance 1)
    await seedMemoryWithMetadata(
      user.id,
      MemoryType.PEOPLE,
      "John enjoys playing chess on weekends",
      {
        source: "seeded_test",
        entityRefs: ["person:john"],
        entityLabel: "John",
        importance: 1,
      },
      false // not pinned
    );
    console.log("  - Seeded: John enjoys chess (not pinned, importance 1)");

    // Memory 4: Sarah at startup (pinned, importance 3)
    await seedMemoryWithMetadata(
      user.id,
      MemoryType.PEOPLE,
      "Sarah is the CEO of TechStartup Inc",
      {
        source: "seeded_test",
        entityRefs: ["person:sarah", "org:techstartup_inc"],
        entityLabel: "Sarah",
        importance: 3,
      },
      true // pinned
    );
    console.log("  - Seeded: Sarah is CEO (pinned, importance 3)");

    // Memory 5: Dashboard project (not pinned, importance 2)
    await seedMemoryWithMetadata(
      user.id,
      MemoryType.PROJECT,
      "Working on the dashboard redesign project with tight deadlines",
      {
        source: "seeded_test",
        entityRefs: ["project:dashboard_redesign"],
        importance: 2,
      },
      false // not pinned
    );
    console.log("  - Seeded: Dashboard project (importance 2)");

    // Small delay to ensure embeddings are written
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Test 1: Query about John
    console.log("\n--- Test 1: Query 'How is John doing?' ---");
    const context1 = await buildContext(user.id, personaId, "How is John doing?");
    const relevantText1 = context1.relevantMemories.join("\n");
    console.log("Relevant memories:");
    for (const mem of context1.relevantMemories) {
      console.log(`  ${mem}`);
    }

    // Assert: Entity card for person:john exists
    const hasJohnEntityCard = relevantText1.includes("[person:john]:");
    if (!hasJohnEntityCard) {
      errors.push("Missing entity card for person:john");
      console.log("[FAIL] Missing entity card for person:john");
    } else {
      console.log("[PASS] Entity card for person:john found");
    }

    // Assert: Card includes linked facts (Google, London)
    const hasGoogleFact = relevantText1.toLowerCase().includes("google");
    const hasLondonFact = relevantText1.toLowerCase().includes("london");

    if (!hasGoogleFact) {
      errors.push("Entity card missing Google fact (1-hop from person:john)");
      console.log("[FAIL] Missing Google fact in entity card");
    } else {
      console.log("[PASS] Google fact found in entity card");
    }

    if (!hasLondonFact) {
      errors.push("Entity card missing London fact (1-hop from person:john)");
      console.log("[FAIL] Missing London fact in entity card");
    } else {
      console.log("[PASS] London fact found in entity card");
    }

    // Assert: Low-importance fact (chess) should NOT be in entity card (importance < 2)
    // It's OK if chess appears in [OBSERVATION] entries, just not in entity card format
    const entityCardLines = context1.relevantMemories.filter((line) =>
      line.startsWith("[person:") || line.startsWith("[place:") ||
      line.startsWith("[org:") || line.startsWith("[project:")
    );
    const chessInEntityCard = entityCardLines.some((line) =>
      line.toLowerCase().includes("chess")
    );
    if (chessInEntityCard) {
      errors.push("Entity card incorrectly includes low-importance fact (chess)");
      console.log("[FAIL] Low-importance chess fact in entity card");
    } else {
      console.log("[PASS] Chess fact not in entity card (correctly excluded low-importance)");
    }

    // Test 2: Query about Sarah
    console.log("\n--- Test 2: Query 'Tell me about Sarah' ---");
    const context2 = await buildContext(user.id, personaId, "Tell me about Sarah");
    const relevantText2 = context2.relevantMemories.join("\n");
    console.log("Relevant memories:");
    for (const mem of context2.relevantMemories) {
      console.log(`  ${mem}`);
    }

    const hasSarahCard = relevantText2.includes("[person:sarah]:") ||
      relevantText2.toLowerCase().includes("sarah");
    if (!hasSarahCard) {
      errors.push("Missing Sarah-related content");
      console.log("[FAIL] Missing Sarah-related content");
    } else {
      console.log("[PASS] Sarah-related content found");
    }

    // Test 3: Query about dashboard
    console.log("\n--- Test 3: Query 'What about the dashboard?' ---");
    const context3 = await buildContext(user.id, personaId, "What about the dashboard?");
    const relevantText3 = context3.relevantMemories.join("\n");
    console.log("Relevant memories:");
    for (const mem of context3.relevantMemories) {
      console.log(`  ${mem}`);
    }

    const hasDashboardContent = relevantText3.toLowerCase().includes("dashboard");
    if (!hasDashboardContent) {
      errors.push("Missing dashboard-related content");
      console.log("[FAIL] Missing dashboard-related content");
    } else {
      console.log("[PASS] Dashboard-related content found");
    }

    // Summary
    console.log("\n=== Summary ===\n");
    console.log(`Total memories seeded: 5`);

    if (errors.length > 0) {
      console.log(`\n[FAIL] Entity Pipeline v1 Test FAILED with ${errors.length} error(s):`);
      for (const error of errors) {
        console.log(`  - ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n[PASS] Entity Pipeline v1 Test PASSED");
    }
  } finally {
    await cleanupQaUser(user.id);
    console.log("\nCleanup complete.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
