process.env.FEATURE_SESSION_SUMMARY = "false";
import {
  cleanupQaUser,
  createQaUser,
  getPersonaIdBySlug,
  installMockResumePacketSynapse,
  parseBooleanFlag,
  readResumePacket,
  seedSessionConversation,
  summarizePacket,
  timeStep,
  waitForResumePacket,
  waitForResumePacketWithTiming,
  writeHarnessResult,
} from "./utils/resume-packet-harness";
import { clearTimingProbes, getLatestTimingProbe } from "@/lib/debug/timingProbe";

async function timeBuildContext(
  buildContextFn: typeof import("@/lib/services/memory/contextBuilder").buildContext,
  userId: string,
  personaId: string,
  transcript: string
) {
  clearTimingProbes("buildContext");
  clearTimingProbes("buildContextFromSynapse");
  const started = Date.now();
  const context = await buildContextFn(userId, personaId, transcript);
  const durationMs = Date.now() - started;
  return {
    context,
    durationMs,
    probes: {
      buildContext: getLatestTimingProbe("buildContext"),
      buildContextFromSynapse: getLatestTimingProbe("buildContextFromSynapse"),
    },
  };
}

async function main() {
  const { env } = await import("@/env");
  (env as { FEATURE_SESSION_SUMMARY?: string }).FEATURE_SESSION_SUMMARY = "false";
  const { buildContext } = await import("@/lib/services/memory/contextBuilder");
  const { closeSessionOnExplicitEnd, ensureActiveSession } = await import(
    "@/lib/services/session/sessionService"
  );
  const useMockSynapse = !parseBooleanFlag(process.argv, "--live-synapse");
  const personaId = await getPersonaIdBySlug("creative");
  const user = await createQaUser("qa_resume_start_");
  const mock = useMockSynapse ? installMockResumePacketSynapse() : null;

  try {
    const sessionCloseTime = new Date(Date.now() - 2 * 60_000);
    const seed = await timeStep("seed-session", async () =>
      seedSessionConversation({
      userId: user.id,
      personaId,
      sessionStartedAt: new Date(sessionCloseTime.getTime() - 10 * 60_000),
      now: sessionCloseTime,
      messages: [
        {
          role: "user",
          content: "We need fast session-start continuity without live Synapse waits.",
          createdAt: new Date(sessionCloseTime.getTime() - 9 * 60_000),
        },
        {
          role: "assistant",
          content: "Cache one resume packet and derive the handshake view at request time.",
          createdAt: new Date(sessionCloseTime.getTime() - 8 * 60_000),
        },
      ],
      })
    );

    const close = await timeStep("close-session", async () =>
      closeSessionOnExplicitEnd(user.id, personaId, sessionCloseTime)
    );
    const packetWait = await waitForResumePacketWithTiming({
      userId: user.id,
      personaId,
      timeoutMs: 10_000,
    });
    const packet = packetWait.packet;
    if (!packet) {
      throw new Error("resume_packet was not generated before session-start test");
    }

    mock?.reset();
    clearTimingProbes("ensureActiveSession");
    const ensure = await timeStep("ensure-active-session", async () =>
      ensureActiveSession(user.id, personaId, new Date())
    );
    const ensureProbe = getLatestTimingProbe("ensureActiveSession");

    const lightweight = await timeBuildContext(buildContext, user.id, personaId, "hi");
    const substantive = await timeBuildContext(
      buildContext,
      user.id,
      personaId,
      "Can we continue with the roadmap and continuity plan?"
    );
    const refreshedPacket = await readResumePacket(user.id, personaId);

    const result = {
      ok: true,
      mode: useMockSynapse ? "mock-synapse" : "live-synapse",
      packet: summarizePacket(refreshedPacket),
      counters_after_session_start: mock?.counters ?? null,
      timings: {
        seed_session_ms: seed.ms,
        close_session_ms: close.ms,
        wait_for_packet_ms: packetWait.wait_ms,
        ensure_active_session_ms: ensure.ms,
      },
      ensure_active_session_probe: ensureProbe,
      lightweight: {
        duration_ms: lightweight.durationMs,
        probes: lightweight.probes,
        is_session_start: lightweight.context.isSessionStart,
        startbrief_used: lightweight.context.startBrief?.used ?? null,
        startbrief_fetch: lightweight.context.startbriefFetch ?? null,
        bridge_text: lightweight.context.startbriefPacket?.resume?.bridge_text ?? null,
        handover_text: lightweight.context.startbriefPacket?.handover_text ?? null,
      },
      substantive: {
        duration_ms: substantive.durationMs,
        probes: substantive.probes,
        is_session_start: substantive.context.isSessionStart,
        startbrief_used: substantive.context.startBrief?.used ?? null,
        startbrief_fetch: substantive.context.startbriefFetch ?? null,
        bridge_text: substantive.context.startbriefPacket?.resume?.bridge_text ?? null,
        handover_text: substantive.context.startbriefPacket?.handover_text ?? null,
        deferred_profile_work_context:
          substantive.context.deferredProfileContext?.workContextLine ?? null,
      },
    };

    const outputPath = await writeHarnessResult("resume-packet-session-start", result);
    console.log(JSON.stringify({ ...result, output_path: outputPath }, null, 2));

    if (mock && mock.counters.startBrief !== 0) {
      throw new Error(`Expected no live startbrief fetch on cached session start, got ${mock.counters.startBrief}`);
    }
    if (lightweight.context.startBrief?.used !== false) {
      throw new Error("Expected lightweight greeting to use handshake_view only");
    }
    if (!lightweight.context.startbriefPacket?.resume?.bridge_text) {
      throw new Error("Expected lightweight greeting to expose a bridge hint");
    }
    if (substantive.context.startBrief?.used !== true) {
      throw new Error("Expected substantive first turn to use cached resume_packet");
    }
    if (!substantive.context.startbriefPacket?.handover_text) {
      throw new Error("Expected substantive first turn to include cached handover");
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
