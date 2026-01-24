import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { MemoryType } from "@prisma/client";
import { canonicalizeEntityRefs } from "@/lib/services/memory/entityNormalizer";

const CONFIRM = process.env.BACKFILL_DEDUPE_CONFIRM === "true";
const BATCH_SIZE = Number.parseInt(process.env.BACKFILL_DEDUPE_BATCH_SIZE ?? "200", 10);
const GROUP_LIMIT = Number.parseInt(process.env.BACKFILL_DEDUPE_GROUP_LIMIT ?? "200", 10);

type MemoryRow = {
  id: string;
  userId: string;
  type: MemoryType;
  content: string;
  metadata: unknown;
  createdAt: Date;
  pinned: boolean;
  memoryKey: string | null;
};

function normalizeMemoryContent(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:'"(){}\[\]\\\/]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function computeMemoryKey(type: MemoryType, content: string, metadata: Record<string, unknown>) {
  const entityRefs = Array.isArray(metadata.entityRefs) ? (metadata.entityRefs as string[]) : [];
  const primaryRef = entityRefs[0] ?? `content:${normalizeMemoryContent(content)}`;
  const subtype = (metadata.subtype && typeof metadata.subtype === "object"
    ? (metadata.subtype as Record<string, unknown>)
    : {});
  const factType = typeof subtype.factType === "string" ? subtype.factType : "fact";
  const entityType = typeof subtype.entityType === "string" ? subtype.entityType : "none";
  return `${type.toLowerCase()}|${entityType}|${primaryRef}|${factType}`;
}

function mergeMetadata(rows: MemoryRow[]) {
  const merged: Record<string, unknown> = {};
  const entityRefs = new Set<string>();
  let maxImportance = 1;
  let mentionCount = 0;

  for (const row of rows) {
    const metadata = (row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {});
    const refs = Array.isArray(metadata.entityRefs) ? (metadata.entityRefs as string[]) : [];
    for (const ref of refs) {
      entityRefs.add(ref);
    }

    const importance =
      typeof metadata.importance === "number" && Number.isFinite(metadata.importance)
        ? Math.round(metadata.importance as number)
        : 1;
    maxImportance = Math.max(maxImportance, importance);

    const count =
      typeof metadata.mentionCount === "number" && Number.isFinite(metadata.mentionCount)
        ? (metadata.mentionCount as number)
        : 1;
    mentionCount += count;
  }

  if (entityRefs.size > 0) {
    merged.entityRefs = canonicalizeEntityRefs(Array.from(entityRefs));
  }
  merged.importance = maxImportance;
  merged.mentionCount = Math.max(mentionCount, rows.length);

  return merged;
}

async function backfillMemoryKeys() {
  let updated = 0;
  while (true) {
    const rows = await prisma.memory.findMany({
      where: {
        memoryKey: null,
        NOT: {
          metadata: { path: ["status"], equals: "ARCHIVED" },
        },
      },
      take: BATCH_SIZE,
      select: {
        id: true,
        userId: true,
        type: true,
        content: true,
        metadata: true,
      },
    });
    if (rows.length === 0) break;

    let progressed = 0;
    for (const row of rows) {
      const metadata = (row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {});
      const key = computeMemoryKey(row.type, row.content, metadata);
      if (!key) continue;
      const existing = await prisma.memory.findUnique({
        where: { userId_memoryKey: { userId: row.userId, memoryKey: key } },
        select: {
          id: true,
          metadata: true,
          pinned: true,
          content: true,
          type: true,
          userId: true,
          memoryKey: true,
          createdAt: true,
        },
      });

      if (existing) {
        const mergedMetadata = mergeMetadata([
          {
            ...row,
            memoryKey: key,
          } as MemoryRow,
          {
            ...existing,
            content: existing.content ?? "",
            type: row.type,
            userId: row.userId,
            memoryKey: key,
            createdAt: new Date(),
            pinned: existing.pinned,
            metadata: existing.metadata,
          } as MemoryRow,
        ]);

        const existingMeta =
          existing.metadata && typeof existing.metadata === "object"
            ? (existing.metadata as Record<string, unknown>)
            : {};
        await prisma.memory.update({
          where: { id: existing.id },
          data: {
            metadata: { ...existingMeta, ...mergedMetadata } as any,
            pinned: existing.pinned,
          },
        });

        const archiveMeta =
          row.metadata && typeof row.metadata === "object"
            ? (row.metadata as Record<string, unknown>)
            : {};
        await prisma.memory.update({
          where: { id: row.id },
          data: {
            metadata: {
              ...archiveMeta,
              status: "ARCHIVED",
              archivedAt: new Date().toISOString(),
            } as any,
          },
        });
        progressed += 1;
        continue;
      }

      await prisma.memory.update({
        where: { id: row.id },
        data: { memoryKey: key },
      });
      updated += 1;
      progressed += 1;
    }

    if (progressed === 0) {
      console.warn("No progress in batch; stopping to avoid infinite loop.");
      break;
    }
  }
  return updated;
}

