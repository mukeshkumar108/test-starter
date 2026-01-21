import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import { MemoryType } from "@prisma/client";

const MAX_FOLDS_PER_RUN = 5;

function isCuratorEnabled() {
  return env.FEATURE_MEMORY_CURATOR === "true";
}

function getEntityKey(content: string) {
  const match = content.match(/\b[A-Z][a-z]+\b/);
  return match?.[0] ?? null;
}

function buildSummary(prefix: string, items: Array<{ content: string }>) {
  const details = items.map((item) => item.content).slice(0, 5).join(" / ");
  return `${prefix}: ${details}`;
}

export async function runCuratorForUser(userId: string) {
  if (!isCuratorEnabled()) {
    return { enabled: false, folded: 0 };
  }

  const candidates = await prisma.memory.findMany({
    where: {
      userId,
      type: { in: [MemoryType.PEOPLE, MemoryType.PROJECT] },
    },
    orderBy: { createdAt: "asc" },
  });

  const activeObservations = candidates.filter((memory) => {
    const source = memory.metadata?.source;
    const status = memory.metadata?.status ?? "ACTIVE";
    return source === "shadow_extraction" && status !== "ARCHIVED";
  });

  const groups = new Map<
    string,
    {
      type: MemoryType;
      key: string;
      items: typeof activeObservations;
      metaKey?: { entity?: string; project?: string };
    }
  >();

  for (const memory of activeObservations) {
    if (memory.type === MemoryType.PEOPLE) {
      const entity = memory.metadata?.entity || getEntityKey(memory.content);
      if (!entity) continue;
      const key = `PEOPLE:${entity}`;
      const group = groups.get(key) ?? {
        type: MemoryType.PEOPLE,
        key,
        items: [],
        metaKey: { entity },
      };
      group.items.push(memory);
      groups.set(key, group);
    }

    if (memory.type === MemoryType.PROJECT) {
      const project = memory.metadata?.project;
      if (!project) continue;
      const key = `PROJECT:${project}`;
      const group = groups.get(key) ?? {
        type: MemoryType.PROJECT,
        key,
        items: [],
        metaKey: { project },
      };
      group.items.push(memory);
      groups.set(key, group);
    }
  }

  let folded = 0;
  const nowIso = new Date().toISOString();

  for (const group of groups.values()) {
    if (folded >= MAX_FOLDS_PER_RUN) break;
    if (group.items.length < 3) continue;

    const summary =
      group.type === MemoryType.PEOPLE
        ? buildSummary(group.metaKey?.entity ?? "Person", group.items)
        : buildSummary(group.metaKey?.project ?? "Project", group.items);

    const foldedIds = group.items.map((item) => item.id);

    await prisma.memory.create({
      data: {
        userId,
        type: group.type,
        content: summary,
        metadata: {
          source: "curated_fold",
          status: "ACTIVE",
          importance: 2,
          folded_from_ids: foldedIds,
          ...(group.metaKey ?? {}),
        },
      },
    });

    for (const memory of group.items) {
      await prisma.memory.update({
        where: { id: memory.id },
        data: {
          metadata: {
            ...(memory.metadata ?? {}),
            status: "ARCHIVED",
            archivedAt: nowIso,
          },
        },
      });
    }

    folded += 1;
  }

  return { enabled: true, folded };
}

export async function runCuratorBatch(limitUsers: number = 25) {
  if (!isCuratorEnabled()) {
    return { enabled: false, folded: 0, usersProcessed: 0 };
  }

  const userIds = await prisma.memory.findMany({
    where: { type: { in: [MemoryType.PEOPLE, MemoryType.PROJECT] } },
    distinct: ["userId"],
    take: limitUsers,
    select: { userId: true },
  });

  let foldedTotal = 0;
  for (const user of userIds) {
    const result = await runCuratorForUser(user.userId);
    foldedTotal += result.folded;
  }

  return { enabled: true, folded: foldedTotal, usersProcessed: userIds.length };
}
