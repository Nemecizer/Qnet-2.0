// Where the tour's callout sits (new in 2.1, ROADMAP C2; ledger UX-217): beside its target, never
// over it, and always wholly inside the window. Pure arithmetic over rectangles in the window's
// own coordinates, so it is the same in the main window and in a detached pane's.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}

/** Which side of the target the callout is on; "inside" a target too large to stand beside (the canvas); "corner" with no target. */
export type Side = "bottom" | "top" | "right" | "left" | "inside" | "corner";

export interface Placement {
  left: number;
  top: number;
  side: Side;
  /** Where the pointer sits along the callout's edge facing the target, in px from that edge's start; null when there is none. */
  arrow: number | null;
}

export const GAP = 12;
export const MARGIN = 12;
/** The pointer keeps this far from the callout's corners. */
export const ARROW_INSET = 18;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The callout's place for a target: the preferred side when the callout fits there, else below,
 * above, right, left in turn; inside the target's bottom-right corner when it fits nowhere beside
 * it; the window's bottom-right corner with no target. Along the other axis it is centred on the
 * target and pushed back inside the window, and the pointer stays on the target's centre.
 */
export function placeCallout(target: Box | null, size: Size, viewport: Size, prefer: Exclude<Side, "inside" | "corner"> = "bottom"): Placement {
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  if (!target) return { left: maxLeft, top: maxTop, side: "corner", arrow: null };
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const fits = {
    bottom: target.top + target.height + GAP + size.height <= viewport.height - MARGIN,
    top: target.top - GAP - size.height >= MARGIN,
    right: target.left + target.width + GAP + size.width <= viewport.width - MARGIN,
    left: target.left - GAP - size.width >= MARGIN,
  };
  const side = ([prefer, "bottom", "top", "right", "left"] as const).find((s) => fits[s]);
  if (!side) {
    return {
      left: clamp(Math.min(target.left + target.width, viewport.width) - size.width - MARGIN, MARGIN, maxLeft),
      top: clamp(Math.min(target.top + target.height, viewport.height) - size.height - MARGIN, MARGIN, maxTop),
      side: "inside",
      arrow: null,
    };
  }
  if (side === "bottom" || side === "top") {
    const left = clamp(cx - size.width / 2, MARGIN, maxLeft);
    const top = clamp(side === "bottom" ? target.top + target.height + GAP : target.top - GAP - size.height, MARGIN, maxTop);
    return { left, top, side, arrow: clamp(cx - left, ARROW_INSET, size.width - ARROW_INSET) };
  }
  const top = clamp(cy - size.height / 2, MARGIN, maxTop);
  const left = clamp(side === "right" ? target.left + target.width + GAP : target.left - GAP - size.width, MARGIN, maxLeft);
  return { left, top, side, arrow: clamp(cy - top, ARROW_INSET, size.height - ARROW_INSET) };
}

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
/** How far apart two boxes are, edge to edge (0 when they touch or overlap). */
export function boxDistance(a: Box, b: Box): number {
  const dx = Math.max(0, a.left - (b.left + b.width), b.left - (a.left + a.width));
  const dy = Math.max(0, a.top - (b.top + b.height), b.top - (a.top + a.height));
  return Math.hypot(dx, dy);
}

/**
 * The callout's place when it must stay inside `region` (the canvas, while a network is drawn)
 * and point at a `target` outside or inside it (a tool, a node): as near the target as it can be
 * without lying over it, and off the `avoid` boxes (the nodes already placed) when any such
 * place exists; lying over a `soft` box (the empty canvas's hint, which is wider than the room
 * beside it) costs a little, 1 px of distance per 100 px² covered, so the callout clips the
 * hint's margin rather than cross the canvas. Beside the target, level with it, when the region reaches
 * that far — then it has a pointer; otherwise the nearest place along the region's edges. It
 * replaces "below the canvas, centred", which left the callout some 300 px from the tool it was
 * about (gap FIX-106). Falls back to `placeCallout` when the region cannot hold the callout.
 */
