import { inngest } from "@/inngest/client";
import { refreshResumePacket, repairResumePackets } from "@/lib/services/session/resumePacket";
import { runSessionClosedMaintenance } from "@/lib/services/session/sessionService";

export const refreshResumePacketFunction = inngest.createFunction(
  {
    id: "refresh-resume-packet",
    triggers: [{ event: "app/resume-packet.refresh.requested" }],
  },
  async ({ event, step }) => {
    const functionStartedAtMs = Date.now();
    console.log("[resume.packet.function.start]", {
      userId: event.data.userId,
      personaId: event.data.personaId,
      sourceSessionId: event.data.sourceSessionId ?? null,
      lastSessionEndedAt: event.data.lastSessionEndedAt ?? null,
      reason: event.data.reason ?? null,
    });
    await step.run("refresh-resume-packet", async () => {
      await refreshResumePacket({
        userId: event.data.userId,
        personaId: event.data.personaId,
        sourceSessionId: event.data.sourceSessionId ?? null,
        lastSessionEndedAt: event.data.lastSessionEndedAt ?? null,
        reason: event.data.reason ?? null,
      });
      return { ok: true };
    });

    console.log("[resume.packet.function.done]", {
      userId: event.data.userId,
      personaId: event.data.personaId,
      sourceSessionId: event.data.sourceSessionId ?? null,
      lastSessionEndedAt: event.data.lastSessionEndedAt ?? null,
      reason: event.data.reason ?? null,
      total_ms: Date.now() - functionStartedAtMs,
    });

    return { ok: true };
  }
);

export const sessionClosedMaintenanceFunction = inngest.createFunction(
  {
    id: "session-closed-maintenance",
    triggers: [{ event: "app/session.closed" }],
  },
  async ({ event, step }) => {
    const functionStartedAtMs = Date.now();
    console.log("[session.closed.function.start]", {
      sessionId: event.data.sessionId,
      userId: event.data.userId,
      personaId: event.data.personaId,
      endedAt: event.data.endedAt,
    });
    await step.run("run-session-closed-maintenance", async () => {
      await runSessionClosedMaintenance({
        id: event.data.sessionId,
        userId: event.data.userId,
        personaId: event.data.personaId,
        startedAt: new Date(event.data.startedAt),
        endedAt: new Date(event.data.endedAt),
        lastActivityAt: new Date(event.data.lastActivityAt),
      });
      return { ok: true };
    });

    console.log("[session.closed.function.done]", {
      sessionId: event.data.sessionId,
      userId: event.data.userId,
      personaId: event.data.personaId,
      endedAt: event.data.endedAt,
      total_ms: Date.now() - functionStartedAtMs,
    });

    return { ok: true };
  }
);

export const repairResumePacketsFunction = inngest.createFunction(
  {
    id: "repair-resume-packets",
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) => {
    const result = await step.run("repair-resume-packets", async () => {
      return repairResumePackets({ limit: 25 });
    });

    return { ok: true, ...result };
  }
);
