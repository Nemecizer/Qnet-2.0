// The canvas tokens (src/styles.css, "Canvas" block; ledger CAN-055, CAN-220, CAN-221): 0.90.34's
// values, the media-query copies equal to the attribute blocks, the contrast pairs the canvas
// relies on in light, dark and Increase Contrast, and the resolver that turns them into plain
// colours for the drawing and the export.
import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";
import { canvasColors, canvasToken, classColor, resolveColor, type CanvasTheme, type RGBA } from "./layers/colors";

const canvas = css.slice(css.indexOf("/* ---------- Canvas ----------"), css.indexOf("/* ---------- end Canvas ---------- */"));

function block(selector: string, from = 0): string {
  const start = canvas.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no block ${selector}`);
  const open = canvas.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < canvas.length; i++) {
    if (canvas[i] === "{") depth++;
    else if (canvas[i] === "}" && --depth === 0) return canvas.slice(open + 1, i);
  }
  throw new Error(`unterminated ${selector}`);
}
const decls = (body: string) => Object.fromEntries([...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (c: RGBA) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
/** Composites a translucent colour over an opaque ground. */
const over = (c: RGBA, g: RGBA): RGBA => ({ r: c.r * c.a + g.r * (1 - c.a), g: c.g * c.a + g.g * (1 - c.a), b: c.b * c.a + g.b * (1 - c.a), a: 1 });
function ratio(fg: string, bg: string, theme: CanvasTheme, more: boolean): number {
  const g = canvasToken(bg, theme, more);
  const a = lum(over(canvasToken(fg, theme, more), g));
  const b = lum(g);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("the canvas tokens are 0.90.34's (CAN-220)", () => {
  const rgb = (t: [number, number, number]) => `#${t.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
  it.each([
    ["station-fill", [0.8, 0.87, 0.98], [0.16, 0.27, 0.46]],
    ["buffer-fill", [0.99, 0.9, 0.76], [0.47, 0.31, 0.12]],
    ["source-fill", [0.82, 0.94, 0.83], [0.14, 0.38, 0.22]],
    ["sink-fill", [0.98, 0.83, 0.83], [0.48, 0.17, 0.18]],
    ["node-stroke", [0.22, 0.22, 0.24], [0.86, 0.86, 0.88]],
    ["node-glyph", [0.15, 0.15, 0.17], [0.92, 0.92, 0.94]],
  ] as [string, [number, number, number], [number, number, number]][])("%s", (name, l, d) => {
    // Half-way components (229.5) round up, as the sRGB hex of 0.90.34's value.
    const hex = (t: [number, number, number]) => rgb(t.map((v) => Math.floor(v * 255 + 0.5 + 1e-9) / 255) as [number, number, number]);
    expect(canvasColors("light")[camel(name)]).toBe(hex(l));
    expect(canvasColors("dark")[camel(name)]).toBe(hex(d));
  });

  it("steps each node colour 30 % toward black (light) or white (dark) under Increase Contrast", () => {
    const step = (c: RGBA, t: number): number[] => [c.r, c.g, c.b].map((v) => v + (t - v) * 0.3);
    for (const name of ["station-fill", "buffer-fill", "source-fill", "sink-fill", "node-stroke", "node-glyph"]) {
      for (const [theme, target] of [["light", 0], ["dark", 255]] as const) {
        const plain = canvasToken(`--canvas-${name}`, theme);
        const more = canvasToken(`--canvas-${name}`, theme, true);
        const want = step(plain, target);
        [more.r, more.g, more.b].forEach((v, i) => expect(Math.abs(v - want[i]), `${name} ${theme}`).toBeLessThanOrEqual(1.01));
      }
    }
  });

  it("draws the grid in black 26 % / 12 % (light) and white 30 % / 14 % (dark)", () => {
    expect(canvasColors("light").gridDot).toBe("rgba(0, 0, 0, 0.26)");
    expect(canvasColors("light").gridLine).toBe("rgba(0, 0, 0, 0.12)");
    expect(canvasColors("dark").gridDot).toBe("rgba(255, 255, 255, 0.3)");
    expect(canvasColors("dark").gridLine).toBe("rgba(255, 255, 255, 0.14)");
  });
});

const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()).replace(/^(\w)/, (c) => c) as "stationFill";

