/**
 * Unit tests for startbrief-v2 prompt stack ordering and exclusions.
 * Run with: pnpm tsx src/app/api/__tests__/promptStackV2.test.ts
 */

import {
  __test__applyOpsSupplementalMutualExclusion,
  __test__buildChatMessages,
  __test__extractLocalTurnSignalLine,
  __test__selectUserContextCandidates,
  __test__updateRecentInjectedContextKeys,
  __test__buildStartbriefInjection,
} from "../chat/route";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toContain(expected: string) {
      if (typeof actual !== "string" || !actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
      }
    },
    notToContain(expected: string) {
      if (typeof actual === "string" && actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(expected)}`);
      }
    },
  };
}

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  await runTest("message order follows final prompt stack", () => {
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      userContextBlock: "[USER_CONTEXT]\n- Daily anchors: steps goal 10,000.",
      overlayBlock: "[OVERLAY]\nOverlay behavior",
      bridgeBlock: "BRIDGE",
      handoverBlock: "HANDOVER VERBATIM",
      opsSnippetBlock: "One useful thread to anchor on is walk daily.",
      supplementalContext: "FACTS:\n- follow-up",
      recentMessages: [{ role: "assistant", content: "prev" }],
      transcript: "current user turn",
    });
    const contents = messages.map((message) => message.content);
    expect(contents[0]).toBe("PERSONA");
    expect(contents[1].startsWith("[CONVERSATION_POSTURE]")).toBe(true);
    expect(contents[2].startsWith("[USER_CONTEXT]")).toBe(true);
    expect(contents[3].startsWith("[OVERLAY]")).toBe(true);
    expect(contents[4]).toBe("BRIDGE");
    expect(contents[5]).toBe("HANDOVER VERBATIM");
    expect(contents[6]).toBe("One useful thread to anchor on is walk daily.");
    expect(contents[7].startsWith("[SUPPLEMENTAL_CONTEXT]")).toBe(true);
    expect(contents[8]).toBe("prev");
    expect(contents[9]).toBe("current user turn");
  });

  await runTest("legacy orientation blocks never appear in composed messages", () => {
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      overlayBlock: "[OVERLAY]\nOverlay behavior",
      recentMessages: [],
      transcript: "hello",
    });
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).notToContain("SITUATIONAL_CONTEXT:");
    expect(joined).notToContain("[CONTINUITY]");
    expect(joined).notToContain("SESSION FACTS:");
  });

  await runTest("local turn signal extraction captures stress, walk, and shipped push", () => {
    const line = __test__extractLocalTurnSignalLine(
      "I've been stressed lately, going for a walk, and just shipped a push."
    );
    expect(line ?? "").toBe("Local (now): stressed lately, going for a walk, just shipped a push.");
  });

  await runTest("user context block supports local + synapse line ordering", () => {
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      userContextBlock:
        "[USER_CONTEXT]\n- Local (now): stressed lately, going for a walk, just shipped a push.\n- Synapse (recent): Daily anchors: steps goal 10,000; minimum 5,000.",
      recentMessages: [],
      transcript: "current user turn",
    });
    const contents = messages.map((message) => message.content);
    expect(contents[2]).toContain("Local (now): stressed lately");
    expect(contents[2]).toContain("Synapse (recent): Daily anchors");
  });

  await runTest("magic moment is prioritized in selected user context candidates", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "I've been stressed lately and just shipped a push.",
      deferredProfileLines: ["Daily anchors: steps goal 10,000."],
      recentInjectedContextKeys: [],
    });
    expect(selected[0]?.line ?? "").toContain("Moment (salient):");
  });

  await runTest("repetition suppression drops repeated key without re-mention", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "quick check-in",
      deferredProfileLines: ["Daily anchors: steps goal 10,000."],
      recentInjectedContextKeys: ["synapse:daily_anchors"],
    });
    const joined = selected.map((item) => item.line).join("\n");
    expect(joined).notToContain("Daily anchors");
  });

  await runTest("repetition suppression allows re-mention override", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "can we revisit my steps goal today",
      deferredProfileLines: ["Daily anchors: steps goal 10,000."],
      recentInjectedContextKeys: ["synapse:daily_anchors"],
    });
    const joined = selected.map((item) => item.line).join("\n");
    expect(joined).toContain("Daily anchors");
  });

  await runTest("trajectory candidate is added when 2+ components exist", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "quick check-in",
      deferredProfileLines: [],
      recentInjectedContextKeys: [],
      trajectory: {
        longTermDirectionLine: "Long-term direction is ship a reliable memory system.",
        workContextLine: "Current work focus is prompt reliability.",
        dailyAnchorsLine: "Daily anchors: steps goal 10,000.",
        currentFocus: null,
        topLoopText: null,
        topLoopFetchedAt: null,
        now: new Date("2026-02-22T12:00:00Z"),
      },
    });
    const joined = selected.map((item) => item.line).join("\n");
    expect(joined).toContain("Trajectory: ship a reliable memory system -> prompt reliability -> steps goal 10,000.");
  });

  await runTest("trajectory is suppressed by repetition key unless re-anchored", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "quick check-in",
      deferredProfileLines: [],
      recentInjectedContextKeys: ["synapse:trajectory"],
      trajectory: {
        longTermDirectionLine: "Long-term direction is ship a reliable memory system.",
        workContextLine: "Current work focus is prompt reliability.",
        dailyAnchorsLine: null,
        currentFocus: null,
        topLoopText: "close parser bug",
        topLoopFetchedAt: "2026-02-22T11:00:00Z",
        now: new Date("2026-02-22T12:00:00Z"),
      },
    });
    const joined = selected.map((item) => item.line).join("\n");
    expect(joined).notToContain("Trajectory:");
  });

  await runTest("trajectory repetition allows explicit re-anchoring", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "can we refocus on my goal and plan for today",
      deferredProfileLines: [],
      recentInjectedContextKeys: ["synapse:trajectory"],
      trajectory: {
        longTermDirectionLine: "Long-term direction is ship a reliable memory system.",
        workContextLine: "Current work focus is prompt reliability.",
        dailyAnchorsLine: "Daily anchors: steps goal 10,000.",
        currentFocus: null,
        topLoopText: null,
        topLoopFetchedAt: null,
        now: new Date("2026-02-22T12:00:00Z"),
      },
    });
    const joined = selected.map((item) => item.line).join("\n");
    expect(joined).toContain("Trajectory:");
  });

  await runTest("trajectory is skipped when loop anchor is stale and no daily anchors", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "quick check-in",
      deferredProfileLines: [],
      recentInjectedContextKeys: [],
      trajectory: {
        longTermDirectionLine: "Long-term direction is ship a reliable memory system.",
        workContextLine: "Current work focus is prompt reliability.",
        dailyAnchorsLine: null,
        currentFocus: null,
        topLoopText: "close parser bug",
        topLoopFetchedAt: "2026-02-20T11:00:00Z",
        now: new Date("2026-02-22T12:00:00Z"),
      },
    });
    const joined = selected.map((item) => item.line).join("\n");
    expect(joined).notToContain("Trajectory:");
  });

  await runTest("recent context key buffer remains session-local and bounded", () => {
    const updated = __test__updateRecentInjectedContextKeys(
      ["a", "b", "c", "d", "e", "f"],
      ["g", "h"]
    );
    expect(updated.join(",")).toBe("c,d,e,f,g,h");
  });

  await runTest("handover is injected verbatim", () => {
    const verbatim = "Keep this line exactly as authored by startbrief.";
    const injection = __test__buildStartbriefInjection({
      packet: {
        handover_text: verbatim,
        handover_depth: "today",
        resume: { use_bridge: false, bridge_text: null },
        time_context: { gap_minutes: 15 },
      },
      userTurnsSeen: 0,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    expect(injection.handoverBlock ?? "").toBe(verbatim);
  });

  await runTest("bridge only on turn1 when use_bridge is true", () => {
    const packet = {
      handover_text: "handover",
      handover_depth: "today" as const,
      resume: { use_bridge: true, bridge_text: "bridge" },
      time_context: { gap_minutes: 30 },
    };
    const turn1 = __test__buildStartbriefInjection({
      packet,
      userTurnsSeen: 0,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    const turn2 = __test__buildStartbriefInjection({
      packet,
      userTurnsSeen: 1,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    expect(turn1.bridgeBlock ?? "").toBe("bridge");
    expect(turn2.bridgeBlock).toBe(null);
  });

  await runTest("handover persists beyond turn1 across the session", () => {
    const packet = {
      handover_text: "handover",
      handover_depth: "today" as const,
      resume: { use_bridge: false, bridge_text: null },
      time_context: { gap_minutes: 30 },
    };
    const turn2 = __test__buildStartbriefInjection({
      packet,
      userTurnsSeen: 1,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    const turn3 = __test__buildStartbriefInjection({
      packet,
      userTurnsSeen: 2,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    expect(turn2.handoverBlock).toBe("handover");
    expect(turn3.handoverBlock).toBe("handover");
  });

  await runTest("supplemental context suppresses ops snippet", () => {
    const withSupplemental = __test__applyOpsSupplementalMutualExclusion(
      "One useful thread is walk daily.",
      "FACTS:\n- reminder"
    );
    const withoutSupplemental = __test__applyOpsSupplementalMutualExclusion(
      "One useful thread is walk daily.",
      null
    );
    expect(withSupplemental).toBe(null);
    expect(withoutSupplemental).toBe("One useful thread is walk daily.");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nPrompt stack v2 tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Prompt stack v2 tests passed.");
}

main();
