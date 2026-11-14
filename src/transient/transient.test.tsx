// Run ▸ Transient… (src/transient; ledger SCI-601…): the set-up read into a request and refused
// in a sentence, the readings, the table, the command and its menu item, and the view — both
// tiers labelled, exact solid and fluid dashed, long-run averages, settling marks, the surge's
// window, the table alternative, refusals, progress and Stop. The curves here come from the
// preview's stand-in (src/dev/mock/transient.ts) or from an answer written out in the test: the
// app's own arithmetic is checked in Rust (core/src/transient.rs) against closed forms.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockTransient, standInPrepare, standInTransient, FINITE } from "../dev/mock/transient";
import { defaultHandlers } from "../dev/mockBackend";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, unavailableReason } from "../lib/commands";
import { loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC } from "../lib/menuSpec";
import { resetOverlays } from "../lib/overlays";
import { mockTauri } from "../test/tauri";
import { addTab, resetWorkspace, tabById } from "../workspace/store";
import { startTransientCommands, TRANSIENT_COMMAND } from "./commands";
import { DEFAULT_SETTINGS, peak, reading, relaxationReading, requestFor, sampleIndices, transientTable, valueAt, type TransientAnalysis, type TransientPrepare, type TransientRequest } from "./model";
import { resetTransientStore, takeTransientViewRequest, transientResult } from "./store";
import { FLUID_DASH, STATIONARY_DASH } from "./TransientChart";
import { TransientView } from "./TransientView";
import { about, pct, tiny, transientWords as w } from "./words";

const examples = import.meta.glob("../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const example = (stem: string) => ({ canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(examples[`../../examples/${stem}.bnet`]) }) as BnetDocument;
const openExample = (stem: string) => tabById(addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: example(stem) }))!;

/** γ = 1; S1 → S2 with 0.7, back to S1 with 0.3; ρ₁ = ρ₂ = 0.7, L = 7/3 at each. */
const FEEDBACK = "OpenJackson.d2.feedback.p30.inf";
const FINITE_EXAMPLE = "MM1K.d1.c1.fin";
const WAIT = { timeout: 8000 };
const fmt = (x: number) => x.toFixed(2);

const station = (name: string, stationary: number | null, relaxation: number | null, utilisation = 0.5) => ({ id: name, name, servers: 1, utilisation, stationary, relaxation });
const PREPARE: TransientPrepare = { exactReason: null, fluidReason: null, stations: [station("S1", 1, 12), station("S2", 9, 380, 0.9)], suggestedHorizon: 760 };
const REQUEST: TransientRequest = { id: "x", document: {}, horizon: 100, initial: { kind: "empty" }, surge: null, settleFraction: 0.05 };

/** An answer written out: two stations on five times. */
function answer(patch: Partial<TransientAnalysis> = {}, settling: (number | null)[] = [10, 46], settleFrom = 0): TransientAnalysis {
  return {
    times: [0, 25, 50, 75, 100],
    stations: PREPARE.stations,
    exact: { mean: [[0, 0.9, 1, 1, 1], [0, 6, 8.4, 8.8, 9]], shortfall: [1e-9, 3e-8], uncertified: [false, false], empty: [[1, 0.5, 0.5, 0.5, 0.5], [1, 0.2, 0.1, 0.1, 0.1]], distance: [1, 0.4, 0.1, 0.02, 0.001], settling, settleFrom, levels: [30, 180], states: 5611, uniformisationRate: 3.4, products: 400, poissonBound: 1e-8, missingMass: 2.1e-9, stationaryTail: 1e-10 },
    exactReason: null,
    fluid: { level: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], emptied: [] },
    fluidReason: null,
    stopped: false,
    ...patch,
  };
}

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetWorkspace();
  resetOverlays();
  resetTransientStore();
  startTransientCommands();
});
afterEach(() => {
  mockTransient.release();
  vi.restoreAllMocks();
});

