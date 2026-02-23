/**
 * Confidence distribution report for runMemoryGate outputs in traces.
 *
 * Usage:
 *   pnpm tsx scripts/admin/gate-confidence-report.ts
 *   pnpm tsx scripts/admin/gate-confidence-report.ts --userId=cmkqxf72t0000lb04axesvlpx --limit=500
 */

import { PrismaClient } from "@prisma/client";

type ParsedRow = {
  source: "gate" | "prompt_packet";
  createdAt: Date;
  transcript: string;
  confidence: number | null;
  postureConfidence: number | null;
  stateConfidence: number | null;
  posture: string | null;
  riskLevel: string | null;
  intent: string | null;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { userId?: string; limit: number } = { limit: 2000 };
  for (const arg of args) {
    if (arg.startsWith("--userId=")) out.userId = arg.slice("--userId=".length).trim();
    if (arg.startsWith("--limit=")) {
      const value = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(value) && value > 0) out.limit = value;
    }
  }
  return out;
}

function clip(input: string, max = 120) {
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePosture(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.split("|")[0]?.trim();
  return first || null;
}

function parsePostureFromPromptPacket(memoryResponse: unknown): string | null {
  if (!memoryResponse || typeof memoryResponse !== "object" || Array.isArray(memoryResponse)) return null;
  const messages = (memoryResponse as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (const entry of messages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const role = (entry as { role?: unknown }).role;
    const content = (entry as { content?: unknown }).content;
    if (role !== "system" || typeof content !== "string") continue;
    if (!content.includes("[CONVERSATION_POSTURE]")) continue;
    const match = content.match(/Mode:\s*([A-Z_]+)\s*\(pressure:\s*([A-Z]+)\)/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function bucket(value: number): string {
  if (value >= 1) return "0.9-1.0";
  const low = Math.floor(value * 10) / 10;
  const high = Math.min(1, low + 0.1);
  return `${low.toFixed(1)}-${high.toFixed(1)}`;
}

function histogram(values: number[]) {
  const bins = new Map<string, number>();
  for (let i = 0; i < 10; i += 1) {
    const low = (i / 10).toFixed(1);
    const high = ((i + 1) / 10).toFixed(1);
    bins.set(`${low}-${high}`, 0);
  }
  for (const value of values) {
    const key = bucket(Math.max(0, Math.min(1, value)));
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(bins.entries());
}

function toBreakdown<T extends string>(rows: ParsedRow[], keyFn: (row: ParsedRow) => T | null) {
  const out = new Map<string, number>();
  for (const row of rows) {
    const key = keyFn(row) ?? "UNKNOWN";
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...out.entries()].sort((a, b) => b[1] - a[1])
  );
}

const griefRepairRegex =
  /\b(miss her|i miss|grief|guilt|shame|estranged|falling out|how do i fix|fix this|repair|apology|reconcile|made me cry|i cried|tears|broke down|funeral|lost my|olive branch|daughter)\b/i;

async function main() {
  const { userId, limit } = parseArgs();
  const prisma = new PrismaClient();
  try {
    const where = userId ? { userId } : {};
    const [gateRows, packetRows] = await Promise.all([
      prisma.librarianTrace.findMany({
        where: { ...where, kind: "gate" },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.librarianTrace.findMany({
        where: { ...where, kind: "prompt_packet" },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
    ]);

    const parsed: ParsedRow[] = [];

    for (const row of gateRows) {
      const bouncer =
        row.bouncer && typeof row.bouncer === "object" && !Array.isArray(row.bouncer)
          ? (row.bouncer as Record<string, unknown>)
          : null;
      if (!bouncer) continue;
      parsed.push({
        source: "gate",
        createdAt: row.createdAt,
        transcript: row.transcript ?? "",
        confidence: toNumber(bouncer.confidence),
        postureConfidence: toNumber(bouncer.posture_confidence),
        stateConfidence: toNumber(bouncer.state_confidence),
        posture: normalizePosture(bouncer.posture),
        riskLevel: typeof bouncer.risk_level === "string" ? bouncer.risk_level : null,
        intent: typeof bouncer.intent === "string" ? bouncer.intent : null,
      });
    }

    for (const row of packetRows) {
      const mq =
        row.memoryQuery && typeof row.memoryQuery === "object" && !Array.isArray(row.memoryQuery)
          ? (row.memoryQuery as Record<string, unknown>)
          : null;
      if (!mq) continue;
      const confidence = toNumber(mq.gate_confidence);
      const postureConfidence = toNumber(mq.posture_confidence);
      const stateConfidence = toNumber(mq.state_confidence);
      if (confidence == null && postureConfidence == null && stateConfidence == null) continue;
      parsed.push({
        source: "prompt_packet",
        createdAt: row.createdAt,
        transcript: row.transcript ?? "",
        confidence,
        postureConfidence,
        stateConfidence,
        posture: parsePostureFromPromptPacket(row.memoryResponse),
        riskLevel: typeof mq.risk_level === "string" ? mq.risk_level : null,
        intent: typeof mq.intent === "string" ? mq.intent : null,
      });
    }

    const confidenceVals = parsed.map((r) => r.confidence).filter((v): v is number => v != null);
    const postureVals = parsed
      .map((r) => r.postureConfidence)
      .filter((v): v is number => v != null);
    const stateVals = parsed.map((r) => r.stateConfidence).filter((v): v is number => v != null);

    const griefRows = parsed.filter((r) => griefRepairRegex.test(r.transcript));
    const normalRows = parsed.filter((r) => !griefRepairRegex.test(r.transcript));

    const sample = parsed
      .slice(0, 20)
      .map((r) => ({
        createdAt: r.createdAt.toISOString(),
        source: r.source,
        posture: r.posture,
        confidence: r.confidence,
        posture_confidence: r.postureConfidence,
        state_confidence: r.stateConfidence,
        transcript: clip(r.transcript),
      }));

    const output = {
      meta: {
        userId: userId ?? "ALL",
        limit,
        rows_gate: gateRows.length,
        rows_prompt_packet: packetRows.length,
        rows_with_confidence_fields: parsed.length,
      },
      histograms: {
        confidence: histogram(confidenceVals),
        posture_confidence: histogram(postureVals),
        state_confidence: histogram(stateVals),
      },
      breakdowns: {
        by_posture: toBreakdown(parsed, (r) => r.posture),
        by_risk: toBreakdown(parsed, (r) => r.riskLevel),
        by_intent: toBreakdown(parsed, (r) => r.intent),
        by_grief_repair: {
          grief_repair: griefRows.length,
          normal: normalRows.length,
        },
      },
      confidence_means: {
        overall: confidenceVals.length
          ? Number((confidenceVals.reduce((a, b) => a + b, 0) / confidenceVals.length).toFixed(4))
          : null,
        grief_repair: griefRows.length
          ? Number(
              (
                griefRows
                  .map((r) => r.confidence)
                  .filter((v): v is number => v != null)
                  .reduce((a, b) => a + b, 0) /
                Math.max(
                  1,
                  griefRows.map((r) => r.confidence).filter((v): v is number => v != null).length
                )
              ).toFixed(4)
            )
          : null,
        normal: normalRows.length
          ? Number(
              (
                normalRows
                  .map((r) => r.confidence)
                  .filter((v): v is number => v != null)
                  .reduce((a, b) => a + b, 0) /
                Math.max(
                  1,
                  normalRows.map((r) => r.confidence).filter((v): v is number => v != null).length
                )
              ).toFixed(4)
            )
          : null,
      },
      sample_rows: sample,
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[gate-confidence-report] failed", error);
  process.exit(1);
});

