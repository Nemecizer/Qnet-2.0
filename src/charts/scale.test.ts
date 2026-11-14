// Scales and ticks (ledger VIZ-001, VIZ-002).
import { describe, expect, it } from "vitest";
import { bandScale, extent, finite, linearScale, niceStep, niceTicks, stepDecimals, tickLabel } from "./scale";

describe("nice ticks", () => {
  it("steps by 1, 2, 2.5 or 5 times a power of ten and covers the data", () => {
    expect(niceTicks(0, 9.27).values).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(8.4, 9.8).values).toEqual([8, 8.5, 9, 9.5, 10]);
    expect(niceTicks(0, 1).values).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0.11, 0.93, 4).values).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(niceStep(0, 100, 5)).toBe(20);
    expect(niceStep(0, 7, 5)).toBe(2);
  });

  it("writes ticks without floating-point dust", () => {
    const t = niceTicks(0.1, 0.7, 6);
    expect(t.values).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(t.values.map((x) => tickLabel(x, t))).toEqual(["0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7"]);
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(5)).toBe(0);
  });

  it("gives one value, or all equal values, a domain round it", () => {
    expect(niceTicks(9, 9).values).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(0, 0).values).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const neg = niceTicks(-3, -3);
    expect(neg.min).toBeLessThanOrEqual(-3);
    expect(neg.max).toBe(0);
  });

  it("handles negative ranges, swapped ends and ranges across zero", () => {
    expect(niceTicks(-9.3, -0.4).values).toEqual([-10, -8, -6, -4, -2, 0]);
    expect(niceTicks(4, -4).values).toEqual([-4, -2, 0, 2, 4]);
    expect(niceTicks(-4, 4).values).toContain(0);
    expect(tickLabel(-2, niceTicks(-4, 4))).toBe("−2");
    expect(tickLabel(-0, niceTicks(-4, 4))).toBe("0");
  });

  it("handles a huge range and a tiny one in a handful of ticks", () => {
    const huge = niceTicks(1e-9, 3.2e12);
    expect(huge.values.length).toBeLessThanOrEqual(9);
    expect(huge.min).toBe(0);
    expect(huge.max).toBeGreaterThanOrEqual(3.2e12);
    expect(tickLabel(huge.values[1], huge)).toMatch(/^\d(\.\d+)?e\d+$/);
    const tiny = niceTicks(1.0000001, 1.0000004);
    expect(tiny.values.length).toBeGreaterThanOrEqual(3);
    expect(tiny.values.length).toBeLessThanOrEqual(9);
    expect(new Set(tiny.values).size).toBe(tiny.values.length);
    const small = niceTicks(0, 3e-7);
    expect(tickLabel(small.values[1], small)).toMatch(/e-\d+$/);
  });

  it("reads a non-finite end as zero rather than looping", () => {
    expect(niceTicks(NaN, 5).values).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0, Infinity).values).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe("the scales", () => {
  it("filter NaN, infinities and missing values out of the extent", () => {
    expect(finite([1, NaN, null, undefined, Infinity, -2])).toEqual([1, -2]);
    expect(extent([NaN, 3, 1, Infinity, 2])).toEqual([1, 3]);
    expect(extent([NaN])).toBeNull();
  });

  it("map the nice domain onto the range, in either direction, and back", () => {
    const x = linearScale([2, 9.27, NaN], [100, 600], { zero: true });
    expect(x.domain).toEqual([0, 10]);
    expect(x(0)).toBe(100);
    expect(x(10)).toBe(600);
    expect(x(5)).toBe(350);
    expect(x.invert(350)).toBe(5);
    const y = linearScale([8.5, 9.75], [300, 20]);
    expect(y(y.domain[0])).toBe(300);
    expect(y(y.domain[1])).toBe(20);
    expect(y.domain[0]).toBeGreaterThan(0);
  });

  it("stand on a default domain when there is nothing finite to scale", () => {
    const x = linearScale([NaN], [0, 100]);
    expect(x.domain).toEqual([0, 1]);
    expect(x(0.5)).toBe(50);
  });

  it("divide a range into equal bands with padding", () => {
    const b = bandScale(["a", "b", "c", "d"], [0, 400], 0.2);
    expect(b.step).toBe(100);
    expect(b.bandwidth).toBe(80);
    expect(b("a")).toBe(10);
    expect(b.center("d")).toBe(350);
    expect(b("nope")).toBeNaN();
    expect(bandScale([], [0, 100]).bandwidth).toBeGreaterThan(0);
  });
});
