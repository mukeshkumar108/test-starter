import { readFile } from "fs/promises";
import { join } from "path";

export type StanceOverlayType =
  | "witness"
  | "excavator"
  | "repair_and_forward"
  | "high_standards_friend";

export type TacticOverlayType =
  | "curiosity_spiral"
  | "accountability_tug"
  | "daily_focus"
  | "daily_review"
  | "weekly_compass"
  | "conflict_regulation";

export type OverlayType = StanceOverlayType | TacticOverlayType;

const overlayCache = new Map<OverlayType, string>();

const OVERLAY_PATHS: Record<OverlayType, string> = {
  witness: "prompts/overlays/stance/witness.md",
  excavator: "prompts/overlays/stance/excavator.md",
  repair_and_forward: "prompts/overlays/stance/repair_and_forward.md",
  high_standards_friend: "prompts/overlays/stance/high_standards_friend.md",
  curiosity_spiral: "prompts/overlays/curiosity_spiral.md",
  accountability_tug: "prompts/overlays/accountability_tug.md",
  daily_focus: "prompts/overlays/daily_focus.md",
  daily_review: "prompts/overlays/daily_review.md",
  weekly_compass: "prompts/overlays/weekly_compass.md",
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