describe("the set-up", () => {
  it("becomes a request: the suggested horizon when none is typed, the band as a fraction", () => {
    const built = requestFor(DEFAULT_SETTINGS, PREPARE, { a: 1 }, "id-1");
    expect(built).toEqual({ request: { id: "id-1", document: { a: 1 }, horizon: 760, intervals: 200, initial: { kind: "empty", numbers: undefined }, surge: null, settleFraction: 0.05 } });
    const typed = requestFor({ ...DEFAULT_SETTINGS, horizon: " 120,5 ", band: "2", initial: "given", numbers: { S1: "4" }, surge: true, factor: "1.5", from: "10", until: "40" }, PREPARE, {}, "i");
    expect("request" in typed && typed.request).toMatchObject({ horizon: 120.5, settleFraction: 0.02, initial: { kind: "given", numbers: [4, 0] }, surge: { factor: 1.5, from: 10, until: 40 } });
  });

  it("is refused in a sentence when a field is not what it must be", () => {
    const bad = (patch: Partial<typeof DEFAULT_SETTINGS>) => {
      const r = requestFor({ ...DEFAULT_SETTINGS, ...patch }, PREPARE, {}, "i");
      return "problem" in r ? r.problem : null;
    };
    expect(bad({ horizon: "0" })).toBe(w.badHorizon);
    expect(bad({ horizon: "soon" })).toBe(w.badHorizon);
    expect(bad({ band: "0" })).toBe(w.badBand);
    expect(bad({ band: "100" })).toBe(w.badBand);
    expect(bad({ surge: true, factor: "-1", from: "1", until: "2" })).toBe(w.badFactor);
    expect(bad({ surge: true, factor: "2", from: "5", until: "5" })).toBe(w.badSurge);
    expect(bad({ surge: true, factor: "2", from: "", until: "" })).toBe(w.badSurge);
    expect(bad({ surge: true, factor: "2", from: "800", until: "900" })).toBe(w.surgeBeyond);
    expect(bad({ initial: "given", numbers: { S2: "1.5" } })).toBe(w.badNumber("S2"));
    expect(bad({ initial: "given", numbers: { S1: "-1" } })).toBe(w.badNumber("S1"));
    expect(requestFor(DEFAULT_SETTINGS, { ...PREPARE, suggestedHorizon: null }, {}, "i")).toEqual({ problem: w.badHorizon });
  });
});

