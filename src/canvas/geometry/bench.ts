// The canvas bench's network and timings (ledger CAN-206, canvas.md §17): 200 nodes / 400 links laid
// out as 0.90.34's validation/canvas_perf/main.swift did (a √n-column grid, 140 × 120 pt, kinds by
// i mod 8, link k from a random node to the one 1 + k mod 5 further on, class k mod 2). 0.90.34 drew
// the random endpoints from SystemRandomNumberGenerator; here they come from xorshift32 with a fixed
// seed, so the network is the same on every run, and scripts/canvas-synthetic.swift builds this very
// network for 0.90.34's side of the comparison.
import type { BnetLink, BnetNode, NodeKind } from "../../lib/bnet";
import { buildGrid } from "./grid";
import { buildRoutePlan, interpolatePlans } from "./route";
import { buildScene, hitLink, hitNode } from "./scene";
import { makeTransform } from "./transform";

export const BENCH_SEED = 20261111;
export const BENCH_VIEWPORT = { width: 1600, height: 1000 } as const;
export const BENCH_SCALES = [0.5, 0.86, 1.0, 2.0, 4.0] as const;

export function xorshift32(seed: number) {
  let x = seed >>> 0;
  const next = () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x;
  };
  return { next, int: (n: number) => next() % n };
}

const uuid = (prefix: number, i: number) => `${String(prefix).padStart(8, "0")}-0000-0000-0000-${String(i).padStart(12, "0")}`;

function node(id: string, kind: NodeKind, x: number, y: number): BnetNode {
  return {
    id,
    kind,
    name: id,
    position: [x, y],
    bufferSize: 0,
    distribution: "Exponential",
    distributionParameters: "rate=1.0",
    numberOfServers: 1,
    serviceDistributions: {},
    picture: "",
  } as unknown as BnetNode;
}

export function benchNetwork(seed = BENCH_SEED, nodeCount = 200, linkCount = 400): { nodes: BnetNode[]; links: BnetLink[] } {
  const rng = xorshift32(seed);
  const cols = Math.ceil(Math.sqrt(nodeCount));
  const nodes: BnetNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const m = i % 8;
    const kind: NodeKind = m === 0 ? "source" : m === 7 ? "sink" : m === 3 ? "buffer" : "station";
    nodes.push(node(uuid(1, i), kind, (i % cols) * 140 + 60, Math.floor(i / cols) * 120 + 60));
  }
  const links: BnetLink[] = [];
  for (let k = 0; k < linkCount; k++) {
    const a = rng.int(nodeCount);
    let b = (a + 1 + (k % 5)) % nodeCount;
    if (b === a) b = (a + 1) % nodeCount;
    links.push({ id: uuid(2, k), fromNodeID: nodes[a].id, toNodeID: nodes[b].id, routingProbability: 1, customerClass: k % 2 });
  }
  return { nodes, links };
}

/** Mean ms per call over `reps`, after one warm-up call. */
export function timeMs(reps: number, body: () => void, now: () => number = () => performance.now()): number {
  body();
  const t0 = now();
  for (let i = 0; i < reps; i++) body();
  return (now() - t0) / reps;
}

export interface BenchResult {
  planMs: number;
  bowed: number;
  dragReplanMs: number;
  interpolateMs: number;
  perScale: { scale: number; sceneMs: number; gridMs: number; hitMs: number }[];
}

/** The bench, as 0.90.34's main.swift ran it (same reps, same pan, same probe point). */
export function runBench(reps = { plan: 20, drag: 60, lerp: 200, scene: 60, grid: 200, hit: 500 }): BenchResult {
  const { nodes, links } = benchNetwork();
  const planMs = timeMs(reps.plan, () => buildRoutePlan(nodes, links));
  const plan = buildRoutePlan(nodes, links);

  const moving = nodes.map((n) => ({ ...n, position: [n.position[0], n.position[1]] as [number, number] }));
  let frame = 0;
  const dragReplanMs = timeMs(reps.drag, () => {
    frame += 1;
    moving[10].position = [moving[10].position[0] + 2, moving[10].position[1] + ((frame % 3) - 1)];
    buildRoutePlan(moving, links);
  });
  moving[10].position = [moving[10].position[0] + 180, moving[10].position[1]];
  const after = buildRoutePlan(moving, links);
  const interpolateMs = timeMs(reps.lerp, () => interpolatePlans(plan, after, 0.4));

  const perScale = BENCH_SCALES.map((scale) => {
    const t = makeTransform(scale, { width: 37, height: -21 }, BENCH_VIEWPORT);
    const sceneMs = timeMs(reps.scene, () => buildScene({ nodes, links, transform: t, classFilter: null, routePlan: plan }));
    const gridMs = timeMs(reps.grid, () => buildGrid(t, BENCH_VIEWPORT, 28));
    const scene = buildScene({ nodes, links, transform: t, classFilter: null, routePlan: plan });
    const p = { x: 803, y: 517 };
    const hitMs = timeMs(reps.hit, () => {
      hitNode(scene, p);
      hitLink(scene, p);
    });
    return { scale, sceneMs, gridMs, hitMs };
  });
  return { planMs, bowed: plan.bulges.size, dragReplanMs, interpolateMs, perScale };
}
