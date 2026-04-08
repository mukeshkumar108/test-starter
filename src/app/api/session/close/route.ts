import { NextRequest, NextResponse } from "next/server";
import { auth, verifyToken } from "@clerk/nextjs/server";

import { env } from "@/env";
import { closeCurrentSessionForClerkUser } from "@/lib/services/session/closeCurrentSession";

async function resolveClerkUserId(request: NextRequest) {
  const { userId: cookieUserId } = await auth();
  if (cookieUserId) return cookieUserId;

  const authHeader =
    request.headers.get("authorization") || request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!bearerToken) return null;

  try {
    const verified = await verifyToken(bearerToken, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    return verified?.sub ?? null;
  } catch (error) {
    console.warn("Bearer token verification failed:", error);
    return null;
  }
}

export async function POST(request: NextRequest) {
  const clerkUserId = await resolveClerkUserId(request);
  if (!clerkUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    personaId?: string;
  } | null;
  const personaId = typeof body?.personaId === "string" ? body.personaId.trim() : "";

  if (!personaId) {
    return NextResponse.json({ error: "Missing personaId" }, { status: 400 });
  }

  const result = await closeCurrentSessionForClerkUser({
    clerkUserId,
    personaId,
  });

  return NextResponse.json(result);
}
