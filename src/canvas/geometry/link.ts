// One link's drawn geometry (docs/specs/canvas.md §5, 0.90.34 `LinkGeometry` in CanvasGeometry.swift).
// Display space throughout: the scene passes display centres, the display-space bundle offset and
// the display-space bow (plan bulge × scale). Arithmetic follows the Swift line by line.
import type { NodeKind } from "../../lib/bnet";
import { cubicPoint, distance, flattenCubic, flattenQuad, pointToSegmentDistance, quadPoint, swiftMax, swiftMin, unit } from "./math";
import { exitDistance } from "./outline";
import type { Point } from "./types";

export type LinkRoute = { kind: "straight" } | { kind: "quad"; control: Point } | { kind: "cubic"; c1: Point; c2: Point };

/** One link's drawn geometry, display space. */
export interface LinkGeometry {
  /** On the source outline. */
  readonly start: Point;
  /** The arrowhead's base, where the stroke ends. */
  readonly base: Point;
  /** The arrowhead's tip, on the target outline. */
  readonly tip: Point;
  readonly wingLeft: Point;
  readonly wingRight: Point;
  readonly route: LinkRoute;
  /** Where the probability chip sits. */
  readonly labelAnchor: Point;
  /** The flattened stroke plus the tip, for distance queries. */
  readonly polyline: readonly Point[];
}

export const arrowLength = (scale: number) => swiftMax(6, 10 * scale);
export const ARROW_HALF_ANGLE = (28 * Math.PI) / 180;
export const lineWidth = (scale: number) => swiftMax(1, 2 * scale);
/** Half-width of the 10 pt hit slab, display pt. */
export const LINK_HIT_TOLERANCE = 5;
/** Clear air between an outline and the stroke, display pt. */
export const LINK_GAP = 1.5;
/** Flattening of a curved link's polyline. */
export const QUAD_SEGMENTS = 12;
export const CUBIC_SEGMENTS = 16;

/**
 * A straight or bowed link between two distinct nodes (`LinkGeometry.between`).
 * `parallelOffset`: display-space perpendicular shift for a bundle member. `bulge`: display-space
 * sideways bow of a quadratic; 0 is straight; positive bows to the right of travel.
 */
export function linkBetween(
  fromCentre: Point,
  fromKind: NodeKind,
  toCentre: Point,
  toKind: NodeKind,
  scale: number,
  parallelOffset = 0,
  bulge = 0,
): LinkGeometry {
  const gap = LINK_GAP;
  const dx = toCentre.x - fromCentre.x;
  const dy = toCentre.y - fromCentre.y;
  const len = swiftMax(Math.sqrt(dx * dx + dy * dy), 0.001);
  const u = { x: dx / len, y: dy / len };
  const perp = { x: -u.y, y: u.x };

  const fromC = { x: fromCentre.x + perp.x * parallelOffset, y: fromCentre.y + perp.y * parallelOffset };
  const toC = { x: toCentre.x + perp.x * parallelOffset, y: toCentre.y + perp.y * parallelOffset };
  const localOffset = { x: (perp.x * parallelOffset) / scale, y: (perp.y * parallelOffset) / scale };

  const arrowLen = arrowLength(scale);
  const wingSpread = arrowLen * Math.tan(ARROW_HALF_ANGLE);

  if (bulge === 0) {
    const tFrom = exitDistance(fromKind, localOffset, u) * scale + gap;
    const tTo = exitDistance(toKind, localOffset, { x: -u.x, y: -u.y }) * scale + gap;
    const start = { x: fromC.x + u.x * tFrom, y: fromC.y + u.y * tFrom };
    const tip = { x: toC.x - u.x * tTo, y: toC.y - u.y * tTo };
    const base = { x: tip.x - u.x * arrowLen, y: tip.y - u.y * arrowLen };
    const wl = { x: base.x + perp.x * wingSpread, y: base.y + perp.y * wingSpread };
    const wr = { x: base.x - perp.x * wingSpread, y: base.y - perp.y * wingSpread };
    const mid = { x: (start.x + base.x) / 2, y: (start.y + base.y) / 2 };
    // Label side: outward of the bundle for a parallel member, otherwise "above" the segment.
    let n = perp;
    if (parallelOffset !== 0) {
      if (parallelOffset < 0) n = { x: -n.x, y: -n.y };
    } else if (n.y > 0) {
      n = { x: -n.x, y: -n.y };
    }
    const labelGap = 9 + lineWidth(scale);
    const label = { x: mid.x + n.x * labelGap, y: mid.y + n.y * labelGap };
    return { start, base, tip, wingLeft: wl, wingRight: wr, route: { kind: "straight" }, labelAnchor: label, polyline: [start, base, tip] };
  }

  // Curved: aim the end tangents at the control point so the stroke leaves and enters the
  // outlines along the curve, not the chord.
  const mid = { x: (fromC.x + toC.x) / 2, y: (fromC.y + toC.y) / 2 };
  const control = { x: mid.x + perp.x * bulge, y: mid.y + perp.y * bulge };
  const dirStart = unit(fromC, control);
  const dirEnd = unit(control, toC);
  const tFrom = exitDistance(fromKind, localOffset, dirStart) * scale + gap;
  const tTo = exitDistance(toKind, localOffset, { x: -dirEnd.x, y: -dirEnd.y }) * scale + gap;
  const start = { x: fromC.x + dirStart.x * tFrom, y: fromC.y + dirStart.y * tFrom };
  const tip = { x: toC.x - dirEnd.x * tTo, y: toC.y - dirEnd.y * tTo };
  const base = { x: tip.x - dirEnd.x * arrowLen, y: tip.y - dirEnd.y * arrowLen };
  const endPerp = { x: -dirEnd.y, y: dirEnd.x };
  const wl = { x: base.x + endPerp.x * wingSpread, y: base.y + endPerp.y * wingSpread };
  const wr = { x: base.x - endPerp.x * wingSpread, y: base.y - endPerp.y * wingSpread };
  const poly = flattenQuad(start, control, base, QUAD_SEGMENTS);
  poly.push(tip);
  // Label on the outer (convex) side of the bow.
  const apex = quadPoint(start, control, base, 0.5);
  const side = bulge > 0 ? 1 : -1;
  const labelGap = 9 + lineWidth(scale);
  const label = { x: apex.x + perp.x * side * labelGap, y: apex.y + perp.y * side * labelGap };
  return { start, base, tip, wingLeft: wl, wingRight: wr, route: { kind: "quad", control }, labelAnchor: label, polyline: poly };
}

