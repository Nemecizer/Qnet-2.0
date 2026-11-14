// The chart colour tokens in styles.css (ledger VIZ-003): each tier and series colour is a mark
// that must be seen on the pane surfaces and on the white of an export (WCAG 3:1 for graphics), in
// both themes; the System copy equals the Dark block; and no two tiers share a colour or a shape.
import { describe, expect, it } from "vitest";
import { canvasToken, type RGBA } from "../canvas/layers/colors";
import css from "../styles.css?raw";
import { lightValue, SERIES_COUNT, seriesToken, TIER_STYLE } from "./theme";

const TIERS = ["--tier-exact", "--tier-simulation", "--tier-approximation", "--tier-diffusion", "--tier-bound"];
const SERIES = Array.from({ length: SERIES_COUNT }, (_, i) => `--series-${i + 1}`);

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (c: RGBA) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const ratio = (a: RGBA, b: RGBA) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };

describe("chart colour tokens", () => {
  it.each(["light", "dark"] as const)("every tier and series colour is at least 3:1 on the surfaces (%s)", (theme) => {
    for (const contrast of [false, true]) {
      for (const name of [...TIERS, ...SERIES]) {
        const c = canvasToken(name, theme, contrast);
        for (const ground of ["--surface", "--surface-2"]) expect(ratio(c, canvasToken(ground, theme, contrast)), `${name} on ${ground} (${theme})`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("the light values, which every export uses, are at least 3:1 on white", () => {
    for (const name of [...TIERS, ...SERIES]) expect(ratio(canvasToken(name, "light"), WHITE), name).toBeGreaterThanOrEqual(3);
    expect(lightValue("--tier-exact")).toBe("#2b5fd9");
  });

  it("the text that sits beside the marks stays legible on the chart card", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const name of ["--text", "--text-2", "--muted"]) expect(ratio(canvasToken(name, theme), canvasToken("--surface", theme)), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("repeats the Dark block exactly inside prefers-color-scheme", () => {
    const block = css.slice(css.indexOf("/* ---------- Charts"), css.indexOf("/* ---------- end Charts"));
    const decls = (text: string) => Object.fromEntries([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    const dark = block.slice(block.indexOf(':root[data-theme="dark"]'), block.indexOf("@media"));
    const media = block.slice(block.indexOf("@media"));
    expect(decls(media)).toEqual(decls(dark));
    expect(Object.keys(decls(dark)).sort()).toEqual([...TIERS, ...SERIES].sort());
  });

  it("gives each tier its own colour and its own shape, and never cycles the series", () => {
    const styles = Object.values(TIER_STYLE);
    expect(new Set(styles.map((s) => s.color)).size).toBe(styles.length);
    expect(new Set(styles.map((s) => s.shape)).size).toBe(styles.length);
    for (const theme of ["light", "dark"] as const) {
      expect(new Set([...TIERS].map((n) => JSON.stringify(canvasToken(n, theme)))).size).toBe(TIERS.length);
      expect(new Set([...SERIES].map((n) => JSON.stringify(canvasToken(n, theme)))).size).toBe(SERIES.length);
    }
    expect(seriesToken(0)).toBe("--series-1");
    expect(seriesToken(7)).toBe("--series-8");
    expect(seriesToken(8)).toBeNull();
  });
});
