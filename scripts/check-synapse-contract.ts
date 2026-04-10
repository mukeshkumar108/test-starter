/**
 * Lightweight contract checker for Synapse endpoints used by Sophie backend.
 *
 * Usage:
 *   pnpm tsx scripts/check-synapse-contract.ts --tenantId=<id> --userId=<id> [--personaId=<id>] [--sessionId=<id>] [--timezone=Europe/Zagreb]
 */

import { env } from "@/env";

function arg(name: string) {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: boolean, message: string) {
  if (!condition) fail(message);
}

function isIsoStringOrNull(value: unknown) {
  return value === null || typeof value === "string";
}

async function main() {
  const baseUrl = env.SYNAPSE_BASE_URL;
  const tenantId = arg("tenantId") ?? env.SYNAPSE_TENANT_ID ?? null;
  const userId = arg("userId");
  const personaId = arg("personaId");
  const sessionId = arg("sessionId");
  const timezone = arg("timezone") ?? "Europe/Zagreb";

  if (!baseUrl) fail("Missing SYNAPSE_BASE_URL");
  if (!tenantId) fail("Missing tenantId (pass --tenantId or set SYNAPSE_TENANT_ID)");
  if (!userId) fail("Missing userId (pass --userId)");

  const now = new Date().toISOString();

  const startParams = new URLSearchParams({ tenantId, userId, timezone, now });
  if (personaId) startParams.set("personaId", personaId);
  if (sessionId) startParams.set("sessionId", sessionId);

  const startRes = await fetch(`${baseUrl}/session/startbrief?${startParams.toString()}`);
  if (!startRes.ok) {
    const body = await startRes.text();
    fail(`/session/startbrief failed: ${startRes.status} ${body}`);
  }
  const startData = (await startRes.json()) as Record<string, unknown>;

  assert("timeOfDayLabel" in startData, "startbrief missing timeOfDayLabel");
  assert("timeGapHuman" in startData, "startbrief missing timeGapHuman");
  assert("bridgeText" in startData, "startbrief missing bridgeText");
  assert(Array.isArray(startData.items), "startbrief items must be an array");
  assert(isIsoStringOrNull(startData.timeGapHuman), "startbrief timeGapHuman must be string|null");
  assert(isIsoStringOrNull(startData.bridgeText), "startbrief bridgeText must be string|null");

  for (const [index, item] of (startData.items as unknown[]).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`startbrief items[${index}] must be object`);
    }
    const row = item as Record<string, unknown>;
    assert(typeof row.kind === "string", `startbrief items[${index}].kind must be string`);
    assert(typeof row.text === "string", `startbrief items[${index}].text must be string`);
    assert(isIsoStringOrNull(row.dueDate), `startbrief items[${index}].dueDate must be string|null`);
    assert(isIsoStringOrNull(row.lastSeenAt), `startbrief items[${index}].lastSeenAt must be string|null`);
  }

  const memoryRes = await fetch(`${baseUrl}/memory/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantId,
      userId,
      query: "what should we follow up on next",
      limit: 10,
      memoryIntent: "hybrid",
      referenceTime: now,
      includeContext: false,
    }),
  });

  if (!memoryRes.ok) {
    const body = await memoryRes.text();
    fail(`/memory/query failed: ${memoryRes.status} ${body}`);
  }
  const memoryData = (await memoryRes.json()) as Record<string, unknown>;

  assert(Array.isArray(memoryData.facts), "memory/query facts must be array");
  assert(Array.isArray(memoryData.factItems), "memory/query factItems must be array");
  assert(Array.isArray(memoryData.entities), "memory/query entities must be array");
  assert(Array.isArray(memoryData.episodes), "memory/query episodes must be array");
  assert("metadata" in memoryData, "memory/query missing metadata");

  const metadata = (memoryData.metadata ?? {}) as Record<string, unknown>;
  assert(
    metadata.memoryIntent === "exact" ||
      metadata.memoryIntent === "episodic" ||
      metadata.memoryIntent === "hybrid" ||
      metadata.memoryIntent === undefined,
    "memory/query metadata.memoryIntent must be exact|episodic|hybrid when present"
  );
  assert(
    metadata.responseMode === "recall" ||
      metadata.responseMode === "context" ||
      metadata.responseMode === undefined,
    "memory/query metadata.responseMode must be recall|context when present"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        startbrief: {
          items: (startData.items as unknown[]).length,
          hasBridgeText: typeof startData.bridgeText === "string" && startData.bridgeText.length > 0,
          timeOfDayLabel: startData.timeOfDayLabel ?? null,
        },
        memoryQuery: {
          facts: (memoryData.facts as unknown[]).length,
          factItems: (memoryData.factItems as unknown[]).length,
          entities: (memoryData.entities as unknown[]).length,
          episodes: (memoryData.episodes as unknown[]).length,
          memoryIntent: metadata.memoryIntent ?? null,
          responseMode: metadata.responseMode ?? null,
          episodicWeakRecall:
            typeof metadata.episodicWeakRecall === "boolean" ? metadata.episodicWeakRecall : null,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[synapse.contract-check] failed", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
