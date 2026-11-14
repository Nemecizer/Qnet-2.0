// Canvas typography (0.90.34 DesignSystem.swift `DS.Canvas`; ledger CAN-034, CAN-135…CAN-140) and
// a text measure that needs no DOM.
//
// SwiftUI measured and truncated text with the real font. The canvas here is an SVG that must
// also render on the server (the image export uses renderToStaticMarkup), so widths come from a
// fixed table of SF Pro advance widths (em units, regular weight, tabular digits) rather than a
// layout pass. It is an estimate — good to a few percent for Latin text — used only to decide
// where a label is truncated and how wide a chip's pill is.

// The zoom thresholds and clamped sizes are the geometry area's (../geometry/lod.ts), so the
// drawing, the export's content rect and the level-of-detail tests read one set of numbers.
export {
  NAME_ROW_MIN_SCALE,
  DETAIL_ROW_MIN_SCALE,
  RATE_ROW_MIN_SCALE,
  LINK_LABEL_MIN_SCALE,
  labelBlockDisplayWidth,
  nameFontSize as nameSize,
  detailFontSize as detailSize,
  chipFontSize as linkLabelSize,
} from "../geometry/lod";

/** DS.Font.numberCaption (the system caption, 10 pt) for the ρ badge. */
export const BADGE_SIZE = 10;

/** The family every canvas label uses: the system font, with tabular digits. */
export const CANVAS_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

export type Weight = 400 | 500 | 600 | 700;

const NARROW = new Set([..."iljI.,:;'|!·()[]{}/  "]);
const WIDE = new Set([..."mwMW@%"]);

/** Advance width of one character in em, SF Pro regular. */
function advance(ch: string): number {
  if (/[0-9]/.test(ch)) return 0.6; // tabular figures
  if (NARROW.has(ch)) return 0.27;
  if (WIDE.has(ch)) return 0.86;
  if (ch === "…") return 0.78;
  if (ch === "→" || ch === "≥") return 0.75;
  if (ch === "=" || ch === "+" || ch === "−" || ch === "-") return ch === "-" ? 0.38 : 0.6;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[a-z]/.test(ch)) return ch === "f" || ch === "t" || ch === "r" ? 0.36 : 0.53;
  if (/[Ͱ-Ͽ]/.test(ch)) return 0.58; // Greek: λ μ ρ
  return 0.6;
}

const WEIGHT_FACTOR: Record<Weight, number> = { 400: 1, 500: 1.02, 600: 1.045, 700: 1.07 };

/** Estimated width of `text` in display points. */
export function textWidth(text: string, size: number, weight: Weight = 400): number {
  let em = 0;
  for (const ch of text) em += advance(ch);
  return em * size * WEIGHT_FACTOR[weight];
}

/** The line height SwiftUI gives the system font (ascender + descender ≈ 1.19 em). */
export const lineHeight = (size: number) => Math.ceil(size * 1.19);

/** `.lineLimit(1)` with `.truncationMode(.middle)` or `.tail`. */
export function truncate(text: string, maxWidth: number, size: number, weight: Weight, mode: "middle" | "tail"): string {
  if (textWidth(text, size, weight) <= maxWidth) return text;
  const chars = [...text];
  const ell = "…";
  if (mode === "tail") {
    for (let n = chars.length - 1; n > 0; n--) {
      const t = chars.slice(0, n).join("") + ell;
      if (textWidth(t, size, weight) <= maxWidth) return t;
    }
    return ell;
  }
  for (let keep = chars.length - 1; keep > 0; keep--) {
    const head = Math.ceil(keep / 2);
    const t = chars.slice(0, head).join("") + ell + chars.slice(chars.length - (keep - head)).join("");
    if (textWidth(t, size, weight) <= maxWidth) return t;
  }
  return ell;
}
