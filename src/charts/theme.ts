// The charts' paint and type (new in 2.1, ROADMAP B1). Every colour a chart draws is a token from
// src/styles.css, written into the SVG as `var(--token)`, so the screen follows the theme; the
// export (svgString.ts) replaces each with the light theme's value, read from the stylesheet's own
// text, so a figure never depends on the appearance of the Mac that made it.
import { canvasToken, colorString } from "../canvas/layers/colors";
import { CANVAS_FONT, textWidth, type Weight } from "../canvas/layers/text";
import type { Tier } from "../results/insight";

/** `var(--name)` for a token name ("--tier-exact"). */
export const v = (token: string) => `var(${token})`;

/** The family every chart label is set in: the canvas's, so an export embeds the same font. */
export const CHART_FONT = CANVAS_FONT;

/** Type sizes in px at text scale 1 (the app's --fs-md, --fs-sm and --fs-xs). */
export const SIZE = { title: 13, label: 11, tick: 10.5 } as const;

export type MarkShape = "circle" | "diamond" | "square" | "triangle" | "cross" | "ring";

/** A tier's colour token and shape: the two together, so a tier is never told by colour alone. */
export const TIER_STYLE: Record<Tier, { color: string; shape: MarkShape }> = {
  exact: { color: "--tier-exact", shape: "circle" },
  simulation: { color: "--tier-simulation", shape: "diamond" },
  approximation: { color: "--tier-approximation", shape: "square" },
  diffusion: { color: "--tier-diffusion", shape: "triangle" },
  bound: { color: "--tier-bound", shape: "cross" },
  mixed: { color: "--muted", shape: "ring" },
};

export const SERIES_COUNT = 8;
/** The nth series' colour token (0-based), or null past the eighth: series are never cycled. */
export const seriesToken = (index: number): string | null => (index >= 0 && index < SERIES_COUNT ? `--series-${index + 1}` : null);
export const SERIES_SHAPES: MarkShape[] = ["circle", "square", "diamond", "triangle", "cross", "ring", "circle", "square"];

/** A token's value in the light theme with standard contrast, as "#rrggbb" or "rgba(…)". */
export function lightValue(token: string): string {
  return colorString(canvasToken(token, "light", false));
}

export { textWidth };

/** `text` cut with an ellipsis to fit `max` px at `size` (an estimate, as the canvas's labels are). */
export function fitText(text: string, max: number, size: number, weight: Weight = 400): string {
  if (textWidth(text, size, weight) <= max) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, size, weight) > max) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export interface Interval {
  low: number;
  high: number;
}
