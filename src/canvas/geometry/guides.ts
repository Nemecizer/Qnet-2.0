// Smart alignment guides (docs/specs/canvas.md §9, 0.90.34 `SmartGuides` in CanvasGeometry.swift).
// Pure: interaction calls `matchGuides` during a node drag with the dragged node's candidate world
// rect, every other node's world rect and `GUIDE_TOLERANCE / max(scale, 0.01)`, then stores the
// result with `editor.setView({ activeAlignGuides })`; drawing draws it.
import type { AlignGuides } from "../../editor/editor";
import { offsetRect } from "./math";
import { maxX, maxY, midX, midY, minX, minY, type Rect } from "./types";

/** Display-space distance at which a drag snaps to a neighbour (callers divide by the scale). */
export const GUIDE_TOLERANCE = 4;

/** No match (the same value as editor.ts `NO_GUIDES`, kept here so this module stays pure). */
export const NO_MATCH: AlignGuides = Object.freeze({ adjustment: { width: 0, height: 0 }, x: null, y: null, anchor: null, xPartner: null, yPartner: null, xSpacing: null, ySpacing: null });

export type SpacingGuide = { first: Rect; second: Rect };

export function guidesEmpty(m: AlignGuides): boolean {
  return m.x === null && m.y === null && m.xSpacing === null && m.ySpacing === null;
}

/** Forget the horizontal match (the grid won that axis). */
export function dropX(m: AlignGuides): AlignGuides {
  return { ...m, x: null, xPartner: null, xSpacing: null, adjustment: { width: 0, height: m.adjustment.height } };
}

/** Forget the vertical match. */
export function dropY(m: AlignGuides): AlignGuides {
  return { ...m, y: null, yPartner: null, ySpacing: null, adjustment: { width: m.adjustment.width, height: 0 } };
}

/** The match with `anchor` set (moveAnchoredNodes sets it to the candidate offset by the final adjustment). */
export function withAnchor(m: AlignGuides, anchor: Rect | null): AlignGuides {
  return { ...m, anchor };
}

/**
 * Best alignment of `anchor` (the dragged node's candidate world rect) against `others`, within
 * `tolerance` world pt. Per axis: the closest edge/centre pair under tolerance (strictly closer
 * replaces, so the first found wins a tie); equal spacing is tried only on an axis with no edge
 * match, so a node never gets two competing pulls.
 */
export function matchGuides(anchor: Rect, others: readonly Rect[], tolerance: number): AlignGuides {
  if (!(tolerance > 0) || others.length === 0) return NO_MATCH;
  const ax = [minX(anchor), midX(anchor), maxX(anchor)];
  const ay = [minY(anchor), midY(anchor), maxY(anchor)];
  let adjW = 0;
  let adjH = 0;
  let x: number | null = null;
  let y: number | null = null;
  let xPartner: Rect | null = null;
  let yPartner: Rect | null = null;
  let xSpacing: SpacingGuide | null = null;
  let ySpacing: SpacingGuide | null = null;
  let bestDX = tolerance;
  let bestDY = tolerance;
  for (const other of others) {
    const ox = [minX(other), midX(other), maxX(other)];
    const oy = [minY(other), midY(other), maxY(other)];
    for (const av of ax) {
      for (const ov of ox) {
        if (Math.abs(ov - av) < bestDX) {
          bestDX = Math.abs(ov - av);
          adjW = ov - av;
          x = ov;
          xPartner = other;
        }
      }
    }
    for (const av of ay) {
      for (const ov of oy) {
        if (Math.abs(ov - av) < bestDY) {
          bestDY = Math.abs(ov - av);
          adjH = ov - av;
          y = ov;
          yPartner = other;
        }
      }
    }
  }
  if (x === null) {
    const s = spacing(anchor, others, tolerance, "horizontal");
    if (s) {
      adjW = s.adjustment;
      xSpacing = s.guide;
    }
  }
  if (y === null) {
    const s = spacing(anchor, others, tolerance, "vertical");
    if (s) {
      adjH = s.adjustment;
      ySpacing = s.guide;
    }
  }
  const empty = x === null && y === null && xSpacing === null && ySpacing === null;
  return {
    adjustment: { width: adjW, height: adjH },
    x,
    y,
    anchor: empty ? null : offsetRect(anchor, adjW, adjH),
    xPartner,
    yPartner,
    xSpacing,
    ySpacing,
  };
}

