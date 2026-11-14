// The model features new in 2.1 in the interface (ledger SCI-1040…): the Inspector's sections
// write the document's keys and remove them again; the Run menu and the Method Chooser offer
// what applies and say why the rest does not; the canvas, the outline and the gallery name the
// features in words; the Transient view follows a stored rate profile and draws the stationary
// approximation beside it; the animation's bookkeeping follows priority order and preemption.
// The arithmetic is core's (core/src/priority.rs, batch.rs, transient.rs, sim.rs, with the exact
// checks there); the numbers here are the preview's stand-in (src/dev/mock/extended.ts), held
// to the same hand-computed values.
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AnimState, DEPART, PREEMPT, START, ARRIVE, type AnimateEvents, type AnimateLayout } from "../animate/model";
import { nodeDescription } from "../canvas/layers/labels";
import { nodeFacts } from "../canvas/outline/describe";
import { extendedExampleFiles } from "../dev/mock/documents";
import { standInBatch, standInPriority, trafficView } from "../dev/mock/extended";
import { standInPrepare, standInTransient } from "../dev/mock/transient";
import { defaultHandlers } from "../dev/mockBackend";
import { activeEditor, type Editor } from "../editor";
import { api } from "../lib/api";
import type { BnetDocument, BnetNode } from "../lib/bnet";
import { loadKv, resetKv } from "../lib/kv";
import { resetOverlays } from "../lib/overlays";
import type { MethodDomain, RuntimeAvailability, RuntimeKey } from "../lib/types";
import { InspectorPane } from "../panes/inspector";
import { candidates, solveChoice } from "../panes/results/agreement/plan";
import { runWhen } from "../runs/ui/commands";
import { mockTauri } from "../test/tauri";
import { resetTransientStore } from "../transient/store";
import { startTransientCommands } from "../transient/commands";
import { TransientView } from "../transient/TransientView";
import { transientWords as tw } from "../transient/words";
import { describe as describeExample, factsOf } from "../welcome/describe";
import { recommendations } from "../windows/methodchooser/advice";
import { addTab, replaceWorkspace, resetWorkspace, tabById } from "../workspace/store";
import { fullOrder, parsePmf } from "./InspectorSections";
import { batchMean, nodeFeatures, profileMean, profileProblem } from "./model";
import { usesAnyFeature } from "./shape";
import { extendedWords as w } from "./words";

const FILES = extendedExampleFiles();
const example = (stem: string) => ({ canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(FILES[`/examples/extended/${stem}.bnet`]) }) as BnetDocument;
const PRIORITY = "PriorityHelpDesk.mg1.2class";
const BATCH = "BatchArrivals.mx-m-1.geometric";
const RUSH = "RushHour.mt-m-2.daily";
const WAIT = { timeout: 8000 };

function open(doc: BnetDocument, title = "t.bnet"): Editor {
  act(() => replaceWorkspace({ tabs: [{ id: "TAB-1", title, path: null, document: doc, revision: 0, savedRevision: 0, log: [] }], activeId: "TAB-1" }));
  return activeEditor();
}
const named = (e: Editor, name: string): BnetNode => e.nodes.find((n) => n.name === name)!;
const select = (e: Editor, name: string) => act(() => e.setView({ selectedNodeID: named(e, name).id, selectedLinkID: null, selectedNodeIDs: new Set() }));
const section = (title: string) => screen.getByRole("region", { name: title });

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetWorkspace();
  resetOverlays();
});

