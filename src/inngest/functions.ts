import { inngest } from "@/inngest/client";
import { refreshResumePacket } from "@/lib/services/session/resumePacket";

export const refreshResumePacketFunction = inngest.createFunction(
  {
    id: "refresh-resume-packet",
    triggers: [{ event: "app/resume-packet.refresh.requested" }],
  },
  async ({ event, step }) => {
    await step.run("refresh-resume-packet", async () => {
      await refreshResumePacket({
        userId: event.data.userId,
        personaId: event.data.personaId,
        sourceSessionId: event.data.sourceSessionId ?? null,
        lastSessionEndedAt: event.data.lastSessionEndedAt ?? null,
      });
      return { ok: true };
    });

    return { ok: true };
  }
);
