// Bundling and the route plan (docs/specs/canvas.md §6.1, §6.3; 0.90.34 `CanvasScene.bundleGroups`,
// `LinkRoutePlan.build` / `solve` in CanvasGeometry.swift). World space, decided once per layout:
// the camera never changes which node an arrow has to step over.
import type { BnetLink, BnetNode } from "../../lib/bnet";
import { linkBetween } from "./link";
import { distance, quadPoint, segIntersectsRect, cgIntersectsXY, swiftMax, swiftMin, unit } from "./math";
import { CanvasObstacles, hitsLess, isClear, noHits, type Hits, type Obstacle } from "./obstacles";
import { IDENTITY } from "./transform";
import type { Point } from "./types";

/** World pt between multi-class siblings on one directed pair. */
export const BUNDLE_SPACING = 8;
/** The bow given to each link of an opposite-direction pair. */
export const PAIR_BULGE = 24;
/** Bow magnitudes (world pt) tried in ascending order when the chord crosses somebody. */
export const BULGE_LADDER: readonly number[] = [14, PAIR_BULGE, 48, 96, 160, 240];
/** Flattening of a candidate bow while it is probed. */
export const PROBE_SEGMENTS = 8;
/** Clear air (world pt) the solved bow leaves between the stroke and the body it steps over. */
export const CLEARANCE_MARGIN = 10;
/** Hard ceiling on a detour (world pt). */
export const MAX_BULGE = 260;
/** Chord fraction at each end within which the closed-form solve declines to act. */
export const SOLVE_WINDOW = 0.2;

/** Per-link bow, world pt; a link absent from the plan is straight. Plans are immutable. */
export interface LinkRoutePlan {
  readonly bulges: ReadonlyMap<string, number>;
}

export const EMPTY_PLAN: LinkRoutePlan = Object.freeze({ bulges: new Map<string, number>() });

export function planBulge(plan: LinkRoutePlan, id: string): number {
  return plan.bulges.get(id) ?? 0;
}

/** Number of links the plan bows (diagnostics and the bench). */
export function bowedCount(plan: LinkRoutePlan): number {
  return plan.bulges.size;
}

export function plansEqual(a: LinkRoutePlan, b: LinkRoutePlan): boolean {
  if (a === b) return true;
  if (a.bulges.size !== b.bulges.size) return false;
  for (const [k, v] of a.bulges) if (b.bulges.get(k) !== v) return false;
  return true;
}

/** Bow-by-bow blend so routes ease instead of teleporting (§6.3); straight ↔ bowed eases via 0. */
export function interpolatePlans(a: LinkRoutePlan, b: LinkRoutePlan, t: number): LinkRoutePlan {
  if (t <= 0) return a;
  if (t >= 1 || plansEqual(a, b)) return b;
  const out = new Map<string, number>();
  for (const [id, target] of b.bulges) {
    const from = a.bulges.get(id) ?? 0;
    const v = from + (target - from) * t;
    if (v !== 0) out.set(id, v);
  }
  for (const [id, from] of a.bulges) {
    if (b.bulges.has(id)) continue;
    const v = from * (1 - t);
    if (v !== 0) out.set(id, v);
  }
  return { bulges: out };
}

// MARK: Bundling

export const pairKey = (from: string, to: string) => `${from}>${to}`;

/**
 * Links grouped by directed node pair, each group sorted by customerClass (stable, so equal classes
 * keep document order). Over ALL links, not just the visible ones, so a class filter never moves
 * a bundle.
 */
export function bundleGroups(links: readonly BnetLink[]): Map<string, BnetLink[]> {
  const groups = new Map<string, BnetLink[]>();
  for (const l of links) {
    const k = pairKey(l.fromNodeID, l.toNodeID);
    const g = groups.get(k);
    if (g) g.push(l);
    else groups.set(k, [l]);
  }
  for (const g of groups.values()) if (g.length > 1) g.sort((p, q) => p.customerClass - q.customerClass);
  return groups;
}

export interface BundleSlot {
  /** The link's index among its siblings (`firstIndex(where: id ==)`). */
  readonly index: number;
  readonly count: number;
  /** (index − (count − 1)/2) × BUNDLE_SPACING, world pt. */
  readonly offsetWorld: number;
  /** The reversed pair exists too (a self-loop never has one). */
  readonly hasOpposite: boolean;
}