/** `SmartGuides.match`, under 0.90.34's name. */
export const SmartGuides = { match: matchGuides, tolerance: GUIDE_TOLERANCE, dropX, dropY } as const;

type Axis = "horizontal" | "vertical";

function spacing(anchor: Rect, others: readonly Rect[], tolerance: number, axis: Axis): { adjustment: number; guide: SpacingGuide } | null {
  const h = axis === "horizontal";
  const lo = (r: Rect) => (h ? minX(r) : minY(r));
  const hi = (r: Rect) => (h ? maxX(r) : maxY(r));
  const crossMid = (r: Rect) => (h ? midY(r) : midX(r));
  const crossExtent = (r: Rect) => (h ? r.height : r.width);

  const band = crossExtent(anchor);
  const row = others.filter((r) => Math.abs(crossMid(r) - crossMid(anchor)) <= band);
  if (row.length < 2) return null;
  const before = row.filter((r) => hi(r) <= lo(anchor) + tolerance).sort((p, q) => (hi(p) > hi(q) ? -1 : hi(q) > hi(p) ? 1 : 0));
  const after = row.filter((r) => lo(r) >= hi(anchor) - tolerance).sort((p, q) => (lo(p) < lo(q) ? -1 : lo(q) < lo(p) ? 1 : 0));

  const gapRect = (from: number, to: number): Rect => {
    const c = crossMid(anchor);
    return h ? { x: from, y: c, width: to - from, height: 0 } : { x: c, y: from, width: 0, height: to - from };
  };

  let bestAdjust = tolerance;
  let result: { adjustment: number; guide: SpacingGuide } | null = null;

  // Between a neighbour on each side: equalise the two gaps.
  if (before.length > 0 && after.length > 0) {
    const l = before[0];
    const r = after[0];
    const gapL = lo(anchor) - hi(l);
    const gapR = lo(r) - hi(anchor);
    const adjust = (gapR - gapL) / 2;
    if (gapL >= 0 && gapR >= 0 && Math.abs(adjust) < bestAdjust) {
      bestAdjust = Math.abs(adjust);
      result = { adjustment: adjust, guide: { first: gapRect(hi(l), lo(anchor) + adjust), second: gapRect(hi(anchor) + adjust, lo(r)) } };
    }
  }
  // Beyond two neighbours on the near side: repeat their gap.
  if (before.length >= 2) {
    const l1 = before[0];
    const l2 = before[1];
    const gapPrev = lo(l1) - hi(l2);
    const gapNew = lo(anchor) - hi(l1);
    const adjust = gapPrev - gapNew;
    if (gapPrev > 0 && gapNew >= 0 && Math.abs(adjust) < bestAdjust) {
      bestAdjust = Math.abs(adjust);
      result = { adjustment: adjust, guide: { first: gapRect(hi(l2), lo(l1)), second: gapRect(hi(l1), lo(anchor) + adjust) } };
    }
  }
  if (after.length >= 2) {
    const r1 = after[0];
    const r2 = after[1];
    const gapPrev = lo(r2) - hi(r1);
    const gapNew = lo(r1) - hi(anchor);
    const adjust = gapNew - gapPrev;
    if (gapPrev > 0 && gapNew >= 0 && Math.abs(adjust) < bestAdjust) {
      bestAdjust = Math.abs(adjust);
      result = { adjustment: adjust, guide: { first: gapRect(hi(anchor) + adjust, lo(r1)), second: gapRect(hi(r1), lo(r2)) } };
    }
  }
  return result;
}
