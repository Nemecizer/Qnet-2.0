// Canvas arithmetic helpers (0.90.34 `CanvasMath`, CanvasGeometry.swift), written to give the same
// doubles as the Swift: the same operation order, `sqrt(dx·dx + dy·dy)` rather than Math.hypot,
// Swift's `min`/`max` NaN behaviour, `.rounded()` with ties away from zero, and CoreGraphics'
// rect tests (a zero-width rect inside another one DOES intersect it in CG; see `cgIntersects`).
import type { Point, Rect } from "./types";

/** Swift `min(x, y)`: `y < x ? y : x` (so `min(NaN, 1)` is NaN and `min(1, NaN)` is 1). */
export function swiftMin(x: number, y: number): number {
  return y < x ? y : x;
}

/** Swift `max(x, y)`: `y >= x ? y : x` (so `max(NaN, 1)` is NaN and `max(1, NaN)` is 1). */
export function swiftMax(x: number, y: number): number {
  return y >= x ? y : x;
}

/** Swift `.rounded()`: to nearest, ties away from zero (Math.round rounds −2.5 to −2). */
export function roundSwift(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function length(w: number, h: number): number {
  return Math.sqrt(w * w + h * h);
}

export function unit(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = swiftMax(Math.sqrt(dx * dx + dy * dy), 0.001);
  return { x: dx / len, y: dy / len };
}

/** Closed segment p0–p1 touches `r` (Liang–Barsky clip, as `CanvasMath.segmentIntersectsRect`). */
export function segmentIntersectsRect(p0: Point, p1: Point, r: Rect): boolean {
  return segIntersectsRect(p0.x, p0.y, p1.x, p1.y, r.x, r.y, r.x + r.width, r.y + r.height);
}

/** The same test on bare coordinates (rect given as min/max), so the router allocates nothing. */
export function segIntersectsRect(x0: number, y0: number, x1: number, y1: number, rminX: number, rminY: number, rmaxX: number, rmaxY: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  for (let edge = 0; edge < 4; edge++) {
    let p: number;
    let q: number;
    switch (edge) {
      case 0:
        p = -dx;
        q = x0 - rminX;
        break;
      case 1:
        p = dx;
        q = rmaxX - x0;
        break;
      case 2:
        p = -dy;
        q = y0 - rminY;
        break;
      default:
        p = dy;
        q = rmaxY - y0;
    }
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

export function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);
  const t = swiftMax(0, swiftMin(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function quadPoint(p0: Point, c: Point, p1: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
  };
}

export function cubicPoint(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

export function flattenQuad(p0: Point, c: Point, p1: Point, segments: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= segments; i++) out.push(quadPoint(p0, c, p1, i / segments));
  return out;
}

export function flattenCubic(p0: Point, c1: Point, c2: Point, p1: Point, segments: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= segments; i++) out.push(cubicPoint(p0, c1, c2, p1, i / segments));
  return out;
}

/** CanvasMath.clampWorld: ±100 000 on each axis. */
export function clampWorld(p: Point): Point {
  const bound = 100_000;
  return { x: swiftMin(swiftMax(p.x, -bound), bound), y: swiftMin(swiftMax(p.y, -bound), bound) };
}

/** One axis of CGRect.intersects on standardised extents: equal minimums always overlap; otherwise
 * the later one must start strictly before the earlier one ends. Checked against CoreGraphics
 * (200 000 random integer rects, ties and zero sizes included, no disagreement). */
function axisOverlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  if (a0 === b0) return true;
  if (b0 > a0) return b0 < a1;
  return a0 < b1;
}

/**
 * CoreGraphics' CGRect.intersects, exactly: touching edges do NOT intersect, but a zero-width or
 * zero-height rect inside another DOES (so a horizontal chord's flat bounding box still meets the
 * bodies it crosses). Differs from types.ts `intersects`, which treats empty rects as touching
 * nothing; the router and the chip declutter need CG's rule.
 */
export function cgIntersects(a: Rect, b: Rect): boolean {
  const ax0 = a.width < 0 ? a.x + a.width : a.x;
  const ax1 = a.width < 0 ? a.x : a.x + a.width;
  const ay0 = a.height < 0 ? a.y + a.height : a.y;
  const ay1 = a.height < 0 ? a.y : a.y + a.height;
  const bx0 = b.width < 0 ? b.x + b.width : b.x;
  const bx1 = b.width < 0 ? b.x : b.x + b.width;
  const by0 = b.height < 0 ? b.y + b.height : b.y;
  const by1 = b.height < 0 ? b.y : b.y + b.height;
  return axisOverlaps(ax0, ax1, bx0, bx1) && axisOverlaps(ay0, ay1, by0, by1);
}

/** cgIntersects on bare min/max extents (both already standardised). */
export function cgIntersectsXY(ax0: number, ay0: number, ax1: number, ay1: number, bx0: number, by0: number, bx1: number, by1: number): boolean {
  return axisOverlaps(ax0, ax1, bx0, bx1) && axisOverlaps(ay0, ay1, by0, by1);
}

export function offsetRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}
