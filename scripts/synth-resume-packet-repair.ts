process.env.FEATURE_SESSION_SUMMARY = "false";

import {
  cleanupQaUser,
  clearResumePacket,
  createQaUser,
  getPersonaIdBySlug,
  installMockResumePacketSynapse,
  parseBooleanFlag,
  readResumePacket,
  seedSessionConversation,
  summarizePacket,
  timeStep,
  waitForResumePacketWithTiming,
  writeHarnessResult,
} from "./utils/resume-packet-harness";
import { clearTimingProbes, getLatestTimingProbe } from "@/lib/debug/timingProbe";

async function main() {
  const { env } = await import("@/env");
  (env as { FEATURE_SESSION_SUMMARY?: string }).FEATURE_SESSION_SUMMARY = "false";
  const { buildContext } = await import("@/lib/services/memory/contextBuilder");
  const { closeSessionOnExplicitEnd, ensureActiveSession } = await import(
    "@/lib/services/session/sessionService"
  );
  const { refreshResumePacket } = await import("@/lib/services/session/resumePacket");

  const useMockSynapse = !parseBooleanFlag(process.argv, "--live-synapse");
  const personaId = await getPersonaIdBySlug("creative");
  const user = await createQaUser("qa_resume_repair_");
  const mock = useMockSynapse ? installMockResumePacketSynapse() : null;

  try {
    const sessionCloseTime = new Date(Date.now() - 2 * 60_000);
    const sourceSession = await seedSessionConversation({
      userId: user.id,
      personaId,
      sessionStartedAt: new Date(sessionCloseTime.getTime() - 10 * 60_000),
      now: sessionCloseTime,
      messages: [
        {
          role: "user",
          content: "We need a reliable session-start repair path if the cached packet is missing.",
          createdAt: new Date(sessionCloseTime.getTime() - 9 * 60_000),
        },
        {
          role: "assistant",
          content: "The first hi should stay fast, then the packet can be repaired and reused.",
          createdAt: new Date(sessionCloseTime.getTime() - 8 * 60_000),
        },
      ],
    });

    await closeSessionOnExplicitEnd(user.id, personaId, sessionCloseTime);
    const initialWait = await waitForResumePacketWithTiming({
      userId: user.id,
      personaId,
      timeoutMs: 10_000,
    });
    if (!initialWait.packet) {
      throw new Error("Expected initial resume_packet before repair scenario");
    }

    await clearResumePacket(user.id, personaId);
    const afterClear = await readResumePacket(user.id, personaId);
    if (afterClear) {
      throw new Error("Expected resume_packet to be cleared before repair scenario");
    }

    mock?.reset();
    clearTimingProbes("ensureActiveSession");
    const ensureFirstSession = await timeStep("ensure-first-session", async () =>
      ensureActiveSession(user.id, personaId, new Date())
    );
    const ensureFirstProbe = getLatestTimingProbe("ensureActiveSession");
    clearTimingProbes("buildContext");
    clearTimingProbes("buildContextFromSynapse");
    const lightweight = await timeStep("lightweight-buildContext", async () =>
      buildContext(user.id, personaId, "hi")
    );
    const lightweightProbes = {
      buildContext: getLatestTimingProbe("buildContext"),
      buildContextFromSynapse: getLatestTimingProbe("buildContextFromSynapse"),
    };

    const repair = await timeStep("refresh-resume-packet", async () => {
      await refreshResumePacket({
        userId: user.id,
        personaId,
        sourceSessionId: sourceSession.id,
        lastSessionEndedAt: sessionCloseTime.toISOString(),
      });
      return readResumePacket(user.id, personaId);
    });
    if (!repair.value) {
      throw new Error("Expected repair to recreate resume_packet");
    }

    const closeRepairedSession = await timeStep("close-repaired-session", async () =>
      closeSessionOnExplicitEnd(user.id, personaId, new Date())
    );
    clearTimingProbes("ensureActiveSession");
    const ensureSecondSession = await timeStep("ensure-second-session", async () =>
      ensureActiveSession(user.id, personaId, new Date(Date.now() + 5_000))
    );
    const ensureSecondProbe = getLatestTimingProbe("ensureActiveSession");
    clearTimingProbes("buildContext");
    clearTimingProbes("buildContextFromSynapse");
    const substantive = await timeStep("substantive-buildContext", async () =>
      buildContext(user.id, personaId, "Can we continue with the cached continuity plan?")
    );
    const substantiveProbes = {
      buildContext: getLatestTimingProbe("buildContext"),
      buildContextFromSynapse: getLatestTimingProbe("buildContextFromSynapse"),
    };

    const result = {
      ok: true,
      mode: useMockSynapse ? "mock-synapse" : "live-synapse",
      initial_packet: summarizePacket(initialWait.packet),
      counters: mock?.counters ?? null,
      timings: {
        initial_wait_ms: initialWait.wait_ms,
        ensure_first_session_ms: ensureFirstSession.ms,
        lightweight_build_context_ms: lightweight.ms,
        repair_ms: repair.ms,
        close_repaired_session_ms: closeRepairedSession.ms,
        ensure_second_session_ms: ensureSecondSession.ms,
        substantive_build_context_ms: substantive.ms,
      },
      ensure_first_session_probe: ensureFirstProbe,
      lightweight: {
        probes: lightweightProbes,
        is_session_start: lightweight.value.isSessionStart,
        startbrief_used: lightweight.value.startBrief?.used ?? null,
        startbrief_fetch: lightweight.value.startbriefFetch ?? null,
        bridge_text: lightweight.value.startbriefPacket?.resume?.bridge_text ?? null,
        handover_text: lightweight.value.startbriefPacket?.handover_text ?? null,
      },
      repaired_packet: summarizePacket(repair.value),
      ensure_second_session_probe: ensureSecondProbe,
      substantive: {
        probes: substantiveProbes,
        is_session_start: substantive.value.isSessionStart,
        startbrief_used: substantive.value.startBrief?.used ?? null,
        startbrief_fetch: substantive.value.startbriefFetch ?? null,
        bridge_text: substantive.value.startbriefPacket?.resume?.bridge_text ?? null,
        handover_text: substantive.value.startbriefPacket?.handover_text ?? null,
      },
    };

    const outputPath = await writeHarnessResult("resume-packet-repair", result);
    console.log(JSON.stringify({ ...result, output_path: outputPath }, null, 2));

    if (lightweight.value.startBrief?.used !== false) {
      throw new Error("Expected missing-packet lightweight greeting to avoid rich startbrief usage");
    }
    if (!lightweight.value.startbriefPacket?.resume?.bridge_text) {
      throw new Error("Expected missing-packet lightweight greeting to still expose a bridge hint");
    }
    if (substantive.value.startBrief?.used !== true) {
      throw new Error("Expected repaired packet to be reused on the next substantive session start");
    }
    if (!substantive.value.startbriefPacket?.handover_text) {
      throw new Error("Expected repaired packet reuse to include cached handover");
    }
  } finally {
    mock?.restore();
    await cleanupQaUser(user.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