describe("the Inspector: a station's order of service", () => {
  it("shows the discipline and the order, moves a class by button and by Option-arrow, and removes both keys for first come, first served", async () => {
    const e = open(example(PRIORITY));
    render(<InspectorPane />);
    select(e, "S1");
    const s = section(w.orderSection);
    const picker = within(s).getByRole("combobox", { name: w.discipline }) as HTMLSelectElement;
    expect(picker.value).toBe("priorityPreemptiveResume");
    const rows = () => within(s).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"));
    expect(rows()).toEqual(["1. Class 1", "2. Class 2"]);
    expect(within(s).getByRole("button", { name: "Move Class 1 up" })).toBeDisabled();

    fireEvent.click(within(s).getByRole("button", { name: "Move Class 2 up" }));
    expect(named(e, "S1").priorityOrder).toEqual([1, 0]);
    expect(rows()).toEqual(["1. Class 2", "2. Class 1"]);
    expect(e.undoManager.undoActionName).toBe("Change Priority Order");
    expect(within(s).getByRole("status")).toHaveTextContent("Class 2 is now 1 of 2");

    // The keyboard: Option and an arrow on the class's own row.
    const row = within(s).getAllByRole("listitem")[0];
    fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
    expect(named(e, "S1").priorityOrder).toEqual([0, 1]);
    fireEvent.keyDown(within(s).getAllByRole("listitem")[0], { key: "ArrowDown" });
    expect(named(e, "S1").priorityOrder).toEqual([0, 1]);

    fireEvent.change(picker, { target: { value: "priorityNonPreemptive" } });
    expect(named(e, "S1")).toMatchObject({ serviceDiscipline: "priorityNonPreemptive", priorityOrder: [0, 1] });
    fireEvent.change(picker, { target: { value: "fcfs" } });
    expect("serviceDiscipline" in named(e, "S1") || "priorityOrder" in named(e, "S1")).toBe(false);
    expect(within(s).queryByRole("list")).toBeNull();
    expect(usesAnyFeature(e.document)).toBe(false);
    // Undo brings the priority discipline back (a run of changes to one setting is one step).
    act(() => e.undo());
    expect(named(e, "S1").serviceDiscipline).toMatch(/^priority/);
    expect(named(e, "S1").priorityOrder).toEqual([0, 1]);
  });

  it("lists every class of the network, the stored order first", () => {
    expect(fullOrder([2, 0], 3)).toEqual([2, 0, 1]);
    expect(fullOrder(undefined, 2)).toEqual([0, 1]);
    expect(fullOrder([5, 1, 1, -1], 2)).toEqual([1, 0]);
  });
});

