/**
 * Local-only section presence comparator for vNext parity inspection.
 *
 * Usage:
 *   LEGACY_SECTIONS=persona,recent_turns,memory VNEXT_SECTIONS=recent_turns pnpm tsx scripts/vnext-section-compare.ts
 *   LEGACY_SECTIONS_FILE=legacy.json VNEXT_PREVIEW_FILE=preview.json pnpm tsx scripts/vnext-section-compare.ts
 */

import { readFileSync } from "fs";

type SectionComparison = {
  legacy: string[];
  vnext: string[];
  shared: string[];
  missingFromVNext: string[];
  extraInVNext: string[];
};

function readMaybeFile(path?: string) {
  return path ? readFileSync(path, "utf8") : undefined;
}

function parseInput(raw?: string): unknown {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return JSON.parse(trimmed);
  return trimmed.split(",").map((value) => value.trim()).filter(Boolean);
}

function normalizeSections(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((value) => {
        if (typeof value === "string") return value;
        if (value && typeof value === "object" && "key" in value) {
          const key = (value as { key?: unknown }).key;
          return typeof key === "string" ? key : null;
        }
        return null;
      })
      .filter((value): value is string => Boolean(value));
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.contextSections)) return normalizeSections(record.contextSections);
    if (record.preview && typeof record.preview === "object") {
      return normalizeSections((record.preview as Record<string, unknown>).contextSections);
    }
    if (Array.isArray(record.sections)) return normalizeSections(record.sections);
  }

  return [];
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values)).sort();
}

function compareSections(legacy: string[], vnext: string[]): SectionComparison {
  const legacySet = new Set(legacy);
  const vnextSet = new Set(vnext);

  return {
    legacy: uniqueSorted(legacy),
    vnext: uniqueSorted(vnext),
    shared: uniqueSorted(legacy.filter((section) => vnextSet.has(section))),
    missingFromVNext: uniqueSorted(legacy.filter((section) => !vnextSet.has(section))),
    extraInVNext: uniqueSorted(vnext.filter((section) => !legacySet.has(section))),
  };
}

function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("vNext section comparator is disabled in production.");
  }

  const legacyRaw =
    readMaybeFile(process.env.LEGACY_SECTIONS_FILE) ?? process.env.LEGACY_SECTIONS;
  const vnextRaw =
    readMaybeFile(process.env.VNEXT_PREVIEW_FILE) ??
    readMaybeFile(process.env.VNEXT_SECTIONS_FILE) ??
    process.env.VNEXT_SECTIONS;

  const comparison = compareSections(
    normalizeSections(parseInput(legacyRaw)),
    normalizeSections(parseInput(vnextRaw))
  );

  console.log(JSON.stringify(comparison, null, 2));
}

main();

export const __test__ = {
  compareSections,
  normalizeSections,
};
