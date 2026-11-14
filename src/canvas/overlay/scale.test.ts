// The overlay's colour scale: even steps, a change of kind near 1 for utilisation, both themes.
import { describe, expect, it } from "vitest";
import { canvasToken, type RGBA } from "../layers/colors";
import { KNEE, oklab, fromOklab, resultScale, ringWidth, RING_WIDTH } from "./scale";

function parse(c: string): RGBA {
  const n = parseInt(c.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lum = (c: RGBA) => {
  const f = (x: number) => (x / 255 <= 0.03928 ? x / 255 / 12.92 : Math.pow((x / 255 + 0.055) / 1.055, 2.4));
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (a: RGBA, b: RGBA) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

describe.each([
  ["light", false],
  ["dark", false],
  ["light", true],
  ["dark", true],
] as const)("the %s scale (contrast %s)", (theme, more) => {
  const s = resultScale(theme, more);
  const lab = (t: number, fixed: boolean) => oklab(parse(s.color(t, fixed)));

  it("gives opaque colours mixed from the stylesheet's tokens, ending on the accent", () => {
    expect(s.color(0.5, false)).toMatch(/^#[0-9a-f]{6}$/);
    expect(dist(lab(1, false), oklab(canvasToken("--accent", theme, more)))).toBeLessThan(0.01);
    expect(dist(lab(1, true), oklab(canvasToken("--critical", theme, more)))).toBeLessThan(0.01);
  });

  it("takes even perceptual steps along a relative scale", () => {
    const steps = Array.from({ length: 10 }, (_, i) => dist(lab(i / 10, false), lab((i + 1) / 10, false)));
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    expect(mean).toBeGreaterThan(0.01);
    for (const d of steps) expect(Math.abs(d - mean) / mean).toBeLessThan(0.15);
  });

  it("moves away from the canvas ground monotonically, so more is always more visible", () => {
    const ground = oklab(canvasToken("--canvas-bg", theme, more));
    let last = 0;
    for (let i = 0; i <= 10; i++) {
      const d = dist(lab(i / 10, false), ground);
      expect(d).toBeGreaterThan(last);
      last = d;
    }
    // Even the quiet end is told from the ground; the top is a clear graphic (3:1).
    expect(contrast(parse(s.color(1, false)), canvasToken("--canvas-bg", theme, more))).toBeGreaterThanOrEqual(3);
    expect(contrast(parse(s.color(1, true)), canvasToken("--canvas-bg", theme, more))).toBeGreaterThanOrEqual(3);
  });

  it("changes character near 1 on the utilisation scale: one hue up to the knee, then a turn to the critical colour", () => {
    const hue = (t: number) => {
      const [, a, b] = lab(t, true);
      return Math.atan2(b, a);
    };
    // Below the knee the hue is the accent's; the last 15 % moves further in colour than the first 85 %' steps of the same size.
    expect(Math.abs(hue(0.6) - hue(KNEE))).toBeLessThan(0.12);
    expect(Math.abs(hue(1) - hue(KNEE))).toBeGreaterThan(1);
    const before = dist(lab(KNEE - 0.15, true), lab(KNEE, true));
    const after = dist(lab(KNEE, true), lab(1, true));
    expect(after).toBeGreaterThan(2 * before);
    // An overloaded station (ρ > 1) is the top of the scale, not off it.
    expect(s.color(1.4, true)).toBe(s.color(1, true));
    expect(s.color(Number.NaN, true)).toBe(s.color(0, true));
  });
});

describe("the scale's helpers", () => {
  it("round-trips sRGB through OKLab", () => {
    const c = fromOklab(oklab({ r: 24, g: 107, b: 197, a: 1 }));
    expect(Math.round(c.r)).toBe(24);
    expect(Math.round(c.g)).toBe(107);
    expect(Math.round(c.b)).toBe(197);
  });

  it("widens the ring with the value, so the encoding is not colour alone", () => {
    expect(ringWidth(0)).toBe(RING_WIDTH.min);
    expect(ringWidth(1)).toBe(RING_WIDTH.max);
    expect(ringWidth(0.5)).toBeGreaterThan(ringWidth(0.25));
    expect(ringWidth(7)).toBe(RING_WIDTH.max);
  });
});
