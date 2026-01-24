import { prisma } from "@/lib/prisma";
import { MODELS } from "@/lib/providers/models";
import { env } from "@/env";
import { MemoryType } from "@prisma/client";
import { canonicalizeEntityRefs } from "@/lib/services/memory/entityNormalizer";

export interface Memory {
  id: string;
  personaId?: string | null;
  type: MemoryType;
  content: string;
  similarity?: number;
  operator?: string;
  metadata?: any;
  createdAt?: Date;
}

interface ScoredMemory extends Memory {
  createdAt: Date;
  similarity: number;
  recencyScore: number;
  frequencyScore: number;
  blendedScore: number;
}

// Blended scoring constants
const PREFILTER_K = 50;
const HALF_LIFE_DAYS = 14;
const LAMBDA = Math.LN2 / HALF_LIFE_DAYS; // ≈ 0.0495

const WEIGHT_SIMILARITY = 0.4;
const WEIGHT_RECENCY = 0.3;
const WEIGHT_FREQUENCY = 0.3;

/**
 * Compute blended scores for memory candidates.
 * Score = 0.4 * similarity + 0.3 * recency + 0.3 * frequency
 *
 * Recency: exponential decay with 14-day half-life
 * Frequency: normalized count of entityKey occurrences within the candidate set
 */
function computeBlendedScores(
  candidates: Array<Memory & { createdAt: Date; similarity: number }>,
  now: Date
): ScoredMemory[] {
  if (candidates.length === 0) return [];

  // 1. Compute recency scores
  const withRecency = candidates.map((m) => {
    const ageMs = now.getTime() - m.createdAt.getTime();
    const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
    const recencyScore = Math.exp(-LAMBDA * ageDays);
    return { ...m, recencyScore };
  });

  // 2. Compute frequency scores (count of entityKey occurrences within K set)
  const entityKeyCounts = new Map<string, number>();
  for (const m of withRecency) {
    const refs = (m.metadata?.entityRefs as string[]) ?? [];
    for (const ref of refs) {
      entityKeyCounts.set(ref, (entityKeyCounts.get(ref) || 0) + 1);
    }
  }
  const maxFreq = Math.max(1, ...entityKeyCounts.values());

  const scored: ScoredMemory[] = withRecency.map((m) => {
    const refs = (m.metadata?.entityRefs as string[]) ?? [];
    // frequencyScore = avg normalized frequency of all entityRefs (or 0 if none)
    let frequencyScore = 0;
    if (refs.length > 0) {
      const freqSum = refs.reduce((sum, ref) => sum + (entityKeyCounts.get(ref) || 0), 0);
      frequencyScore = (freqSum / refs.length) / maxFreq;
    }

    const blendedScore =
      WEIGHT_SIMILARITY * (m.similarity ?? 0) +
      WEIGHT_RECENCY * m.recencyScore +
      WEIGHT_FREQUENCY * frequencyScore;

    return { ...m, frequencyScore, blendedScore };
  });

  // 3. Sort by blendedScore descending
  return scored.sort((a, b) => b.blendedScore - a.blendedScore);
}

export async function searchMemories(
  userId: string,
  personaId: string,
  query: string,
  limit: number = 5
): Promise<Memory[]> {
  try {
    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(query);

    if (!queryEmbedding) {
      return [];
    }

    const useEntityPipeline = env.FEATURE_ENTITY_PIPELINE !== "false";

    // Fetch more candidates when using entity pipeline for blended scoring
    const fetchLimit = useEntityPipeline ? PREFILTER_K : limit;

    // Vector similarity search using pgvector
    const memories = await prisma.$queryRaw<
      Array<Memory & { createdAt: Date; similarity: number }>
    >`
      SELECT id, "personaId", type, content, metadata, "createdAt",
             1 - (embedding <=> ${queryEmbedding}::vector) as similarity,
             '<=>' as operator
      FROM "Memory"
      WHERE "userId" = ${userId}
        AND ("personaId" = ${personaId} OR "personaId" IS NULL)
        AND "type" IN ('PROFILE', 'PEOPLE', 'PROJECT')
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${queryEmbedding}::vector
      LIMIT ${fetchLimit}
    `;

    // Filter out archived memories
    const activeMemories = memories.filter(
      (memory) => (memory.metadata?.status ?? "ACTIVE") !== "ARCHIVED"
    );

    if (!useEntityPipeline) {
      // Old behavior: return vector-sorted results
      return activeMemories.slice(0, limit);
    }

    // New behavior: compute blended scores and re-rank
    const scored = computeBlendedScores(activeMemories, new Date());
    return scored.slice(0, limit);
  } catch (error) {
    console.error("Memory search failed:", error);
    return [];
  }
}

