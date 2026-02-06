import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { prisma } from "@/lib/prisma";

function getLimit(params: URLSearchParams) {
  const raw = params.get("limit");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 200);
}

function isAuthorized(request: NextRequest) {
  if (!env.ADMIN_API_KEY) return false;
  const key = request.headers.get("x-admin-key");
  return Boolean(key && key === env.ADMIN_API_KEY);
}

export async function GET(request: NextRequest) {
  if (!env.ADMIN_API_KEY) {
    return new NextResponse("Not Found", { status: 404 });
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId") || undefined;
  const personaId = searchParams.get("personaId") || undefined;
  const sessionId = searchParams.get("sessionId") || undefined;
  const onlyFailures = searchParams.get("onlyFailures") === "1";
  const includeText = searchParams.get("includeText") === "1";
  const limit = getLimit(searchParams);

  const rows = await prisma.synapseIngestTrace.findMany({
    where: {
      ...(userId ? { userId } : {}),
      ...(personaId ? { personaId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(onlyFailures ? { ok: false } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const data = rows.map((row) => ({
    ...row,
    error: includeText ? row.error : null,
  }));

  return NextResponse.json({
    count: data.length,
    data,
  });
}
