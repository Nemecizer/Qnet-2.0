// The geometry against 0.90.34 on synthetic networks the shipped examples never reach: self-loops
// (nested), solved bows and the body-clear / least-bad tiers, a class filter, hit tests, smart
// guides and the grid at seven zooms. (A link with nothing near it is unit-tested in route.test.ts.) fixtures/synthetic-0.90.34.json is written by 0.90.34's own
// CanvasGeometry.swift (scripts/canvas-synthetic.swift says how); every number must match to the bit.
import { describe, expect, it } from "vitest";
import type { BnetLink, BnetNode, NodeKind } from "../../lib/bnet";
import { buildGrid } from "./grid";
import { matchGuides } from "./guides";
import { buildRoutePlan, planBulge, solveBulgeTraced, bundleGroups, bundleSlot, PAIR_BULGE, type SolveTier } from "./route";
import { CanvasObstacles } from "./obstacles";
import { buildScene, hitLink, hitNode, sceneContentRect } from "./scene";
import { IDENTITY, makeTransform } from "./transform";
import type { Point, Rect } from "./types";
import fixtureText from "./fixtures/synthetic-0.90.34.json?raw";
import { benchNetwork } from "./bench";

type G = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture: G = JSON.parse(fixtureText);

function networkFrom(net: G): { nodes: BnetNode[]; links: BnetLink[] } {
  const nodes = net.nodes.map(([id, kind, x, y]: [string, NodeKind, number, number]) => ({ id, kind, position: [x, y], name: id }) as unknown as BnetNode);
  const links = net.links.map(([id, from, to, c]: [string, string, string, number]) => ({ id, fromNodeID: from, toNodeID: to, customerClass: c, routingProbability: 1 }) as BnetLink);
  return { nodes, links };
}

const pt = (p: Point) => [p.x, p.y];
const rc = (r: Rect | null) => (r ? [r.x, r.y, r.width, r.height] : null);