export function bundleSlot(groups: ReadonlyMap<string, readonly BnetLink[]>, link: BnetLink): BundleSlot {
  const siblings = groups.get(pairKey(link.fromNodeID, link.toNodeID)) ?? [link];
  let index = siblings.findIndex((s) => s.id === link.id);
  if (index < 0) index = 0;
  const count = siblings.length;
  const offsetWorld = (index - (count - 1) / 2) * BUNDLE_SPACING;
  const hasOpposite = link.fromNodeID !== link.toNodeID && groups.has(pairKey(link.toNodeID, link.fromNodeID));
  return { index, count, offsetWorld, hasOpposite };
}

// MARK: The plan

/**
 * The route plan for a layout, world space (§6.3): which links bow, and by how much, so no arrow
 * crosses a node body. Depends on node positions and links only, never on the camera.
 */
export function buildRoutePlan(nodes: readonly BnetNode[], links: readonly BnetLink[]): LinkRoutePlan {
  const bulges = new Map<string, number>();
  if (links.length === 0) return { bulges };
  const index = new Map<string, BnetNode>();
  let cx = 0;
  let cy = 0;
  for (const n of nodes) {
    index.set(n.id, n);
    cx += n.position[0];
    cy += n.position[1];
  }
  if (nodes.length > 0) {
    cx /= nodes.length;
    cy /= nodes.length;
  }
  const centroid = { x: cx, y: cy };
  const obstacles = new CanvasObstacles(nodes, IDENTITY);
  const groups = bundleGroups(links);
  for (const link of links) {
    if (link.fromNodeID === link.toNodeID) continue;
    const from = index.get(link.fromNodeID);
    const to = index.get(link.toNodeID);
    if (!from || !to) continue;
    const slot = bundleSlot(groups, link);
    const bulge = solveBulge({
      fromCentre: { x: from.position[0], y: from.position[1] },
      fromKind: from.kind,
      fromID: link.fromNodeID,
      toCentre: { x: to.position[0], y: to.position[1] },
      toKind: to.kind,
      toID: link.toNodeID,
      parallelOffset: slot.offsetWorld,
      baseBulge: slot.hasOpposite ? PAIR_BULGE : 0,
      lockSide: slot.hasOpposite,
      obstacles,
      centroid,
    });
    if (bulge !== 0) bulges.set(link.id, bulge);
  }
  return { bulges };
}

export interface SolveInput {
  fromCentre: Point;
  fromKind: BnetNode["kind"];
  fromID: string;
  toCentre: Point;
  toKind: BnetNode["kind"];
  toID: string;
  parallelOffset: number;
  baseBulge: number;
  lockSide: boolean;
  obstacles: CanvasObstacles;
  centroid: Point;
}

/** Which rule picked a link's bow; reported by `solveBulgeTraced` for tests and diagnostics. */
export type SolveTier = "empty" | "nothing-near" | "base" | "ladder" | "solved" | "body-clear" | "least-bad";

const probeX = new Float64Array(PROBE_SEGMENTS + 1);
const probeY = new Float64Array(PROBE_SEGMENTS + 1);

/** `LinkRoutePlan.solve`: the world bow one link needs (three tiers; see canvas.md §6.3). */
export function solveBulge(input: SolveInput): number {
  return solveBulgeTraced(input).bulge;
}