describe("accent-derived colours (CAN-221)", () => {
  it.each(["light", "dark"] as const)("hover ring, glow and selection fill at 35 %, marquee 8 %, halo 25 % of the accent (%s)", (theme) => {
    const c = canvasColors(theme);
    const accent = canvasToken("--accent", theme);
    const at = (a: number) => `rgba(${accent.r}, ${accent.g}, ${accent.b}, ${a})`;
    expect([c.hoverRing, c.selectionGlow, c.selectionFillStrong, c.marqueeFill, c.linkHalo]).toEqual([at(0.35), at(0.35), at(0.35), at(0.08), at(0.25)]);
    expect(c.accent).toBe(`#${[accent.r, accent.g, accent.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
  });

  it("steps hairlines to 1.5 under Increase Contrast", () => {
    expect(canvasColors("light").hairline).toBe(1);
    expect(canvasColors("light", true).hairline).toBe(1.5);
  });
});

describe("customer-class colours (CAN-055)", () => {
  it("are the system red, blue, green, orange, purple, cyan, pink and yellow, then golden-angle hues", () => {
    expect(canvasColors("light").classes).toEqual(["#ff3b30", "#007aff", "#28cd41", "#ff9500", "#af52de", "#55bef0", "#ff2d55", "#ffcc00"]);
    expect(canvasColors("dark").classes[0]).toBe("#ff453a");
    expect(canvasColors("light", true).classes[1]).toBe("#0040dd");
    const c = canvasColors("light");
    // Class 9: overflow 0 → hue 0, saturation 0.72, brightness 0.82.
    expect(classColor(c, 8)).toBe("#d13b3b");
    // Class 10: overflow 1 → hue 0.618, saturation 0.88, brightness 0.95.
    expect(classColor(c, 9)).toBe("#1d5bf2");
    expect(classColor(c, 9)).toBe(classColor(canvasColors("dark"), 9));
  });
});

describe("contrast the canvas relies on", () => {
  // The outline against its own fill is a shape edge, not text; 0.90.34's Increase Contrast dark
  // pair (both stepped toward white) measures 2.8:1, which is the floor kept here.
  const PAIRS: [string, string, number][] = [
    ["--canvas-text", "--canvas-bg", 7],
    ["--canvas-text-2", "--canvas-bg", 4.5],
    ["--canvas-text-2", "--canvas-chip-fill", 4.5],
    ["--canvas-on-tint", "--canvas-rho-light", 4.5],
    ["--canvas-on-tint", "--canvas-rho-moderate", 4.5],
    ["--canvas-on-tint", "--canvas-rho-heavy", 4.5],
    ["--canvas-node-stroke", "--canvas-bg", 3],
    ["--canvas-node-stroke", "--canvas-station-fill", 2.5],
    ["--canvas-node-stroke", "--canvas-buffer-fill", 2.5],
    ["--canvas-node-stroke", "--canvas-source-fill", 2.5],
    ["--canvas-node-stroke", "--canvas-sink-fill", 2.5],
    ["--canvas-node-glyph", "--canvas-station-fill", 3],
    ["--canvas-accent", "--canvas-bg", 3],
    ["--canvas-text", "--canvas-panel", 7],
  ];
  describe.each([
    ["light", "light", false],
    ["dark", "dark", false],
    ["light, increased contrast", "light", true],
    ["dark, increased contrast", "dark", true],
  ] as const)("%s", (_n, theme, more) => {
    it.each(PAIRS)("%s on %s ≥ %s:1", (fg, bg, min) => {
      expect(ratio(fg, bg, theme, more)).toBeGreaterThanOrEqual(min);
    });
  });
});

describe("the System copies", () => {
  it("repeats the Canvas dark block inside prefers-color-scheme, and Increase Contrast inside prefers-contrast", () => {
    expect(decls(block(':root:not([data-theme="light"])', canvas.indexOf("@media (prefers-color-scheme: dark)")))).toEqual(decls(block(':root[data-theme="dark"]')));
    expect(decls(block(":root:not([data-contrast])", canvas.indexOf("@media (prefers-contrast: more)")))).toEqual(decls(block(':root[data-contrast="more"]')));
  });

  it("gives every themed token a dark value and every stepped token a -more twin", () => {
    const root = decls(block(":root"));
    const dark = decls(block(':root[data-theme="dark"]'));
    const more = decls(block(':root[data-contrast="more"]'));
    for (const [k, v] of Object.entries(root)) if (v.startsWith("#") || v.startsWith("rgba")) expect(dark[k], k).toBeDefined();
    for (const [k, v] of Object.entries(more)) expect(v).toBe(`var(${k}-more)`);
  });
});

describe("the resolver", () => {
  it("follows var() chains and mixes in srgb, premultiplied", () => {
    const t = new Map([["--a", "#ff0000"], ["--b", "var(--a)"], ["--c", "color-mix(in srgb, var(--b) 50%, #0000ff)"], ["--d", "color-mix(in srgb, var(--a) 25%, transparent)"]]);
    expect(resolveColor(t, "var(--c)")).toEqual({ r: 127.5, g: 0, b: 127.5, a: 1 });
    expect(resolveColor(t, "var(--d)")).toEqual({ r: 255, g: 0, b: 0, a: 0.25 });
    expect(resolveColor(t, "rgba(1, 2, 3, 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  it("gives plain colour strings for every field, no var()", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const more of [false, true]) {
        for (const v of Object.values(canvasColors(theme, more))) {
          if (typeof v === "string" && v !== theme) expect(v).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/);
        }
      }
    }
  });
});