describe("the Inspector: a source's batches and rate over time", () => {
  it("writes each batch law as it is typed, says what is wrong, and removes the key for one at a time", () => {
    const original = example(BATCH);
    const e = open(original);
    render(<InspectorPane />);
    select(e, "Src1");
    const s = section(w.batchSection);
    const kind = within(s).getByRole("combobox", { name: w.batchKind }) as HTMLSelectElement;
    expect(kind.value).toBe("geometric");
    expect(within(s).getByText(w.batchReadout("2.5", "0.6"))).toBeInTheDocument();

    const mean = within(s).getByRole("textbox", { name: w.batchGeometric }) as HTMLInputElement;
    fireEvent.change(mean, { target: { value: "3" } });
    expect(named(e, "Src1").batchSize).toEqual({ kind: "geometric", mean: 3 });
    fireEvent.change(mean, { target: { value: "0.5" } });
    expect(named(e, "Src1").batchSize).toEqual({ kind: "geometric", mean: 3 });
    expect(within(s).getByText(w.batchMeanAtLeastOne)).toBeInTheDocument();

    fireEvent.change(kind, { target: { value: "constant" } });
    expect(named(e, "Src1").batchSize).toEqual({ kind: "constant", size: 2 });
    fireEvent.change(within(s).getByRole("textbox", { name: w.batchConstant }), { target: { value: "4" } });
    expect(named(e, "Src1").batchSize).toEqual({ kind: "constant", size: 4 });

    fireEvent.change(kind, { target: { value: "pmf" } });
    const pmf = within(s).getByRole("textbox", { name: w.batchPmf }) as HTMLInputElement;
    fireEvent.change(pmf, { target: { value: "0.5, 0.2" } });
    // What parses is stored, so Problems can say it too; the field says it at once.
    expect(named(e, "Src1").batchSize).toEqual({ kind: "pmf", probabilities: [0.5, 0.2] });
    expect(within(s).getByText(w.batchPmfSum("0.7"))).toBeInTheDocument();
    fireEvent.change(pmf, { target: { value: "0.5, x" } });
    expect(within(s).getByText(w.batchPmfNotNumbers)).toBeInTheDocument();
    expect(named(e, "Src1").batchSize).toEqual({ kind: "pmf", probabilities: [0.5, 0.2] });

    fireEvent.change(kind, { target: { value: "single" } });
    expect("batchSize" in named(e, "Src1")).toBe(false);
    // Without the key the node is the plain source: nothing of the feature is left in the file.
    const plain = { ...original, nodes: original.nodes.map(({ batchSize: _b, ...n }) => n) };
    expect(JSON.stringify(e.document.nodes)).toBe(JSON.stringify(plain.nodes));
    expect(parsePmf("0.25 0.25;0.5")).toEqual([0.25, 0.25, 0.5]);
    expect(parsePmf("")).toBeNull();
    expect(parsePmf("-0.1, 1.1")).toBeNull();
  });

  it("edits the profile's segments, draws the step chart and removes the key for a constant rate", () => {
    const e = open(example(RUSH));
    render(<InspectorPane />);
    select(e, "Src1");
    const s = section(w.profileSection);
    expect((within(s).getByRole("combobox", { name: w.profileKind }) as HTMLSelectElement).value).toBe("varying");
    expect(within(s).getAllByRole("row")).toHaveLength(1 + 5);
    expect(within(s).getByRole("img", { name: w.profileChartLabel(5, true) })).toBeInTheDocument();
    // (6·0.3 + 4·1.5 + 6·0.9 + 4·1.4 + 4·0.5)/24 = 20.8/24.
    expect(profileMean(named(e, "Src1").rateProfile!)).toBeCloseTo(20.8 / 24, 12);
    expect(within(s).getByText(w.profileCaptionPeriodic("24", "0.8667"))).toBeInTheDocument();

    fireEvent.change(within(s).getByRole("textbox", { name: w.profileMultiplier(2) }), { target: { value: "1.8" } });
    expect(named(e, "Src1").rateProfile!.segments[1]).toEqual({ until: 10, multiplier: 1.8 });
    // A segment that does not end later than the one before: stored, flagged, and no chart.
    fireEvent.change(within(s).getByRole("textbox", { name: w.profileUntil(3) }), { target: { value: "9" } });
    expect(profileProblem(named(e, "Src1").rateProfile!)).toEqual({ segment: 3, what: "length" });
    expect(within(s).getByText(w.profileNoLength(3))).toBeInTheDocument();
    expect(within(s).queryByRole("img")).toBeNull();
    fireEvent.change(within(s).getByRole("textbox", { name: w.profileUntil(3) }), { target: { value: "16" } });

    fireEvent.click(within(s).getByRole("button", { name: w.profileAdd }));
    expect(named(e, "Src1").rateProfile!.segments).toHaveLength(6);
    expect(named(e, "Src1").rateProfile!.segments[5]).toEqual({ until: 28, multiplier: 1 });
    fireEvent.click(within(s).getByRole("button", { name: w.profileRemove(6) }));
    expect(named(e, "Src1").rateProfile!.segments).toHaveLength(5);
    fireEvent.click(within(s).getByRole("checkbox", { name: w.profilePeriodic }));
    expect(named(e, "Src1").rateProfile!.periodic).toBe(false);
    expect(within(s).getByText(w.profileCaptionOnce("24"))).toBeInTheDocument();

    fireEvent.change(within(s).getByRole("combobox", { name: w.profileKind }), { target: { value: "constant" } });
    expect("rateProfile" in named(e, "Src1")).toBe(false);
    act(() => e.undo());
    expect(named(e, "Src1").rateProfile!.segments).toHaveLength(5);
  });

  it("offers neither section on a buffer or a sink, and no order of service in a closed network", () => {
    const e = open(example(PRIORITY));
    render(<InspectorPane />);
    select(e, "B1");
    expect(screen.queryByRole("region", { name: w.orderSection })).toBeNull();
    expect(screen.queryByRole("region", { name: w.batchSection })).toBeNull();
    select(e, "Src2");
    expect(section(w.batchSection)).toBeInTheDocument();
    expect(section(w.profileSection)).toBeInTheDocument();
  });
});

