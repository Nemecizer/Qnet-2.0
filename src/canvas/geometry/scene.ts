// The scene: one memoised description that every layer draws from and every hit test reads
// (docs/specs/canvas.md §5–§7, 0.90.34 `CanvasScene`, `LinkGeometry`, `LinkRoutePlan`).
//
// This file is the CONTRACT the canvas surface, the export and the editor build against; its
// exported names and signatures are fixed. The geometry lives in link.ts (LinkGeometry.between /
// selfLoop), route.ts (bundling and the route plan), obstacles.ts and math.ts, re-exported here.
import type { BnetLink, BnetNode } from "../../lib/bnet";
import { linkBetween, LINK_HIT_TOLERANCE, polylineDistance, selfLoop, type LinkGeometry } from "./link";
import { offsetRect } from "./math";
import { nodeLabelRect, nodeWorldRect, outlineContains } from "./outline";
import { BUNDLE_SPACING, bundleGroups, bundleSlot, buildRoutePlan, planBulge, type LinkRoutePlan } from "./route";
import { IDENTITY, toDisplay, type CanvasTransform } from "./transform";
import { insetBy, union, type Point, type Rect } from "./types";

export {
  arrowLength,
  ARROW_HALF_ANGLE,
  lineWidth,
  LINK_HIT_TOLERANCE,
  linkBetween,
  selfLoop,
  linkStrokePath,
  linkArrowPath,
  polylineDistance,
  type LinkGeometry,
  type LinkRoute,
} from "./link";
export {
  BUNDLE_SPACING,
  PAIR_BULGE,
  BULGE_LADDER,
  EMPTY_PLAN,
  planBulge,
  plansEqual,
  interpolatePlans,
  buildRoutePlan,
  bundleGroups,
  bundleSlot,
  bowedCount,
  type LinkRoutePlan,
} from "./route";

export interface SceneLink {
  readonly id: string;
  readonly link: BnetLink;
  readonly geometry: LinkGeometry;
}

export interface CanvasScene {
  readonly transform: CanvasTransform;
  readonly nodes: readonly BnetNode[];
  readonly nodeIndex: ReadonlyMap<string, BnetNode>;
  readonly displayCentres: ReadonlyMap<string, Point>;
  /** Visible links only, sorted by customerClass ascending so the highest class paints on top. */
  readonly links: readonly SceneLink[];
}

export interface SceneInput {
  nodes: readonly BnetNode[];
  links: readonly BnetLink[];
  transform: CanvasTransform;
  classFilter: number | null;
  /** null plans on the spot (offline checkers); the canvas passes the editor's memoised plan. */
  routePlan: LinkRoutePlan | null;
}

/**
 * Builds the scene (§7): index the nodes, map every centre to display space, bundle over ALL links,
 * then for each visible link (class order) a self-loop nested by its slot, or `between` with the
 * bundle offset and the plan's bow, both scaled to display space.
 */
export function buildScene(input: SceneInput): CanvasScene {
  const { nodes, links, transform, classFilter } = input;
  const nodeIndex = new Map<string, BnetNode>();
  const displayCentres = new Map<string, Point>();
  for (const n of nodes) {
    nodeIndex.set(n.id, n);
    displayCentres.set(n.id, toDisplay(transform, { x: n.position[0], y: n.position[1] }));
  }
  const groups = bundleGroups(links);
  const plan = input.routePlan ?? buildRoutePlan(nodes, links);
  const scale = transform.scale;
  const ordered = links.slice().sort((p, q) => p.customerClass - q.customerClass);
  const items: SceneLink[] = [];
  for (const link of ordered) {
    if (classFilter !== null && link.customerClass !== classFilter) continue;
    const from = nodeIndex.get(link.fromNodeID);
    const to = nodeIndex.get(link.toNodeID);
    if (!from || !to) continue;
    const fromC = displayCentres.get(link.fromNodeID)!;
    const toC = displayCentres.get(link.toNodeID)!;
    const slot = bundleSlot(groups, link);
    const geometry =
      link.fromNodeID === link.toNodeID
        ? selfLoop(fromC, from.kind, scale, slot.index * BUNDLE_SPACING * scale)
        : linkBetween(fromC, from.kind, toC, to.kind, scale, slot.offsetWorld * scale, planBulge(plan, link.id) * scale);
    items.push({ id: link.id, link, geometry });
  }
  return { transform, nodes, nodeIndex, displayCentres, links: items };
}

/** The node drawn under display point `p` (later nodes draw on top), with a 3-pt display slop. */
export function hitNode(scene: CanvasScene, p: Point): BnetNode | null {
  const s = scene.transform.scale;
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const n = scene.nodes[i];
    const c = scene.displayCentres.get(n.id);
    if (!c) continue;
    if (outlineContains(n.kind, { x: (p.x - c.x) / s, y: (p.y - c.y) / s }, 3 / s)) return n;
  }
  return null;
}

/**
 * The nearest visible link within `tolerance` display pt of `p`. Walked topmost first (last drawn)
 * with a strict `<`, so on an exact tie the topmost link wins, as 0.90.34's `hitLink(at:)`.
 */
export function hitLink(scene: CanvasScene, p: Point, tolerance = LINK_HIT_TOLERANCE): BnetLink | null {
  let best: BnetLink | null = null;
  let bestD = 0;
  for (let i = scene.links.length - 1; i >= 0; i--) {
    const d = polylineDistance(scene.links[i].geometry.polyline, p);
    if (d <= tolerance && (best === null || d < bestD)) {
      bestD = d;
      best = scene.links[i].link;
    }
  }
  return best;
}

/** DS.Spacing.l: the room the content rect leaves for the ρ badge and a self-loop's chip. */
export const CONTENT_INSET = 16;

/**
 * The world rect the network occupies (§18, `CanvasImageExport.contentRect`): measured on a scene
 * at zoom 1 with no pan, the union of every body, every label block and every point of every
 * routed polyline, grown by Spacing.l. null when there are no nodes. Zoom to Fit and the export
 * both read it.
 */
export function sceneContentRect(nodes: readonly BnetNode[], links: readonly BnetLink[], plan: LinkRoutePlan | null): Rect | null {
  if (nodes.length === 0) return null;
  const scene = buildScene({ nodes, links, transform: IDENTITY, classFilter: null, routePlan: plan });
  let r = nodeWorldRect(nodes[0]);
  for (const n of nodes) {
    r = union(r, nodeWorldRect(n));
    r = union(r, nodeLabelRect(n));
  }
  for (const item of scene.links) for (const p of item.geometry.polyline) r = union(r, { x: p.x, y: p.y, width: 0, height: 0 });
  return insetBy(r, -CONTENT_INSET, -CONTENT_INSET);
}

/** A rect moved by (dx, dy) (CGRect.offsetBy). */
export { offsetRect };
