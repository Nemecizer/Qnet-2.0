// Routing obstacles (docs/specs/canvas.md §6.2, 0.90.34 `CanvasObstacles`): every node's body (hard)
// and the label block under it (soft), display space, bucketed into a coarse uniform grid so asking
// "does this route cross somebody else's body?" costs a handful of rect tests. A per-obstacle visit
// stamp replaces a Set per query, so a query allocates nothing.
import type { BnetNode } from "../../lib/bnet";
import { cgIntersectsXY, length, pointToSegmentDistance, segIntersectsRect, swiftMax, swiftMin } from "./math";
import { nodeLabelRect, nodeWorldRect } from "./outline";
import { rectToDisplay, type CanvasTransform } from "./transform";
import type { Point } from "./types";

/** World slack round a node body, so a link grazing an outline counts as blocked. */
export const OBSTACLE_PADDING = 6;
/** World slack round a label block (text has no ring or halo to keep clear of). */
export const LABEL_PADDING = 2;

/** One rect a route may have to avoid (display space; min/max precomputed as CGRect's). */
export interface Obstacle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly maxX: number;
  readonly maxY: number;
  /** A label block (soft) rather than a node body (hard). */
  readonly isLabel: boolean;
}

/** Separate tallies of the two kinds of obstacle a route enters. */
export interface Hits {
  bodies: number;
  labels: number;
}

export const noHits = (): Hits => ({ bodies: 0, labels: 0 });
export const isClear = (h: Hits) => h.bodies === 0 && h.labels === 0;
/** Any body crossing is worse than any number of label crossings; among equals, fewer labels wins. */
export const hitsLess = (a: Hits, b: Hits) => (a.bodies !== b.bodies ? a.bodies < b.bodies : a.labels < b.labels);

const KEY_STRIDE = 4194304; // 2^22: gx·stride + gy is exact and unique for |gy| < 2^21

export class CanvasObstacles {
  private readonly cell: number;
  private readonly ids: string[] = [];
  private readonly obs: Obstacle[] = [];
  private readonly buckets = new Map<number, number[]>();
  private stamp: Int32Array = new Int32Array(0);
  private token = 0;