describe("what the canvas, the outline and the gallery say", () => {
  it("marks each feature with a lettered glyph and names it in words", () => {
    const p = example(PRIORITY).nodes.find((n) => n.name === "S1")!;
    expect(nodeFeatures(p)).toEqual([{ feature: "priorities", glyph: "P", label: "Priority service, preemptive-resume", outline: "priority preemptive-resume: Class 1 > Class 2" }]);
    expect(nodeDescription(p, true, 0.7)).toContain("Priority service, preemptive-resume");
    const b = example(BATCH).nodes.find((n) => n.name === "Src1")!;
    expect(nodeFeatures(b).map((f) => [f.glyph, f.label, f.outline])).toEqual([["×n", "Arrives in batches", "batches, mean size 2.5"]]);
    expect(batchMean({ kind: "pmf", probabilities: [0.5, 0.3, 0, 0.2] })).toBeCloseTo(1.9, 12);
    const r = example(RUSH).nodes.find((n) => n.name === "Src1")!;
    expect(nodeFeatures(r).map((f) => [f.glyph, f.outline])).toEqual([["λ(t)", "rate profile, 5 segments, repeating"]]);
    // A plain node has no mark and its description is what it was.
    const plain = { ...p, serviceDiscipline: undefined, priorityOrder: undefined };
    expect(nodeFeatures(plain)).toEqual([]);
    expect(nodeDescription(plain, true, undefined)).not.toContain("Priority");
  });

  it("lists the feature among the node's parameters in the Canvas Outline", () => {
    const e = open(example(BATCH));
    const facts = nodeFacts({ editor: e, results: null, diagnostics: [], utilisation: {} } as unknown as Parameters<typeof nodeFacts>[0], named(e, "Src1"));
    expect(facts.parameters).toContain("batches, mean size 2.5");
    expect(facts.spoken).toContain("Arrives in batches");
  });

  it("describes the three examples in the gallery", () => {
    expect(describeExample(factsOf(example(PRIORITY)))).toBe("1 station · 2 customer classes · infinite buffers. One queue: the place to start. Priority service at a station.");
    expect(describeExample(factsOf(example(BATCH)))).toMatch(/Customers arrive in batches\.$/);
    expect(describeExample(factsOf(example(RUSH)))).toMatch(/Has stations with several servers\. The arrival rate changes over time\.$/);
  });
});

describe("what runs", () => {
  const KEYS: RuntimeKey[] = ["productForm", "qbd", "regenerative", "truncatedCtmc", "adaptiveBar", "barBounds", "multiclass", "genericCtmc", "decomposition"];
  const installed: RuntimeAvailability[] = KEYS.map((key) => ({ key, available: true, reason: null }));

  it("dims every older method with the reason, and offers each exact method only with its feature", () => {
    open(example(PRIORITY));
    expect(runWhen("run:priority-exact")).toBe(true);
    expect(runWhen("run:replicated-simulation")).toBe(true);
    expect(runWhen("run:batch-exact")).toBe(w.needsBatches);
    for (const id of ["run:qna", "run:product-form", "run:monte-carlo-infinite", "run:comparison", "run:mlmc"]) expect(runWhen(id), id).toBe(w.usesFeature);
    open(example(BATCH));
    expect([runWhen("run:batch-exact"), runWhen("run:priority-exact")]).toEqual([true, w.needsPriorities]);
    open({ ...example(BATCH), nodes: example(BATCH).nodes.map(({ batchSize: _b, ...n }) => n) });
    expect([runWhen("run:qna"), runWhen("run:batch-exact")]).toEqual([true, w.needsBatches]);
  });

  it("the preview's stand-in gives the hand-computed values, and Solve picks the exact method", async () => {
    // Preemptive-resume, λ = (0.3, 0.2), exponential mean 1 and Erlang-2 mean 2:
    // T₁ = 1 + 0.3/0.7 = 10/7, T₂ = 2/0.7 + 0.9/(0.7·0.3) = 50/7, L = (3 + 10)/7.
    const p = standInPriority(example(PRIORITY));
    expect(p.ok && [p.number, p.classes[0].sojourn, p.classes[1].sojourn, p.utilisation].map((x) => +x.toFixed(12))).toEqual([13 / 7, 10 / 7, 50 / 7, 0.7].map((x) => +x.toFixed(12)));
    // Non-preemptive (Cobham): W₀ = (0.3·2 + 0.2·6)/2 = 0.9; Wq₁ = 0.9/0.7, Wq₂ = 0.9/(0.7·0.3).
    const np = example(PRIORITY);
    np.nodes = np.nodes.map((n) => (n.name === "S1" ? { ...n, serviceDiscipline: "priorityNonPreemptive" as const } : n));
    const c = standInPriority(np);
    expect(c.ok && [c.classes[0].wait, c.classes[1].wait].map((x) => +x.toFixed(12))).toEqual([0.9 / 0.7, 0.9 / 0.21].map((x) => +x.toFixed(12)));
    // Geometric batches of mean 2.5 at 0.24 per time unit, μ = 1: ρ = 0.6, L = ρ/((1 − α)(1 − ρ)) = 3.75.
    const b = standInBatch(example(BATCH));
    expect(b.ok && [+b.number.toFixed(12), +b.utilisation.toFixed(12)]).toEqual([3.75, 0.6]);
    expect(trafficView(example(BATCH)).nodes.find((n) => n.name === "Src1")).toMatchObject({ distributionParameters: "lambda=0.6" });

    for (const [stem, label] of [[PRIORITY, "priority_exact"], [BATCH, "batch_exact"]] as const) {
      const domain = (await api.methodDomain(example(stem))) as MethodDomain;
      const rows = recommendations(domain, installed);
      expect(rows[0]).toMatchObject({ suitability: "recommended", layer: "exactQueue" });
      expect(rows.filter((r) => r.suitability !== "unavailable").map((r) => r.id).sort()).toEqual([rows[0].id, "simulation-inprocess"].sort());
      expect(rows.find((r) => r.id === "qna")).toMatchObject({ suitability: "unavailable", summary: domain.extended!.others });
      expect(solveChoice(candidates(rows, true))?.candidate.label).toBe(label);
    }
    // A rate profile: no steady-state method at all, and the simulation says why.
    const domain = (await api.methodDomain(example(RUSH))) as MethodDomain;
    const rows = recommendations(domain, installed);
    expect(rows.every((r) => r.suitability === "unavailable")).toBe(true);
    expect(rows.find((r) => r.id === "simulation-inprocess")!.summary).toMatch(/no single steady state .* The Transient view/);
    expect(solveChoice(candidates(rows, true))).toBeNull();
  });

  it("live results are exact where the formula covers the network, and say why where it does not", async () => {
    const live = await api.liveResults(example(PRIORITY));
    expect([live.tier, live.formula, live.reasonIfPartial]).toEqual(["exact", "priority", null]);
    expect(live.perStation[0].meanInSystem).toBeCloseTo(13 / 7, 12);
    const rush = await api.liveResults(example(RUSH));
    expect([rush.tier, rush.reasonIfPartial]).toEqual(["utilisation", "extended"]);
    expect(rush.perStation[0].utilisation).toBeCloseTo((0.625 * 20.8) / 24, 9);
    expect(rush.perStation[0].meanInSystem).toBeNull();
    // A wrong setting is a problem in core's sentence, on the node.
    const bad = example(PRIORITY);
    bad.nodes = bad.nodes.map((n) => (n.name === "S1" ? { ...n, priorityOrder: [0] } : n));
    const ds = await api.networkDiagnostics(bad);
    expect(ds.find((d) => d.code === "featureSetting")).toMatchObject({ severity: "error", values: { name: "S1", detail: "S1's priority order is missing Class 2, which is served there. Give every class served at the station a place in the order." } });
  });
});