export function solveBulgeTraced(input: SolveInput): { bulge: number; tier: SolveTier } {
  const { fromCentre, fromKind, fromID, toCentre, toKind, toID, parallelOffset, baseBulge, lockSide, obstacles, centroid } = input;
  if (obstacles.isEmpty) return { bulge: baseBulge, tier: "empty" };

  // Probe geometry: the bundle-shifted chord and its perpendicular.
  const u = unit(fromCentre, toCentre);
  const perp = { x: -u.y, y: u.x };
  const a = { x: fromCentre.x + perp.x * parallelOffset, y: fromCentre.y + perp.y * parallelOffset };
  const b = { x: toCentre.x + perp.x * parallelOffset, y: toCentre.y + perp.y * parallelOffset };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  const reach = BULGE_LADDER[BULGE_LADDER.length - 1] ?? 0;
  const nearby: Obstacle[] = obstacles.near(a, b, reach, fromID, toID);
  if (nearby.length === 0) return { bulge: baseBulge, tier: "nothing-near" };

  const segs = PROBE_SEGMENTS;
  const probeHits = (bulge: number): Hits => {
    const control = { x: mid.x + perp.x * bulge, y: mid.y + perp.y * bulge };
    for (let i = 0; i <= segs; i++) {
      const p = quadPoint(a, control, b, i / segs);
      probeX[i] = p.x;
      probeY[i] = p.y;
    }
    // A quadratic lies inside the hull of its three points.
    const hx0 = swiftMin(a.x, swiftMin(control.x, b.x));
    const hy0 = swiftMin(a.y, swiftMin(control.y, b.y));
    const hw = Math.abs(swiftMax(a.x, swiftMax(control.x, b.x)) - swiftMin(a.x, swiftMin(control.x, b.x)));
    const hh = Math.abs(swiftMax(a.y, swiftMax(control.y, b.y)) - swiftMin(a.y, swiftMin(control.y, b.y)));
    const hx1 = hx0 + hw;
    const hy1 = hy0 + hh;
    const hits = noHits();
    for (let k = 0; k < nearby.length; k++) {
      const o = nearby[k];
      if (!cgIntersectsXY(o.x, o.y, o.maxX, o.maxY, hx0, hy0, hx1, hy1)) continue;
      for (let i = 1; i <= segs; i++) {
        if (segIntersectsRect(probeX[i - 1], probeY[i - 1], probeX[i], probeY[i], o.x, o.y, o.maxX, o.maxY)) {
          if (o.isLabel) hits.labels += 1;
          else hits.bodies += 1;
          break;
        }
      }
    }
    return hits;
  };

  // Acceptance is always decided on the stroke that will really be drawn.
  const builtHits = (bulge: number): Hits =>
    obstacles.hits(linkBetween(fromCentre, fromKind, toCentre, toKind, 1, parallelOffset, bulge).polyline, fromID, toID);

  let bodyClear: number | null = null;
  let best = baseBulge;
  let bestHits = probeHits(baseBulge);

  const consider = (candidate: number): boolean => {
    const p = probeHits(candidate);
    if (hitsLess(p, bestHits)) {
      bestHits = p;
      best = candidate;
    }
    if (p.bodies !== 0) return false;
    const built = builtHits(candidate);
    if (isClear(built)) return true;
    if (built.bodies === 0 && bodyClear === null) bodyClear = candidate;
    return false;
  };

  if (consider(baseBulge)) return { bulge: baseBulge, tier: "base" };

  // The side of the chord facing away from the rest of the drawing goes first.
  const outward = perp.x * (mid.x - centroid.x) + perp.y * (mid.y - centroid.y);
  const firstSign = outward >= 0 ? 1 : -1;
  const signs = lockSide ? [baseBulge >= 0 ? 1 : -1] : [firstSign, -firstSign];

  const floorMagnitude = Math.abs(baseBulge) + 0.001;
  for (const magnitude of BULGE_LADDER) {
    if (!(magnitude > floorMagnitude)) continue;
    for (const sign of signs) {
      if (consider(sign * magnitude)) return { bulge: sign * magnitude, tier: "ladder" };
    }
  }

  // No rung cleared everything: solve for the bow. A quadratic of control offset B displaces its
  // curve by 2·t·(1−t)·B at chord parameter t.
  const chordLength = swiftMax(distance(a, b), 0.001);
  const solved = (sign: number, includingLabels: boolean): number | null => {
    let need = 0;
    for (const o of nearby) {
      if (!(includingLabels || !o.isLabel)) continue;
      const c = { x: o.x + o.width / 2, y: o.y + o.height / 2 };
      const d = { x: c.x - a.x, y: c.y - a.y };
      const t = (d.x * u.x + d.y * u.y) / chordLength;
      if (!(t > SOLVE_WINDOW && t < 1 - SOLVE_WINDOW)) continue;
      const along = d.x * perp.x + d.y * perp.y;
      const half = (Math.abs(perp.x) * o.width + Math.abs(perp.y) * o.height) / 2;
      const target = sign * (along + sign * (half + CLEARANCE_MARGIN));
      if (!(target > 0)) continue;
      need = swiftMax(need, target / (2 * t * (1 - t)));
    }
    if (!(need > 0 && need <= MAX_BULGE)) return null;
    return sign * swiftMax(need, Math.abs(baseBulge));
  };

  for (const includingLabels of [true, false]) {
    for (const sign of signs) {
      const candidate = solved(sign, includingLabels);
      if (candidate === null) continue;
      if (consider(candidate)) return { bulge: candidate, tier: "solved" };
    }
  }

  if (bodyClear !== null) return { bulge: bodyClear, tier: "body-clear" };
  return { bulge: best, tier: "least-bad" };
}
