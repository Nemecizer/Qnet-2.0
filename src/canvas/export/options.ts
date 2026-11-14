// The diagram export's remembered answers (0.90.34 `CanvasExportOptions`, ledger SET-181…184,
// FILE-058): kept in state.json under 0.90.34's UserDefaults keys. The panel writes each answer
// the moment it changes, as its @AppStorage did, and Print and Copy as Image read them unasked.
import { getStateValue, setStateValues } from "../../lib/kv";

export type ExportBackground = "canvas" | "white" | "transparent";
export type ExportFormat = "pdf" | "png";

export interface ExportOptions {
  /** Pixels per point for a PNG (and Copy as Image's TIFF); a PDF is vector and ignores it. */
  pixelScale: 1 | 2 | 4;
  background: ExportBackground;
  includesGrid: boolean;
  /** The class-colour key, composed in when the network has more than one class. */
  includesLegend: boolean;
}

export const EXPORT_KEYS = {
  pixelScale: "canvas.export.pixelScale",
  background: "canvas.export.background",
  includesGrid: "canvas.export.includesGrid",
  includesLegend: "canvas.export.includesLegend",
} as const;

export const PIXEL_SCALES = [1, 2, 4] as const;
export const BACKGROUNDS: readonly ExportBackground[] = ["canvas", "white", "transparent"];

export const DEFAULT_OPTIONS: ExportOptions = { pixelScale: 2, background: "canvas", includesGrid: false, includesLegend: true };

/** `CanvasExportOptions.load()`: each stored value when it is a valid one, else the default. */
export function loadExportOptions(): ExportOptions {
  const o = { ...DEFAULT_OPTIONS };
  const s = getStateValue<unknown>(EXPORT_KEYS.pixelScale, null);
  if (typeof s === "number" && (PIXEL_SCALES as readonly number[]).includes(s)) o.pixelScale = s as ExportOptions["pixelScale"];
  const b = getStateValue<unknown>(EXPORT_KEYS.background, null);
  if (typeof b === "string" && (BACKGROUNDS as readonly string[]).includes(b)) o.background = b as ExportBackground;
  const g = getStateValue<unknown>(EXPORT_KEYS.includesGrid, null);
  if (typeof g === "boolean") o.includesGrid = g;
  const l = getStateValue<unknown>(EXPORT_KEYS.includesLegend, null);
  if (typeof l === "boolean") o.includesLegend = l;
  return o;
}

/** Remembers the changed answers. */
export function rememberExportOptions(patch: Partial<ExportOptions>): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch) as (keyof ExportOptions)[]) out[EXPORT_KEYS[k]] = patch[k];
  return setStateValues(out).catch(() => {});
}