describe("the Transient view with a stored rate profile", () => {
  beforeEach(() => {
    resetTransientStore();
    startTransientCommands();
  });

  it("follows the profile, hides the surge, and draws the stationary approximation beside the exact curve", async () => {
    const doc = example(RUSH);
    const prepare = standInPrepare(doc);
    expect(prepare.profile).toEqual({ sources: ["Src1"], periodic: true, span: 24 });
    expect(prepare.suggestedHorizon).toBe(48);
    const a = standInTransient({ id: "x", document: doc, horizon: 48, intervals: 48, initial: { kind: "empty" }, surge: null, settleFraction: 0.05 });
    expect(a.profileBreaks).toEqual([6, 10, 16, 20, 24, 30, 34, 40, 44]);
    // PSA at the peak (1.5 × ρ 0.625 = 0.9375 on two servers) is far above the true mean there.
    const at = (t: number) => a.times.findIndex((x) => Math.abs(x - t) < 1e-9);
    expect(a.psa![0][at(8)]!).toBeGreaterThan(10);
    expect(a.exact!.mean[0][at(8)]).toBeLessThan(4);
    expect(a.exact!.settling).toEqual([null]);

    const tab = tabById(addTab({ title: `${RUSH}.bnet`, path: null, document: doc }))!;
    const { container } = render(<TransientView tabId={tab.id} decimals={4} />);
    await waitFor(() => expect(container.querySelector("[data-transient-profile]")).not.toBeNull(), WAIT);
    expect(container.querySelector("[data-transient-profile]")!.textContent).toBe(tw.profileNote("Src1", true, "24"));
    expect(screen.getByRole("checkbox", { name: tw.surgeLabel, hidden: true }).closest(".transient-row")).toHaveAttribute("hidden");
    fireEvent.click(container.querySelector("[data-transient-run]")!);
    await waitFor(() => expect(container.querySelector('[data-tier="psa"]')).not.toBeNull(), WAIT);
    expect(container.querySelectorAll("path[data-tier='psa']")).toHaveLength(1);
    expect(container.querySelectorAll("[data-profile-break]")).toHaveLength(9);
    expect(container.querySelector("li[data-tier='psa']")!.textContent).toContain(tw.tierPsa);
    expect(container.querySelector("li[data-tier='psa']")!.textContent).toContain("an approximation");
    expect(container.querySelector("[data-transient-reading]")!.textContent).toMatch(/^The arrival rate repeats, so the mean numbers cycle and never settle\./);
  });

  it("is refused for priorities and batches in core's sentence", () => {
    expect(standInPrepare(example(BATCH)).exactReason).toBe("This network uses batch arrivals at Src1. Transient analysis does not model that, and would answer for a different network. Replicated Simulation models it, and so does the exact single-station formula where it applies.");
  });
});

