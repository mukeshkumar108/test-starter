/**
 * Entity Normalization for Memory B
 *
 * Entity keys follow the format: <type>:<slug>
 * - type: person | place | org | project
 * - slug: lowercase, no punctuation, underscores for spaces/hyphens
 */

export type EntityType = "person" | "place" | "org" | "project";
export type FactType = "fact" | "preference" | "relationship" | "friction" | "habit";

export interface MemorySubtype {
  entityType?: EntityType;
  factType?: FactType;
}

const VALID_ENTITY_TYPES = new Set<EntityType>(["person", "place", "org", "project"]);
const VALID_FACT_TYPES = new Set<FactType>(["fact", "preference", "relationship", "friction", "habit"]);

/**
 * Normalize a raw name into a slug for entity keys.
 * Rules:
 * 1. Lowercase + trim
 * 2. Replace punctuation with spaces (preserves word boundaries)
 * 3. Spaces/hyphens → underscore
 * 4. Collapse multiple underscores
 * 5. Trim leading/trailing underscores
 */
export function slugify(rawName: string): string {
  return rawName
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, " ")   // Replace punctuation with space (preserves word boundaries)
    .replace(/[\s-]+/g, "_")     // Spaces/hyphens → underscore
    .replace(/_+/g, "_")         // Collapse multiple underscores
    .replace(/^_|_$/g, "");      // Trim leading/trailing underscores
}

/**
 * Create a normalized entity key from type and name.
 * Format: <type>:<slug>
 */
export function normalizeEntityKey(entityType: EntityType, rawName: string): string {
  const slug = slugify(rawName);
  if (!slug) return "";
  return `${entityType}:${slug}`;
}

/**
 * Parse an entity key back into type and slug.
 * Returns null if invalid format.
 */
export function parseEntityKey(key: string): { type: EntityType; slug: string } | null {
  const match = key.match(/^(person|place|org|project):([a-z0-9_]+)$/);
  if (!match) return null;
  return { type: match[1] as EntityType, slug: match[2] };
}

/**
 * Validate and sanitize a subtype object from LLM output.
 */
export function sanitizeSubtype(raw: unknown): MemorySubtype | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  const result: MemorySubtype = {};

  if (typeof obj.entityType === "string" && VALID_ENTITY_TYPES.has(obj.entityType as EntityType)) {
    result.entityType = obj.entityType as EntityType;
  }

  if (typeof obj.factType === "string" && VALID_FACT_TYPES.has(obj.factType as FactType)) {
    result.factType = obj.factType as FactType;
  }

  // Return undefined if both fields are missing
  if (!result.entityType && !result.factType) return undefined;

  return result;
}

/**
 * Validate and sanitize an array of entity refs from LLM output.
 * Only allows properly formatted entity keys.
 */
export function sanitizeEntityRefs(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];

  const ENTITY_KEY_PATTERN = /^(person|place|org|project):[a-z0-9_]+$/;

  return refs
    .filter((ref): ref is string => typeof ref === "string" && ENTITY_KEY_PATTERN.test(ref))
    .slice(0, 5); // Cap at 5 entity refs per memory
}

/**
 * Validate and sanitize an importance score from LLM output.
 * Returns 1 (default) if invalid.
 */
export function sanitizeImportance(val: unknown): 0 | 1 | 2 | 3 {
  if (typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 3) {
    return Math.round(val) as 0 | 1 | 2 | 3;
  }
  return 1; // Default importance
}

/**
 * Sanitize an entity label string.
 */
export function sanitizeEntityLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 100) return undefined;
  return trimmed;
}

/**
 * Enforce importance=3 for pinned memories.
 * Per Memory B spec: pinned memories must have importance >= 3.
 */
export function enforceImportanceForPinned(
  importance: 0 | 1 | 2 | 3,
  pinned: boolean
): 0 | 1 | 2 | 3 {
  if (pinned) {
    return Math.max(importance, 3) as 0 | 1 | 2 | 3;
  }
  return importance;
}
