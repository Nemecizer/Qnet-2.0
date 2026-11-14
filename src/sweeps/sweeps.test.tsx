// Run ▸ What-If Sweep… (src/sweeps; ledger VIZ-300…): the parameters a network offers and the
// documents a sweep makes of them, the runner against the preview's quiet runs
// (src/dev/mock/sweeps2.ts) — progress, Stop, an overloaded gap, a refused method, nothing filed —
// the chart's data, the table and the CSV, Apply as one undo step, the panel and the Sweep view.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { lineLayout, LineChart } from "../charts";
import { mockRuns } from "../dev/mock/runs";
import { mockProbe, mockQuiet, mockQuietOutcome, PROBE_SUBJECT } from "../dev/mock/sweeps2";
import { drawnAs, openOnly } from "../closed/shape";
import type { QuietRunRequest } from "../lib/types";
import { defaultHandlers } from "../dev/mockBackend";
import { editorFor } from "../editor";
import { displayFixed } from "../editor/numbers";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, runCommand, unavailableReason } from "../lib/commands";
import { getStateValue, loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC } from "../lib/menuSpec";
import { resetOverlays } from "../lib/overlays";
import { ResultsPane } from "../panes/results/ResultsPane";
import { getRunState, resetRuns, startRun, stopRun } from "../runs/state";
import { liveRun } from "../runs/ui/live";
import { displayLabel } from "../runs/ui/words";
import { extendMock, mockCalls, mockTauri } from "../test/tauri";
import { addTab, getWorkspace, removeTabs, resetWorkspace, tabById } from "../workspace/store";
import { methodNotes, metricOptions, pickMetric, pickStation, stationOptions, sweepChart, sweepCsv, sweepTable } from "./chart";
import { applySweepValue, resetSweepCommands, specOf, startSweepCommands, summaryLine, SWEEP_COMMAND, sweepProblem, type SweepForm } from "./commands";
import { classesListed, classesServed, discoverParameters, parameterById, substitute, sweepValues, TIME_SCALE, withRate, type SweepParameter } from "./model";
import { MEASURED_SECONDS } from "./pointSeconds";
import { defaultRange, endAbandonedSweep, estimateSeconds, methodsFor, offeredMethods, POINT_SECONDS, resetSweepRunner, runSweep, SWEEP_METHOD, SWEEPABLE, UNMEASURED_SECONDS, type MethodChoice, type SweepSpec } from "./runner";
import { SweepHost } from "./SweepPanel";
import { SweepView } from "./SweepView";
import { resetSweepStore, setSweepResult, startSweepStore, stateKey, sweepIsStale, sweepResult, takeSweepViewRequest, type SweepResult } from "./store";
import { aboutTime, sweepWords } from "./words";
import { asDistribution, computeMean, computeSCV, DISTRIBUTIONS, storedParams } from "../panes/inspector/distributions";
import { setStateValues } from "../lib/kv";
import { resetStructures } from "../results/current";

const examples = import.meta.glob("../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
// Rust's reader fills in the view fields an older file lacks; so does this.
const example = (stem: string) => ({ canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(examples[`../../examples/${stem}.bnet`]) }) as BnetDocument;
const openExample = (stem: string) => addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: example(stem) });

const TANDEM = "5stationtandem.inf";
const MULTI = "3d2ctandem.inf";
const FINITE = "Tandem2.MM1.K5.fin";
const REENTRANT = "KumarSeidman90.d2.c4.reentrant.inf";
const FEEDBACK = "OpenJackson.d2.feedback.p30.inf";

const node = (doc: BnetDocument, name: string) => doc.nodes.find((n) => n.name === name)!;
const byLabel = (doc: BnetDocument, label: string) => discoverParameters(doc).find((p) => p.label === label)!;
const fmt = (x: number) => displayFixed(x, 3);

const frames: HTMLIFrameElement[] = [];
let opened: { name: string; win: Window }[] = [];

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetWorkspace();
  resetRuns();
  resetOverlays();
  resetSweepStore();
  resetSweepRunner();
  resetSweepCommands();
  startSweepCommands();
  mockQuiet.pointMs = 2;
  mockRuns.replayMs = 30;
  opened = [];
  vi.spyOn(window, "open").mockImplementation((_url, target) => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frames.push(frame);
    const win = frame.contentWindow!;
    opened.push({ name: String(target), win });
    return win;
  });
});
afterEach(async () => {
  if (getRunState().active) await act(async () => void (await stopRun()));
  await new Promise((r) => setTimeout(r, 10));
  frames.splice(0).forEach((f) => f.remove());
  vi.restoreAllMocks();
});

const spec = (doc: BnetDocument, label: string, from: number, to: number, points: number, methods: string[], more: Partial<SweepSpec> = {}): SweepSpec => ({
  parameterId: byLabel(doc, label).id,
  from,
  to,
  points,
  methods: methods.map((m) => ({ label: m, name: displayLabel(m), tier: "approximation" as const })),
  metric: "Mean number in system",
  stationId: null,
  ...more,
});

// ── Parameters ──────────────────────────────────────────────────────────────────────────────────

describe("the parameters a network offers", () => {
  it("a single-class tandem: the load factor, the arrival rate, a service rate and a server count per station", () => {
    const doc = example(TANDEM);
    const ps = discoverParameters(doc);
    expect(ps.map((p) => p.label)).toEqual([
      "Load factor (every arrival rate × this)",
      "Src1 arrival rate",
      ...[1, 2, 3, 4, 5].map((i) => `S${i} service rate`),
      ...[1, 2, 3, 4, 5].map((i) => `S${i} number of servers`),
    ]);
    expect(ps[0]).toMatchObject({ id: "load", kind: "load", current: 1, integer: false });
    expect(ps[1]).toMatchObject({ kind: "arrival", current: 1, unit: "per time unit", nodeId: node(doc, "Src1").id });
    expect(byLabel(doc, "S1 service rate").current).toBeCloseTo(1.1111111, 9);
    expect(byLabel(doc, "S3 number of servers")).toMatchObject({ current: 1, integer: true, min: 1 });
    // Infinite buffers: no buffer size; a tandem: no routing probability.
    expect(ps.some((p) => p.kind === "buffer" || p.kind === "routing")).toBe(false);
  });

  it("a multiclass network: each source's rate, and a service rate per class at each station", () => {
    const doc = example(MULTI);
    const ps = discoverParameters(doc);
    expect(ps.filter((p) => p.kind === "arrival").map((p) => p.label)).toEqual(["Src1 arrival rate", "Src2 arrival rate"]);
    expect(ps.filter((p) => p.kind === "service").map((p) => p.label)).toEqual(["S1", "S2", "S3"].flatMap((s) => [`${s} service rate, Class 1`, `${s} service rate, Class 2`]));
    expect(byLabel(doc, "S3 service rate, Class 2")).toMatchObject({ customerClass: 1, axis: "Service rate at S3, Class 2" });
    expect(byLabel(doc, "S3 service rate, Class 2").current).toBeCloseTo(1.111111111, 9);
  });

  it("a finite-buffer network adds each buffer's size", () => {
    const doc = example(FINITE);
    const ps = discoverParameters(doc);
    expect(ps.filter((p) => p.kind === "buffer").map((p) => [p.label, p.current, p.integer])).toEqual([["B1 size", 4, true], ["B2 size", 4, true]]);
    // A Poisson source's rate is its λ.
    expect(byLabel(doc, "Src1 arrival rate").current).toBeCloseTo(0.7, 12);
  });

  it("a re-entrant line: the classes a station serves, by their own laws", () => {
    const doc = example(REENTRANT);
    expect(classesServed(doc, node(doc, "S1").id)).toEqual([0, 3]);
    expect(classesServed(doc, node(doc, "S2").id)).toEqual([1, 2]);
    const service = discoverParameters(doc).filter((p) => p.kind === "service");
    expect(service.map((p) => [p.label, Number(p.current.toPrecision(7))])).toEqual([
      ["S1 service rate, Class 1", 10],
      ["S1 service rate, Class 4", 1.666667],
      ["S2 service rate, Class 2", 10],
      ["S2 service rate, Class 3", 1.666667],
    ]);
    // Each class leaves a station by one link: no probability has a "rest" to give.
    expect(discoverParameters(doc).some((p) => p.kind === "routing")).toBe(false);
  });

  it("an empty canvas offers nothing, and a network without a source no load factor", () => {
    expect(discoverParameters({ nodes: [], links: [], infiniteBuffers: true, canvasScale: 1, canvasPanOffset: [0, 0] })).toEqual([]);
    const doc = example(TANDEM);
    const sourceless = { ...doc, nodes: doc.nodes.filter((n) => n.kind !== "source") };
    expect(discoverParameters(sourceless).some((p) => p.kind === "load" || p.kind === "arrival")).toBe(false);
  });
});

