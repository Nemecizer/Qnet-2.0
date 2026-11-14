// The canvas's colours as plain values (0.90.34 DesignSystem.swift's canvas tokens and
// `CustomerClass`; docs/specs/canvas.md §19; ledger CAN-055, CAN-220, CAN-221).
//
// The tokens live in src/styles.css (its "Canvas" block, beside the app's neutral ramp and
// accent). The drawing can't use `var(--…)`: an exported SVG must stand alone, and 0.90.34 drew
// every export in the light ("aqua") appearance whatever the screen showed. So this module reads
// the stylesheet's own text and resolves the cascade for a theme and contrast — hex, rgb(a),
// var() chains and `color-mix(in srgb, A p%, B)` — into colour strings, with no DOM. On screen
// `useCanvasColors()` (./useCanvasColors.ts) picks the set for the current appearance.
import css from "../../styles.css?raw";

export type CanvasTheme = "light" | "dark";

export interface CanvasColors {
  readonly theme: CanvasTheme;
  /** Increase Contrast: hairlines step to 1.5 pt (DS.Stroke.hairline(_:)) and the node colours to their -more twins. */
  readonly contrast: boolean;
  /** The canvas ground (0.90.34 `surfaceRaised`). */
  readonly background: string;
  readonly stationFill: string;
  readonly bufferFill: string;
  readonly sourceFill: string;
  readonly sinkFill: string;
  readonly nodeStroke: string;
  readonly nodeGlyph: string;
  readonly gridDot: string;
  readonly gridLine: string;
  readonly accent: string;
  readonly accentStroke: string;
  readonly hoverRing: string;
  readonly selectionGlow: string;
  readonly selectionFillStrong: string;
  readonly marqueeFill: string;
  readonly linkHalo: string;
  /** Probability-chip fill (0.90.34 `surfaceRaised`). */
  readonly chipFill: string;
  /** `separator(contrast)`. */
  readonly separator: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  /** ρ badge fills: light (< 0.7), moderate (≥ 0.7), heavy (≥ 0.9); `onTint` is the ink on them. */
  readonly rhoLight: string;
  readonly rhoModerate: string;
  readonly rhoHeavy: string;
  readonly onTint: string;
  /** The eight fixed class colours; `classColor` generates the rest. */
  readonly classes: readonly string[];
  /** `DS.Stroke.hairline(contrast)`: 1, or 1.5 under Increase Contrast. */
  readonly hairline: number;
}

/** DS.Opacity, the canvas's share (ledger CAN-221). */
export const OPACITY = { linkStroke: 0.75, dim: 0.2, disabled: 0.4 } as const;

// ── A small resolver for styles.css ─────────────────────────────────────────────────────────

interface Rule {
  selector: string;
  decls: [string, string][];
}

/** Top-level rule blocks (outside any @media), in document order. */
function topLevelRules(text: string): Rule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const selector = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < src.length && depth; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
    }
    if (!selector.startsWith("@")) {
      const body = src.slice(open + 1, j - 1);
      const decls: [string, string][] = [];
      for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.push([m[1], m[2].trim()]);
      out.push({ selector, decls });
    }
    i = j;
  }
  return out;
}

const RULES = topLevelRules(css);

