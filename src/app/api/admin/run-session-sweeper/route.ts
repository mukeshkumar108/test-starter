import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
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

function toBase64Url(input: Buffer | string) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  return Buffer.from(padded, "base64");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyJwtWithKey(token: string, key: string) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const keyCandidates: Buffer[] = [Buffer.from(key, "utf8")];
  const maybeDecoded = fromBase64Url(key);
  if (maybeDecoded.length > 0 && !safeEqual(toBase64Url(maybeDecoded), toBase64Url(Buffer.from(key, "utf8")))) {
    keyCandidates.push(maybeDecoded);
  }

  return keyCandidates.some((secret) => {
    const expectedSignature = toBase64Url(
      crypto.createHmac("sha256", secret).update(signingInput).digest()
    );
    return safeEqual(encodedSignature, expectedSignature);
  });
}

async function verifyQstashSignature(request: NextRequest) {
  const signatureHeader = request.headers.get("upstash-signature");
  const currentKey = env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = env.QSTASH_NEXT_SIGNING_KEY;
  const keys = [currentKey, nextKey].filter((value): value is string => Boolean(value));
  if (!signatureHeader || keys.length === 0) {
    return false;
  }

  const token = signatureHeader.toLowerCase().startsWith("bearer ")
    ? signatureHeader.slice(7).trim()
    : signatureHeader.trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload] = parts;

  let header: { alg?: string; typ?: string } | null = null;
  let payload: { iss?: string; sub?: string; exp?: number; nbf?: number; body?: string } | null = null;
  try {
    header = JSON.parse(fromBase64Url(encodedHeader).toString("utf8"));
    payload = JSON.parse(fromBase64Url(encodedPayload).toString("utf8"));
  } catch {
    return false;
  }

  if (!header || header.alg !== "HS256") return false;
  if (!payload || payload.iss !== "Upstash") return false;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.nbf !== "number" || payload.nbf > now) return false;
  if (typeof payload.exp !== "number" || payload.exp <= now) return false;

  return keys.some((key) => verifyJwtWithKey(token, key));
}

async function handleSweep(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const secret = request.headers.get("x-admin-secret");
  const isAdminAuthorized = Boolean(env.ADMIN_SECRET && secret && secret === env.ADMIN_SECRET);
  const isVercelCron = request.headers.get("x-vercel-cron") === "1";
  const isQstashAuthorized = await verifyQstashSignature(request);
  if (!isAdminAuthorized && !isVercelCron && !isQstashAuthorized) {
    if (!env.ADMIN_SECRET && !env.QSTASH_CURRENT_SIGNING_KEY && !env.QSTASH_NEXT_SIGNING_KEY) {
      return new NextResponse("Not Found", { status: 404 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
