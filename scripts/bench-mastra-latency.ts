import "dotenv/config";

import crypto from "node:crypto";

import { env } from "@/env";
import { loadCreativeKernelByFiles } from "@/lib/prompts/personaPromptLoader";
import { runMastraTurn } from "@/mastra/runMastraTurn";

type BenchmarkCase = {
  name: string;
  message: string;
};

type CliOptions = {
  userId: string;
  model: string;
  repeat: number;
};

function parseArgs(argv: string[]): CliOptions {
  let userId = "cmkqxf72t0000lb04axesvlpx";
  let model = env.MASTRA_ORCHESTRATION_MODEL?.trim() || "x-ai/grok-4.1-fast";
  let repeat = 1;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user-id") {
      userId = argv[i + 1] ?? userId;
      i += 1;
      continue;
    }
    if (arg === "--model") {
      model = argv[i + 1] ?? model;
      i += 1;
      continue;
    }
    if (arg === "--repeat") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) repeat = parsed;
      i += 1;
      continue;
    }
  }

  return { userId, model, repeat };
}

const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    name: "no_tool_companion",
    message: "I’m feeling pretty good today. The sun is out and I think the system is getting better.",
  },
  {
    name: "memory_recall",
    message: "Do you remember why I went to hospital a couple of weeks ago?",
  },
  {
    name: "web_lookup",
    message: "What are the latest news headlines for today, Wednesday the 8th of April, 2026?",
  },
  {
    name: "emotional_no_tool",
    message: "I think I’m still hurting about Ashley and I don’t really know what to do with that.",
  },
];

async function main() {
  const options = parseArgs(process.argv);
  const instructions = await loadCreativeKernelByFiles({
    files: [
      "00_model_kernel.md",
      "10_identity_kernel.md",
      "20_steering_kernel.md",
      "30_product_kernel.md",
      "40_style_kernel.md",
    ],
  });

  const runs: Array<Record<string, unknown>> = [];

  for (let iteration = 0; iteration < options.repeat; iteration += 1) {
    for (const benchCase of BENCHMARK_CASES) {
      const requestId = crypto.randomUUID();
      const result = await runMastraTurn({
        userId: options.userId,
        requestId,
        now: new Date(),
        chosenModel: options.model,
        instructions,
        messages: [{ role: "user", content: benchCase.message }],
      });

      const row = {
        iteration: iteration + 1,
        case: benchCase.name,
        model_used: result.modelUsed,
        memory_tool_used: result.memoryToolUsed,
        memory_tool_query: result.memoryToolQuery,
        web_tool_used: result.webToolUsed,
        web_tool_query: result.webToolQuery,
        mastra_total_ms: result.timings.mastra_total_ms,
        prefetch_ms: result.timings.prefetch_ms,
        memory_prefetch_ms: result.timings.memory_prefetch_ms,
        web_prefetch_ms: result.timings.web_prefetch_ms,
        final_generation_ms: result.timings.final_generation_ms,
        assistant_chars: result.assistantText.length,
      };
      runs.push(row);
      console.log(JSON.stringify(row));
    }
  }

  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of runs) {
    const key = String(row.case);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  console.log("\nAverages:");
  for (const [key, rows] of grouped.entries()) {
    const avg = (field: keyof (typeof rows)[number]) =>
      Math.round(
        rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0) / Math.max(1, rows.length)
      );
    console.log(
      JSON.stringify({
        case: key,
        runs: rows.length,
        avg_mastra_total_ms: avg("mastra_total_ms"),
        avg_prefetch_ms: avg("prefetch_ms"),
        avg_memory_prefetch_ms: avg("memory_prefetch_ms"),
        avg_web_prefetch_ms: avg("web_prefetch_ms"),
        avg_final_generation_ms: avg("final_generation_ms"),
      })
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
