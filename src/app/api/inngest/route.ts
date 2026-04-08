import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  refreshResumePacketFunction,
  repairResumePacketsFunction,
  sessionClosedMaintenanceFunction,
} from "@/inngest/functions";

export const maxDuration = 60;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    refreshResumePacketFunction,
    sessionClosedMaintenanceFunction,
    repairResumePacketsFunction,
  ],
});
