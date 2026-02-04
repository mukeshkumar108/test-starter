import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { health } from "@/lib/services/synapseClient";

export async function GET(request: NextRequest) {
  if (!env.ADMIN_SECRET) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const secret = request.headers.get("x-admin-secret");
  if (!secret || secret !== env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseUrl = env.SYNAPSE_BASE_URL ?? null;
  try {
    const result = await health();
    if (!result) {
      return NextResponse.json({
        ok: false,
        baseUrl,
        status: null,
        ms: null,
        error: "health_request_failed",
      });
    }
    return NextResponse.json({
      ok: result.ok,
      baseUrl,
      status: result.status,
      ms: result.ms,
      ...(result.ok ? {} : { error: "health_status_not_ok" }),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      baseUrl,
      status: null,
      ms: null,
      error: error instanceof Error ? error.message : "health_request_failed",
    });
  }
}
