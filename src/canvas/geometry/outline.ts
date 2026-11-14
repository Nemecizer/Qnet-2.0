// Node outlines (docs/specs/canvas.md §4, 0.90.34 `NodeOutline` and CanvasScene's rect helpers).
// Shape metrics are world units at zoom 1; the node view, the router, hit-testing and the marquee
// all read these, so an arrow lands exactly on the drawn outline and a click lands on what is drawn.
import type { BnetNode, NodeKind } from "../../lib/bnet";
import { insetBy, intersects, type Point, type Rect, type Size } from "./types";

export function outlineSize(kind: NodeKind): Size {
  switch (kind) {
    case "station":
      return { width: 48, height: 48 }; // circle
    case "buffer":
      return { width: 52, height: 44 }; // rectangle with two dividers
    case "source":
      return { width: 46, height: 46 }; // diamond
    case "sink":
      return { width: 48, height: 48 }; // rounded square
  }
}

export const SINK_CORNER_RADIUS = 8;

/** The label block hung under every node. */
export const LABEL_BLOCK_WIDTH = 76;
export const LABEL_BLOCK_GAP = 4;

export function labelBlockHeight(kind: NodeKind): number {
  switch (kind) {
    case "station":
    case "source":
      return 36; // name + distribution + μ·SCV rows
    case "buffer":
      return 24; // name + buffer-size row
    case "sink":
      return 13; // name only
  }
}

export function boundingRadius(kind: NodeKind): number {
  const s = outlineSize(kind);
  return Math.max(s.width, s.height) / 2 + 2;
}

/** Exact containment in node-local world coordinates (origin at the centre, y down), widened by `slop`. */
export function outlineContains(kind: NodeKind, p: Point, slop = 0): boolean {
  const s = outlineSize(kind);
  const hw = s.width / 2 + slop;
  const hh = s.height / 2 + slop;
  switch (kind) {
    case "station":
      return p.x * p.x + p.y * p.y <= hw * hw;
    case "source":
      return Math.abs(p.x) / hw + Math.abs(p.y) / hh <= 1;
    case "buffer":
      return Math.abs(p.x) <= hw && Math.abs(p.y) <= hh;
    case "sink": {
      if (!(Math.abs(p.x) <= hw && Math.abs(p.y) <= hh)) return false;
      const cr = SINK_CORNER_RADIUS + slop;
      const ix = Math.abs(p.x) - (hw - cr);
      const iy = Math.abs(p.y) - (hh - cr);
      if (ix > 0 && iy > 0) return ix * ix + iy * iy <= cr * cr;
      return true;
    }
  }
}

/** How far from `origin` along unit vector `u` the outline is: a 14-step bisection against `outlineContains`. */
export function exitDistance(kind: NodeKind, origin: Point, u: Point): number {
  if (!outlineContains(kind, origin)) return 0;
  let lo = 0;
  let hi = boundingRadius(kind) * 1.5;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const p = { x: origin.x + u.x * mid, y: origin.y + u.y * mid };
    if (outlineContains(kind, p)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The node's body: centre ± half its outline, world space. */
export function nodeWorldRect(n: Pick<BnetNode, "kind" | "position">): Rect {
  const s = outlineSize(n.kind);
  return { x: n.position[0] - s.width / 2, y: n.position[1] - s.height / 2, width: s.width, height: s.height };
}

/** The label block: 76 wide, centred under the body, LABEL_BLOCK_GAP below it. The top is the body
 * rect's maxY, ((y − h/2) + h), as 0.90.34 computed it, so it matches to the bit. */
export function nodeLabelRect(n: Pick<BnetNode, "kind" | "position">): Rect {
  const s = outlineSize(n.kind);
  return {
    x: n.position[0] - LABEL_BLOCK_WIDTH / 2,
    y: n.position[1] - s.height / 2 + s.height + LABEL_BLOCK_GAP,
    width: LABEL_BLOCK_WIDTH,
    height: labelBlockHeight(n.kind),
  };
}

/**
 * Marquee selection is by intersection with the body (the OmniGraffle / Figma rule). The band is
 * grown by 0.01 first so a zero-area band (a click with the Multi-Select tool) still selects what
 * it touches. The live highlight, the live count and the commit all call this one predicate.
 */
export function marqueeSelects(n: Pick<BnetNode, "kind" | "position">, band: Rect): boolean {
  return intersects(nodeWorldRect(n), insetBy(band, -0.01, -0.01));
}

/** Bounding box of the nodes' CENTRES (what Zoom to Fit frames, with its margin); null when empty. */
export function boundsOfCentres(nodes: readonly Pick<BnetNode, "position">[]): Rect | null {
  if (!nodes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.position[0]);
    y0 = Math.min(y0, n.position[1]);
    x1 = Math.max(x1, n.position[0]);
    y1 = Math.max(y1, n.position[1]);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
