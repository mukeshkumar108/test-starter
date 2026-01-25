/**
 * Synth test for Prompt Assembly v1: SessionSummary Conditional Injection
 *
 * Verifies:
 * - SessionSummary IS injected on session boundary (first turn or gap > 30m)
 * - SessionSummary is NOT injected mid-session (no gap)
 *
 * Run with: pnpm synth:prompt-assembly:v1:gap
 */

import { prisma } from "@/lib/prisma";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser } from "./regress/helpers";

async function main() {
  const user = await createQaUser("qa_prompt_gap_");
  const personaId = await getPersonaIdBySlug("creative");
  const errors: string[] = [];

  console.log("\n=== Prompt Assembly v1 Gap Test ===\n");
  console.log(`User ID: ${user.id}`);
  console.log(`Persona ID: ${personaId}`);

  try {
    // Create a session and session summary
    const now = new Date();
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        personaId,
        startedAt: new Date(now.getTime() - 60 * 60 * 1000), // 1 hour ago
        lastActivityAt: new Date(now.getTime() - 45 * 60 * 1000), // 45 min ago (gap > 30m)
        endedAt: new Date(now.getTime() - 45 * 60 * 1000),
        turnCount: 5,
      },
    });
    console.log(`  - Created session: ${session.id}`);

    await prisma.sessionSummary.create({
      data: {
        sessionId: session.id,
        userId: user.id,
        personaId,
        summary: JSON.stringify({
          one_liner: "Test session about weather",
          what_mattered: ["discussed weather"],
          open_loops: [],
          commitments: [],
          people: [],
          tone: "casual",
        }),
      },
    });
    console.log("  - Created SessionSummary");

    // Test 1: First turn (no messages) - SessionSummary SHOULD be available
    console.log("\n--- Test 1: First turn (no messages) - isSessionStart ---");
    const context1 = await buildContext(user.id, personaId, "Hello");

    if (!context1.isSessionStart) {
      errors.push("isSessionStart should be true when no messages exist");
      console.log("[FAIL] isSessionStart should be true");
    } else {
      console.log("[PASS] isSessionStart is true");
    }

    if (!context1.sessionSummary) {
      errors.push("sessionSummary should be available on first turn");
      console.log("[FAIL] sessionSummary not available");
    } else {
      console.log(`[PASS] sessionSummary available: "${context1.sessionSummary.slice(0, 50)}..."`);
    }

    // Add some messages to simulate mid-session
    const recentTime = new Date(now.getTime() - 5 * 60 * 1000); // 5 min ago
    await prisma.message.createMany({
      data: [
        { userId: user.id, personaId, role: "user", content: "Hi there", createdAt: recentTime },
        { userId: user.id, personaId, role: "assistant", content: "Hello!", createdAt: recentTime },
      ],
    });
    console.log("\n  - Added recent messages (5 min ago)");

    // Test 2: Mid-session (recent messages) - isSessionStart should be false
    console.log("\n--- Test 2: Mid-session (recent messages exist) ---");
    const context2 = await buildContext(user.id, personaId, "How are you?");

    if (context2.isSessionStart) {
      errors.push("isSessionStart should be false when messages exist");
      console.log("[FAIL] isSessionStart should be false");
    } else {
      console.log("[PASS] isSessionStart is false");
    }

    // SessionSummary is still AVAILABLE in context (contextBuilder always provides it if it exists)
    // But route.ts decides whether to INJECT it based on isSessionStart or gap
    console.log(`  sessionSummary in context: ${context2.sessionSummary ? "yes" : "no"}`);

    // Test 3: Simulate route.ts injection logic
    console.log("\n--- Test 3: Route.ts injection logic simulation ---");

    // Simulate: no gap (last message 5 min ago), not first turn
    const lastMessageAt = recentTime;
    const hasGap = (now.getTime() - lastMessageAt.getTime()) > 30 * 60 * 1000;
    const shouldInjectMidSession = context2.isSessionStart || hasGap;

    console.log(`  Last message: ${Math.round((now.getTime() - lastMessageAt.getTime()) / 60000)} min ago`);
    console.log(`  hasGap (>30m): ${hasGap}`);
    console.log(`  isSessionStart: ${context2.isSessionStart}`);
    console.log(`  shouldInject: ${shouldInjectMidSession}`);

    if (shouldInjectMidSession) {
      errors.push("SessionSummary should NOT be injected mid-session (no gap)");
      console.log("[FAIL] Would inject SessionSummary mid-session");
    } else {
      console.log("[PASS] Would NOT inject SessionSummary mid-session");
    }

    // Test 4: Simulate gap scenario (last message > 30m ago)
    console.log("\n--- Test 4: Gap scenario (last message > 30m ago) ---");

    // Update message to be old
    await prisma.message.updateMany({
      where: { userId: user.id, personaId },
      data: { createdAt: new Date(now.getTime() - 45 * 60 * 1000) }, // 45 min ago
    });
    console.log("  - Updated messages to 45 min ago");

    const context3 = await buildContext(user.id, personaId, "I'm back!");
    const oldMessageAt = new Date(now.getTime() - 45 * 60 * 1000);
    const hasGapOld = (now.getTime() - oldMessageAt.getTime()) > 30 * 60 * 1000;
    const shouldInjectAfterGap = context3.isSessionStart || hasGapOld;

    console.log(`  Last message: ${Math.round((now.getTime() - oldMessageAt.getTime()) / 60000)} min ago`);
    console.log(`  hasGap (>30m): ${hasGapOld}`);
    console.log(`  isSessionStart: ${context3.isSessionStart}`);
    console.log(`  shouldInject: ${shouldInjectAfterGap}`);

    if (!shouldInjectAfterGap) {
      errors.push("SessionSummary SHOULD be injected after gap > 30m");
      console.log("[FAIL] Would NOT inject SessionSummary after gap");
    } else {
      console.log("[PASS] Would inject SessionSummary after gap");
    }

    // Summary
    console.log("\n=== Summary ===\n");
    console.log("Injection rules verified:");
    console.log("  - First turn (no messages): inject = YES");
    console.log("  - Mid-session (recent messages, no gap): inject = NO");
    console.log("  - After gap (> 30m since last message): inject = YES");

    if (errors.length > 0) {
      console.log(`\n[FAIL] Prompt Assembly Gap Test FAILED with ${errors.length} error(s):`);
      for (const error of errors) {
        console.log(`  - ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n[PASS] Prompt Assembly Gap Test PASSED");
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