const SELF_A1 = (-55 * Math.PI) / 180; // upper-right (y is down)
const SELF_A2 = (-125 * Math.PI) / 180; // upper-left

/** A self-loop: a cubic arc above the node; `extraRadius` (display pt) nests further loops outward. */
export function selfLoop(centre: Point, kind: NodeKind, scale: number, extraRadius = 0): LinkGeometry {
  const gap = LINK_GAP;
  const d1 = { x: Math.cos(SELF_A1), y: Math.sin(SELF_A1) };
  const d2 = { x: Math.cos(SELF_A2), y: Math.sin(SELF_A2) };
  const r1 = exitDistance(kind, { x: 0, y: 0 }, d1) * scale + gap;
  const r2 = exitDistance(kind, { x: 0, y: 0 }, d2) * scale + gap;
  const loop = 40 * scale + extraRadius;
  const arrowLen = arrowLength(scale);
  const wingSpread = arrowLen * Math.tan(ARROW_HALF_ANGLE);

  const start = { x: centre.x + d1.x * r1, y: centre.y + d1.y * r1 };
  const tip = { x: centre.x + d2.x * r2, y: centre.y + d2.y * r2 };
  const c1 = { x: centre.x + d1.x * (r1 + loop) + 4 * scale, y: centre.y + d1.y * (r1 + loop) };
  const c2 = { x: centre.x + d2.x * (r2 + loop) - 4 * scale, y: centre.y + d2.y * (r2 + loop) };
  const dirEnd = unit(c2, tip);
  const base = { x: tip.x - dirEnd.x * arrowLen, y: tip.y - dirEnd.y * arrowLen };
  const endPerp = { x: -dirEnd.y, y: dirEnd.x };
  const wl = { x: base.x + endPerp.x * wingSpread, y: base.y + endPerp.y * wingSpread };
  const wr = { x: base.x - endPerp.x * wingSpread, y: base.y - endPerp.y * wingSpread };
  const poly = flattenCubic(start, c1, c2, base, CUBIC_SEGMENTS);
  poly.push(tip);
  const apex = cubicPoint(start, c1, c2, base, 0.5);
  const label = { x: apex.x, y: apex.y - 9 - lineWidth(scale) };
  return { start, base, tip, wingLeft: wl, wingRight: wr, route: { kind: "cubic", c1, c2 }, labelAnchor: label, polyline: poly };
}

/** `LinkGeometry.distance(to:)`: the nearest the stroke or arrowhead comes to `p`. */
export function polylineDistance(poly: readonly Point[], p: Point): number {
  if (poly.length === 1) return distance(p, poly[0]);
  let best = Infinity;
  const px = p.x;
  const py = p.y;
  for (let i = 1; i < poly.length; i++) {
    // CanvasMath.pointToSegmentDistance, inlined (same operations, no allocation): hit tests run
    // on every hover frame.
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let ex: number;
    let ey: number;
    if (lenSq === 0) {
      ex = px - a.x;
      ey = py - a.y;
    } else {
      const raw = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
      const t = swiftMax(0, swiftMin(1, raw));
      ex = px - (a.x + t * dx);
      ey = py - (a.y + t * dy);
    }
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d < best) best = d;
  }
  return best;
}

/** The plain (allocating) form, kept for reference tests. */
export function polylineDistanceReference(poly: readonly Point[], p: Point): number {
  if (poly.length === 1) return distance(p, poly[0]);
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const d = pointToSegmentDistance(p, poly[i - 1], poly[i]);
    if (d < best) best = d;
  }
  return best;
}

const f = (v: number) => String(v);

/** `strokePath` as an SVG path `d`: start, then the line / quad / cubic to the arrowhead's base. */
export function linkStrokePath(g: LinkGeometry): string {
  const m = `M${f(g.start.x)} ${f(g.start.y)}`;
  const b = `${f(g.base.x)} ${f(g.base.y)}`;
  switch (g.route.kind) {
    case "straight":
      return `${m}L${b}`;
    case "quad":
      return `${m}Q${f(g.route.control.x)} ${f(g.route.control.y)} ${b}`;
    case "cubic":
      return `${m}C${f(g.route.c1.x)} ${f(g.route.c1.y)} ${f(g.route.c2.x)} ${f(g.route.c2.y)} ${b}`;
  }
}

/** `arrowPath` as an SVG path `d`: the closed triangle tip → wingLeft → wingRight. */
export function linkArrowPath(g: LinkGeometry): string {
  return `M${f(g.tip.x)} ${f(g.tip.y)}L${f(g.wingLeft.x)} ${f(g.wingLeft.y)}L${f(g.wingRight.x)} ${f(g.wingRight.y)}Z`;
}
