/* Container sizes — shared by the Containers section (App.tsx) and the
 * Folder cover, so both look and count the same way. */

export type Size = "20" | "40" | "45";

export const SIZES: Size[] = ["20", "40", "45"];

export const SIZE_STYLES: Record<Size, string> = {
  "20": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  "40": "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "45": "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

export const SIZE_ACTIVE: Record<Size, string> = {
  "20": "seg-active-sky",
  "40": "seg-active-violet",
  "45": "seg-active-amber",
};

/** Marque shown on MISE A QUAI: always 01TC{size}. */
export const marqueFor = (size: Size) => `01TC${size}`;
