// A loose guard on the canvas budgets (ledger CAN-206, INV-067): the real numbers come from
// `node scripts/canvas-bench.ts` (0.90.34: route plan 4.2 ms, scene build 0.29 ms at 200 nodes /
// 400 links). These ceilings are ~10× that, so only a gross regression fails here, not a busy Mac.
import { describe, expect, it } from "vitest";
import { benchNetwork, runBench } from "./bench";

describe("canvas budgets at 200 nodes / 400 links", () => {
  it("builds the bench network 0.90.34's bench describes", () => {
    const { nodes, links } = benchNetwork();
    expect(nodes.length).toBe(200);
    expect(links.length).toBe(400);
    expect(nodes[14].position).toEqual([60 + 14 * 140, 60]);
    expect(nodes[16].position).toEqual([60 + 140, 60 + 120]);
  });

  it("plans, builds, draws the grid and hit-tests well inside a frame", () => {
    const r = runBench({ plan: 5, drag: 5, lerp: 20, scene: 10, grid: 20, hit: 50 });
    expect(r.planMs).toBeLessThan(50);
    expect(r.interpolateMs).toBeLessThan(1);
    for (const s of r.perScale) {
      expect(s.sceneMs, `scene at ${s.scale}`).toBeLessThan(5);
      expect(s.gridMs, `grid at ${s.scale}`).toBeLessThan(2);
      expect(s.hitMs, `hit test at ${s.scale}`).toBeLessThan(1);
    }
  });
});
