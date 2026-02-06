# SPEC_memory_B.md — Universal Human Substrate & Entity-First Retrieval (Historical)

Note: This spec predates the Great Simplification. Current memory architecture uses Synapse session briefs + session ingest. See `docs/orchestrator-overview.md`.

## 1. Objective
Transition the memory engine from "Semantic Top-K" (A) to "Entity-First Pipeline" (B). The goal is to enable multi-hop intelligence (e.g., connecting a person to a place or project) without a Graph DB.

## 2. Core Concepts
### A. Taxonomy & Storage (No-Migration Rule)
- We do NOT change Prisma Enums. 
- **Universal Substrate** lives in `metadata.subtype`:
  - `entityType`: person | place | org | project
  - `factType`: fact | preference | relationship | friction | habit
- **Importance Score:** `metadata.importance` (0 to 3, default 1).
- **Pinned:** Stays as the boolean `Memory.pinned`.

### B. Entity Normalization (The Slug Rule)
- `entityKey` format: `<type>:<slugified_name>` (e.g., `person:john_doe`).
- **Rules:** Lowercase, trim, no punctuation, collapse whitespace.
- **Labels:** `metadata.entityLabel` (e.g., "John Doe") for display.

## 3. The Retrieval Pipeline (B-Standard)
1. **Extraction:** Identify `entityKeys` in the current message.
2. **Expansion (Max 1 Hop):** - Fetch entities mentioned + up to 2 linked entities from `pinned` or `importance=3` facts.
3. **Scoring Formula:**
   - `Score = (Similarity * 0.4) + (RecencyScore * 0.3) + (FrequencyScore * 0.3)`
   - `RecencyScore`: Exponential decay (14-day half-life).
   - `FrequencyScore`: Count of Memory rows containing the `entityKey`.
4. **Context Blocks:**
   - **[ENTITY CARDS]**: Compact cards for resolved entities.
   - **[RELEVANT MEMORIES]**: Blended top-ranked facts (Cap: 8).

## 4. Implementation Stages
- **Stage 1: Schema & Metadata Prep.** Update `Memory` metadata handling to support `entityRefs` and `importance` scores.
- **Stage 2: Shadow Judge Upgrade.** Update extraction logic to tag memories with entity keys.
- **Stage 3: Context Builder Pipeline.** Implement the 4-stage retrieval pipeline.
- **Stage 4: Narrative Consolidation.** Integrate Rolling Summaries with the new Entity Cards.