export function placeNear(target: Box, region: Box, size: Size, viewport: Size, avoid: readonly Box[] = [], soft: readonly Box[] = []): Placement {
  const lo = { left: Math.max(region.left, 0) + MARGIN, top: Math.max(region.top, 0) + MARGIN };
  // Sideways it never leaves the region (beside it are the panes it must not cover); downwards
  // it may run past the region's foot into the window when that is what keeps it off the nodes,
  // at a small cost (1 px of distance per 400 px² outside).
  const foot = Math.min(region.top + region.height, viewport.height) - MARGIN;
  const hi = { left: Math.min(region.left + region.width, viewport.width) - MARGIN - size.width, top: viewport.height - MARGIN - size.height };
  if (hi.left < lo.left || foot - size.height < lo.top) return placeCallout(target, size, viewport);
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  // The places tried: beside the target and level with it, the region's edges and middle, and
  // just clear of each box to keep off (below a row of nodes, say), on each axis.
  const along = (beforeEdge: number, afterEdge: number, centre: number, extent: number, min: number, max: number, clear: [number, number][]) =>
    [...new Set([afterEdge + GAP, beforeEdge - GAP - extent, centre - extent / 2, min, max, (min + max) / 2, ...clear.flatMap(([a, b]) => [b + GAP, a - GAP - extent])].map((v) => clamp(v, min, max)))];
  const xs = along(target.left, target.left + target.width, cx, size.width, lo.left, hi.left, avoid.map((b) => [b.left, b.left + b.width]));
  const ys = [...along(target.top, target.top + target.height, cy, size.height, lo.top, hi.top, avoid.map((b) => [b.top, b.top + b.height])), foot - size.height];
  // Over the target, or closer to it than GAP, is the last resort.
  const keepOff = { left: target.left - GAP + 1e-6, top: target.top - GAP + 1e-6, width: target.width + 2 * GAP - 2e-6, height: target.height + 2 * GAP - 2e-6 };
  let best: { left: number; top: number; cost: number } | null = null;
  for (const left of xs) {
    for (const top of ys) {
      const box = { left, top, width: size.width, height: size.height };
      // Over something to avoid is the next-to-last resort.
      const covered = (boxes: readonly Box[]) => boxes.reduce((a, b) => a + overlap(box, b), 0);
      // Among places equally near, the one most nearly level with the target (it gets the pointer).
      const level = Math.min(Math.abs(top + size.height / 2 - cy), Math.abs(left + size.width / 2 - cx)) / 1e3;
      const cost = overlap(box, keepOff) * 1e6 + (covered(avoid) > 0 ? 1e6 + covered(avoid) : 0) + covered(soft) / 100 + (Math.max(0, top + size.height - foot) * size.width) / 400 + boxDistance(box, target) + level;
      if (!best || cost < best.cost - 1e-9) best = { left, top, cost };
    }
  }
  const { left, top } = best!;
  const levelY = cy >= top + ARROW_INSET && cy <= top + size.height - ARROW_INSET;
  const levelX = cx >= left + ARROW_INSET && cx <= left + size.width - ARROW_INSET;
  if (levelY && left >= target.left + target.width) return { left, top, side: "right", arrow: cy - top };
  if (levelY && left + size.width <= target.left) return { left, top, side: "left", arrow: cy - top };
  if (levelX && top >= target.top + target.height) return { left, top, side: "bottom", arrow: cx - left };
  if (levelX && top + size.height <= target.top) return { left, top, side: "top", arrow: cx - left };
  return { left, top, side: "inside", arrow: null };
}

/**
 * The callout's place with no target (the tour's last card): the window's bottom-right corner,
 * unless it would lie over an `avoid` box (the Results pane's header and view switcher, which the
 * card has just sent the reader to). Then, in turn: at the right edge just above that box (over
 * the canvas), and the other three corners — the first that covers nothing, or the one that
 * covers least.
 */
export function placeCorner(size: Size, viewport: Size, avoid: readonly Box[] = []): Placement {
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  const beside = avoid.map((b): [number, number] => [maxLeft, clamp(b.top - GAP - size.height, MARGIN, maxTop)]);
  let best: { left: number; top: number; cost: number } | null = null;
  for (const [left, top] of [[maxLeft, maxTop], ...beside, [MARGIN, maxTop], [maxLeft, MARGIN], [MARGIN, MARGIN]]) {
    const box = { left, top, width: size.width, height: size.height };
    const cost = avoid.reduce((a, b) => a + overlap(box, b), 0);
    if (!best || cost < best.cost) best = { left, top, cost };
  }
  return { left: best!.left, top: best!.top, side: "corner", arrow: null };
}

/** The spotlight ring: the target grown by `pad`, kept inside the window (so a pane that fills it still shows a ring). */
export function ringBox(target: Box, viewport: Size, pad = 4): Box {
  const left = Math.max(2, target.left - pad);
  const top = Math.max(2, target.top - pad);
  const right = Math.min(viewport.width - 2, target.left + target.width + pad);
  const bottom = Math.min(viewport.height - 2, target.top + target.height + pad);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export const sameBox = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
