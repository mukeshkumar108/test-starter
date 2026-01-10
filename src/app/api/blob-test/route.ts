import { auth } from "@clerk/nextjs/server";
import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { env } from "@/env";

export const runtime = "nodejs";

export async function POST() {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  void env.BLOB_READ_WRITE_TOKEN;

  const blob = await put("hello.txt", "hello from nextstarter", {
    access: "public",
    addRandomSuffix: true,
  });

  return NextResponse.json({ url: blob.url });
}