describe("geometry against 0.90.34 on synthetic networks", () => {
  for (const net of fixture.networks as G[]) {
    describe(net.name, () => {
      const { nodes, links } = networkFrom(net);
      const plan = buildRoutePlan(nodes, links);

      it("plans the same bow for every link", () => {
        expect(links.map((l) => planBulge(plan, l.id))).toEqual(net.bulges);
      });

      it("measures the same content rect", () => {
        expect(rc(sceneContentRect(nodes, links, plan))).toEqual(net.contentRect);
      });

      for (const view of net.views as G[]) {
        it(`builds the same scene at scale ${view.scale}${view.filter === null ? "" : `, class ${view.filter} only`}`, () => {
          const tr = makeTransform(view.scale, { width: view.pan[0], height: view.pan[1] }, { width: 1600, height: 1000 });
          const scene = buildScene({ nodes, links, transform: tr, classFilter: view.filter, routePlan: plan });
          const ours = scene.links.map((item) => {
            const g = item.geometry;
            const route = g.route.kind === "straight" ? [] : g.route.kind === "quad" ? [pt(g.route.control)] : [pt(g.route.c1), pt(g.route.c2)];
            const hasPoly = (view.links[0]?.[8]?.length ?? 0) > 0;
            return [item.id, pt(g.start), pt(g.base), pt(g.tip), pt(g.wingLeft), pt(g.wingRight), pt(g.labelAnchor), route, hasPoly ? g.polyline.map(pt) : []];
          });
          expect(ours).toEqual(view.links);
          if (view.hits) {
            for (const [q, n, l] of view.hits as [number[], string | null, string | null][]) {
              const p = { x: q[0], y: q[1] };
              expect(hitNode(scene, p)?.id ?? null).toBe(n);
              expect(hitLink(scene, p)?.id ?? null).toBe(l);
            }
          }
        });
      }
    });
  }

  it("covers every tier of the solve, self-loops and opposite pairs", () => {
    const tiers = new Set<SolveTier>();
    let selfLoops = 0;
    let nested = 0;
    let opposite = 0;
    for (const net of fixture.networks as G[]) {
      const { nodes, links } = networkFrom(net);
      const obstacles = new CanvasObstacles(nodes, IDENTITY);
      const index = new Map(nodes.map((n) => [n.id, n]));
      const groups = bundleGroups(links);
      let cx = 0;
      let cy = 0;
      for (const n of nodes) {
        cx += n.position[0];
        cy += n.position[1];
      }
      const centroid = { x: cx / nodes.length, y: cy / nodes.length };
      for (const l of links) {
        const slot = bundleSlot(groups, l);
        if (l.fromNodeID === l.toNodeID) {
          selfLoops++;
          if (slot.index > 0) nested++;
          continue;
        }
        if (slot.hasOpposite) opposite++;
        const a = index.get(l.fromNodeID)!;
        const b = index.get(l.toNodeID)!;
        const r = solveBulgeTraced({
          fromCentre: { x: a.position[0], y: a.position[1] },
          fromKind: a.kind,
          fromID: a.id,
          toCentre: { x: b.position[0], y: b.position[1] },
          toKind: b.kind,
          toID: b.id,
          parallelOffset: slot.offsetWorld,
          baseBulge: slot.hasOpposite ? PAIR_BULGE : 0,
          lockSide: slot.hasOpposite,
          obstacles,
          centroid,
        });
        tiers.add(r.tier);
      }
    }
    // A solved bow is chosen here only as the body-clear / least-bad fallback; route.test.ts has a
    // layout where the solve itself returns.
    for (const t of ["base", "ladder", "body-clear", "least-bad"] as SolveTier[]) expect(tiers, t).toContain(t);
    const offLadder = (fixture.networks as G[]).flatMap((n) => n.bulges as number[]).filter((b) => b !== 0 && ![14, 24, 48, 96, 160, 240].includes(Math.abs(b)));
    expect(offLadder.length).toBeGreaterThan(2);
    expect(selfLoops).toBeGreaterThan(10);
    expect(nested).toBeGreaterThan(0);
    expect(opposite).toBeGreaterThan(10);
  });

  it("matches every smart-guide case", () => {
    for (const c of fixture.guides as G[]) {
      const r = (a: number[]) => ({ x: a[0], y: a[1], width: a[2], height: a[3] });
      const m = matchGuides(r(c.anchor), c.others.map(r), c.tol);
      const sp = (s: { first: Rect; second: Rect } | null) => (s ? [rc(s.first), rc(s.second)] : null);
      expect([m.adjustment.width, m.adjustment.height, m.x, m.y, rc(m.anchor), rc(m.xPartner), rc(m.yPartner), sp(m.xSpacing), sp(m.ySpacing)]).toEqual([
        ...c.adj,
        c.x,
        c.y,
        c.a,
        c.xp,
        c.yp,
        c.xs,
        c.ys,
      ]);
    }
  });

  it("builds the same grid at every zoom", () => {
    for (const c of fixture.grid as G[]) {
      const tr = makeTransform(c.scale, { width: c.pan[0], height: c.pan[1] }, { width: 1600, height: 1000 });
      const g = buildGrid(tr, { width: 1600, height: 1000 }, 28);
      expect(g.minorAlpha).toBe(c.minorAlpha);
      expect(g.majorAlpha).toBe(c.majorAlpha);
      // SwiftUI's Path keeps its points as Float32, so the reference holds our doubles rounded to float.
      const f = Math.fround;
      expect((g.minorDots ?? []).map((d) => [f(d.x), f(d.y)])).toEqual(c.dots);
      expect((g.majorLines ?? []).map((l) => [f(l.x1), f(l.y1)])).toEqual(c.lines);
    }
  });

  it("the bench network is the one 0.90.34's reference run used", () => {
    const bench = (fixture.networks as G[]).find((n) => n.name === "bench");
    const { nodes, links } = benchNetwork();
    const ref = networkFrom(bench);
    expect(nodes.map((n) => [n.id, n.kind, n.position[0], n.position[1]])).toEqual(ref.nodes.map((n) => [n.id, n.kind, n.position[0], n.position[1]]));
    expect(links.map((l) => [l.id, l.fromNodeID, l.toNodeID, l.customerClass])).toEqual(ref.links.map((l) => [l.id, l.fromNodeID, l.toNodeID, l.customerClass]));
  });
});