  constructor(nodes: readonly BnetNode[], transform: CanvasTransform) {
    // Buckets a few node-widths across.
    this.cell = swiftMax(48, 200 * swiftMax(transform.scale, 0.05));
    if (nodes.length <= 2) return;
    const pad = OBSTACLE_PADDING * transform.scale;
    const labelPad = LABEL_PADDING * transform.scale;
    for (const n of nodes) {
      this.push(n.id, rectToDisplay(transform, nodeWorldRect(n)), pad, false);
      this.push(n.id, rectToDisplay(transform, nodeLabelRect(n)), labelPad, true);
    }
    this.stamp = new Int32Array(this.obs.length);
    const cell = this.cell;
    for (let i = 0; i < this.obs.length; i++) {
      const b = this.obs[i];
      const x0 = Math.floor(b.x / cell);
      const x1 = Math.floor(b.maxX / cell);
      const y0 = Math.floor(b.y / cell);
      const y1 = Math.floor(b.maxY / cell);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const k = gx * KEY_STRIDE + gy;
          const list = this.buckets.get(k);
          if (list) list.push(i);
          else this.buckets.set(k, [i]);
        }
      }
    }
  }

  private push(id: string, r: { x: number; y: number; width: number; height: number }, pad: number, isLabel: boolean) {
    // CGRect.insetBy(dx: -pad, dy: -pad)
    const x = r.x - pad;
    const y = r.y - pad;
    const width = r.width + 2 * pad;
    const height = r.height + 2 * pad;
    this.ids.push(id);
    this.obs.push({ x, y, width, height, maxX: x + width, maxY: y + height, isLabel });
  }

  get isEmpty(): boolean {
    return this.obs.length === 0;
  }

  /** Every obstacle, in build order (body then label per node); for tests and the routing check. */
  get all(): readonly Obstacle[] {
    return this.obs;
  }

  get cellSize(): number {
    return this.cell;
  }

  /**
   * How many third-party bodies and labels `polyline` enters; `a` and `b` (the link's endpoints)
   * never count. With `stopAtFirstBody` the walk ends at the first body crossing.
   */
  hits(polyline: readonly Point[], a: string, b: string, stopAtFirstBody = false): Hits {
    if (this.obs.length === 0 || polyline.length <= 1) return noHits();
    let minX = polyline[0].x;
    let maxX = polyline[0].x;
    let minY = polyline[0].y;
    let maxY = polyline[0].y;
    for (let i = 1; i < polyline.length; i++) {
      const p = polyline[i];
      minX = swiftMin(minX, p.x);
      maxX = swiftMax(maxX, p.x);
      minY = swiftMin(minY, p.y);
      maxY = swiftMax(maxY, p.y);
    }
    return this.visit(minX, minY, maxX, maxY, a, b, stopAtFirstBody, null, (o) => {
      for (let i = 1; i < polyline.length; i++) {
        const p = polyline[i - 1];
        const q = polyline[i];
        if (segIntersectsRect(p.x, p.y, q.x, q.y, o.x, o.y, o.maxX, o.maxY)) return true;
      }
      return false;
    });
  }

  /**
   * The obstacles a link a→b could meet when bowed at most `reach` display pt either side of the
   * chord: those whose centre lies within reach + half-diagonal of it. Gathered once per link.
   */
  near(a: Point, b: Point, reach: number, x: string, y: string): Obstacle[] {
    if (this.obs.length === 0) return [];
    const minX = swiftMin(a.x, b.x) - reach;
    const maxX = swiftMax(a.x, b.x) + reach;
    const minY = swiftMin(a.y, b.y) - reach;
    const maxY = swiftMax(a.y, b.y) + reach;
    const found: Obstacle[] = [];
    this.visit(minX, minY, maxX, maxY, x, y, false, found, (o) => {
      const c = { x: o.x + o.width / 2, y: o.y + o.height / 2 };
      const halfDiagonal = length(o.width, o.height) / 2;
      return pointToSegmentDistance(c, a, b) <= reach + halfDiagonal;
    });
    return found;
  }

  private visit(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    a: string,
    b: string,
    stopAtFirstBody: boolean,
    collect: Obstacle[] | null,
    test: (o: Obstacle) => boolean,
  ): Hits {
    const cell = this.cell;
    const gx0 = Math.floor(minX / cell);
    const gx1 = Math.floor(maxX / cell);
    const gy0 = Math.floor(minY / cell);
    const gy1 = Math.floor(maxY / cell);
    const hits = noHits();
    // A wildly off-screen link would sweep a huge bucket range; guard as 0.90.34 did.
    if (!(gx1 >= gx0 && gy1 >= gy0 && gx1 - gx0 < 512 && gy1 - gy0 < 512)) return hits;
    // The query box (CGRect(x: minX, y: minY, width: maxX − minX, height: maxY − minY)).
    const bx1 = minX + (maxX - minX);
    const by1 = minY + (maxY - minY);
    this.token = (this.token + 1) | 0;
    if (this.token === 0) {
      this.stamp.fill(0);
      this.token = 1;
    }
    const token = this.token;
    const stamp = this.stamp;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const list = this.buckets.get(gx * KEY_STRIDE + gy);
        if (!list) continue;
        for (let j = 0; j < list.length; j++) {
          const i = list[j];
          if (stamp[i] === token) continue;
          stamp[i] = token;
          const id = this.ids[i];
          if (id === a || id === b) continue;
          const o = this.obs[i];
          if (!cgIntersectsXY(o.x, o.y, o.maxX, o.maxY, minX, minY, bx1, by1)) continue;
          if (test(o)) {
            if (o.isLabel) hits.labels += 1;
            else hits.bodies += 1;
            if (collect) collect.push(o);
            if (stopAtFirstBody && !o.isLabel) return hits;
          }
        }
      }
    }
    return hits;
  }
}