describe("the animation's bookkeeping", () => {
  const layout: AnimateLayout = { stations: [{ id: "S", name: "S1", servers: 1, bufferId: "B", exactNumber: null, rank: [1, 0] }], sources: [{ id: "A", name: "Src1", class: 0 }, { id: "C", name: "Src2", class: 1 }], sinks: ["Out"], classes: 2, population: null, unstable: [], eventRate: 1 };
  const events = (rows: [number, number, number, number, number, number][]): AnimateEvents => ({ t: rows.map((r) => r[0]), k: rows.map((r) => r[1]), c: rows.map((r) => r[2]), cls: rows.map((r) => r[3]), s: rows.map(() => 0), srv: rows.map((r) => r[4]), o: rows.map((r) => r[5]) });

  it("keeps a priority queue in order of service and puts an interrupted customer back at its head", () => {
    const state = new AnimState(layout, { time: 0, queues: [[]], servers: [[null]] }, 30);
    // Class 0 ranks below class 1 here. Customers 1, 2 (class 0) arrive; 1 starts; 3 (class 1)
    // arrives and interrupts it; 3 is served; then 1 resumes before 2.
    const e = events([
      [1, ARRIVE, 1, 0, -1, 0],
      [1, START, 1, 0, 0, -1],
      [2, ARRIVE, 2, 0, -1, 0],
      [3, ARRIVE, 3, 1, -1, 1],
      [3, PREEMPT, 1, 0, 0, -1],
      [3, START, 3, 1, 0, -1],
    ]);
    for (let n = 0; n < e.t.length; n++) state.apply(e, n);
    expect(state.faults).toBe(0);
    const st = state.stations[0];
    expect([st.servers[0]?.id, st.queue.at(0)?.id, st.queue.at(1)?.id, st.queue.length, st.busy]).toEqual([3, 1, 2, 2, 1]);
    // A fourth customer of the high class goes ahead of both waiting low-class ones.
    const more = events([[4, ARRIVE, 4, 1, -1, 1], [5, DEPART, 3, 1, 0, -1]]);
    for (let n = 0; n < more.t.length; n++) state.apply(more, n);
    expect([state.stations[0].queue.at(0)?.id, state.stations[0].queue.at(1)?.id, state.stations[0].queue.at(2)?.id]).toEqual([4, 1, 2]);
    expect(state.faults).toBe(0);
    expect(state.stations[0].queue.length + state.stations[0].busy).toBe(3);
  });

  it("starts a customer from inside the queue only at a priority station", () => {
    const fcfs = new AnimState({ ...layout, stations: [{ ...layout.stations[0], rank: undefined }] }, { time: 0, queues: [[[1, 0], [2, 1]]], servers: [[null]] }, 30);
    fcfs.apply(events([[1, START, 2, 1, 0, -1]]), 0);
    expect(fcfs.faults).toBe(1);
    const ranked = new AnimState(layout, { time: 0, queues: [[[1, 0], [2, 1]]], servers: [[null]] }, 30);
    ranked.apply(events([[1, START, 2, 1, 0, -1]]), 0);
    expect([ranked.faults, ranked.stations[0].servers[0]?.id, ranked.stations[0].queue.length]).toEqual([0, 2, 1]);
  });
});
