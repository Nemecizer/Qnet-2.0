// What the overlay costs on the canvas bench's 200-node / 400-link network (src/canvas/geometry/
// bench.ts, the scene scripts/canvas-bench.ts measures): a pan re-renders no badge, a drag
// re-renders only the dragged node's badge, and the layer adds a fraction of the scene's own
// drawing time. The times are printed for the record; the assertions are relative, so a busy
// machine doesn't fail them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResultRecord } from "../../panes/results/model";
import { benchNetwork, BENCH_VIEWPORT } from "../geometry/bench";
import { buildRoutePlan, buildScene } from "../geometry/scene";
import { makeTransform } from "../geometry/transform";
import { canvasColors } from "../layers/colors";
import { SceneLayers } from "../layers/SceneLayers";
import { quietView } from "../layers/testkit";
import * as text from "../layers/text";
import { overlayModel } from "./model";
import { ResultsLayer } from "./ResultsLayer";

vi.mock("../layers/text", async (original) => {
  const m = await original<typeof import("../layers/text")>();
  return { ...m, textWidth: vi.fn(m.textWidth) };
});

const net = benchNetwork();
const stations = net.nodes.filter((n) => n.kind === "station");
const plan = buildRoutePlan(net.nodes, net.links);
const sceneAt = (nodes = net.nodes, pan = { width: 0, height: 0 }, scale = 1) => buildScene({ nodes, links: net.links, transform: makeTransform(scale, pan, BENCH_VIEWPORT), classFilter: null, routePlan: plan });

/** A simulation's record for the bench network: utilisation with an interval at every station. */
const record: ResultRecord = {
  id: "bench",
  method: { identifier: "queue.des", displayName: "Monte Carlo", shortName: "Monte Carlo", layer: "Queue", fidelity: "Queue simulation" },
  provenance: { tabID: "T", networkTitle: "bench", networkFingerprint: "fp", bufferRegime: "infinite", parameters: {} },
  status: "completed",
  startedAt: "2026-11-11T00:00:00Z",
  completedAt: "2026-11-11T00:00:01Z",
  warnings: [],
  measurements: stations.map((n, i) => {
    const rho = 0.05 + (0.93 * i) / (stations.length - 1);
    return { id: `m${i}`, stationID: n.id, stationName: n.name, metric: "Utilization", estimate: rho, unit: "ratio", uncertainty: { lowerBound: rho - 0.004, upperBound: rho + 0.004, confidenceLevel: 0.95 } };
  }),
};
const model = overlayModel({ records: [record], fingerprint: "fp", metric: "Utilization", decimals: 6 })!;
const results = { model, color: true };
const colors = canvasColors("light");
const widths = vi.mocked(text.textWidth);

/** The fastest of `n` runs: the least disturbed by whatever else the machine is doing. */
function fastest(f: () => void, n = 12): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    f();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

beforeEach(() => {
  widths.mockClear();
});

describe("the overlay on the 200-node bench scene", () => {
  it("has a badge for each of the 125 stations", () => {
    expect(stations.length).toBe(125);
    expect(model.items.size).toBe(125);
  });

  it("re-renders no badge for a pan and exactly one for a dragged node", () => {
    const layer = (scene: ReturnType<typeof sceneAt>) => (
      <svg>
        <ResultsLayer scene={scene} results={results} colors={colors} live />
      </svg>
    );
    const { rerender, container } = render(layer(sceneAt()));
    expect(container.querySelectorAll("[data-result]")).toHaveLength(125);
    const perBadge = widths.mock.calls.length / 125;
    expect(perBadge).toBeGreaterThan(0);
    expect(Number.isInteger(perBadge)).toBe(true);

    widths.mockClear();
    rerender(layer(sceneAt(net.nodes, { width: -240, height: 130 })));
    expect(widths).not.toHaveBeenCalled();
    expect(container.querySelector('[data-layer="results"]')).toHaveAttribute("transform", "translate(-240 130)");

    // One frame of a drag: one node's position changes, every other node object is the same.
    widths.mockClear();
    const dragged = stations[40];
    const moved = net.nodes.map((n) => (n.id === dragged.id ? { ...n, position: [n.position[0] + 33, n.position[1] + 21] as [number, number] } : n));
    rerender(layer(sceneAt(moved, { width: -240, height: 130 })));
    expect(widths.mock.calls.length).toBe(perBadge);
  });

  it("adds a fraction of the scene's own drawing time, and builds its model in well under a frame", () => {
    const view = quietView();
    const scene = sceneAt();
    const plain = () => renderToStaticMarkup(<SceneLayers scene={scene} view={view} colors={colors} infiniteBuffers />);
    const overlaid = () => renderToStaticMarkup(<SceneLayers scene={scene} view={view} colors={colors} infiniteBuffers results={results} />);
    plain();
    overlaid();
    // Interleaved, so a burst of load falls on both.
    let without = Number.POSITIVE_INFINITY;
    let withOverlay = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 4; i++) {
      without = Math.min(without, fastest(plain, 4));
      withOverlay = Math.min(withOverlay, fastest(overlaid, 4));
    }
    const build = fastest(() => overlayModel({ records: [record], fingerprint: "fp", metric: "Utilization", decimals: 6 }));
    // eslint-disable-next-line no-console
    console.log(`overlay bench (200 nodes / 400 links, 125 badges): scene render ${without.toFixed(2)} ms, with overlay ${withOverlay.toFixed(2)} ms, model build ${build.toFixed(3)} ms`);
    expect(withOverlay).toBeLessThan(without * 2);
    expect(build).toBeLessThan(without);
  });
});
