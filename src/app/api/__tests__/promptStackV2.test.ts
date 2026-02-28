/**
 * Unit tests for startbrief-v2 prompt stack ordering and exclusions.
 * Run with: pnpm tsx src/app/api/__tests__/promptStackV2.test.ts
 */

import { readFile } from "fs/promises";
import { join } from "path";
import {
  __test__applyOpsSupplementalMutualExclusion,
  __test__buildStyleGuardBlock,
  __test__buildChatMessages,
  __test__nextEndearmentCooldownTurns,
  __test__resolvePolicySkipSelection,
  __test__extractLocalTurnSignalLine,
  __test__selectUserContextCandidates,
  __test__updateRecentInjectedContextKeys,
  __test__buildStartbriefInjection,
  __test__resolveEffectiveOverlaySignals,
  __test__shouldHoldWitnessOnContinuation,
  __test__buildBouncerAuthorityTraceFields,
  __test__buildMomentumGuardBlock,
  __test__shouldInjectSignalPack,
  __test__buildContextGovernorSelection,
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
  await runTest("steering kernel replaces default clarifying-question rule with conditional trigger", async () => {
    const steering = await readFile(join(process.cwd(), "prompts/20_steering_kernel.md"), "utf-8");
    expect(steering).notToContain("If uncertain, ask one clarifying question before assuming.");
    expect(steering).toContain(
      "Default to a grounded statement. Ask a question only if it unlocks a meaningful next move or prevents a likely misread."
    );
  });

  await runTest("style kernel reflection template no longer mandates a question fork", async () => {
    const style = await readFile(join(process.cwd(), "prompts/40_style_kernel.md"), "utf-8");
    expect(style).toContain("Avoid generic interview questions; if you ask, make it narrow and consequential.");
    expect(style).toContain("- Optional: ask ONE specific question only if it changes what you'd say or do next; otherwise stop.");
    expect(style).notToContain("Optionally ask one choice question.");
    expect(style).notToContain("Want to stay with that for a second, or take one tiny next step?");
  });

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
    expect(contents[1].startsWith("[USER_CONTEXT]")).toBe(true);
    expect(contents[2].startsWith("[OVERLAY]")).toBe(true);
    expect(contents[3]).toBe("BRIDGE");
    expect(contents[4]).toBe("HANDOVER VERBATIM");
    expect(contents[5]).toBe("One useful thread to anchor on is walk daily.");
    expect(contents[6].startsWith("[SUPPLEMENTAL_CONTEXT]")).toBe(true);
    expect(contents[7]).toBe("prev");
    expect(contents[8]).toBe("current user turn");
  });

  await runTest("conversation history block combines rolling summary and raw turns", () => {
    const longSummary = `S${"x".repeat(850)}`;
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      rollingSummary: longSummary,
      recentMessages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
      transcript: "current user turn",
    });
    const contents = messages.map((message) => message.content);
    expect(contents[1].startsWith("[CONVERSATION_HISTORY]")).toBe(true);
    expect(contents[1]).toContain("\n---\n");
    expect(contents[1]).toContain("user: u1");
    expect(contents[1]).toContain("assistant: a1");
    const summaryLine = contents[1].split("\n")[1] ?? "";
    expect(summaryLine.length).toBe(803);
    expect(summaryLine.endsWith("...")).toBe(true);
  });

  await runTest("falls back to raw recent turns when rolling summary is empty", () => {
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      rollingSummary: "   ",
      recentMessages: [
        { role: "assistant", content: "prev" },
        { role: "user", content: "older user" },
      ],
      transcript: "current user turn",
    });
    const contents = messages.map((message) => message.content);
    const joined = contents.join("\n");
    expect(joined).notToContain("[CONVERSATION_HISTORY]");
    expect(contents[1]).toBe("prev");
    expect(contents[2]).toBe("older user");
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
    expect(contents[1]).toContain("Local (now): stressed lately");
    expect(contents[1]).toContain("Synapse (recent): Daily anchors");
  });

  await runTest("signal pack is not injected on session start", () => {
    const useSignalPack = __test__shouldInjectSignalPack({
      signalPackBlock: "Signal Pack (private):\n- [identity] Prefers concise responses.",
      isSessionStart: true,
      intent: "companion",
      posture: "COMPANION",
      pressure: "LOW",
      stance: "none",
      riskLevel: "LOW",
      isUrgent: false,
    });
    expect(useSignalPack).toBe(false);
  });

  await runTest("signal pack is suppressed on urgent or high-risk turns", () => {
    const urgent = __test__shouldInjectSignalPack({
      signalPackBlock: "Signal Pack (private):\n- [identity] Prefers concise responses.",
      isSessionStart: false,
      intent: "companion",
      posture: "COMPANION",
      pressure: "MED",
      stance: "none",
      riskLevel: "LOW",
      isUrgent: true,
    });
    const highRisk = __test__shouldInjectSignalPack({
      signalPackBlock: "Signal Pack (private):\n- [identity] Prefers concise responses.",
      isSessionStart: false,
      intent: "companion",
      posture: "COMPANION",
      pressure: "MED",
      stance: "none",
      riskLevel: "HIGH",
      isUrgent: false,
    });
    expect(urgent).toBe(false);
    expect(highRisk).toBe(false);
  });

  await runTest("signal pack is injected on normal non-start turns based on librarian labels", () => {
    const useSignalPack = __test__shouldInjectSignalPack({
      signalPackBlock: "Signal Pack (private):\n- [identity] Prefers concise responses.",
      isSessionStart: false,
      intent: "momentum",
      posture: "MOMENTUM",
      pressure: "MED",
      stance: "none",
      riskLevel: "LOW",
      isUrgent: false,
    });
    expect(useSignalPack).toBe(true);
  });

  await runTest("context governor suppresses overlapping signal loop classes when handover exists", () => {
    const governed = __test__buildContextGovernorSelection({
      userContextBlock: "[USER_CONTEXT]\n- Local (now): focused on this conversation.",
      signalPackBlock:
        "Signal Pack (private):\n- [open_loops] Follow up on pending item.\n- [state] Feels emotionally raw.",
      bridgeBlock: "Bridge note.",
      handoverBlock: "Handover note.",
      opsSnippetBlock: "One useful thread to anchor on is the pending item.",
      intent: "companion",
      posture: "RELATIONSHIP",
      pressure: "MED",
      stance: "none",
      riskLevel: "LOW",
    });
    expect(governed.handoverBlock ?? "").toBe("Handover note.");
    expect(governed.signalPackBlock ?? "").toContain("[state] Feels emotionally raw.");
    expect(governed.signalPackBlock ?? "").notToContain("[open_loops]");
  });

  await runTest("context governor enforces context budget", () => {
    const lineA = `A-${"x".repeat(250)}`;
    const lineB = `B-${"x".repeat(250)}`;
    const lineC = `C-${"x".repeat(250)}`;
    const lineD = `D-${"x".repeat(250)}`;
    const lineE = `E-${"x".repeat(250)}`;
    const governed = __test__buildContextGovernorSelection({
      userContextBlock: `[USER_CONTEXT]\n- ${lineA}\n- ${lineB}\n- ${lineC}\n- ${lineD}\n- ${lineE}`,
      signalPackBlock: `Signal Pack (private):\n- [identity] ${lineA}\n- [state] ${lineB}`,
      bridgeBlock: lineC,
      handoverBlock: lineD,
      opsSnippetBlock: lineE,
      intent: "momentum",
      posture: "MOMENTUM",
      pressure: "MED",
      stance: "none",
      riskLevel: "LOW",
    });
    const totalChars =
      (governed.userContextBlock?.length ?? 0) +
      (governed.signalPackBlock?.length ?? 0) +
      (governed.bridgeBlock?.length ?? 0) +
      (governed.handoverBlock?.length ?? 0) +
      (governed.opsSnippetBlock?.length ?? 0);
    expect(totalChars <= 1200).toBe(true);
    expect(governed.runtime.dropped_by_reason.budget > 0).toBe(true);
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

  await runTest("warmup grief forces witness stance", () => {
    const resolved = __test__resolvePolicySkipSelection({
      skipReason: "session_warmup",
      transcript: "I saw her face again and it made me cry",
      posture: "COMPANION",
      intent: "companion",
      explicitTopicShift: false,
      avoidanceOrDrift: false,
      openLoops: ["finish proposal"],
      commitments: [],
      recentUserMessages: ["I keep thinking about this"],
      overlayUsed: {},
      dailyFocusEligible: false,
      dailyReviewEligible: false,
      weeklyCompassEligible: false,
      hasTodayFocus: false,
      hasDailyReviewToday: false,
      hasWeeklyCompass: false,
      pressure: "MED",
      riskLevel: "LOW",
      mood: "LOW",
      tone: "SERIOUS",
      userLastTugAt: null,
      tugBackoff: {},
      now: new Date("2026-02-22T12:00:00Z"),
    });
    expect(resolved.stanceSelected).toBe("witness");
    expect(resolved.triggerReason).toBe("witness_force_during_policy_skip");
  });

  await runTest("user context rejects stopword garbage lines", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "quick check in",
      deferredProfileLines: ["People currently in focus include got and was."],
      recentInjectedContextKeys: [],
    });
    const joined = selected.map((item) => item.line).join("\n");
    expect(joined).notToContain("got and was");
  });

  await runTest("user context rejects echo local lines", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "Sophie are you still with me",
      deferredProfileLines: [],
      recentInjectedContextKeys: [],
    });
    const joined = selected.map((item) => item.line).join("\n").toLowerCase();
    expect(joined).notToContain("are you still with me");
  });

  await runTest("user context rejects short local echo lines under 40 chars", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "Sophie are you there",
      deferredProfileLines: [],
      recentInjectedContextKeys: [],
    });
    const local = selected.find((item) => item.key.startsWith("local:"));
    expect(Boolean(local)).toBe(false);
  });

  await runTest("momentum guard is absent on COMPANION posture", () => {
    const block = __test__buildMomentumGuardBlock({
      intent: "momentum",
      posture: "COMPANION",
      localHour: 10,
    });
    expect(block).toBe(null);
  });

  await runTest("trajectory candidate drops duplicate segments", () => {
    const selected = __test__selectUserContextCandidates({
      transcript: "quick check-in with real signal text here",
      deferredProfileLines: [],
      recentInjectedContextKeys: [],
      trajectory: {
        longTermDirectionLine: "Long-term direction is Walk daily.",
        workContextLine: "Current work focus is Walk daily.",
        dailyAnchorsLine: null,
        currentFocus: null,
        topLoopText: "Walk daily",
        topLoopFetchedAt: "2026-02-22T11:00:00Z",
        now: new Date("2026-02-22T12:00:00Z"),
      },
    });
    const joined = selected.map((item) => item.line).join("\n");
    expect(joined).notToContain("Trajectory:");
  });

  await runTest("witness style guard includes banned phrase list", () => {
    const block = __test__buildStyleGuardBlock({
      stance: "witness",
      endearmentCooldownTurns: 3,
    });
    expect(block).toContain("must feel");
    expect(block).toContain("that must feel");
    expect(block).toContain("No endearments");
    expect(block).notToContain("buddy");
    expect(block).notToContain("babe");
  });

  await runTest("endearment throttle enforces one allowance per 10 turns", () => {
    let cooldown = 0;
    const sequence: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      cooldown = __test__nextEndearmentCooldownTurns(cooldown, "none");
      sequence.push(cooldown);
    }
    expect(sequence[0]).toBe(10);
    expect(sequence[10]).toBe(0);
  });

  await runTest("effective signals fall back to derived when confidence is low", () => {
    const effective = __test__resolveEffectiveOverlaySignals({
      authorityRemapEnabled: true,
      transcript: "can you give me steps? anyway, new topic",
      lastTurns: ["we were talking about jasmine"],
      gateConfidence: 0.4,
      postureConfidence: 0.5,
      rawIsUrgent: false,
      rawIsDirectRequest: false,
      rawExplicitTopicShift: false,
    });
    expect(effective.isDirectRequest).toBe(true);
    expect(effective.explicitTopicShift).toBe(true);
  });

  await runTest("effective explicit topic shift requires high confidence gate", () => {
    const lowConfidence = __test__resolveEffectiveOverlaySignals({
      authorityRemapEnabled: true,
      transcript: "quick check in",
      gateConfidence: 0.6,
      postureConfidence: 0.6,
      rawIsUrgent: false,
      rawIsDirectRequest: false,
      rawExplicitTopicShift: true,
    });
    expect(lowConfidence.explicitTopicShift).toBe(false);

    const highConfidence = __test__resolveEffectiveOverlaySignals({
      authorityRemapEnabled: true,
      transcript: "quick check in",
      gateConfidence: 0.85,
      postureConfidence: 0.6,
      rawIsUrgent: false,
      rawIsDirectRequest: false,
      rawExplicitTopicShift: true,
    });
    expect(highConfidence.explicitTopicShift).toBe(true);
    expect(highConfidence.explicitTopicShiftFromHighConfidence).toBe(true);
  });

  await runTest("witness not dropped on adjacent grief continuation when effective shift is false", () => {
    const keep = __test__shouldHoldWitnessOnContinuation({
      enabled: true,
      previousStance: "witness",
      selectedStance: "none",
      transcript: "I still miss her and the grief is heavy",
      explicitTopicShiftFromHighConfidence: false,
      effectiveIsDirectRequest: false,
    });
    expect(keep).toBe(true);
  });

  await runTest("witness can be released on explicit action request with effective direct request", () => {
    const keep = __test__shouldHoldWitnessOnContinuation({
      enabled: true,
      previousStance: "witness",
      selectedStance: "none",
      transcript: "what should i do next, give me steps",
      explicitTopicShiftFromHighConfidence: false,
      effectiveIsDirectRequest: true,
    });
    expect(keep).toBe(false);
  });

  await runTest("trace authority fields include raw and effective signals when enabled", () => {
    const fields = __test__buildBouncerAuthorityTraceFields({
      shadowLogEnabled: true,
      authorityRemapEnabled: true,
      raw: {
        is_urgent: false,
        is_direct_request: false,
        explicit_topic_shift: true,
        confidence: 0.81,
        posture_confidence: 0.82,
        state_confidence: 0.71,
      },
      effective: {
        isUrgent: false,
        isDirectRequest: true,
        explicitTopicShift: true,
      },
    }) as Record<string, unknown>;
    expect(String(fields.authority_mode)).toBe("remap_v1");
    expect(Boolean(fields.bouncer_raw)).toBe(true);
    expect(Boolean(fields.effective_signals)).toBe(true);
  });

  await runTest("handover is injected verbatim", () => {
    const verbatim = "Keep this line exactly as authored by startbrief.";
    const injection = __test__buildStartbriefInjection({
      packet: {
        handover_text: verbatim,
        handover_depth: "today",
        resume: { use_bridge: false, bridge_text: null },
        time_context: {
          local_time: "13:00",
          time_of_day: "AFTERNOON",
          gap_minutes: 15,
          sessions_today: 1,
          first_session_today: true,
        },
      },
      userTurnsSeen: 0,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
      now: new Date("2026-02-28T13:00:00.000Z"),
      timeZone: "Europe/Zagreb",
    });
    const handoverBlock = injection.handoverBlock ?? "";
    expect(handoverBlock.includes(verbatim)).toBe(true);
    expect(handoverBlock.startsWith("It is 1pm on Saturday, 28 Feb.")).toBe(true);
    expect(handoverBlock.includes("Your last conversation was 15 minutes ago.")).toBe(true);
    expect(handoverBlock.includes("This is the 1st conversation today.")).toBe(true);
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
    expect((turn2.handoverBlock ?? "").includes("handover")).toBe(true);
    expect((turn3.handoverBlock ?? "").includes("handover")).toBe(true);
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