async function dedupeByMemoryKey() {
  const groups = await prisma.$queryRaw<
    Array<{ userId: string; memoryKey: string; ids: string[] }>
  >`
    SELECT "userId", "memoryKey", array_agg(id ORDER BY "createdAt" DESC) AS ids
    FROM "Memory"
    WHERE "memoryKey" IS NOT NULL
    GROUP BY "userId", "memoryKey"
    HAVING COUNT(*) > 1
    LIMIT ${GROUP_LIMIT}
  `;

  let archived = 0;
  let merged = 0;

  for (const group of groups) {
    const ids = group.ids;
    if (!ids || ids.length < 2) continue;

    const keepId = ids[0];
    const rows = await prisma.memory.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        userId: true,
        type: true,
        content: true,
        metadata: true,
        createdAt: true,
        pinned: true,
        memoryKey: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const mergedMetadata = mergeMetadata(rows);
    const pinned = rows.some((row) => row.pinned);

    const keepMeta =
      rows[0].metadata && typeof rows[0].metadata === "object"
        ? (rows[0].metadata as Record<string, unknown>)
        : {};
    await prisma.memory.update({
      where: { id: keepId },
      data: {
        metadata: { ...keepMeta, ...mergedMetadata } as any,
        pinned,
      },
    });
    merged += 1;

    const archiveIds = ids.slice(1);
    if (archiveIds.length > 0) {
      const archiveRows = rows.filter((row) => archiveIds.includes(row.id));
      await Promise.all(
        archiveRows.map(async (row) => {
          const existingMeta =
            row.metadata && typeof row.metadata === "object"
              ? (row.metadata as Record<string, unknown>)
              : {};
          await prisma.memory.update({
            where: { id: row.id },
            data: {
              metadata: {
                ...existingMeta,
                status: "ARCHIVED",
                archivedAt: new Date().toISOString(),
              } as any,
            },
          });
        })
      );
      archived += archiveIds.length;
    }
  }

  return { groupsProcessed: groups.length, merged, archived };
}

async function run() {
  if (!CONFIRM) {
    console.error("Refusing to run. Set BACKFILL_DEDUPE_CONFIRM=true to proceed.");
    process.exitCode = 1;
    return;
  }

  console.log("=== Memory Dedupe Sweep ===");
  console.log(`batchSize: ${BATCH_SIZE}`);
  console.log(`groupLimit: ${GROUP_LIMIT}`);

  const updatedKeys = await backfillMemoryKeys();
  console.log(`memoryKey updated: ${updatedKeys}`);

  const dedupeResult = await dedupeByMemoryKey();
  console.log("dedupeResult:", dedupeResult);
}

run().catch((error) => {
  console.error("Memory dedupe sweep failed:", error);
  process.exitCode = 1;
});
