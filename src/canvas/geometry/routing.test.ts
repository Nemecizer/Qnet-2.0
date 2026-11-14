// The routing check (canvas.md §17; 0.90.34 validation/canvas_perf/routing_check.swift, ledger
// CAN-083, INV-068, INV-069): every shipped example is planned and built at zoom 1, and every routed
// polyline (the stroke that is drawn and hit-tested) is tested against every node it is not attached
// to. A crossing of a third node's BODY always fails; crossings of a third node's LABEL block are a
// budget that may only be lowered (11 in 0.90.34). The same polylines are also tested against the
// bodies grown by the router's own 6-pt obstacle padding, so the probe shortcut stays conservative.
import { describe, expect, it } from "vitest";
import { parseDocument } from "../../lib/bnet";
import { segmentIntersectsRect } from "./math";
import { OBSTACLE_PADDING } from "./obstacles";
import { nodeLabelRect, nodeWorldRect } from "./outline";
import { buildScene } from "./scene";
import { makeTransform } from "./transform";
import { insetBy, type Point, type Rect } from "./types";

const examples = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** routing_check.swift `labelCrossingBudget`: drive it down, never up. */
const LABEL_CROSSING_BUDGET = 11;
/**
 * Crossings of a third body grown by the 6-pt padding, measured on the shipped examples as built
 * (identical to 0.90.34's, golden.test.ts): three links where no rung or solve cleared the padding
 * and the least-bad route still misses the body itself. A budget that may only be lowered.
 */
const PADDED_BODY_BUDGET = 3;

function crosses(poly: readonly Point[], r: Rect): boolean {
  for (let i = 1; i < poly.length; i++) if (segmentIntersectsRect(poly[i - 1], poly[i], r)) return true;
  return false;
}

describe("routing check over every shipped example", () => {
  const files = Object.keys(examples).sort();
  let links = 0;
  const body: string[] = [];
  const label: string[] = [];
  const padded: string[] = [];
  for (const path of files) {
    const doc = parseDocument(examples[path]);
    const names = new Map(doc.nodes.map((n) => [n.id, n.name]));
    const scene = buildScene({ nodes: doc.nodes, links: doc.links, transform: makeTransform(1, { width: 0, height: 0 }, { width: 4000, height: 3000 }), classFilter: null, routePlan: null });
    for (const item of scene.links) {
      links++;
      const poly = item.geometry.polyline;
      if (poly.length <= 1) continue;
      for (const n of doc.nodes) {
        if (n.id === item.link.fromNodeID || n.id === item.link.toNodeID) continue;
        const what = `${path.split("/").pop()}: ${names.get(item.link.fromNodeID)} -> ${names.get(item.link.toNodeID)} crosses ${n.name}`;
        const r = nodeWorldRect(n);
        if (crosses(poly, r)) body.push(what);
        if (crosses(poly, insetBy(r, -OBSTACLE_PADDING, -OBSTACLE_PADDING))) padded.push(what);
        if (crosses(poly, nodeLabelRect(n))) label.push(`${what}'s label`);
      }
    }
  }

  it("routes every link of all 50 examples", () => {
    expect(files.length).toBe(50);
    expect(links).toBeGreaterThan(700);
  });

  it("draws no link through the body of a node it is not attached to", () => {
    expect(body).toEqual([]);
  });

  it("keeps label crossings within 0.90.34's budget", () => {
    console.info(`routing check: ${links} links, ${body.length} body, ${padded.length} padded-body, ${label.length} label crossings`, label);
    expect(label.length).toBeLessThanOrEqual(LABEL_CROSSING_BUDGET);
  });

  it("keeps padded-body crossings within their measured budget", () => {
    expect(padded.length).toBeLessThanOrEqual(PADDED_BODY_BUDGET);
  });
});
