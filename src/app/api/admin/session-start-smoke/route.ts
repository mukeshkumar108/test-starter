import { NextRequest, NextResponse } from "next/server";

import { env } from "@/env";
import { runRemoteSessionStartSmoke } from "@/lib/admin/sessionStartSmoke";

function isAuthorized(request: NextRequest) {
  if (!env.ADMIN_SECRET) return false;
  const secret = request.headers.get("x-admin-secret");
  return Boolean(secret && secret === env.ADMIN_SECRET);
}

export async function POST(request: NextRequest) {
  if (!env.ADMIN_SECRET) {
    return new NextResponse("Not Found", { status: 404 });
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    personaSlug?: string;
    scenario?: "session-start" | "repair";
  };

  const result = await runRemoteSessionStartSmoke({
    personaSlug: body.personaSlug,
    scenario: body.scenario,
  });

  return NextResponse.json(result);
}
