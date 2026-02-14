import { readFile } from "fs/promises";
import { join } from "path";

export type OverlayType = "curiosity_spiral" | "accountability_tug" | "daily_focus" | "conflict_regulation";

const overlayCache = new Map<OverlayType, string>();

const OVERLAY_PATHS: Record<OverlayType, string> = {
  curiosity_spiral: "prompts/overlays/curiosity_spiral.md",
  accountability_tug: "prompts/overlays/accountability_tug.md",
  daily_focus: "prompts/overlays/daily_focus.md",
  conflict_regulation: "prompts/overlays/conflict_regulation.md",
};

export async function loadOverlay(overlayType: OverlayType): Promise<string> {
  const cached = overlayCache.get(overlayType);
  if (cached) return cached;
  const relPath = OVERLAY_PATHS[overlayType];
  const fullPath = join(process.cwd(), relPath);
  const contents = await readFile(fullPath, "utf-8");
  const cleaned = contents.trim();
  overlayCache.set(overlayType, cleaned);
  return cleaned;
}

export function clearOverlayCache() {
  overlayCache.clear();
}
