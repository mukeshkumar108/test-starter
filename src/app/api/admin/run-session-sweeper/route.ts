import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { closeInactiveSessionsBatch } from "@/lib/services/session/sessionService";

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value: string | null) {
  if (!value) return false;
  const lowered = value.trim().toLowerCase();
  return lowered === "1" || lowered === "true" || lowered === "yes";
}

function getCloseInactiveSessionsBatch() {
  const override = (globalThis as { __closeInactiveSessionsBatchOverride?: typeof closeInactiveSessionsBatch })
    .__closeInactiveSessionsBatchOverride;
  return typeof override === "function" ? override : closeInactiveSessionsBatch;
}

async function handleSweep(request: NextRequest) {
  const secret = request.headers.get("x-admin-secret");
  const isAdminAuthorized = Boolean(env.ADMIN_SECRET && secret && secret === env.ADMIN_SECRET);
  const isVercelCron = request.headers.get("x-vercel-cron") === "1";
  if (!isAdminAuthorized && !isVercelCron) {
    if (!env.ADMIN_SECRET) {
      return new NextResponse("Not Found", { status: 404 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const inactivityMinutes = parsePositiveInt(searchParams.get("inactivityMinutes"), 10);
  const limit = parsePositiveInt(searchParams.get("limit"), 100);
  const dryRun = parseBoolean(searchParams.get("dryRun"));

  const result = await getCloseInactiveSessionsBatch()({
    inactivityMs: inactivityMinutes * 60_000,
    limit,
    dryRun,
  });

  return NextResponse.json({
    ok: true,
    inactivityMinutes,
    limit,
    dryRun,
    result,
  });
}

export async function GET(request: NextRequest) {
  return handleSweep(request);
}

export async function POST(request: NextRequest) {
  return handleSweep(request);
}