describe("a parameter set to another value", () => {
  it("writes a rate as the inspector would, and leaves every other node as it was", () => {
    const doc = example(TANDEM);
    const next = substitute(doc, byLabel(doc, "Src1 arrival rate"), 0.85)!;
    expect(node(next, "Src1")).toMatchObject({ distribution: "exponential", distributionParameters: "rate=0.85" });
    for (const n of doc.nodes) if (n.name !== "Src1") expect(next.nodes.find((x) => x.id === n.id)).toBe(n);
    expect(next.links).toBe(doc.links);
    expect(doc.nodes.find((n) => n.name === "Src1")!.distributionParameters).toBe("rate=1.0");
    // A Poisson source keeps its key.
    const fin = example(FINITE);
    expect(node(substitute(fin, byLabel(fin, "Src1 arrival rate"), 0.45)!, "Src1").distributionParameters).toBe("lambda=0.45");
    // The preview's traffic equations read the new document: it is a valid network.
    expect(mockProbe(next).loads.map((l) => Number(l.utilisation.toFixed(4)))).toEqual([0.765, 0.765, 0.765, 0.765, 0.765]);
  });

  it("keeps a family's shape when it moves its mean", () => {
    expect(withRate("gamma", "shape=2.0,scale=1.0", 1)).toBe("shape=2.0,scale=0.5");
    expect(withRate("erlang", "k=2,rate=1.0", 0.25)).toBe("k=2,rate=0.5");
    expect(withRate("constant", "value=0.25", 2)).toBe("value=0.5");
    expect(withRate("uniform", "min=0.5,max=1.5", 2)).toBe("min=0.25,max=0.75");
    expect(withRate("exponential", "rate=1.0", 0)).toBeNull();
    expect(withRate("exponential", "rate=1.0", Number.NaN)).toBeNull();
  });

  it("the load factor scales every arrival rate", () => {
    const doc = example(MULTI);
    const next = substitute(doc, byLabel(doc, "Load factor (every arrival rate × this)"), 1.2)!;
    expect([node(next, "Src1").distributionParameters, node(next, "Src2").distributionParameters]).toEqual(["rate=0.6", "rate=0.6"]);
    expect(node(next, "S1")).toBe(node(doc, "S1"));
  });

  it("a service rate goes to the class's own law, and the station's law follows its first class", () => {
    const doc = example(MULTI);
    const second = substitute(doc, byLabel(doc, "S2 service rate, Class 2"), 2)!;
    expect(node(second, "S2").serviceDistributions).toEqual({ "0": { distribution: "exponential", distributionParameters: "rate=1.1111111111" }, "1": { distribution: "exponential", distributionParameters: "rate=2" } });
    expect(node(second, "S2").distributionParameters).toBe("rate=1.1111111111");
    const first = substitute(doc, byLabel(doc, "S2 service rate, Class 1"), 2)!;
    expect(node(first, "S2").serviceDistributions["0"].distributionParameters).toBe("rate=2");
    expect(node(first, "S2").distributionParameters).toBe("rate=2");
    // One class with its own entry (S1 of the tandem) and one without (S4): both laws stay in step.
    const tandem = example(TANDEM);
    const s1 = node(substitute(tandem, byLabel(tandem, "S1 service rate"), 1.5)!, "S1");
    expect([s1.distributionParameters, s1.serviceDistributions["0"].distributionParameters]).toEqual(["rate=1.5", "rate=1.5"]);
    const s4 = node(substitute(tandem, byLabel(tandem, "S4 service rate"), 1.5)!, "S4");
    expect([s4.distributionParameters, s4.serviceDistributions]).toEqual(["rate=1.5", {}]);
    // A re-entrant class that had only its own entry.
    const re = example(REENTRANT);
    const k = node(substitute(re, byLabel(re, "S1 service rate, Class 4"), 2)!, "S1");
    expect(k.serviceDistributions["3"].distributionParameters).toBe("rate=2");
    expect(k.serviceDistributions["0"].distributionParameters).toBe("rate=10.000000");
    expect(k.distributionParameters).toBe("rate=1.0");
  });

  it("servers and buffer sizes are whole numbers within their bounds", () => {
    const doc = example(FINITE);
    expect(node(substitute(doc, byLabel(doc, "S1 number of servers"), 3)!, "S1").numberOfServers).toBe(3);
    expect(node(substitute(doc, byLabel(doc, "B2 size"), 9)!, "B2").bufferSize).toBe(9);
    expect(substitute(doc, byLabel(doc, "B2 size"), 2.5)).toBeNull();
    expect(substitute(doc, byLabel(doc, "B2 size"), 0)).toBeNull();
    expect(substitute(doc, byLabel(doc, "S1 number of servers"), 0)).toBeNull();
    expect(substitute(doc, byLabel(doc, "Src1 arrival rate"), 0)).toBeNull();
    expect(substitute(doc, byLabel(doc, "Src1 arrival rate"), -1)).toBeNull();
  });

  it("evenly spaced values, each once", () => {
    expect(sweepValues({ integer: false }, 0.5, 0.95, 4)).toEqual([0.5, 0.65, 0.8, 0.95]);
    expect(sweepValues({ integer: false }, 0.1, 0.3, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(sweepValues({ integer: true }, 1, 4, 12)).toEqual([1, 2, 3, 4]);
    expect(sweepValues({ integer: false }, 1, 0, 3)).toEqual([1, 0.5, 0]);
    expect(sweepValues({ integer: false }, 0, 1, 500)).toHaveLength(60);
    // Readable values: two more places than the step needs, the ends as given.
    expect(sweepValues({ integer: false }, 0.5, 1.25, 14).slice(0, 4)).toEqual([0.5, 0.5577, 0.6154, 0.6731]);
    expect(sweepValues({ integer: false }, 0.5, 1.0555555, 3)).toEqual([0.5, 0.778, 1.0555555]);
    expect(sweepValues({ integer: false }, 100, 400, 4)).toEqual([100, 200, 300, 400]);
  });
});

describe("the routing complement", () => {
  it("is offered where exactly one other link leaves the same node on the same class, and that link takes the rest", () => {
    const doc = example(FEEDBACK);
    const routing = discoverParameters(doc).filter((p) => p.kind === "routing");
    expect(routing.map((p) => [p.label, p.current, p.max])).toEqual([
      ["S1 → B2 probability (S1 → B1 takes the rest)", 0.7, 1],
      ["S1 → B1 probability (S1 → B2 takes the rest)", 0.3, 1],
    ]);
    const next = substitute(doc, routing[1], 0.45)!;
    const p = (d: BnetDocument, to: string) => d.links.find((l) => l.fromNodeID === node(d, "S1").id && l.toNodeID === node(d, to).id)!.routingProbability;
    expect([p(next, "B1"), p(next, "B2")]).toEqual([0.45, 0.55]);
    expect(p(next, "B1") + p(next, "B2")).toBe(1);
    // The ends of the range: all of it, none of it; nothing beyond.
    expect([p(substitute(doc, routing[1], 0)!, "B1"), p(substitute(doc, routing[1], 0)!, "B2")]).toEqual([0, 1]);
    expect([p(substitute(doc, routing[1], 1)!, "B1"), p(substitute(doc, routing[1], 1)!, "B2")]).toEqual([1, 0]);
    expect(substitute(doc, routing[1], 1.2)).toBeNull();
    expect(substitute(doc, routing[1], -0.1)).toBeNull();
    // Every other link is the same object.
    expect(next.links.filter((l, i) => l !== doc.links[i])).toHaveLength(2);
  });

  it("keeps a row that sums to less than one at that sum", () => {
    const doc = example(FEEDBACK);
    const leaky = { ...doc, links: doc.links.map((l) => (l.routingProbability === 0.7 ? { ...l, routingProbability: 0.5 } : l)) };
    const back = discoverParameters(leaky).find((p) => p.label.startsWith("S1 → B1"))!;
    expect(back.max).toBe(0.8);
    const next = substitute(leaky, back, 0.2)!;
    expect(next.links.filter((l) => l.fromNodeID === node(doc, "S1").id).map((l) => l.routingProbability)).toEqual([0.6, 0.2]);
  });

  it("is not offered for a three-way split, a lone link, or links of different classes", () => {
    const doc = example(FEEDBACK);
    const s1 = node(doc, "S1").id;
    const third = { ...doc.links.find((l) => l.fromNodeID === s1)!, id: "THIRD", toNodeID: node(doc, "Sink").id, routingProbability: 0.1 };
    expect(discoverParameters({ ...doc, links: [...doc.links, third] }).some((p) => p.kind === "routing")).toBe(false);
    expect(discoverParameters(example(TANDEM)).some((p) => p.kind === "routing")).toBe(false);
    const split = { ...doc, links: doc.links.map((l) => (l.fromNodeID === s1 && l.routingProbability === 0.3 ? { ...l, customerClass: 1 } : l)) };
    expect(discoverParameters(split).some((p) => p.kind === "routing")).toBe(false);
    // A sweep made before the network lost the sibling can't be substituted any more.
    const was = discoverParameters(doc).find((p) => p.kind === "routing")!;
    expect(substitute({ ...doc, links: [...doc.links, third] }, was, 0.5)).toBeNull();
  });
});

// ── Ranges and methods ──────────────────────────────────────────────────────────────────────────

describe("the panel's defaults", () => {
  it("a range round the current value, drawn in where the network would pass utilisation 0.95", async () => {
    const doc = example(TANDEM);
    const probe = async (d: BnetDocument) => mockProbe(d);
    // ρ = 0.9 λ here: λ = 1.5 would overload every station.
    const arrival = await defaultRange(doc, byLabel(doc, "Src1 arrival rate"), probe);
    expect(arrival.from).toBe(0.5);
    expect(arrival.to).toBeLessThanOrEqual(0.95 / 0.9);
    expect(arrival.to).toBeGreaterThan(1.04);
    expect(arrival.edge!.unstable).toBe("above");
    expect(arrival.edge!.x).toBeCloseTo(1 / 0.9, 3);
    // A service rate is overloaded from below.
    const service = await defaultRange(doc, byLabel(doc, "S2 service rate"), probe);
    expect(service.from).toBeGreaterThanOrEqual(1 / 0.95);
    expect(service.from).toBeLessThan(1.07);
    expect(service.to).toBeCloseTo(1.6666666665, 6);
    expect(service.edge).toMatchObject({ unstable: "below" });
    expect(service.edge!.x).toBeCloseTo(1, 3);
    // A count: a few steps either way, never below one server.
    expect(await defaultRange(doc, byLabel(doc, "S1 number of servers"), probe)).toMatchObject({ from: 1, to: 4 });
    // A finite-buffer network is never overloaded: the plain range.
    const fin = example(FINITE);
    expect(await defaultRange(fin, byLabel(fin, "Src1 arrival rate"), probe)).toEqual({ from: 0.35, to: 1.05, edge: null });
    expect(await defaultRange(fin, byLabel(fin, "B1 size"), probe)).toEqual({ from: 1, to: 10, edge: null });
    // A probability: the whole row, unless part of it overloads.
    const fb = example(FEEDBACK);
    const back = await defaultRange(fb, byLabel(fb, "S1 → B1 probability (S1 → B2 takes the rest)"), probe);
    expect(back.from).toBe(0);
    expect(back.to).toBeLessThan(1);
    // A network that can't be probed gets the plain range.
    expect(await defaultRange(doc, byLabel(doc, "Src1 arrival rate"), async () => Promise.reject(new Error("no")))).toEqual({ from: 0.5, to: 1.5, edge: null });
  });

  it("offers the Method Chooser's applicable methods that are quick, with the best exact one and the best approximation ticked", async () => {
    const tab = tabById(openExample(TANDEM))!;
    const offered = await methodsFor(tab);
    const labels = offered.map((m) => m.label);
    expect(labels).toEqual(expect.arrayContaining(["product_form", "qna", "rqna", "inf_sim"]));
    // The experimental methods are not offered, nor a finite-buffer one.
    for (const no of ["adaptive_bar", "bar_bounds", "mc", "fm", "sim"]) expect(labels).not.toContain(no);
    const ticked = offered.filter((m) => m.preferred);
    expect(ticked.map((m) => m.tier).sort()).toEqual(["approximation", "exact"]);
    expect(ticked.find((m) => m.tier === "exact")!.label).toBe("product_form");
    expect(offered.find((m) => m.label === "inf_sim")).toMatchObject({ tier: "simulation", slow: true, preferred: false });
    expect(offered.find((m) => m.label === "inf_sm")?.tier ?? "diffusion").toBe("diffusion");
    // With no exact method, the best approximation alone.
    const fin = await methodsFor(tabById(openExample(FINITE))!);
    expect(fin.map((m) => m.label)).toEqual(expect.arrayContaining(["sim", "fb_decomp"]));
    expect(fin.filter((m) => m.preferred).length).toBeGreaterThanOrEqual(1);
    expect(offeredMethods([])).toEqual([]);
  });

  it("says what will happen in plain words, and what stops it", () => {
    const doc = example(TANDEM);
    const p = byLabel(doc, "Src1 arrival rate");
    const offered: MethodChoice[] = [
      { label: "product_form", name: "Product Form", tier: "exact", seconds: 0.6, slow: false, preferred: true },
      { label: "qna", name: "QNA", tier: "approximation", seconds: 0.3, slow: false, preferred: true },
      { label: "inf_sim", name: "Simulation", tier: "simulation", seconds: 10, slow: true, preferred: false },
    ];
    const form: SweepForm = { parameterId: p.id, from: "0.5", to: "0.95", points: "12", methods: ["product_form", "qna"], metric: "Mean number in system", stationId: null };
    expect(estimateSeconds(12, offered.slice(0, 2))).toBeCloseTo(10.8, 9);
    expect(summaryLine(form, p, offered)).toBe("12 points × 2 methods; about 11 seconds.");
    expect(summaryLine({ ...form, points: "10", methods: ["qna"] }, p, offered)).toBe("10 points × 1 method; about 3 seconds.");
    expect(summaryLine({ ...form, methods: ["qna", "inf_sim"] }, p, offered)).toBe("12 points × 2 methods; about 4 seconds, plus the simulation (set by its run length).");
    expect(summaryLine({ ...form, methods: ["inf_sim"] }, p, offered)).toBe("12 points × 1 method; the time is set by the simulation's run length.");
    expect(aboutTime(0.4)).toBe("under a second");
    expect(sweepProblem(form, p)).toBeNull();
    expect(specOf(form, p, offered)).toMatchObject({ parameterId: p.id, from: 0.5, to: 0.95, points: 12, methods: [{ label: "product_form" }, { label: "qna" }] });
    expect(sweepProblem(form, null)).toBe("Choose a parameter");
    expect(sweepProblem({ ...form, from: "x" }, p)).toBe("From isn't a number");
    expect(sweepProblem({ ...form, to: "" }, p)).toBe("To isn't a number");
    expect(sweepProblem({ ...form, to: "0.5" }, p)).toBe("From and To must differ");
    expect(sweepProblem({ ...form, from: "0" }, p)).toBe("Values must be above 0");
    expect(sweepProblem({ ...form, points: "1" }, p)).toBe("Points must be between 2 and 60");
    expect(sweepProblem({ ...form, points: "61" }, p)).toBe("Points must be between 2 and 60");
    expect(sweepProblem({ ...form, methods: [] }, p)).toBe("Tick at least one method");
    expect(specOf({ ...form, methods: [] }, p, offered)).toBeNull();
    const servers = byLabel(doc, "S1 number of servers");
    expect(sweepProblem({ ...form, parameterId: servers.id, from: "1.5", to: "4" }, servers)).toBe("This parameter takes whole numbers");
    expect(sweepProblem({ ...form, parameterId: servers.id, from: "0", to: "4" }, servers)).toBe("Values can't be below 1");
    const fb = example(FEEDBACK);
    const back = byLabel(fb, "S1 → B1 probability (S1 → B2 takes the rest)");
    expect(sweepProblem({ ...form, parameterId: back.id, from: "0", to: "1.5" }, back)).toBe("Values can't be above 1");
    // A count's range holds only so many whole numbers.
    expect(summaryLine({ ...form, parameterId: servers.id, from: "1", to: "4", methods: ["qna"] }, servers, offered)).toBe("4 points × 1 method; about 1 second.");
  });
});

// ── The runner ──────────────────────────────────────────────────────────────────────────────────

describe("running a sweep against the preview", () => {
  it("runs every point by every method quietly: progress in the run segment, nothing filed, nothing in the Shell", async () => {
    const id = openExample(TANDEM);
    const doc = tabById(id)!.document;
    const seen: { fraction: number | null; text: string; label: string }[] = [];
    const before = mockQuiet.runs.length;
    const fractions: (number | null)[] = [];
    const timer = setInterval(() => {
      const a = getRunState().active;
      if (a) {
        fractions.push(a.fraction);
        seen.push({ fraction: a.fraction, text: a.text, label: displayLabel(a.method) });
      }
    }, 1);
    const result = (await runSweep(id, spec(doc, "Load factor (every arrival rate × this)", 0.5, 1, 6, ["product_form", "qna"])))!;
    clearInterval(timer);

    expect(result.values).toEqual([0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    expect(result.methods.map((m) => [m.label, m.shortName, m.tier])).toEqual([["product_form", "Product Form", "exact"], ["qna", "QNA", "approximation"]]);
    expect(result.cells.every((row) => row.length === 6 && row.every((c) => c.ok))).toBe(true);
    expect(mockQuiet.runs.length - before).toBe(12);
    // Each run got the document with the parameter set, and the settings.
    const sent = mockQuiet.runs.slice(before);
    expect(sent.map((r) => r.method)).toEqual(Array.from({ length: 6 }, () => ["product_form", "qna"]).flat());
    expect(sent.map((r) => (r.document as BnetDocument).nodes.find((n) => n.kind === "source")!.distributionParameters).filter((_x, i) => i % 2 === 0)).toEqual(["rate=0.5", "rate=0.6", "rate=0.7", "rate=0.8", "rate=0.9", "rate=1.0"]);
    // Each point is named as this sweep's.
    expect(new Set(sent.map((r) => r.sweepId)).size).toBe(1);
    expect(sent[0].sweepId).toMatch(/^preview-sweep-/);
    expect(sent[0].settings).toHaveProperty("output.decimals");
    expect(sent[0]).toMatchObject({ tabId: id, title: `${TANDEM}.bnet` });
    // The tab's own document is untouched.
    expect(tabById(id)!.document).toBe(doc);

    // One run to the app: it held the slot once, showed as "What-If Sweep" with a growing fraction, and ended.
    expect([mockQuiet.begun, mockQuiet.ended]).toEqual([1, 1]);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((s) => s.label))).toEqual(new Set(["What-If Sweep"]));
    const known = fractions.filter((f): f is number => f !== null);
    expect(known).toEqual([...known].sort((a, b) => a - b));
    expect(known.every((f) => f >= 0 && f <= 1)).toBe(true);
    expect(seen.some((s) => /^Point \d of 6 · /.test(s.text))).toBe(true);
    expect(getRunState().active).toBeNull();
    expect(getRunState().last).toMatchObject({ kind: "success", tabId: id, recordId: null });
    expect(getRunState().last!.summary).toMatch(/^What-If Sweep finished in \d+\.\d s$/);

    // Nothing was filed and no method was started through the Run menu's path.
    expect(mockRuns.records).toEqual([]);
    expect(mockRuns.starts).toEqual([]);
    expect(mockCalls.some((c) => c.cmd === "run_start")).toBe(false);
    // The tab's Status log has the sweep's two lines, not twelve runs'.
    expect(tabById(id)!.log.map((l) => l.text)).toEqual([
      "What-If Sweep: Load factor (every arrival rate × this) from 0.5 to 1, 6 points, by Product Form and QNA.",
      "What-If Sweep finished: 12 of 12 runs gave a result.",
    ]);
    // It is the tab's saved sweep, in memory and in the state file, and the Results pane is asked for it.
    expect(sweepResult(id)).toBe(result);
    expect((getStateValue<SweepResult | null>(stateKey(id), null))!.id).toBe(result.id);
    expect(takeSweepViewRequest()).toBe(true);
  });

  it("leaves an overloaded point out as a gap with the reason, without starting a method for it, and finds where the network tips over", async () => {
    const id = openExample(TANDEM);
    const doc = tabById(id)!.document;
    const result = (await runSweep(id, spec(doc, "Src1 arrival rate", 0.9, 1.3, 5, ["qna"])))!;
    expect(result.values).toEqual([0.9, 1, 1.1, 1.2, 1.3]);
    expect(result.cells[0].map((c) => (c.ok ? "ok" : c.reason))).toEqual(["ok", "ok", "ok", "unstable", "unstable"]);
    const gap = result.cells[0][3];
    // S1 is the slowest server by a hair (rate 1.1111111).
    expect(!gap.ok && gap.sentence).toBe("S1 would be overloaded (utilisation 1.080), so the network has no steady state.");
    // Only the three stable points were run.
    expect(mockQuiet.runs).toHaveLength(3);
    // ρ reaches 1 at λ = 1.1111111 (S1's rate): between the third point and the fourth.
    expect(result.limits).toHaveLength(1);
    expect(result.limits[0].unstable).toBe("above");
    expect(result.limits[0].x).toBeCloseTo(1.1111111, 4);
    expect(getRunState().last).toMatchObject({ kind: "success" });
    expect(tabById(id)!.log.at(-1)!.text).toBe("What-If Sweep finished: 3 of 5 runs gave a result; 2 points left out (see the Sweep view).");
  });

  it("drops a method that refuses the network after its first refusal, and keeps the others", async () => {
    const id = openExample(TANDEM);
    const doc = tabById(id)!.document;
    mockQuiet.refuse.rqna = "RQNA needs a licence the preview lacks.";
    mockQuiet.fail.sbd = "SBD exited with status 3.";
    const result = (await runSweep(id, spec(doc, "S1 service rate", 1.2, 2, 4, ["qna", "rqna", "fm", "sbd"])))!;
    expect(result.cells[0].every((c) => c.ok)).toBe(true);
    expect(result.cells[1].map((c) => (c.ok ? "ok" : c.reason))).toEqual(["refused", "skipped", "skipped", "skipped"]);
    // A method of the other buffer mode refuses in a sentence, as Rust's does.
    expect(result.cells[2].map((c) => (c.ok ? "" : c.sentence))).toEqual(Array(4).fill("Finite Element isn't offered for a network with infinite buffers."));
    // A failure is a gap at that point; the method is tried again at the next.
    expect(result.cells[3].map((c) => (c.ok ? "ok" : c.reason))).toEqual(["failed", "failed", "failed", "failed"]);
    // 4 QNA + 1 RQNA + 1 FEM + 4 SBD: the refused ones were asked once.
    expect(mockQuiet.runs.map((r) => r.method)).toEqual(["qna", "rqna", "fm", "sbd", "qna", "sbd", "qna", "sbd", "qna", "sbd"]);
    const log = tabById(id)!.log;
    expect(log.filter((l) => l.severity === "warning").map((l) => l.text)).toEqual([
      "Robust QNA was left out of the sweep: RQNA needs a licence the preview lacks.",
      "Finite Element was left out of the sweep: Finite Element isn't offered for a network with infinite buffers.",
    ]);
    expect(methodNotes(result)).toEqual([
      { method: "Robust QNA", sentence: "RQNA needs a licence the preview lacks." },
      { method: "Finite Element", sentence: "Finite Element isn't offered for a network with infinite buffers." },
      { method: "SBD", sentence: "SBD exited with status 3." },
    ]);
    expect(getRunState().last).toMatchObject({ kind: "success" });
  });

  it("Stop cancels it promptly, keeps the points that finished and frees the slot", async () => {
    const id = openExample(TANDEM);
    const doc = tabById(id)!.document;
    mockQuiet.pointMs = 40;
    const running = runSweep(id, spec(doc, "Src1 arrival rate", 0.5, 0.9, 20, ["qna", "rqna"]));
    await waitFor(() => expect(mockQuiet.runs.length).toBeGreaterThanOrEqual(3));
    // The sweep is the live run; a Run-menu method is refused with the registry's sentence.
    expect(liveRun()).toMatchObject({ method: SWEEP_METHOD, tabId: id });
    expect(await startRun(id, "qna")).toBe(false);
    expect(tabById(id)!.log.at(-1)!.text).toBe(`QNA was not started because What-If Sweep is already running for “${TANDEM}.bnet”. Stop or wait for that run first.`);
    expect(liveRun()).toMatchObject({ method: SWEEP_METHOD });
    // A second sweep is not started either.
    expect(await runSweep(id, spec(doc, "Src1 arrival rate", 0.5, 0.9, 3, ["qna"]))).toBeNull();

    const asked = mockQuiet.runs.length;
    const t0 = Date.now();
    expect(await stopRun()).toBe("What-If Sweep");
    const result = (await running)!;
    expect(Date.now() - t0).toBeLessThan(35);
    expect(mockQuiet.runs.length).toBe(asked);
    expect(result.stopped).toBe(true);
    const states = result.cells.flat().map((c) => (c.ok ? "ok" : c.reason));
    expect(states.filter((s) => s === "ok").length).toBe(asked - 1);
    expect(states.filter((s) => s === "stopped").length).toBe(40 - (asked - 1));
    expect(result.limits).toEqual([]);
    expect(getRunState().active).toBeNull();
    expect(getRunState().last).toMatchObject({ kind: "warning" });
    expect(getRunState().last!.summary).toMatch(/^What-If Sweep cancelled after /);
    expect(tabById(id)!.log.at(-1)!.text).toBe(`What-If Sweep cancelled. ${asked - 1} of 40 runs had finished; the chart shows those.`);
    expect([mockQuiet.begun, mockQuiet.ended]).toEqual([1, 1]);
    // The slot is free again.
    expect(await startRun(id, "qna")).toBe(true);
    await waitFor(() => expect(getRunState().active).toBeNull());
    expect(sweepResult(id)).toBe(result);
  });

  it("is refused while a run is in progress, and for a sweep with nothing to run", async () => {
    const id = openExample(TANDEM);
    const doc = tabById(id)!.document;
    mockRuns.replayMs = 80;
    expect(await startRun(id, "qna")).toBe(true);
    expect(await runSweep(id, spec(doc, "Src1 arrival rate", 0.5, 0.9, 3, ["qna"]))).toBeNull();
    expect(tabById(id)!.log.at(-1)!.text).toBe(`What-If Sweep was not started because QNA is already running for “${TANDEM}.bnet”. Stop or wait for that run first.`);
    expect(mockQuiet.runs).toEqual([]);
    expect(getRunState().active).toMatchObject({ method: "qna" });
    await waitFor(() => expect(getRunState().active).toBeNull());
    expect(await runSweep(id, { ...spec(doc, "Src1 arrival rate", 0.5, 0.9, 3, []) })).toBeNull();
    expect(await runSweep(id, { ...spec(doc, "Src1 arrival rate", 0.5, 0.9, 3, ["qna"]), parameterId: "arrival:GONE" })).toBeNull();
    expect(await runSweep("NO-TAB", spec(doc, "Src1 arrival rate", 0.5, 0.9, 3, ["qna"]))).toBeNull();
    expect(sweepResult(id)).toBeNull();
  });

  it("a sweep with no result at all still shows why, and a closed tab's sweep is forgotten", async () => {
    const id = openExample(TANDEM);
    const other = openExample(MULTI);
    const doc = tabById(id)!.document;
    mockQuiet.refuse.qna = "No.";
    expect(await runSweep(id, spec(doc, "Src1 arrival rate", 0.5, 0.9, 3, ["qna"]))).toBeNull();
    expect(getRunState().last).toMatchObject({ kind: "failure" });
    expect(tabById(id)!.log.at(-1)!.text).toBe("What-If Sweep finished without a single result; the Sweep view says why for each method.");
    const shown = sweepResult(id)!;
    expect(methodNotes(shown)).toEqual([{ method: "QNA", sentence: "No." }]);
    expect(pickMetric(shown, null)).toBeNull();
    removeTabs([id]);
    expect(sweepResult(id)).toBeNull();
    await waitFor(() => expect(getStateValue<unknown>(stateKey(id), null)).toBeNull());
    expect(getWorkspace().tabs.map((t) => t.id)).toContain(other);
    expect(getWorkspace().tabs.map((t) => t.id)).not.toContain(id);
  });
});

// ── The chart's data, the table and the CSV ─────────────────────────────────────────────────────

/** A sweep of the tandem's arrival rate into the overloaded region, by an exact method, an approximation and a simulation. */
async function tandemSweep(): Promise<{ id: string; result: SweepResult }> {
  const id = openExample(TANDEM);
  const doc = tabById(id)!.document;
  const s2 = node(doc, "S2").id;
  const result = (await runSweep(id, spec(doc, "Src1 arrival rate", 0.5, 1.3, 5, ["product_form", "qna", "inf_sim"], { stationId: s2 })))!;
  return { id, result };
}

describe("what the Sweep view draws", () => {
  it("offers every measure and station kept, and opens on the panel's choice", async () => {
    const { result } = await tandemSweep();
    expect(metricOptions(result).map((o) => `${o.metric} (${o.unit})`)).toEqual(["Utilization (ratio)", "Mean number in system (customers)", "Mean sojourn time (time)", "Throughput (customers / time)"]);
    const metric = pickMetric(result, null)!;
    expect(metric.metric).toBe("Mean number in system");
    expect(stationOptions(result, metric).map((s) => s.label)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(pickStation(result, metric, null)!.label).toBe("S2");
    expect(pickStation(result, metric, stationOptions(result, metric)[4].key)!.label).toBe("S5");
    expect(pickMetric(result, "Throughput|customers / time")!.metric).toBe("Throughput");
    expect(pickMetric(result, "Gone|x")!.metric).toBe("Mean number in system");
  });

  it("is a line per method in its tier's colour, a band for the simulation, a gap where there is no value, and rules for now and for the limit", async () => {
    const { result } = await tandemSweep();
    const metric = pickMetric(result, null)!;
    const station = pickStation(result, metric, null)!;
    const chart = sweepChart(result, metric, station, fmt, 1)!;
    expect(chart.series.map((s) => [s.key, s.label, s.color, s.shape])).toEqual([
      ["product_form", "Product Form · exact", "--tier-exact", "circle"],
      ["qna", "QNA · approximation", "--tier-approximation", "square"],
      ["inf_sim", "Monte Carlo · simulation", "--tier-simulation", "diamond"],
    ]);
    // x = the parameter; the two overloaded points are gaps, not zeros.
    expect(chart.series[0].points.map((p) => [p.x, p.gap ?? false])).toEqual([[0.5, false], [0.7, false], [0.9, false], [1.1, false], [1.3, true]]);
    // M/M/1 at S2 (μ = 1.111111111): L = ρ / (1 − ρ), exactly for the exact method.
    const rho = 0.7 / 1.111111111;
    expect(chart.series[0].points[1].y).toBeCloseTo(rho / (1 - rho), 9);
    expect(chart.series[1].points[1].y).toBeGreaterThan(chart.series[0].points[1].y);
    // Only the simulation carries an interval.
    expect(chart.series[0].points.every((p) => p.low === null || p.low === undefined)).toBe(true);
    const sim = chart.series[2].points[0];
    expect(sim.low!).toBeLessThan(sim.y);
    expect(sim.high!).toBeGreaterThan(sim.y);
    expect(chart.intervalWord).toBe("95 % interval");
    expect(chart.rules!.map((r) => [r.tone, r.label, Number(r.x.toFixed(3))])).toEqual([["current", "now", 1], ["limit", "overloaded beyond", 1.111]]);
    expect(chart.title).toBe("Mean number in system at S2 against arrival rate at Src1");
    expect(chart.subtitle).toBe(`${TANDEM}.bnet · 3 methods · 5 points`);
    expect(chart.xLabel).toBe("Arrival rate at Src1 (per time unit)");
    expect(chart.yLabel).toBe("Mean number in system (customers)");
    expect(chart.unit).toBe("customers");
    expect(chart.caption).toBe(
      `Mean number in system at S2 as arrival rate at Src1 goes from 0.5 to 1.3, according to Exact Open Product Form (exact), Whitt QNA (approximation) and Monte Carlo (simulation). ` +
        `By Product Form it rises from ${fmt(chart.series[0].points[0].y)} to ${fmt(chart.series[0].points[3].y)} customers. The network is overloaded beyond about 1.111, where the measure grows without bound. 1 value could not be computed and is left as a gap.`,
    );
    // The parameter gone from the network: no "now" rule.
    expect(sweepChart(result, metric, station, fmt, null)!.rules!.map((r) => r.tone)).toEqual(["limit"]);
    // A measure only some methods report draws only those.
    const sojourn = pickMetric(result, "Mean sojourn time|time")!;
    expect(sweepChart(result, sojourn, station, fmt, 1)!.series).toHaveLength(3);
  });

  it("the LineChart breaks its line at a gap, spans the gap on the axis, and draws the rules", async () => {
    const { result } = await tandemSweep();
    // Punch a hole in the middle of the exact method's line.
    const holed: SweepResult = { ...result, cells: result.cells.map((row, j) => (j === 0 ? row.map((c, i) => (i === 1 ? { ok: false as const, reason: "failed" as const, sentence: "It broke." } : c)) : row)) };
    const metric = pickMetric(holed, null)!;
    const chart = sweepChart(holed, metric, pickStation(holed, metric, null)!, fmt, 1)!;
    const L = lineLayout({ width: 640, ...chart });
    // Two strokes: 0.5 alone, then 0.9 to 1.1.
    expect(L.lines[0].path.match(/M/g)).toHaveLength(2);
    expect(L.lines[0].points.map((p) => p.x)).toEqual([0.5, 0.9, 1.1]);
    expect(L.lines[1].path.match(/M/g)).toHaveLength(1);
    // The axis runs on to the overloaded 1.3, where nothing is drawn.
    expect(Math.max(...L.x.domain)).toBeGreaterThanOrEqual(1.3);
    expect(L.rules.map((r) => r.tone)).toEqual(["current", "limit"]);
    expect(L.rules[1].px).toBeGreaterThan(L.rules[0].px);
    // The simulation's band stops at its last value.
    expect(L.lines[2].band).toMatch(/Z$/);
    const { container } = render(<LineChart width={640} {...chart} />);
    expect(container.querySelectorAll("[data-line]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-band]")).toHaveLength(1);
    expect([...container.querySelectorAll("[data-rule]")].map((n) => [n.getAttribute("data-rule"), n.querySelector("text")!.textContent])).toEqual([["current", "now"], ["limit", "overloaded beyond"]]);
    expect(container.querySelector('[data-rule="limit"] line')).toHaveAttribute("stroke-dasharray");
    expect(container.querySelector('[data-rule="current"] line')).not.toHaveAttribute("stroke-dasharray");
    // The text alternative has every x, a dash at each gap.
    const t = container.querySelector("[data-chart-table]") as HTMLTableElement;
    expect([...t.tHead!.rows[0].cells].map((c) => c.textContent)).toEqual(["Arrival rate at Src1 (per time unit)", "Product Form · exact (customers)", "QNA · approximation (customers)", "Monte Carlo · simulation (customers)"]);
    expect([...t.tBodies[0].rows].map((r) => r.cells[0].textContent)).toEqual(["0.5", "0.7", "0.9", "1.1"]);
    expect(t.tBodies[0].rows[1].cells[1].textContent).toBe("—");
    // A rule outside the range drawn is left out.
    expect(lineLayout({ width: 640, ...chart, rules: [{ x: 9, label: "now", tone: "current" }] }).rules).toEqual([]);
  });

  it("the table has the same numbers, a row per point, with the reason at each gap", async () => {
    const { result } = await tandemSweep();
    const metric = pickMetric(result, null)!;
    const station = pickStation(result, metric, null)!;
    const chart = sweepChart(result, metric, station, fmt, 1)!;
    const table = sweepTable(result, metric, station, fmt);
    expect(table.caption).toBe("Mean number in system at S2, a row per point");
    expect(table.head).toEqual(["Arrival rate at Src1 (per time unit)", "Product Form (customers)", "QNA (customers)", "Monte Carlo (customers)"]);
    expect(table.rows.map((r) => r.label)).toEqual(["0.5", "0.7", "0.9", "1.1", "1.3"]);
    expect(table.rows[1].cells[0].text).toBe(fmt(chart.series[0].points[1].y));
    const sim = chart.series[2].points[1];
    expect(table.rows[1].cells[2].text).toBe(`${fmt(sim.y)} (${fmt(sim.low!)} to ${fmt(sim.high!)})`);
    expect(table.rows[4].cells.map((c) => [c.text, c.reason])).toEqual(Array(3).fill(["—", "Overloaded"]));
    expect(table.rows[4].cells[0].sentence).toMatch(/would be overloaded \(utilisation 1\.\d{3}\)/);
  });

  it("the CSV has a row per point and method with every digit, and the reason where there is no value", async () => {
    const { result } = await tandemSweep();
    const metric = pickMetric(result, null)!;
    const station = pickStation(result, metric, null)!;
    const csv = sweepCsv(result, { metric, station });
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("Arrival rate at Src1 (per time unit),Method,Tier,Station,Class,Measure,Unit,Estimate,Interval low,Interval high,Note");
    expect(lines).toHaveLength(1 + 5 * 3);
    const exact = result.cells[0][0];
    const value = exact.ok ? exact.m.find((m) => m.k === "Mean number in system" && m.n === "S2")!.v : Number.NaN;
    expect(lines[1]).toBe(`0.5,Product Form,Exact,S2,,Mean number in system,customers,${String(value)},,,`);
    const sim = lines[3].split(",");
    expect(sim.slice(0, 3)).toEqual(["0.5", "Monte Carlo", "Simulation (95 % interval)"]);
    expect(Number(sim[8])).toBeLessThan(Number(sim[7]));
    expect(Number(sim[9])).toBeGreaterThan(Number(sim[7]));
    expect(lines[13]).toMatch(/^1\.3,Product Form,Exact,S2,,Mean number in system,customers,,,,"?Overloaded: S\d would be overloaded \(utilisation 1\.\d+\), so the network has no steady state\."?$/);
    expect(csv.endsWith("\n")).toBe(true);
    // Everything kept: four measures at five stations for each of the eleven results, and a row per gap.
    const all = sweepCsv(result).trimEnd().split("\n");
    expect(all).toHaveLength(1 + 4 * 3 * 20 + 3);
    // A field with a comma is quoted.
    const comma: SweepResult = { ...result, methods: result.methods.map((m, j) => (j === 0 ? { ...m, shortName: 'Exact, "really"' } : m)) };
    expect(sweepCsv(comma, { metric, station }).split("\n")[1]).toMatch(/^0\.5,"Exact, ""really""",Exact,/);
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────────────────────────

describe("Apply this value", () => {
  const event = async (f: () => void) => {
    f();
    await Promise.resolve();
    await Promise.resolve();
  };

  it("sets the parameter in the network as one undo step", async () => {
    const id = openExample(MULTI);
    const editor = editorFor(id);
    const before = tabById(id)!.document;
    const load = parameterById(before, "load")!;
    expect(editor.undoManager.canUndo).toBe(false);
    let changed = false;
    await event(() => void (changed = applySweepValue(id, load, 1.2)));
    expect(changed).toBe(true);
    const after = tabById(id)!.document;
    // Both sources moved, in one step.
    expect([node(after, "Src1").distributionParameters, node(after, "Src2").distributionParameters]).toEqual(["rate=0.6", "rate=0.6"]);
    expect(editor.undoManager.undoActionName).toBe("Apply Sweep Value");
    expect(tabById(id)!.log.at(-1)!.text).toBe("Set Load factor (every arrival rate × this) to 1.2 from the sweep.");
    // One line, not one per source.
    expect(tabById(id)!.log.filter((l) => /Updated Src/.test(l.text))).toEqual([]);
    await event(() => editor.undo());
    expect([node(tabById(id)!.document, "Src1").distributionParameters, node(tabById(id)!.document, "Src2").distributionParameters]).toEqual(["rate=0.5", "rate=0.5"]);
    expect(editor.undoManager.canUndo).toBe(false);
    await event(() => editor.redo());
    expect(node(tabById(id)!.document, "Src1").distributionParameters).toBe("rate=0.6");
  });

  it("applies each kind through the editor: a class's service rate, servers, a buffer, a probability and its complement", async () => {
    const id = openExample(MULTI);
    const doc = () => tabById(id)!.document;
    await event(() => void applySweepValue(id, byLabel(doc(), "S2 service rate, Class 1"), 2));
    expect(node(doc(), "S2").serviceDistributions["0"].distributionParameters).toBe("rate=2");
    expect(node(doc(), "S2").distributionParameters).toBe("rate=2");
    expect(node(doc(), "S2").serviceDistributions["1"].distributionParameters).toBe("rate=1.1111111111");
    await event(() => void applySweepValue(id, byLabel(doc(), "S1 number of servers"), 3));
    expect(node(doc(), "S1").numberOfServers).toBe(3);
    const editor = editorFor(id);
    await event(() => editor.undo());
    await event(() => editor.undo());
    expect(node(doc(), "S2").distributionParameters).toBe("rate=1.1111111111");
    expect(editor.undoManager.canUndo).toBe(false);

    const fin = openExample(FINITE);
    await event(() => void applySweepValue(fin, byLabel(tabById(fin)!.document, "B1 size"), 9));
    expect(node(tabById(fin)!.document, "B1").bufferSize).toBe(9);

    const fb = openExample(FEEDBACK);
    const back = byLabel(tabById(fb)!.document, "S1 → B1 probability (S1 → B2 takes the rest)");
    await event(() => void applySweepValue(fb, back, 0.1));
    const s1 = node(tabById(fb)!.document, "S1").id;
    expect(tabById(fb)!.document.links.filter((l) => l.fromNodeID === s1).map((l) => l.routingProbability)).toEqual([0.9, 0.1]);
    await event(() => editorFor(fb).undo());
    expect(tabById(fb)!.document.links.filter((l) => l.fromNodeID === s1).map((l) => l.routingProbability)).toEqual([0.7, 0.3]);
    expect(editorFor(fb).undoManager.canUndo).toBe(false);
  });

  it("says so when the value is already there or the network no longer has the parameter", async () => {
    const id = openExample(TANDEM);
    const p = byLabel(tabById(id)!.document, "S1 number of servers");
    let changed = true;
    await event(() => void (changed = applySweepValue(id, p, 1)));
    expect(changed).toBe(false);
    expect(tabById(id)!.log.at(-1)!.text).toBe("S1 number of servers is already 1.");
    expect(editorFor(id).undoManager.canUndo).toBe(false);
    const gone: SweepParameter = { ...p, id: "servers:GONE", label: "S9 number of servers" };
    await event(() => void (changed = applySweepValue(id, gone, 2)));
    expect(changed).toBe(false);
    expect(tabById(id)!.log.at(-1)).toMatchObject({ text: "The network no longer has “S9 number of servers”, so the value wasn't applied.", severity: "warning" });
  });
});

// ── The panel and the view ──────────────────────────────────────────────────────────────────────

const panel = () => {
  const o = [...opened].reverse().find((x) => x.name === "qnet-panel-what-if-sweep");
  if (!o) throw new Error("no sweep panel");
  return within(o.win.document.body);
};

describe("the panel", () => {
  it("is in the Run menu, dimmed without a network and while a run is in progress", async () => {
    const run = MENU_SPEC.find((m) => typeof m === "object" && "submenu" in m && m.submenu === "Run") as { items: unknown[] };
    expect(run.items).toContainEqual({ id: SWEEP_COMMAND, label: "What-If Sweep…" });
    const when = () => unavailableReason(getCommand(SWEEP_COMMAND)!);
    expect(when()).toBe("Add a network first");
    const id = openExample(TANDEM);
    expect(when()).toBeNull();
    mockRuns.replayMs = 60;
    await startRun(id, "qna");
    expect(when()).toBe("A run is in progress; stop it or wait for it first");
    await waitFor(() => expect(getRunState().active).toBeNull());
    expect(when()).toBeNull();
  });

  it("opens filled in from the network, says what will run, and runs it", async () => {
    const id = openExample(TANDEM);
    render(<SweepHost />);
    await act(async () => void (await runCommand(SWEEP_COMMAND)));
    const p = panel();
    const parameter = p.getByLabelText("Parameter") as HTMLSelectElement;
    expect([...parameter.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Whole network", "Arrival rates", "Service rates", "Servers"]);
    expect(parameter.selectedOptions[0].textContent).toBe("Load factor (every arrival rate × this)");
    // The range stays stable: the tandem is at ρ = 0.9, so the load factor stops near 0.95 / 0.9.
    await waitFor(() => expect(Number((p.getByLabelText("To") as HTMLInputElement).value)).toBeLessThan(1.06));
    expect((p.getByLabelText("From") as HTMLInputElement).value).toBe("0.5");
    expect(Number((p.getByLabelText("To") as HTMLInputElement).value)).toBeGreaterThan(1.04);
    expect((p.getByLabelText("Points") as HTMLInputElement).value).toBe("12");
    expect(p.getByText("Now 1.")).toBeInTheDocument();
    // The methods, with their tiers; the best exact one and the best approximation ticked.
    await waitFor(() => expect(p.getByLabelText(/Product Form/)).toBeChecked());
    const boxes = [...p.getByRole("form").querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    const ticked = boxes.filter((b) => b.checked).map((b) => b.getAttribute("data-method"));
    expect(ticked).toHaveLength(2);
    expect(ticked).toContain("product_form");
    expect(p.getAllByText("Exact").length).toBeGreaterThanOrEqual(1);
    expect(p.getAllByText("Simulation (95 % interval)").length).toBeGreaterThanOrEqual(1);
    expect((p.getByLabelText("Measure") as HTMLSelectElement).value).toBe("Mean number in system");
    // The chart opens on the busiest station (S1: the slowest server by a hair).
    await waitFor(() => expect((p.getByLabelText("Station") as HTMLSelectElement).selectedOptions[0].textContent).toBe("S1"));
    expect(p.getByText(/^12 points × 2 methods; about \d+ seconds\.$/)).toBeInTheDocument();

    // Ticking a simulation warns about the time, and the summary follows.
    fireEvent.click(boxes.find((b) => b.getAttribute("data-method") === "inf_sim")!);
    expect(p.getByText(/simulates every point afresh: the time is set by the run length in Settings/)).toBeInTheDocument();
    expect(p.getByText(/^12 points × 3 methods; about \d+ seconds, plus the simulation \(set by its run length\)\.$/)).toBeInTheDocument();
    fireEvent.click(boxes.find((b) => b.getAttribute("data-method") === "inf_sim")!);

    // A problem replaces the summary and blocks Run.
    fireEvent.change(p.getByLabelText("Points"), { target: { value: "99" } });
    expect(p.getByText("Points must be between 2 and 60")).toBeInTheDocument();
    expect(p.getByRole("button", { name: "Run Sweep" })).toBeDisabled();
    fireEvent.change(p.getByLabelText("Points"), { target: { value: "4" } });
    // A range the user types beyond the limit says so.
    fireEvent.change(p.getByLabelText("To"), { target: { value: "1.3" } });
    expect(p.getByText("The network is overloaded beyond 1.111; points there are left out.")).toBeInTheDocument();
    fireEvent.change(p.getByLabelText("To"), { target: { value: "1" } });

    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Run Sweep" })));
    await waitFor(() => expect(sweepResult(id)).not.toBeNull());
    await waitFor(() => expect(getRunState().active).toBeNull());
    const result = sweepResult(id)!;
    expect(result.parameter.id).toBe("load");
    expect(result.values).toHaveLength(4);
    expect([result.from, result.to]).toEqual([0.5, 1]);
    expect(result.methods.map((m) => m.label).sort()).toEqual([...ticked].sort());
    expect(result.metric).toBe("Mean number in system");
    expect(result.stationId).toBe(node(tabById(id)!.document, "S1").id);
    // The panel is gone.
    expect(opened.filter((o) => o.name === "qnet-panel-what-if-sweep" && !o.win.closed).length).toBeLessThanOrEqual(1);
  });

  it("changing the parameter finds that parameter's range; Cancel runs nothing", async () => {
    const id = openExample(FINITE);
    render(<SweepHost />);
    await act(async () => void (await runCommand(SWEEP_COMMAND)));
    const p = panel();
    const parameter = p.getByLabelText("Parameter") as HTMLSelectElement;
    expect([...parameter.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Whole network", "Arrival rates", "Service rates", "Servers", "Buffer sizes"]);
    const b1 = [...parameter.options].find((o) => o.textContent === "B1 size")!;
    await act(async () => void fireEvent.change(parameter, { target: { value: b1.value } }));
    await waitFor(() => expect((p.getByLabelText("To") as HTMLInputElement).value).toBe("10"));
    expect((p.getByLabelText("From") as HTMLInputElement).value).toBe("1");
    expect((p.getByLabelText("Points") as HTMLInputElement).value).toBe("10");
    expect(p.getByText("Now 4 customers.")).toBeInTheDocument();
    await act(async () => void fireEvent.click(p.getByRole("button", { name: "Cancel" })));
    expect(mockQuiet.runs).toEqual([]);
    expect(sweepResult(id)).toBeNull();
  });
});

describe("the Sweep view", () => {
  it("says what to press when there is no sweep", () => {
    const id = openExample(TANDEM);
    render(<SweepView tabId={id} decimals={3} />);
    expect(screen.getByRole("heading", { name: "No sweep yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What-If Sweep…" })).toBeEnabled();
  });

  it("draws the chart, changes measure and station without running again, and shows the same numbers as a table", async () => {
    const { id, result } = await tandemSweep();
    const ran = mockQuiet.runs.length;
    const { container } = render(<SweepView tabId={id} decimals={3} />);
    await waitFor(() => expect(container.querySelector('svg[data-chart="line"]')).not.toBeNull());
    const svg = container.querySelector('svg[data-chart="line"]') as SVGSVGElement;
    expect(svg).toHaveAttribute("aria-label", `Mean number in system at S2 against arrival rate at Src1. ${TANDEM}.bnet · 3 methods · 5 points`);
    expect(container.querySelectorAll("[data-line]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-rule]")).toHaveLength(2);
    expect([...container.querySelectorAll("[data-legend-item]")].map((n) => n.textContent)).toEqual(["Product Form · exact", "QNA · approximation", "Monte Carlo · simulation"]);
    expect(container.querySelector(".chart-caption")!.textContent).toMatch(/^Mean number in system at S2 as arrival rate at Src1 goes from 0\.5 to 1\.3/);

    // Another measure and another station: the same sweep, nothing run.
    fireEvent.change(screen.getByLabelText("Measure"), { target: { value: "Utilization|ratio" } });
    expect(container.querySelector("svg[data-chart]")).toHaveAttribute("aria-label", expect.stringMatching(/^Utilization at S2 against/));
    const s5 = [...(screen.getByLabelText("Station") as HTMLSelectElement).options].find((o) => o.textContent === "S5")!;
    fireEvent.change(screen.getByLabelText("Station"), { target: { value: s5.value } });
    expect(container.querySelector("svg[data-chart]")).toHaveAttribute("aria-label", expect.stringMatching(/^Utilization at S5 against/));
    expect(mockQuiet.runs.length).toBe(ran);

    // The table.
    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    expect(container.querySelector('svg[data-chart="line"]')).toBeNull();
    const table = container.querySelector("[data-sweep-table]") as HTMLTableElement;
    expect(table.caption!.textContent).toBe("Utilization at S5, a row per point");
    expect([...table.tBodies[0].rows].map((r) => r.cells[0].textContent)).toEqual(["0.5", "0.7", "0.9", "1.1", "1.3"]);
    const exact = result.cells[0][0];
    const u = exact.ok ? exact.m.find((m) => m.k === "Utilization" && m.n === "S5")!.v : Number.NaN;
    expect(table.tBodies[0].rows[0].cells[1].textContent).toBe(displayFixed(u, 3));
    expect(table.tBodies[0].rows[4].cells[1].textContent).toBe("Overloaded");
    expect(table.tBodies[0].rows[4].cells[1]).toHaveAttribute("title", expect.stringMatching(/would be overloaded/));
    expect(screen.getByRole("button", { name: "Export Chart…" })).toBeDisabled();
    // The view's choices outlive a remount.
    fireEvent.click(screen.getByRole("radio", { name: "Chart" }));
    expect(container.querySelector("svg[data-chart]")).toHaveAttribute("aria-label", expect.stringMatching(/^Utilization at S5 against/));
  });

  it("applies the value the chart's read-out is on, as one undo step, and marks the sweep as of the network before", async () => {
    const { id } = await tandemSweep();
    const { container } = render(<SweepView tabId={id} decimals={3} />);
    await waitFor(() => expect(container.querySelector('svg[data-chart="line"]')).not.toBeNull());
    const apply = () => container.querySelector("[data-sweep-apply]") as HTMLButtonElement;
    expect(apply()).toBeDisabled();
    expect(apply().textContent).toBe("Apply This Value");
    const svg = container.querySelector('svg[data-chart="line"]') as SVGSVGElement;
    act(() => svg.focus());
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    await waitFor(() => expect(apply().textContent).toBe("Apply Arrival rate at Src1 = 0.7"));
    // The read-out goes with the focus; the value stays in hand.
    fireEvent.keyDown(svg, { key: "Escape" });
    expect(apply()).toBeEnabled();
    await act(async () => void fireEvent.click(apply()));
    expect(node(tabById(id)!.document, "Src1").distributionParameters).toBe("rate=0.7");
    const editor = editorFor(id);
    expect(editor.undoManager.undoActionName).toBe("Apply Sweep Value");
    // The "now" rule follows the network.
    await waitFor(() => expect(container.querySelector('[data-rule="current"]')).toHaveAttribute("data-rule-x", "0.7"));
    await act(async () => {
      editor.undo();
      await Promise.resolve();
    });
    expect(node(tabById(id)!.document, "Src1").distributionParameters).toBe("rate=1.0");
    expect(editor.undoManager.canUndo).toBe(false);
    // A table row applies its own value.
    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Apply Arrival rate at Src1 = 0.9" })));
    expect(node(tabById(id)!.document, "Src1").distributionParameters).toBe("rate=0.9");
    expect(container.querySelector("tr[data-current] th")!.textContent).toBe("0.9");
  });

  it("exports the data shown as CSV and the chart as a figure, through the export paths", async () => {
    const { id, result } = await tandemSweep();
    const { container } = render(<SweepView tabId={id} decimals={3} />);
    await waitFor(() => expect(container.querySelector('svg[data-chart="line"]')).not.toBeNull());
    const asked: Record<string, unknown>[] = [];
    const written: { path: string; text: string }[] = [];
    extendMock({
      "plugin:dialog|save": ({ options }: { options: Record<string, unknown> }) => {
        asked.push(options);
        return String(options.defaultPath).endsWith(".csv") ? "/out/sweep.csv" : "/out/sweep.svg";
      },
      export_save: ({ path, text }: { path: string; text: string }) => {
        written.push({ path, text });
        return path.split("/").pop();
      },
    });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Export Data…" })));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(asked[0]).toMatchObject({ title: "Export Sweep Data", defaultPath: `${TANDEM} Sweep.csv` });
    const metric = pickMetric(result, null)!;
    expect(written[0]).toEqual({ path: "/out/sweep.csv", text: sweepCsv(result, { metric, station: pickStation(result, metric, null)! }) });
    expect(tabById(id)!.log.at(-1)!.text).toBe("Saved the sweep's data as sweep.csv.");

    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Export Chart…" })));
    await waitFor(() => expect(written).toHaveLength(2));
    const svg = written[1].text;
    expect(svg).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg /);
    // Light colours on white whatever the app shows; no hover furniture; the rules and the band are in.
    expect(svg).not.toContain("var(--");
    expect(svg).toContain("#2b5fd9");
    expect(svg).toContain("stroke-dasharray");
    expect(svg).toContain("overloaded beyond");
    expect(svg).not.toContain("data-mark");
  });

  it("is the Results pane's fourth view, shown when a sweep finishes", async () => {
    const id = openExample(TANDEM);
    render(<ResultsPane />);
    const sweepTab = () => screen.getByRole("radio", { name: "Sweep" });
    expect(sweepTab()).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sweepTab());
    expect(screen.getByRole("heading", { name: "No sweep yet" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    const doc = tabById(id)!.document;
    await act(async () => void (await runSweep(id, spec(doc, "Src1 arrival rate", 0.5, 0.9, 3, ["qna"]))));
    await waitFor(() => expect(sweepTab()).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(document.querySelector('svg[data-chart="line"]')).not.toBeNull());
    // One method: no legend, and the line is the approximation's colour.
    expect(document.querySelectorAll("[data-line]")).toHaveLength(1);
    // The run history is untouched: the sweep filed nothing.
    expect(mockRuns.records).toEqual([]);
    // The sweep is of the network as it was: an edit says so.
    await act(async () => {
      editorFor(id).updateNumberOfServers(node(doc, "S3").id, 2);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("The network has changed since this sweep ran.")).toBeInTheDocument());
  });

  it("a stored sweep comes back with the tab", async () => {
    const { id, result } = await tandemSweep();
    resetSweepStore();
    expect(sweepResult(id)!.id).toBe(result.id);
    setSweepResult(id, null);
    resetSweepStore();
    expect(sweepResult(id)).toBeNull();
  });
});

// ── The review's findings (each fails without its fix) ──────────────────────────────────────────

const records = import.meta.glob("../../golden/runs/*/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const meanAt = (doc: BnetDocument, station: string, cls: number) => {
  const n = node(doc, station);
  const law = n.serviceDistributions?.[String(cls)] ?? { distribution: n.distribution, distributionParameters: n.distributionParameters };
  return computeMean(asDistribution(law.distribution), storedParams(law.distributionParameters));
};

describe("review 1: a class's service rate at a station whose classes share one law", () => {
  /** S2 of the two-class tandem with no per-class entry: both classes read the station's law. */
  const shared = () => {
    const doc = example(MULTI);
    return { ...doc, nodes: doc.nodes.map((n) => (n.name === "S2" ? { ...n, serviceDistributions: {} } : n)) };
  };

  it("moves only the swept class, in every sweep document", () => {
    for (const [label, swept, other] of [["S2 service rate, Class 1", 0, 1], ["S2 service rate, Class 2", 1, 0]] as const) {
      const doc = shared();
      const before = meanAt(doc, "S2", other);
      for (const x of sweepValues({ integer: false }, 0.5, 3, 6)) {
        const at = substitute(doc, byLabel(doc, label), x)!;
        expect(meanAt(at, "S2", swept)).toBeCloseTo(1 / x, 9);
        expect(meanAt(at, "S2", other)).toBe(before);
        // The untouched class reads the same in the inspector: its own entry, with the old law.
        expect(node(at, "S2").serviceDistributions[String(other)]).toEqual({ distribution: "exponential", distributionParameters: node(doc, "S2").distributionParameters });
      }
    }
  });

  it("and after Apply, through the editor", async () => {
    const id = addTab({ title: "shared.bnet", document: shared() });
    const before = meanAt(tabById(id)!.document, "S2", 1);
    applySweepValue(id, byLabel(tabById(id)!.document, "S2 service rate, Class 1"), 2);
    await Promise.resolve();
    await Promise.resolve();
    const after = tabById(id)!.document;
    expect(meanAt(after, "S2", 0)).toBe(0.5);
    expect(meanAt(after, "S2", 1)).toBe(before);
    expect(editorFor(id).undoManager.undoActionName).toBe("Apply Sweep Value");
  });
});

describe("review 2 and 6: a sweep's requests are its own, and its slot is given back", () => {
  it("Stop with no point in flight (during the stability probe) ends the sweep promptly with “stopped”", async () => {
    const id = openExample(TANDEM);
    const doc = tabById(id)!.document;
    let release: () => void = () => {};
    let probes = 0;
    extendMock({
      quiet_probe: async ({ document }: { document: BnetDocument }) => {
        // The third point's probe waits: nothing is in flight while Stop is pressed.
        if (++probes === 3) await new Promise<void>((r) => (release = r));
        return mockProbe(document);
      },
    });
    const running = runSweep(id, spec(doc, "Src1 arrival rate", 0.5, 0.9, 5, ["qna"]));
    await waitFor(() => expect(probes).toBe(3));
    expect(await stopRun()).toBe("What-If Sweep");
    // The slot is free in that gap, and an ordinary run takes it.
    mockRuns.replayMs = 60;
    expect(await startRun(id, "qna")).toBe(true);
    release();
    const result = (await running)!;
    expect(result.stopped).toBe(true);
    const states = result.cells[0].map((c) => (c.ok ? "ok" : c.reason));
    // Not a record made outside the sweep, and not "refused" (which would drop the method).
    expect(states).toEqual(["ok", "ok", "stopped", "stopped", "stopped"]);
    expect(mockQuiet.runs.length).toBe(3);
    expect(methodNotes(result)).toEqual([]);
    expect(getRunState().last!.summary).toMatch(/^What-If Sweep cancelled after /);
    await waitFor(() => expect(getRunState().active).toBeNull());
  });

  it("a sweep whose loop throws still gives the slot back", async () => {
    const id = openExample(TANDEM);
    const doc = tabById(id)!.document;
    vi.spyOn(sweepWords, "progress").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(await runSweep(id, spec(doc, "Src1 arrival rate", 0.5, 0.9, 3, ["qna"]))).toBeNull();
    expect([mockQuiet.begun, mockQuiet.ended]).toEqual([1, 1]);
    expect(getRunState().active).toBeNull();
    vi.restoreAllMocks();
    expect(await startRun(id, "qna")).toBe(true);
    await waitFor(() => expect(getRunState().active).toBeNull());
  });

  it("a page that loads ends the sweep a previous page left", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    expect(await invoke("quiet_begin", { tabId: "GONE", title: "gone.bnet" })).toMatchObject({ started: true });
    const id = openExample(TANDEM);
    expect(await startRun(id, "qna")).toBe(false);
    await endAbandonedSweep();
    expect(mockQuiet.ended).toBe(1);
    expect(await startRun(id, "qna")).toBe(true);
    await waitFor(() => expect(getRunState().active).toBeNull());
  });

  it("a closed tab's saved sweep is removed without a view ever reading it, and stale ones are swept at launch", async () => {
    const id = openExample(TANDEM);
    const kept = openExample(MULTI);
    const saved = { values: [1], methods: [], cells: [], parameter: { id: "load" } };
    await setStateValues({ [stateKey(id)]: saved, [stateKey(kept)]: saved, [stateKey("no-such-tab")]: saved, "other.key": 1 });
    resetSweepStore();
    let ready: () => void = () => {};
    startSweepStore(undefined, (then) => (ready = then));
    // Not before the session's tabs are in place.
    await new Promise((r) => setTimeout(r, 5));
    expect(getStateValue<unknown>(stateKey("no-such-tab"), null)).not.toBeNull();
    ready();
    await waitFor(() => expect(getStateValue<unknown>(stateKey("no-such-tab"), null)).toBeNull());
    expect(getStateValue<unknown>(stateKey(kept), null)).not.toBeNull();
    expect(getStateValue<unknown>(stateKey(id), null)).not.toBeNull();
    expect(getStateValue<unknown>("other.key", null)).toBe(1);
    removeTabs([id]);
    await waitFor(() => expect(getStateValue<unknown>(stateKey(id), null)).toBeNull());
    expect(getStateValue<unknown>(stateKey(kept), null)).not.toBeNull();
  });
});

describe("review 3: a rate is swept by rescaling time", () => {
  it("the point at the current value is the document itself, for every parameter of every example", () => {
    const stems = Object.keys(examples).map((k) => k.replace(/^.*\/(.*)\.bnet$/, "$1"));
    expect(stems.length).toBe(50);
    let checked = 0;
    for (const stem of stems) {
      const doc = example(stem);
      for (const p of discoverParameters(doc)) {
        expect(substitute(doc, p, p.current), `${stem}: ${p.label}`).toEqual(doc);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("every family has a time scale: the shape's text is untouched, the SCV is the same and the mean is 1/rate", () => {
    const laws: Record<string, string> = {
      exponential: "rate=1.0",
      poisson: "lambda=0.7",
      erlang: "k=3,rate=1.7",
      gamma: "shape=0.3333333333333333,scale=1.3",
      weibull: "shape=0.7300000000001,scale=2.0",
      pareto: "shape=2.5000000000001,scale=1.0",
      constant: "value=0.25",
      uniform: "min=0.1,max=1.7",
      lognormal: "mu=0.3,sigma=0.7100000000003",
    };
    expect(Object.keys(laws).sort()).toEqual([...DISTRIBUTIONS].sort());
    for (const [family, stored] of Object.entries(laws)) {
      const d = asDistribution(family);
      const scaled = new Set(Object.values(TIME_SCALE[d]).flat());
      const next = withRate(family, stored, 3.7)!;
      const [was, now] = [storedParams(stored), storedParams(next)];
      expect(computeMean(d, now)!, family).toBeCloseTo(1 / 3.7, 9);
      expect(computeSCV(d, now)!, family).toBeCloseTo(computeSCV(d, was)!, 9);
      const text = (s: string) => Object.fromEntries(s.split(",").map((pair) => pair.split("=")));
      for (const key of Object.keys(was)) if (!scaled.has(key)) expect(text(next)[key], `${family} ${key}`).toBe(text(stored)[key]);
      // Back again: the same law.
      const rate = Number((1 / computeMean(d, was)!).toPrecision(12));
      expect(withRate(family, stored, rate)).toBe(stored);
    }
  });

  it("Apply at the current value reports no change", async () => {
    const id = openExample(MULTI);
    const p = byLabel(tabById(id)!.document, "S2 service rate, Class 2");
    expect(applySweepValue(id, p, p.current)).toBe(false);
    expect(tabById(id)!.log.at(-1)!.text).toBe("S2 service rate, Class 2 is already 1.111111111.");
    expect(editorFor(id).undoManager.canUndo).toBe(false);
  });
});

describe("the preview's quiet runs on a network drawn closed (gap FIX-109)", () => {
  const closedDoc = (population: number | undefined): BnetDocument => {
    const base = example(TANDEM);
    const stations = base.nodes.filter((n) => n.kind === "station");
    const kept = base.nodes.filter((n) => n.kind === "station" || n.kind === "buffer");
    const ids = new Set(kept.map((n) => n.id));
    const firstBuffer = base.links.find((l) => l.toNodeID === stations[0].id && ids.has(l.fromNodeID))!.fromNodeID;
    const last = stations.at(-1)!;
    const links = [...base.links.filter((l) => ids.has(l.fromNodeID) && ids.has(l.toNodeID)), { id: "99999999-0000-0000-0000-000000000001", fromNodeID: last.id, toNodeID: firstBuffer, routingProbability: 1, customerClass: 0 }];
    return { ...base, nodes: kept, links, ...(population === undefined ? {} : { closedPopulation: population }) };
  };

  it("says it is a closed network, by the shared rule and sentence, never that it has no source node", () => {
    const doc = closedDoc(6);
    expect(drawnAs(doc)).toBe("closed");
    const probe = mockProbe(doc);
    expect(probe.error).toBe(openOnly(doc, PROBE_SUBJECT)!.sentence);
    expect(probe.error).toBe("This is a closed network: a fixed number of customers circulates and nothing arrives from outside. The load check (utilisation from the traffic equations) covers open networks.");
    const refused = mockQuietOutcome({ method: "qna", document: doc, tabId: "t", title: "closed.bnet" } as unknown as QuietRunRequest);
    expect(refused).toEqual({ kind: "refused", sentence: "This is a closed network: a fixed number of customers circulates and nothing arrives from outside. QNA covers open networks." });
    // Drawn closed with no population yet: told what is missing.
    const unset = closedDoc(undefined);
    expect(drawnAs(unset)).toBe("closedNoPopulation");
    for (const said of [mockProbe(unset).error!, (mockQuietOutcome({ method: "inf_sim", document: unset, tabId: "t", title: "x" } as unknown as QuietRunRequest) as { sentence: string }).sentence]) {
      expect(said).toMatch(/^The network has no source and no sink, but no number of customers is set\./);
      expect(said).not.toContain("no source node");
    }
    // An open network with its source deleted is still told that, and a healthy one runs.
    const open = example(TANDEM);
    expect(mockProbe({ ...open, nodes: open.nodes.filter((n) => n.kind !== "source") }).error).toBe("The network has no source node.");
    expect(mockQuietOutcome({ method: "qna", document: open, tabId: "t", title: "x" } as unknown as QuietRunRequest).kind).toBe("record");
  });
});

describe("review 4: a class the inspector does not list", () => {
  it("the re-entrant line: the two rules differ, and the sweep follows the classes served", () => {
    const doc = example(REENTRANT);
    const [s1, s2] = [node(doc, "S1").id, node(doc, "S2").id];
    expect([classesServed(doc, s1), classesListed(doc, s1)]).toEqual([[0, 3], [0, 1, 3]]);
    expect([classesServed(doc, s2), classesListed(doc, s2)]).toEqual([[1, 2], [0, 1, 2]]);
    // The inspector lists the classes served (changed from 0.90.34's entry-class rule; FIX-103).
    expect(classesServed(doc, s1)).toEqual(editorFor(openExample(REENTRANT)).classesServedAtStation(s1));
  });

  it("a station reached only through a class change: the class served is named, written and applied", async () => {
    // S2's one incoming link carries Class 1 in and delivers Class 2: the inspector lists Class 1.
    const base = example(TANDEM);
    const s2 = node(base, "S2");
    const targets = new Set([s2.id, ...base.nodes.filter((n) => n.kind === "buffer" && base.links.some((l) => l.fromNodeID === n.id && l.toNodeID === s2.id)).map((n) => n.id)]);
    const doc: BnetDocument = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === s2.id ? { ...n, serviceDistributions: {} } : n)),
      links: base.links.map((l) => (!targets.has(l.toNodeID) ? l : targets.has(l.fromNodeID) ? { ...l, customerClass: 1 } : { ...l, toCustomerClass: 1 })),
    };
    expect([classesServed(doc, s2.id), classesListed(doc, s2.id)]).toEqual([[1], [0, 1]]);
    // With no buffer between, the inspector's rule misses the class served altogether.
    const direct = { ...doc, links: doc.links.filter((l) => !(targets.has(l.toNodeID) && targets.has(l.fromNodeID))).map((l) => (targets.has(l.toNodeID) ? { ...l, toNodeID: s2.id } : l)) };
    expect([classesServed(direct, s2.id), classesListed(direct, s2.id)]).toEqual([[1], [0]]);
    expect(byLabel(direct, "S2 service rate, Class 2")).toMatchObject({ customerClass: 1 });
    expect(meanAt(substitute(direct, byLabel(direct, "S2 service rate, Class 2"), 4)!, "S2", 1)).toBe(0.25);
    const p = byLabel(doc, "S2 service rate, Class 2");
    expect(p).toMatchObject({ customerClass: 1, axis: "Service rate at S2, Class 2" });
    expect(discoverParameters(doc).filter((x) => x.nodeId === s2.id && x.kind === "service").length).toBe(1);
    const at = substitute(doc, p, 4)!;
    // The class the solver serves has the new law; the row the inspector shows reads as before.
    expect(meanAt(at, "S2", 1)).toBe(0.25);
    expect(meanAt(at, "S2", 0)).toBe(meanAt(doc, "S2", 0));
    expect(substitute(doc, p, p.current)).toEqual(doc);
    const id = addTab({ title: "change.bnet", document: doc });
    expect(applySweepValue(id, p, 4)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(meanAt(tabById(id)!.document, "S2", 1)).toBe(0.25);
    expect(meanAt(tabById(id)!.document, "S2", 0)).toBe(meanAt(doc, "S2", 0));
  });
});

describe("review 5: staleness, and Apply after the parameter was edited", () => {
  it("moving a node leaves the sweep current; changing a parameter does not", async () => {
    resetStructures();
    const { id, result } = await tandemSweep();
    const { container } = render(<SweepView tabId={id} decimals={3} />);
    await waitFor(() => expect(container.querySelector('svg[data-chart="line"]')).not.toBeNull());
    const editor = editorFor(id);
    const stale = () => !!screen.queryByText(/The network has changed since this sweep ran\./);
    expect(stale()).toBe(false);
    const { api } = await import("../lib/api");
    const first = await api.resultsFingerprint(tabById(id)!.document);
    const s1 = node(tabById(id)!.document, "S1");
    await act(async () => {
      editor.moveNode(s1.id, { x: s1.position[0] + 40, y: s1.position[1] + 20 }, false);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(node(tabById(id)!.document, "S1").position).not.toEqual(s1.position);
    // The fingerprint itself moved (it covers positions): the sweep is current all the same.
    const moved = await api.resultsFingerprint(tabById(id)!.document);
    expect(moved).not.toBe(first);
    await waitFor(() => expect(sweepIsStale(result, moved)).toBe(false));
    expect(stale()).toBe(false);
    await act(async () => {
      editor.updateNumberOfServers(s1.id, 2);
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(stale()).toBe(true));
  });

  it("a value the edited network can't take is not applied, and the line says exactly that", async () => {
    const id = openExample(FEEDBACK);
    const doc = () => tabById(id)!.document;
    const swept = byLabel(doc(), "S1 → B1 probability (S1 → B2 takes the rest)");
    expect(swept.rowSum).toBe(1);
    // After the sweep the row is edited: the two now sum to 0.5.
    const editor = editorFor(id);
    editor.updateLinkProbability(swept.linkId!, 0.2);
    editor.updateLinkProbability(swept.complementId!, 0.3);
    await Promise.resolve();
    await Promise.resolve();
    expect(parameterById(doc(), swept.id)).toMatchObject({ current: 0.2, max: 0.5 });
    const before = doc().links.map((l) => l.routingProbability);
    expect(applySweepValue(id, swept, 0.8)).toBe(false);
    await Promise.resolve();
    expect(doc().links.map((l) => l.routingProbability)).toEqual(before);
    expect(tabById(id)!.log.at(-1)).toMatchObject({ text: "S1 → B1 probability (S1 → B2 takes the rest) can't be set to 0.8 in the network as it is now (values can't be above 0.5), so nothing was applied.", severity: "warning" });
    // Never moved to fit, in a sweep document either.
    expect(substitute(doc(), { ...parameterById(doc(), swept.id)!, max: 1 }, 0.8)).toBeNull();
    // A value it can take is applied as given, and reported as given.
    expect(applySweepValue(id, swept, 0.4)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(parameterById(doc(), swept.id)!.current).toBe(0.4);
    expect(tabById(id)!.log.at(-1)!.text).toBe("Set S1 → B1 probability (S1 → B2 takes the rest) to 0.4 from the sweep.");
  });
});

describe("review 7: the per-point time estimates", () => {
  it("the checked-in table is the corpus's medians (re-run src/sweeps/measure-point-seconds.mjs when the corpus changes)", () => {
    const by = new Map<string, number[]>();
    for (const [path, raw] of Object.entries(records)) {
      const label = path.split("/").at(-2)!;
      const r = JSON.parse(raw) as { status?: string; elapsedSeconds?: number };
      if ((r.status !== "completed" && r.status !== "partial") || !Number.isFinite(r.elapsedSeconds)) continue;
      by.set(label, [...(by.get(label) ?? []), r.elapsedSeconds!]);
    }
    const median = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const expected = Object.fromEntries([...by.keys()].sort().map((l) => [l, { seconds: Number(median(by.get(l)!).toFixed(2)), runs: by.get(l)!.length }]));
    expect(MEASURED_SECONDS).toEqual(expected);
    // What the panel uses is the table's, and a method without a recorded run says so.
    for (const l of SWEEPABLE) expect(POINT_SECONDS[l]).toBe(MEASURED_SECONDS[l]?.seconds ?? UNMEASURED_SECONDS);
    expect(SWEEPABLE.filter((l) => !MEASURED_SECONDS[l])).toEqual(["qbd"]);
    expect(POINT_SECONDS.qna).toBe(0.43);
  });
});
