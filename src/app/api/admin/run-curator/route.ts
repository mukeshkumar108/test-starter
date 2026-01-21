import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { runCuratorBatch, runCuratorForUser } from "@/lib/services/memory/memoryCurator";

export async function POST(request: NextRequest) {
  if (!env.ADMIN_SECRET) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const secret = request.headers.get("x-admin-secret");
  if (!secret || secret !== env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (env.FEATURE_MEMORY_CURATOR !== "true") {
    return NextResponse.json({ ok: false, reason: "Feature disabled" }, { status: 200 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  const limit = searchParams.get("limitUsers");

  if (userId) {
    const result = await runCuratorForUser(userId);
    return NextResponse.json({ ok: true, result });
  }

  const limitUsers = limit ? Number.parseInt(limit, 10) : 25;
  const result = await runCuratorBatch(Number.isNaN(limitUsers) ? 25 : limitUsers);
  return NextResponse.json({ ok: true, result });
}
