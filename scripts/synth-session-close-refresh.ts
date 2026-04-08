process.env.FEATURE_SESSION_SUMMARY = "false";
import { clearTimingProbes } from "@/lib/debug/timingProbe";
import {
  cleanupQaUser,
  createQaUser,
  getPersonaIdBySlug,
  installMockResumePacketSynapse,
  seedSessionConversation,
  summarizePacket,
  timeStep,
  waitForResumePacket,
  waitForResumePacketWithTiming,
  writeHarnessResult,
  parseBooleanFlag,
} from "./utils/resume-packet-harness";

async function main() {
  const { env } = await import("@/env");
  (env as { FEATURE_SESSION_SUMMARY?: string }).FEATURE_SESSION_SUMMARY = "false";
  const { closeSessionOnExplicitEnd } = await import("@/lib/services/session/sessionService");
  const useMockSynapse = !parseBooleanFlag(process.argv, "--live-synapse");
  const personaId = await getPersonaIdBySlug("creative");
  const user = await createQaUser("qa_resume_refresh_");
  const mock = useMockSynapse ? installMockResumePacketSynapse() : null;

  try {
    const now = new Date();
    const sessionStartedAt = new Date(now.getTime() - 12 * 60_000);
    const seed = await timeStep("seed-session", async () =>
      seedSessionConversation({
      userId: user.id,
      personaId,
      sessionStartedAt,
      now,
      messages: [
        {
          role: "user",
          content: "We should make session start continuity much faster.",
          createdAt: new Date(now.getTime() - 8 * 60_000),
        },
        {
          role: "assistant",
          content: "The right move is to precompute the continuity packet.",
          createdAt: new Date(now.getTime() - 7 * 60_000),
        },
      ],
      })
    );

    clearTimingProbes("ensureActiveSession");
    const close = await timeStep("close-session", async () =>
      closeSessionOnExplicitEnd(user.id, personaId, now)
    );
    const wait = await waitForResumePacketWithTiming({
      userId: user.id,
      personaId,
      timeoutMs: 10_000,
    });
    const packet = wait.packet;

    const result = {
      ok: Boolean(packet),
      mode: useMockSynapse ? "mock-synapse" : "live-synapse",
      timings: {
        seed_session_ms: seed.ms,
        close_session_ms: close.ms,
        wait_for_packet_ms: wait.wait_ms,
      },
      closed_session_id: close.value?.id ?? null,
      packet: summarizePacket(packet),
      counters: mock?.counters ?? null,
    };

    const outputPath = await writeHarnessResult("session-close-refresh", result);
    console.log(JSON.stringify({ ...result, output_path: outputPath }, null, 2));

    if (!packet) {
      throw new Error("resume_packet was not generated within timeout");
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
