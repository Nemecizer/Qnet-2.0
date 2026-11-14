// A closed cycle to start from (new in 2.1): k stations in a ring, each fed by its own buffer, the
// last returning to the first. Only the drawing is made here (nodes, links, positions on the
// archetypes' grid); every number shown for it is Rust's (core/src/closed.rs).
import { newId, type BnetLink, type BnetNode } from "../lib/bnet";

// The archetype gallery's grid (core/src/generate/layout.rs): the row, its first column and the step.
const Y_ROW = 220;
const X_ROW_START = 200;
const X_STEP = 130;

export const CYCLE_ORIGIN = { x: X_ROW_START, y: Y_ROW };

/** Service rates 1, 2, 3, … so the first station is the bottleneck and the picture is not symmetric. */
export function closedCycle(stations: number): { nodes: BnetNode[]; links: BnetLink[] } {
  const nodes: BnetNode[] = [];
  const links: BnetLink[] = [];
  const node = (kind: BnetNode["kind"], name: string, column: number, rate: number): BnetNode => {
    const n: BnetNode = {
      id: newId(),
      kind,
      name,
      position: [X_ROW_START + column * X_STEP, Y_ROW],
      bufferSize: 1,
      distribution: "exponential",
      distributionParameters: `rate=${rate.toFixed(1)}`,
      numberOfServers: 1,
      serviceDistributions: {},
      picture: "",
    };
    nodes.push(n);
    return n;
  };
  const link = (from: BnetNode, to: BnetNode) => links.push({ id: newId(), fromNodeID: from.id, toNodeID: to.id, routingProbability: 1, customerClass: 0 });
  const buffers: BnetNode[] = [];
  const served: BnetNode[] = [];
  for (let i = 0; i < stations; i++) {
    buffers.push(node("buffer", `B${i + 1}`, 2 * i, 1));
    served.push(node("station", `S${i + 1}`, 2 * i + 1, i + 1));
    link(buffers[i], served[i]);
  }
  for (let i = 0; i < stations; i++) link(served[i], buffers[(i + 1) % stations]);
  return { nodes, links };
}