describe("an answer read in plain words", () => {
  it("names the slowest station, the time it takes and its long-run average", () => {
    expect(reading(answer(), REQUEST, (x) => x.toFixed(1))).toBe("From empty, S2 takes about 46 time units to come within 5 % of its long-run average of 9.0 customers.");
  });

  it("says so when a station has not settled by the horizon, or was settled all along", () => {
    expect(reading(answer({}, [10, null]), REQUEST, fmt)).toBe("S2 has not come within 5 % of its long-run average of 9.00 customers by time 100: lengthen the time horizon to see it settle.");
    expect(reading(answer({}, [0, 0]), { ...REQUEST, initial: { kind: "steady" } }, fmt)).toBe("From its steady state, every station is within 5 % of its long-run average from the first moment.");
  });

  it("after a surge, gives the peak and the time to come back, counted from the surge's end", () => {
    const surge = { factor: 2, from: 10, until: 50 };
    const a = answer({}, [50, 75], 50);
    a.exact!.mean[1] = [9, 14, 21.3, 9.4, 9];
    expect(reading(a, { ...REQUEST, initial: { kind: "steady" }, surge }, (x) => x.toFixed(1))).toBe(
      "The surge lifts S2 to a mean of 21.3 customers at time 50; after the surge ends it takes about 25 time units to come back within 5 % of its long-run average of 9.0 customers.",
    );
    expect(reading(answer({}, [50, 50], 50), { ...REQUEST, surge }, fmt)).toBe(w.surgeNoMark("5 %"));
  });

  it("reads the fluid tier when there is no exact answer: flat, a backlog that drains, or overload", () => {
    const fluidOnly = (level: number[][], emptied: { station: number; time: number }[] = [], utilisation = 0.9) => answer({ exact: null, exactReason: "too many states", stations: [station("S1", null, null), station("S2", null, null, utilisation)], fluid: { level, emptied } });
    expect(reading(fluidOnly([[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]), REQUEST, fmt)).toBe(w.fluidFlat);
    expect(reading(fluidOnly([[0, 0, 0, 0, 0], [0, 24, 12, 0, 0]], [{ station: 1, time: 75 }]), REQUEST, fmt)).toBe("In the fluid approximation S2 builds up to 24.00 customers at time 25 and is empty again at time 75.");
    expect(reading(fluidOnly([[0, 0, 0, 0, 0], [0, 24, 12, 6, 3]]), REQUEST, fmt)).toContain("has not drained by the horizon");
    expect(reading(fluidOnly([[0, 0, 0, 0, 0], [0, 5, 10, 15, 20]], [], 1.2), REQUEST, fmt)).toBe("In the fluid approximation S2 is overloaded: its backlog grows by about 0.2 customers per time unit and never drains.");
  });

  it("gives the slowest relaxation time for scale, finds peaks and interpolates", () => {
    expect(relaxationReading(answer())).toBe("For scale: S2, the slowest station, has a relaxation time of about 380 time units.");
    expect(peak([0, 1, 2, 3], [1, 5, 5, 2])).toEqual({ value: 5, time: 1 });
    expect(valueAt([0, 10, 20], [0, 4, 8], 15)).toBe(6);
    expect(valueAt([0, 10, 20], [0, 4, 8], 99)).toBe(8);
    expect([about(46.04), about(0.1234), about(12345.6), pct(0.05), pct(0.025), tiny(2.1e-9), tiny(0)]).toEqual(["46", "0.123", "12346", "5 %", "2.5 %", "2.1e-9", "0"]);
  });

  it("puts the same numbers in a table, units in the headings, the surge's ends among the rows", () => {
    const times = Array.from({ length: 201 }, (_, k) => k / 2);
    expect(sampleIndices(times, 40)).toHaveLength(41);
    const withEnds = [...times, 10.3].sort((a, b) => a - b);
    expect(sampleIndices(withEnds, 40, [10.3]).map((k) => withEnds[k])).toContain(10.3);
    const t = transientTable(answer(), [1], REQUEST, fmt);
    expect(t.head).toEqual(["Time (time units)", "S2: exact mean (customers)", "S2: fluid level (customers)", "S2: P(empty), exact", "Distance to steady state (total variation, 0 to 1)"]);
    expect(t.rows[2]).toEqual(["50", "8.40", "0.00", "0.1000", "0.1000"]);
    expect(transientTable(answer({ exact: null }), [0, 1], REQUEST, fmt).head).toEqual(["Time (time units)", "S1: fluid level (customers)", "S2: fluid level (customers)"]);
  });
});

describe("the command", () => {
  it("is in the Run menu, needs a network, and opens the Transient view", async () => {
    expect(JSON.stringify(MENU_SPEC)).toContain(`"${TRANSIENT_COMMAND}"`);
    expect(unavailableReason(getCommand(TRANSIENT_COMMAND)!)).toBe(w.noNetwork);
    openExample(FEEDBACK);
    expect(unavailableReason(getCommand(TRANSIENT_COMMAND)!)).toBeNull();
    await act(async () => void (await getCommand(TRANSIENT_COMMAND)!.run()));
    expect(takeTransientViewRequest()).toBe(true);
    expect(takeTransientViewRequest()).toBe(false);
  });
});

describe("the view", () => {
  it("computes at once for a network it can analyse and shows both tiers, each labelled", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector("[data-transient-reading]")).not.toBeNull(), WAIT);
    expect(mockTransient.calls).toHaveLength(1);
    expect(mockTransient.calls[0]).toMatchObject({ horizon: standInPrepare(tab.document).suggestedHorizon, initial: { kind: "empty" }, surge: null, settleFraction: 0.05 });

    // The reading: one sentence with the station, the time, the band and the long-run average.
    expect(container.querySelector("[data-transient-reading]")!.textContent).toMatch(/^From empty, S[12] takes about [\d.]+ time units to come within 5 % of its long-run average of 2\.33 customers\.$/);
    // Tier labels.
    const tiers = container.querySelector("[data-transient-tiers]")!;
    expect(tiers.querySelector('[data-tier="exact"]')!.textContent).toContain("Exact");
    expect(tiers.querySelector('[data-tier="fluid"]')!.textContent).toBe("Fluid approximation(large-scale limit; ignores randomness)");

    // The chart: per station an exact line (solid) and a fluid line (dashed), the long-run
    // average dotted, a settling mark; units on both axes.
    const svg = container.querySelector('svg[data-chart="transient"]')!;
    const exact = [...svg.querySelectorAll('path[data-tier="exact"]')];
    const fluid = [...svg.querySelectorAll('path[data-tier="fluid"]')];
    expect([exact.length, fluid.length]).toEqual([2, 2]);
    expect(exact.every((p) => !p.getAttribute("stroke-dasharray"))).toBe(true);
    expect(fluid.every((p) => p.getAttribute("stroke-dasharray") === FLUID_DASH)).toBe(true);
    expect(exact[0].getAttribute("stroke")).toBe(fluid[0].getAttribute("stroke"));
    expect(exact[0].getAttribute("stroke")).not.toBe(exact[1].getAttribute("stroke"));
    expect([...svg.querySelectorAll("[data-stationary]")].map((l) => l.getAttribute("stroke-dasharray"))).toEqual([STATIONARY_DASH, STATIONARY_DASH]);
    expect(svg.querySelectorAll("[data-settling]")).toHaveLength(2);
    expect(svg.querySelector("[data-surge]")).toBeNull();
    expect([...svg.querySelectorAll("[data-axis-label]")].map((t) => t.textContent)).toEqual(["Mean number at the station (customers)", "Time (time units)"]);
    expect([...svg.querySelectorAll("[data-legend-item]")].map((g) => g.textContent)).toEqual(["S1 · exact", "S1 · fluid", "S2 · exact", "S2 · fluid", "long-run average (exact)", "settled (within 5 %)"]);
    // The text alternative: the caption sentence and a table of the same numbers.
    expect(container.querySelector("figcaption")!.textContent).toContain("Dashed lines: fluid approximation.");
    const described = svg.getAttribute("aria-describedby")!.split(" ");
    expect(described.every((id) => container.ownerDocument.getElementById(id))).toBe(true);
    expect(container.querySelector("[data-chart-table] thead")!.textContent).toContain("S1: exact mean (customers)");

    // By station: the long-run average, the relaxation time and the settling time, with units.
    const summary = container.querySelector("[data-transient-summary]")!;
    expect(summary.querySelector("thead")!.textContent).toContain("Relaxation time (time units)");
    const row = [...summary.querySelectorAll("tbody tr")][0];
    expect([...row.children].slice(0, 3).map((c) => c.textContent)).toEqual(["S1", "70 %", "2.33"]);
  });

  it("moves the read-out along a curve with the arrow keys", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector('svg[data-chart="transient"]')).not.toBeNull(), WAIT);
    const svg = container.querySelector('svg[data-chart="transient"]')!;
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(container.querySelector("[data-chart-live]")!.textContent).toMatch(/^S1 · exact · time [\d.]+\. [\d.]+ customers$/);
    fireEvent.keyDown(svg, { key: "ArrowDown" });
    expect(container.querySelector("[data-chart-live]")!.textContent).toMatch(/^S1 · fluid · time/);
  });

  it("shows the same numbers as a table, and one station at a time", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<TransientView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-transient-reading]")).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("radio", { name: w.modes.table }));
    const table = container.querySelector("[data-transient-table]")!;
    expect(container.querySelector('svg[data-chart="transient"]')).toBeNull();
    expect(table.querySelectorAll("thead th")).toHaveLength(8);
    expect(table.querySelectorAll("tbody tr").length).toBeGreaterThan(30);
    fireEvent.change(screen.getByLabelText(w.stationLabel), { target: { value: transientResult(tab.id)!.analysis.stations[1].id } });
    expect([...container.querySelectorAll("[data-transient-table] thead th")].map((th) => th.textContent)).toEqual(["Time (time units)", "S2: exact mean (customers)", "S2: fluid level (customers)", "S2: P(empty), exact", "Distance to steady state (total variation, 0 to 1)"]);
    expect((screen.getByRole("button", { name: w.exportChart }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds a surge: its ends are suggested, its window is shaded, and settling is counted from its end", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector("[data-transient-reading]")).not.toBeNull(), WAIT);
    fireEvent.change(screen.getByLabelText(w.initialLabel), { target: { value: "steady" } });
    fireEvent.change(screen.getByLabelText(w.horizonLabel), { target: { value: "200" } });
    fireEvent.click(screen.getByLabelText(w.surgeLabel));
    const horizon = 200;
    expect((screen.getByLabelText(w.surgeFrom) as HTMLInputElement).value).toBe(about(horizon / 10));
    expect((screen.getByLabelText(w.surgeUntil) as HTMLInputElement).value).toBe(about(horizon * 0.3));
    // The set-up no longer matches the curves shown.
    expect(container.querySelector(".results-note")!.textContent).toContain(w.staleNote);
    fireEvent.change(screen.getByLabelText(w.surgeFactor), { target: { value: "1.3" } });
    fireEvent.click(screen.getByRole("button", { name: w.runAgain }));
    await waitFor(() => expect(mockTransient.calls).toHaveLength(2), WAIT);
    await waitFor(() => expect(container.querySelector("[data-surge]")).not.toBeNull(), WAIT);
    expect(mockTransient.calls[1]).toMatchObject({ initial: { kind: "steady" }, surge: { factor: 1.3, from: Number(about(horizon / 10)), until: Number(about(horizon * 0.3)) } });
    expect(container.querySelector("[data-surge] text")!.textContent).toBe("Surge ×1.3");
    expect(container.querySelector("[data-chart-subtitle]")!.textContent).toBe(`Start: in steady state · arrivals ×1.3 from time ${about(horizon / 10)} to ${about(horizon * 0.3)}`);
    expect(container.querySelector("[data-transient-reading]")!.textContent).toMatch(/^The surge lifts S[12] to a mean of [\d.]+ customers at time [\d.]+; after the surge ends it takes about [\d.]+ time units to come back within 5 % of its long-run average of 2\.33 customers\.$/);
    expect(container.querySelector(".results-note")).toBeNull();
    const settled = transientResult(tab.id)!.analysis.exact!;
    expect(settled.settling.every((s) => s !== null && s >= settled.settleFrom)).toBe(true);
  });

  it("refuses a set-up it cannot compute, in a sentence, and dims Compute", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector("[data-transient-reading]")).not.toBeNull(), WAIT);
    fireEvent.change(screen.getByLabelText(w.horizonLabel), { target: { value: "-3" } });
    expect(container.querySelector("[data-transient-problem]")!.textContent).toBe(w.badHorizon);
    expect((container.querySelector("[data-transient-run]") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(w.horizonLabel), { target: { value: "30" } });
    expect(container.querySelector("[data-transient-problem]")).toBeNull();
    fireEvent.change(screen.getByLabelText(w.initialLabel), { target: { value: "given" } });
    fireEvent.change(screen.getByLabelText(w.numberAt("S1")), { target: { value: "8" } });
    fireEvent.click(container.querySelector("[data-transient-run]")!);
    await waitFor(() => expect(mockTransient.calls).toHaveLength(2), WAIT);
    expect(mockTransient.calls[1]).toMatchObject({ horizon: 30, initial: { kind: "given", numbers: [8, 0] } });
  });

  it("says why a network cannot be analysed: finite buffers, or nothing drawn", async () => {
    const tab = openExample(FINITE_EXAMPLE);
    const { container, unmount } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector("[data-transient-reason]")).not.toBeNull(), WAIT);
    expect(container.querySelector("[data-transient-reason]")!.textContent).toBe(FINITE);
    expect(container.querySelector("h2")!.textContent).toBe(w.neither);
    expect(mockTransient.calls).toHaveLength(0);
    unmount();
    const empty = tabById(addTab({ title: "Untitled", path: null, document: { ...example(FEEDBACK), nodes: [], links: [] } }))!;
    const second = render(<TransientView tabId={empty.id} decimals={2} />);
    expect(second.container.querySelector("h2")!.textContent).toBe(w.emptyTitle);
  });

  it("shows the fluid tier alone, with the reason, when there is no exact answer", async () => {
    const tab = openExample(FEEDBACK);
    mockTransient.run = (request) => ({ ...standInTransient(request), exact: null, exactReason: "The exact calculation would need about 1 048 576 states (the limit is 200 000): too many stations, or stations too heavily loaded. The fluid approximation still applies." });
    const { container } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector("[data-transient-reading]")).not.toBeNull(), WAIT);
    expect(container.querySelector('[data-tier="exact-refused"]')!.textContent).toContain("200 000");
    expect(container.querySelector('[data-tier="fluid"]')).not.toBeNull();
    const svg = container.querySelector('svg[data-chart="transient"]')!;
    expect([svg.querySelectorAll('path[data-tier="exact"]').length, svg.querySelectorAll('path[data-tier="fluid"]').length, svg.querySelectorAll("[data-stationary]").length]).toEqual([0, 2, 0]);
    expect(container.querySelector("[data-transient-reading]")!.textContent).toBe(w.fluidFlat);
  });

  it("warns when the exact curves lost probability at the cut-off", async () => {
    const tab = openExample(FEEDBACK);
    mockTransient.run = (request) => {
      const a = standInTransient(request);
      return { ...a, exact: { ...a.exact!, missingMass: 0.012, shortfall: a.exact!.shortfall.map(() => 0.74) } };
    };
    const { container } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector(".results-note")).not.toBeNull(), WAIT);
    // The means are lower bounds, with the proven bound on how far below — never "too low by about that fraction".
    expect(container.querySelector(".results-note")!.textContent).toBe(w.lostMassBounded("1.2 %", "0.74"));
    expect(container.querySelector(".results-note")!.textContent).toContain("lower bounds: the true means are higher, by at most 0.74 customers");
    expect(container.querySelector(".results-note")!.textContent).not.toContain("by about that fraction");
    expect(container.querySelector('[data-tier="exact"]')!.textContent).toContain("error in the distribution at most 1.2e-2");
    expect(container.querySelector('[data-tier="exact"]')!.textContent).toContain("each mean is a lower bound, too low by at most");
  });

  it("states no bound and no settling time where none is proven: a surge that overloads the network", async () => {
    const tab = openExample(FEEDBACK);
    mockTransient.run = (request) => {
      const a = standInTransient(request);
      return { ...a, exact: { ...a.exact!, missingMass: 3e-9, shortfall: [null, 2e-8], uncertified: [true, false], settling: [null, a.exact!.settling[1]] } };
    };
    const { container } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector(".results-note")).not.toBeNull(), WAIT);
    expect(container.querySelector(".results-note")!.textContent).toBe(w.meansUnbounded("3e-9"));
    expect(container.querySelector("[data-transient-mean-bound]")!.getAttribute("data-transient-mean-bound")).toBe("none");
    expect(container.querySelector('[data-tier="exact"]')!.textContent).toContain("the means are lower bounds, with no bound on how far below");
    expect(container.querySelector("[data-transient-reading]")!.textContent).toBe(w.uncertifiedUnbounded("S1", "5 %"));
    expect(container.querySelector("tbody tr td[title]")!.textContent).toContain(w.notCertified);
  });

  it("reads an error band wider than the settling band as not certified", () => {
    const a = answer({}, [null, 46]);
    a.exact = { ...a.exact!, shortfall: [0.4, 3e-8], uncertified: [true, false] };
    expect(reading(a, REQUEST, (x) => x.toFixed(2))).toBe(w.uncertifiedWide("S1", "5 %"));
  });

  it("shows progress while the exact tier runs, and Stop ends it with the fluid tier alone", async () => {
    const tab = openExample(FEEDBACK);
    mockTransient.hold = true;
    const { container } = render(<TransientView tabId={tab.id} decimals={2} />);
    await waitFor(() => expect(container.querySelector("[data-transient-progress]")).not.toBeNull(), WAIT);
    await waitFor(() => expect(container.querySelector("[data-transient-progress]")!.textContent).toBe(w.running(25)), WAIT);
    expect(container.querySelector("[data-transient-run]")).toBeNull();
    fireEvent.click(container.querySelector("[data-transient-stop]")!);
    await waitFor(() => expect(container.querySelector("[data-transient-reading]")).not.toBeNull(), WAIT);
    expect(mockTransient.stops).toEqual([mockTransient.calls[0].id]);
    expect(container.querySelector("[data-transient-progress]")).toBeNull();
    expect(container.querySelector(".results-note")!.textContent).toContain(w.stoppedNote);
    expect(container.querySelector('svg[data-chart="transient"]')!.querySelectorAll('path[data-tier="exact"]')).toHaveLength(0);
    expect(container.querySelector("[data-transient-run]")!.textContent).toBe(w.runAgain);
  });

  it("draws in a detached window's document", async () => {
    const tab = openExample(FEEDBACK);
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const host = frame.contentDocument!.body.appendChild(frame.contentDocument!.createElement("div"));
    const { unmount } = render(<TransientView tabId={tab.id} decimals={2} />, { container: host });
    await waitFor(() => expect(host.querySelector('svg[data-chart="transient"]')).not.toBeNull(), WAIT);
    expect(host.querySelector("[data-transient-reading]")!.ownerDocument).toBe(frame.contentDocument);
    unmount();
    frame.remove();
  });
});