export async function storeMemory(
  userId: string,
  type: MemoryType,
  content: string,
  metadata?: any,
  personaId?: string | null
): Promise<string> {
  try {
    const normalizedMetadata = normalizeMemoryMetadata(metadata);
    const memoryKey = computeMemoryKey(type, content, normalizedMetadata);

    if (memoryKey) {
      const existing = await prisma.memory.findUnique({
        where: { userId_memoryKey: { userId, memoryKey } },
        select: { id: true, metadata: true },
      });

      if (existing) {
        const mergedMetadata = mergeMemoryMetadata(existing.metadata, normalizedMetadata);
        const updated = await prisma.memory.update({
          where: { id: existing.id },
          data: {
            memoryKey,
            metadata: mergedMetadata,
          },
        });
        return updated.id;
      }
    }

    const createMetadata = initializeMemoryMetadata(normalizedMetadata);
    const data: any = {
      userId,
      ...(personaId ? { personaId } : {}),
      type,
      content,
      metadata: createMetadata,
      memoryKey,
    };

    // Generate embedding only for new rows.
    const embedding = await generateEmbedding(content);
    const created = await prisma.memory.create({ data });
    if (embedding) {
      const embeddingLiteral = `[${embedding.join(",")}]`;
      await prisma.$executeRaw`
        UPDATE "Memory"
        SET embedding = ${embeddingLiteral}::vector
        WHERE id = ${created.id}
      `;
    }
    return created.id;
  } catch (error) {
    console.error("Memory storage failed:", error);
    throw error;
  }
}

function normalizeMemoryMetadata(metadata?: any): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const normalized: Record<string, unknown> = { ...metadata };

  const refs = Array.isArray(normalized.entityRefs)
    ? canonicalizeEntityRefs(normalized.entityRefs as string[])
    : [];
  if (refs.length > 0) {
    normalized.entityRefs = refs;
  } else {
    delete normalized.entityRefs;
  }

  const importance = normalizeImportance(normalized.importance);
  if (importance !== null) {
    normalized.importance = importance;
  } else {
    delete normalized.importance;
  }

  return normalized;
}

function initializeMemoryMetadata(metadata: Record<string, unknown>) {
  const base = { ...metadata };
  if (typeof base.mentionCount !== "number") {
    base.mentionCount = 1;
  }
  if (typeof base.importance !== "number") {
    base.importance = 1;
  }
  return base;
}

function mergeMemoryMetadata(
  existingMetadata: unknown,
  incomingMetadata: Record<string, unknown>
) {
  const existing = (existingMetadata && typeof existingMetadata === "object"
    ? (existingMetadata as Record<string, unknown>)
    : {});

  const existingRefs = Array.isArray(existing.entityRefs) ? (existing.entityRefs as string[]) : [];
  const incomingRefs = Array.isArray(incomingMetadata.entityRefs)
    ? (incomingMetadata.entityRefs as string[])
    : [];
  const mergedRefs = canonicalizeEntityRefs([...existingRefs, ...incomingRefs]);

  const existingImportance = normalizeImportance(existing.importance) ?? 1;
  const incomingImportance = normalizeImportance(incomingMetadata.importance) ?? 1;
  const mergedImportance = Math.max(existingImportance, incomingImportance);

  const existingCount =
    typeof existing.mentionCount === "number" && Number.isFinite(existing.mentionCount)
      ? (existing.mentionCount as number)
      : 1;

  return {
    ...existing,
    ...incomingMetadata,
    ...(mergedRefs.length > 0 ? { entityRefs: mergedRefs } : {}),
    importance: mergedImportance,
    mentionCount: existingCount + 1,
  };
}

function computeMemoryKey(
  type: MemoryType,
  content: string,
  metadata: Record<string, unknown>
): string | null {
  const entityRefs = Array.isArray(metadata.entityRefs) ? (metadata.entityRefs as string[]) : [];
  const primaryRef = entityRefs[0] ?? `content:${normalizeMemoryContent(content)}`;
  const subtype = (metadata.subtype && typeof metadata.subtype === "object"
    ? (metadata.subtype as Record<string, unknown>)
    : {});
  const factType = typeof subtype.factType === "string" ? subtype.factType : "fact";
  const entityType = typeof subtype.entityType === "string" ? subtype.entityType : "none";
  return `${type.toLowerCase()}|${entityType}|${primaryRef}|${factType}`;
}

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

function normalizeImportance(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 3) return null;
  return Math.round(value);
}

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELS.EMBEDDINGS,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API failed: ${response.status}`);
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (error) {
    console.error("Embedding generation failed:", error);
    return null;
  }
}
