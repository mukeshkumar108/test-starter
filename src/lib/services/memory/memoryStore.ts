import { prisma } from "@/lib/prisma";
import { MODELS } from "@/lib/providers/models";
import { env } from "@/env";
import { MemoryType } from "@prisma/client";

export interface Memory {
  id: string;
  personaId?: string | null;
  type: MemoryType;
  content: string;
  similarity?: number;
  operator?: string;
  metadata?: any;
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

    // Vector similarity search using pgvector
    const memories = await prisma.$queryRaw<Memory[]>`
      SELECT id, "personaId", type, content, metadata,
             1 - (embedding <=> ${queryEmbedding}::vector) as similarity,
             '<=>' as operator
      FROM "Memory"
      WHERE "userId" = ${userId}
        AND ("personaId" = ${personaId} OR "personaId" IS NULL)
        AND "type" IN ('PROFILE', 'PEOPLE', 'PROJECT')
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${queryEmbedding}::vector
      LIMIT ${limit}
    `;

    return memories.filter(
      (memory) => (memory.metadata?.status ?? "ACTIVE") !== "ARCHIVED"
    );
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
): Promise<void> {
  try {
    // Generate embedding
    const embedding = await generateEmbedding(content);

    const data: any = {
      userId,
      ...(personaId ? { personaId } : {}),
      type,
      content,
      metadata,
    };

    const created = await prisma.memory.create({ data });
    if (embedding) {
      const embeddingLiteral = `[${embedding.join(",")}]`;
      await prisma.$executeRaw`
        UPDATE "Memory"
        SET embedding = ${embeddingLiteral}::vector
        WHERE id = ${created.id}
      `;
    }
  } catch (error) {
    console.error("Memory storage failed:", error);
    throw error;
  }
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
