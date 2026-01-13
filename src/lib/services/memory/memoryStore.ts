import { prisma } from "@/lib/prisma";
import { MODELS } from "@/lib/providers/models";
import { env } from "@/env";
import { MemoryType } from "@prisma/client";

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  similarity?: number;
  metadata?: any;
}

export async function searchMemories(
  userId: string,
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
      SELECT id, type, content, metadata,
             1 - (embedding <=> ${queryEmbedding}::vector) as similarity
      FROM "Memory"
      WHERE "userId" = ${userId}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${queryEmbedding}::vector
      LIMIT ${limit}
    `;

    return memories.filter(m => (m.similarity || 0) > 0.7); // Similarity threshold
  } catch (error) {
    console.error("Memory search failed:", error);
    return [];
  }
}

export async function storeMemory(
  userId: string,
  type: MemoryType,
  content: string,
  metadata?: any
): Promise<void> {
  try {
    // Generate embedding
    const embedding = await generateEmbedding(content);

    await prisma.memory.create({
      data: {
        userId,
        type,
        content,
        embedding,
        metadata,
      },
    });
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