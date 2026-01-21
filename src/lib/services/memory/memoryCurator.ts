import { prisma } from "@/lib/prisma";
import { env } from "@/env";
import { MemoryType, type Memory as MemoryRecord } from "@prisma/client";

const MAX_FOLDS_PER_RUN = 5;
const AUTO_RUN_COOLDOWN_MS = 60 * 1000;
const AUTO_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_RUN_MEMORY_THRESHOLD = 25;
const autoRunGuards = new Map<string, number>();

function isCuratorEnabled() {
  return env.FEATURE_MEMORY_CURATOR === "true";
}

function getMetadataObject(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  return metadata as Record<string, unknown>;
}

function normalizeContent(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:]+$/g, "");
}

function isSeeded(metadata: Record<string, unknown> | null) {
  return metadata?.source === "seeded_profile";
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
    const metadata = getMetadataObject(memory.metadata);
    const source = metadata?.source;
    const status = metadata?.status ?? "ACTIVE";
    return source === "shadow_extraction" && status !== "ARCHIVED";
  });

  type Observation = MemoryRecord;
  type Group = {
    type: MemoryType;
    key: string;
    items: Observation[];
    metaKey?: { entity?: string; project?: string };
  };
  const groups = new Map<string, Group>();

  for (const memory of activeObservations) {
    if (memory.type === MemoryType.PEOPLE) {
      const metadata = getMetadataObject(memory.metadata);
      const entityValue = metadata?.entity;
      const entity =
        typeof entityValue === "string" ? entityValue : getEntityKey(memory.content);
      if (!entity) continue;
      const key = `PEOPLE:${entity}`;
      const group = groups.get(key) ?? {
        type: MemoryType.PEOPLE,
        key,
        items: [] as Observation[],
        metaKey: { entity },
      };
      group.items.push(memory);
      groups.set(key, group);
    }

    if (memory.type === MemoryType.PROJECT) {
      const metadata = getMetadataObject(memory.metadata);
      const projectValue = metadata?.project;
      const project = typeof projectValue === "string" ? projectValue : null;
      if (!project) continue;
      const key = `PROJECT:${project}`;
      const group = groups.get(key) ?? {
        type: MemoryType.PROJECT,
        key,
        items: [] as Observation[],
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
      const metadata = getMetadataObject(memory.metadata) ?? {};
      await prisma.memory.update({
        where: { id: memory.id },
        data: {
          metadata: {
            ...metadata,
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

async function runDeterministicHygiene(userId: string) {
  const candidates = await prisma.memory.findMany({
    where: {
      userId,
      type: { in: [MemoryType.PROFILE, MemoryType.PEOPLE, MemoryType.PROJECT] },
    },
    orderBy: { createdAt: "desc" },
  });

  const active = candidates.filter((memory) => {
    const metadata = getMetadataObject(memory.metadata);
    const status = metadata?.status ?? "ACTIVE";
    return status !== "ARCHIVED";
  });

  const groups = new Map<string, MemoryRecord[]>();
  for (const memory of active) {
    const key = `${memory.type}:${normalizeContent(memory.content)}`;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }

  let archived = 0;
  let deduped = 0;
  const nowIso = new Date().toISOString();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const seeded = group.filter((item) => isSeeded(getMetadataObject(item.metadata)));
    const keep =
      seeded.length > 0
        ? seeded.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        : group.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

    for (const memory of group) {
      if (memory.id === keep.id) continue;
      const metadata = getMetadataObject(memory.metadata) ?? {};
      await prisma.memory.update({
        where: { id: memory.id },
        data: {
          metadata: {
            ...metadata,
            status: "ARCHIVED",
            archivedAt: nowIso,
            archiveReason: "dedupe",
          },
        },
      });
      archived += 1;
      deduped += 1;
    }
  }

  let folded = 0;
  for (const memory of active) {
    if (folded >= MAX_FOLDS_PER_RUN) break;
    if (memory.type !== MemoryType.PEOPLE) continue;
    const metadata = getMetadataObject(memory.metadata);
    if (isSeeded(metadata) || metadata?.source === "curated_fold") continue;
    const entityValue = metadata?.entity;
    if (typeof entityValue !== "string") continue;
    const related = active.filter((item) => {
      if (item.type !== MemoryType.PEOPLE) return false;
      const meta = getMetadataObject(item.metadata);
      if (isSeeded(meta)) return false;
      return meta?.entity === entityValue;
    });
    if (related.length < 3) continue;

    const summary = buildSummary(entityValue, related);
    const foldedIds = related.map((item) => item.id);

    await prisma.memory.create({
      data: {
        userId,
        type: MemoryType.PEOPLE,
        content: summary,
        metadata: {
          source: "curated_fold",
          status: "ACTIVE",
          importance: 2,
          folded_from_ids: foldedIds,
          entity: entityValue,
        },
      },
    });

    for (const item of related) {
      const meta = getMetadataObject(item.metadata) ?? {};
      await prisma.memory.update({
        where: { id: item.id },
        data: {
          metadata: {
            ...meta,
            status: "ARCHIVED",
            archivedAt: nowIso,
            archiveReason: "fold",
          },
        },
      });
      archived += 1;
    }

    folded += 1;
  }

  return { archived, deduped, folded };
}

export async function autoCurateMaybe(userId: string, personaId: string) {
  const key = `${userId}:${personaId}`;
  const now = Date.now();
  const lastGuard = autoRunGuards.get(key) ?? 0;
  if (now - lastGuard < AUTO_RUN_COOLDOWN_MS) {
    return { skipped: true, reason: "cooldown" };
  }
  autoRunGuards.set(key, now);

  const sessionState = await prisma.sessionState.findUnique({
    where: { userId_personaId: { userId, personaId } },
  });
  const baseState =
    sessionState?.state && typeof sessionState.state === "object" && !Array.isArray(sessionState.state)
      ? (sessionState.state as Record<string, unknown>)
      : {};
  const curatorState =
    baseState.curator && typeof baseState.curator === "object" && !Array.isArray(baseState.curator)
      ? (baseState.curator as Record<string, unknown>)
      : {};
  const lastRunAtRaw = curatorState.lastRunAt;
  const lastRunAt = typeof lastRunAtRaw === "string" ? new Date(lastRunAtRaw) : null;
  const lastRunMs = lastRunAt?.getTime() ?? 0;

  const dueByTime = !lastRunAt || now - lastRunMs >= AUTO_RUN_INTERVAL_MS;
  let dueByCount = false;

  if (!dueByTime && lastRunAt) {
    const recent = await prisma.memory.findMany({
      where: {
        userId,
        createdAt: { gt: lastRunAt },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { metadata: true },
    });
    const recentCount = recent.filter((item) => {
      const metadata = getMetadataObject(item.metadata);
      const status = metadata?.status ?? "ACTIVE";
      return status !== "ARCHIVED";
    }).length;
    dueByCount = recentCount >= AUTO_RUN_MEMORY_THRESHOLD;
  }

  if (!dueByTime && !dueByCount) {
    return { skipped: true, reason: "not_due" };
  }

  const reason = dueByTime ? "24h" : "25mem";
  const startedAt = Date.now();
  console.log(
    "[curator.auto]",
    JSON.stringify({ userId, personaId, reason, startedAt })
  );

  const result = await runDeterministicHygiene(userId);
  const elapsedMs = Date.now() - startedAt;

  const newState = {
    ...baseState,
    curator: {
      lastRunAt: new Date().toISOString(),
      lastMemoryCountAtRun: result.deduped + result.archived,
    },
  };

  await prisma.sessionState.upsert({
    where: { userId_personaId: { userId, personaId } },
    update: { state: newState },
    create: { userId, personaId, state: newState },
  });

  console.log(
    "[curator.auto.done]",
    JSON.stringify({
      userId,
      personaId,
      reason,
      elapsedMs,
      counts: {
        archived: result.archived,
        deduped: result.deduped,
        folded: result.folded,
      },
    })
  );
  if (elapsedMs > 5000) {
    console.warn(
      "[curator.warn]",
      JSON.stringify({
        userId,
        personaId,
        reason,
        elapsedMs,
        counts: {
          archived: result.archived,
          deduped: result.deduped,
          folded: result.folded,
        },
      })
    );
  }

  return { ...result, reason };
}
