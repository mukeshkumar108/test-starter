import { NextRequest, NextResponse } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { env } from "@/env";
import { upsertUser } from "@/lib/user";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();

  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(request, {
      signingSecret: env.CLERK_WEBHOOK_SECRET,
    });
  } catch (error) {
    console.error("[clerk-webhook] invalid signature", { requestId, error });
    return NextResponse.json(
      { error: "invalid signature", requestId },
      { status: 401 },
    );
  }

  try {
    if (!event?.type || !event?.data) {
      return NextResponse.json(
        { error: "bad payload", requestId },
        { status: 400 },
      );
    }

    if (event.type === "user.created") {
      const data = event.data as {
        id?: string;
        email_addresses?: Array<{ email_address?: string }>;
      };

      if (!data.id) {
        return NextResponse.json(
          { error: "bad payload", requestId },
          { status: 400 },
        );
      }

      const email = data.email_addresses?.[0]?.email_address ?? null;
      await upsertUser({ clerkUserId: data.id, email });
    }

    return NextResponse.json({ ok: true, requestId });
  } catch (error) {
    console.error("[clerk-webhook] unhandled error", { requestId, error });
    return NextResponse.json(
      { error: "internal error", requestId },
      { status: 500 },
    );
  }
}