/** The custom properties `<html>` would have for this appearance: :root first, then the attribute blocks in order. */
function tokensFor(theme: CanvasTheme, contrast: boolean): Map<string, string> {
  const t = new Map<string, string>();
  for (const r of RULES) if (r.selector === ":root") for (const [k, v] of r.decls) t.set(k, v);
  for (const r of RULES) {
    const on = (r.selector === ':root[data-theme="dark"]' && theme === "dark") || (r.selector === ':root[data-contrast="more"]' && contrast);
    if (on) for (const [k, v] of r.decls) t.set(k, v);
  }
  return t;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, RGBA> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

/** Splits on top-level commas. */
function args(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(s.slice(from).trim());
  return out;
}

export function resolveColor(tokens: ReadonlyMap<string, string>, value: string, depth = 0): RGBA {
  if (depth > 16) throw new Error(`colour cycle at ${value}`);
  const v = value.trim();
  if (NAMED[v]) return NAMED[v];
  if (v.startsWith("#")) {
    const h = v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v;
    const n = parseInt(h.slice(1, 7), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: h.length === 9 ? parseInt(h.slice(7, 9), 16) / 255 : 1 };
  }
  const fn = /^([\w-]+)\((.*)\)$/s.exec(v);
  if (!fn) throw new Error(`can't resolve colour ${value}`);
  const [, name, inner] = fn;
  if (name === "var") {
    const [ref, fallback] = args(inner);
    const next = tokens.get(ref) ?? fallback;
    if (next === undefined) throw new Error(`undefined ${ref}`);
    return resolveColor(tokens, next, depth + 1);
  }
  if (name === "rgb" || name === "rgba") {
    const p = args(inner).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  if (name === "color-mix") {
    const [space, a, b] = args(inner);
    if (space !== "in srgb") throw new Error(`unsupported colour space ${space}`);
    const pa = /^(.*?)\s+([\d.]+)%$/.exec(a);
    const pb = /^(.*?)\s+([\d.]+)%$/.exec(b);
    const ca = resolveColor(tokens, pa ? pa[1] : a, depth + 1);
    const cb = resolveColor(tokens, pb ? pb[1] : b, depth + 1);
    const p = pa ? Number(pa[2]) / 100 : pb ? 1 - Number(pb[2]) / 100 : 0.5;
    // CSS Color 5: interpolate premultiplied, then un-premultiply.
    const alpha = ca.a * p + cb.a * (1 - p);
    const ch = (x: number, y: number) => (alpha === 0 ? 0 : (x * ca.a * p + y * cb.a * (1 - p)) / alpha);
    return { r: ch(ca.r, cb.r), g: ch(ca.g, cb.g), b: ch(ca.b, cb.b), a: alpha };
  }
  throw new Error(`can't resolve colour ${value}`);
}

const hex2 = (x: number) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");

/** "#rrggbb" when opaque, else "rgba(r, g, b, a)". */
export function colorString(c: RGBA): string {
  if (c.a >= 1) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  const a = Math.round(c.a * 1000) / 1000;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
}

/** One token, resolved for an appearance (tests and the contrast check use this). */
export function canvasToken(name: string, theme: CanvasTheme, contrast = false): RGBA {
  return resolveColor(tokensFor(theme, contrast), `var(${name})`);
}

const cache = new Map<string, CanvasColors>();

/**
 * The canvas's colours for an appearance, as plain values. The export asks for
 * `canvasColors("light")` (0.90.34 drew every export inside NSAppearance(.aqua), and with the
 * standard contrast: a file should not depend on the exporting Mac's accessibility settings).
 */
export function canvasColors(theme: CanvasTheme, contrast = false): CanvasColors {
  const key = `${theme}/${contrast}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = tokensFor(theme, contrast);
  const c = (name: string) => colorString(resolveColor(t, `var(--canvas-${name})`));
  const colors: CanvasColors = Object.freeze({
    theme,
    contrast,
    background: c("bg"),
    stationFill: c("station-fill"),
    bufferFill: c("buffer-fill"),
    sourceFill: c("source-fill"),
    sinkFill: c("sink-fill"),
    nodeStroke: c("node-stroke"),
    nodeGlyph: c("node-glyph"),
    gridDot: c("grid-dot"),
    gridLine: c("grid-line"),
    accent: c("accent"),
    accentStroke: c("accent"),
    hoverRing: c("hover-ring"),
    selectionGlow: c("selection-glow"),
    selectionFillStrong: c("selection-fill-strong"),
    marqueeFill: c("marquee-fill"),
    linkHalo: c("link-halo"),
    chipFill: c("chip-fill"),
    separator: c("separator"),
    textPrimary: c("text"),
    textSecondary: c("text-2"),
    rhoLight: c("rho-light"),
    rhoModerate: c("rho-moderate"),
    rhoHeavy: c("rho-heavy"),
    onTint: c("on-tint"),
    classes: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8].map((i) => c(`class-${i}`))),
    hairline: contrast ? 1.5 : 1,
  });
  cache.set(key, colors);
  return colors;
}

/** HSB → sRGB, as SwiftUI's Color(hue:saturation:brightness:). */
function hsb(h: number, s: number, v: number): RGBA {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const u = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return { r: r * 255, g: g * 255, b: b * 255, a: 1 };
}

/**
 * `CustomerClass.color(for:)`: the eight fixed colours, then golden-angle hues with alternating
 * saturation (0.72 / 0.88) and brightness (0.82 when the overflow is a multiple of 3, else 0.95).
 */
export function classColor(colors: CanvasColors, i: number): string {
  if (i >= 0 && i < colors.classes.length) return colors.classes[i];
  const overflow = Math.max(0, i - colors.classes.length);
  const hue = overflow * 0.61803398875;
  return colorString(hsb(hue - Math.floor(hue), overflow % 2 === 0 ? 0.72 : 0.88, overflow % 3 === 0 ? 0.82 : 0.95));
}

/** The kind's fill (`DS.Color.nodeFill(for:)`). */
export function kindFill(colors: CanvasColors, kind: "station" | "buffer" | "source" | "sink"): string {
  return kind === "station" ? colors.stationFill : kind === "buffer" ? colors.bufferFill : kind === "source" ? colors.sourceFill : colors.sinkFill;
}
