/**
 * Export size tiers.
 *
 * The tiers are fractions of the *document's own* size, not fixed pixel counts. A hardcoded
 * "512 / 1024 / 4096" would be a lie for every document that is not 1280x720, and would collide
 * with `MAX_CANVAS_AREA` — which is a Safari/iOS canvas-area safety ceiling, not a product tier.
 *
 * Every tier is at or below the document's true raster size. Nothing here can upscale, because
 * a bigger PNG is not more detail, and claiming otherwise is the bait-and-switch this design
 * exists to avoid.
 *
 * Deliberately DOM-free so it is measurable by the node-environment unit suite; `engine.ts`
 * only consumes the numbers.
 */

import { rasterHeight, rasterWidth, type DocModel } from "./document";

export type ExportTierId = "small" | "standard" | "full";

export interface ExportDimensions {
  readonly width: number;
  readonly height: number;
}

/** Ordered smallest first. A `null` factor means "the document's true raster size". */
const TIERS: Readonly<Record<ExportTierId, number | null>> = {
  small: 0.5,
  standard: 1,
  full: null,
};

export const EXPORT_TIER_IDS: readonly ExportTierId[] = ["small", "standard", "full"];

/** Output pixel size for a tier. Reduced tiers scale the logical size; `full` is the raster size. */
export function exportDimensions(doc: DocModel, tier: ExportTierId): ExportDimensions {
  const factor = TIERS[tier];
  if (factor === null) {
    return { width: rasterWidth(doc), height: rasterHeight(doc) };
  }
  return {
    // Floored at 1px: a canvas of zero area throws in every browser.
    width: Math.max(1, Math.round(doc.logicalWidth * factor)),
    height: Math.max(1, Math.round(doc.logicalHeight * factor)),
  };
}

/** Human-readable size for the tier button, e.g. `1280 × 720`. */
export function exportTierLabel({ width, height }: ExportDimensions): string {
  return `${width} × ${height}`;
}
