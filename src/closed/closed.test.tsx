// Closed networks in the interface (ROADMAP D3; ledger SCI-501…): the population as part of the
// document (undo, dirty state, the keys the caches read), creating and converting, the inspector's
// section, the problems and their fixes, the method gating, the sweep over N, and the preview's
// stand-in held to the numbers Rust printed for the bundled example. The arithmetic itself is
// checked in Rust (core/src/closed.rs).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { closedLive, closedRecord, standInClosed } from "../dev/mock/closed";
import { defaultHandlers } from "../dev/mockBackend";
import { mockRuns } from "../dev/mock/runs";
import { fixesFor } from "../canvas/validation/fixes";
import type { Diagnostic } from "../canvas/validation/model";
import { sentence } from "../canvas/validation/words";
import { editorFor, resetEditors } from "../editor";
import { api } from "../lib/api";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, runCommand } from "../lib/commands";
import { loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC } from "../lib/menuSpec";
import type { MethodDomain } from "../lib/types";
import { liveRecord, markFor, readoutFor } from "../live/model";
import { IDENTIFIER, candidates, pickNext, recommendedPlan, solveChoice } from "../panes/results/agreement/plan";
import { checkWithAnother, resetAgreementCommands, solve } from "../panes/results/agreement/commands";
import { resetAdvice } from "../panes/results/agreement/chooser";
import { resetSequence } from "../panes/results/agreement/runner";
import { bannerFor } from "../panes/results/agreement/rows";
import type { ResultRecord } from "../panes/results/model";
import { agreement, currentRuns } from "../results/insight";
import { structureKey } from "../results/current";
import { runCommands, runWhen } from "../runs/ui/commands";
import { getRunState, resetRuns, startRun } from "../runs/state";
import { applySweepValue } from "../sweeps/commands";
import { allowed, discoverParameters, substitute } from "../sweeps/model";
import { defaultRange, methodsFor, POINT_SECONDS } from "../sweeps/runner";
import { mockTauri } from "../test/tauri";
import { commandFor, recommendations } from "../windows/methodchooser/advice";
import { activeTab, addTab, documentSignature, getWorkspace, resetWorkspace } from "../workspace/store";
import { closedCycle } from "./build";
import { closedCommands, convertToClosed, looksClosed, newClosedCycle } from "./commands";
import { PopulationSection } from "./PopulationSection";
import { closedWords as w, suggestedPopulation } from "./words";

const files = import.meta.glob("../../examples/closed/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const central = (): BnetDocument => JSON.parse(Object.values(files)[0]) as BnetDocument;
const open = import.meta.glob("../../golden/OpenJackson.d2.feedback.p30.inf/resave.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const jackson = (): BnetDocument => JSON.parse(Object.values(open)[0]) as BnetDocument;

let dispose: (() => void) | null = null;

beforeEach(async () => {
  mockTauri(defaultHandlers());
  mockRuns.replayMs = 1;
  resetKv();
  resetRuns();
  resetWorkspace();
  resetEditors();
  resetSequence();
  resetAdvice();
  resetAgreementCommands();
  await loadKv();
  const { registerCommands } = await import("../lib/commands");
  const offs = [registerCommands(closedCommands()), registerCommands(runCommands())];
  dispose = () => offs.forEach((off) => off());
});
afterEach(() => {
  dispose?.();
  dispose = null;
});

const tabWith = (doc: BnetDocument, title = "Closed.bnet") => addTab({ title, document: doc }, { activate: true });

// ── The document ─────────────────────────────────────────────────────────────────────────────

describe("the population as part of the document", () => {
  it("is set and removed as undoable steps, and an open network's document has no such key", async () => {
    // Edits made in one task are one undo group (src/editor/undo.ts); a real edit is a task of its own.
    const tick = () => Promise.resolve();
    const { closedPopulation: _n, ...bare } = central();
    const id = tabWith(bare as BnetDocument);
    const editor = editorFor(id);
    expect("closedPopulation" in activeTab().document).toBe(false);
    editor.setClosedPopulation(5);
    await tick();
    expect(activeTab().document.closedPopulation).toBe(5);
    expect(activeTab().log.at(-1)?.text).toBe("Closed network population set to 5 customers.");
    editor.setClosedPopulation(5.6);
    await tick();
    expect(editor.closedPopulation).toBe(6);
    editor.setClosedPopulation(0);
    await tick();
    expect(editor.closedPopulation).toBe(1);
    editor.undoManager.undo();
    editor.undoManager.undo();
    expect(editor.closedPopulation).toBe(5);
    editor.undoManager.undo();
    expect("closedPopulation" in activeTab().document).toBe(false);
    editor.undoManager.redo();
    expect(editor.closedPopulation).toBe(5);
    editor.setClosedPopulation(null);
    await tick();
    expect("closedPopulation" in activeTab().document).toBe(false);
  });

  it("counts as content for the edited dot, the structure key and nothing else changes for an open network", () => {
    const doc = central();
    expect(documentSignature({ ...doc, closedPopulation: 9 })).not.toBe(documentSignature(doc));
    expect(structureKey({ ...doc, closedPopulation: 9 })).not.toBe(structureKey(doc));
    const j = jackson();
    expect(documentSignature(j)).toBe(JSON.stringify([j.nodes, j.links, j.infiniteBuffers]));
    expect(structureKey(j)).not.toContain("closedPopulation");
  });

  it("is saved with the file: the bundled example carries it", () => {
    expect(central().closedPopulation).toBe(8);
    expect(looksClosed(central().nodes)).toBe(true);
    expect(looksClosed(jackson().nodes)).toBe(false);
  });
});

// ── Creating and converting ──────────────────────────────────────────────────────────────────

describe("making a closed network", () => {
  it("New Closed Cycle draws a ring of three stations with six customers on an empty canvas, as one undo step", () => {
    const before = getWorkspace().tabs.length;
    act(() => void newClosedCycle());
    const doc = activeTab().document;
    expect(getWorkspace().tabs).toHaveLength(before);
    expect(doc.nodes.map((n) => n.name)).toEqual(["B1", "S1", "B2", "S2", "B3", "S3"]);
    expect([doc.closedPopulation, doc.infiniteBuffers]).toEqual([6, true]);
    // Each buffer feeds its station, each station the next buffer, the last the first.
    const name = new Map(doc.nodes.map((n) => [n.id, n.name]));
    expect(doc.links.map((l) => `${name.get(l.fromNodeID)}>${name.get(l.toNodeID)}`)).toEqual(["B1>S1", "B2>S2", "B3>S3", "S1>B2", "S2>B3", "S3>B1"]);
    const editor = editorFor(activeTab().id);
    expect(editor.undoManager.undoActionName).toBe(w.cycleAction);
  });

  it("opens a new tab when the canvas already has a network, and the menu names both commands", () => {
    tabWith(jackson(), "OpenJackson.d2.feedback.p30.inf.bnet");
    const before = getWorkspace().tabs.length;
    act(() => void runCommand("network:new-closed-cycle"));
    expect(getWorkspace().tabs).toHaveLength(before + 1);
    expect(activeTab().document.closedPopulation).toBe(6);
    const ids = JSON.stringify(MENU_SPEC);
    for (const id of ["network:new-closed-cycle", "network:make-closed", "run:closed-product-form"]) expect(ids).toContain(`"${id}"`);
  });

  it("Make Closed Network needs the shape and no population yet, and says why otherwise", () => {
    tabWith(jackson());
    expect(getCommand("network:make-closed")!.when!()).toBe(w.notClosedShape);
    const { closedPopulation: _n, ...bare } = central();
    tabWith(bare as BnetDocument);
    expect(getCommand("network:make-closed")!.when!()).toBe(true);
    act(() => void runCommand("network:make-closed"));
    expect(activeTab().document.closedPopulation).toBe(suggestedPopulation(3));
    expect(getCommand("network:make-closed")!.when!()).toBe(w.alreadyClosed);
  });

  it("converting an open network removes its source and sink and sets the population in one undo group", () => {
    const id = tabWith(jackson());
    const editor = editorFor(id);
    convertToClosed(editor, 4);
    expect(activeTab().document.nodes.some((n) => n.kind === "source" || n.kind === "sink")).toBe(false);
    expect(activeTab().document.closedPopulation).toBe(4);
    const cycle = closedCycle(4);
    expect(cycle.nodes.filter((n) => n.kind === "station").map((n) => n.distributionParameters)).toEqual(["rate=1.0", "rate=2.0", "rate=3.0", "rate=4.0"]);
  });
});

// ── The inspector's section ──────────────────────────────────────────────────────────────────

describe("the inspector's Closed Network section", () => {
  it("edits the population with a labelled field and its unit, and can make the network open again", async () => {
    const id = tabWith(central());
    const editor = editorFor(id);
    const view = render(<PopulationSection editor={editor} />);
    const field = screen.getByLabelText(w.populationLabel) as HTMLInputElement;
    expect(field.value).toBe("8");
    expect(field.closest(".insp-row")!.textContent).toContain(w.unit);
    fireEvent.change(field, { target: { value: "12" } });
    expect(editor.closedPopulation).toBe(12);
    fireEvent.click(screen.getByLabelText(w.increment));
    expect(editor.closedPopulation).toBe(13);
    // Out of range is clamped by the field on commit, never written as typed.
    fireEvent.change(field, { target: { value: "0" } });
    expect(editor.closedPopulation).toBe(13);
    fireEvent.blur(field);
    await waitFor(() => expect(editor.closedPopulation).toBe(1), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: w.makeOpen }));
    expect(editor.closedPopulation).toBeUndefined();
    view.rerender(<PopulationSection editor={editor} />);
    // With no population it offers to close the network.
    fireEvent.click(screen.getByRole("button", { name: w.makeClosed(6) }));
    expect(editor.closedPopulation).toBe(6);
  });

  it("is not shown for an open network", () => {
    const id = tabWith(jackson());
    const { container } = render(<PopulationSection editor={editorFor(id)} />);
    expect(container.textContent).toBe("");
  });
});

// ── Problems and fixes ───────────────────────────────────────────────────────────────────────

describe("problems of closed networks", () => {
  const d = (code: string, values: Diagnostic["values"] = {}, nodeIds: string[] = []): Diagnostic => ({ severity: "error", code, nodeIds, linkIds: [], values });

  it("have a sentence a student understands for every code Rust sends", () => {
    expect(sentence(d("closedCandidate"))).toContain("make this a closed network");
    expect(sentence(d("populationIgnored", { population: 5 }))).toContain("population of 5");
    expect(sentence(d("closedNotExponential", { name: "S2" }))).toBe("S2's service time is not exponential. The exact closed-network solution needs exponential service at every station.");
    expect(sentence(d("closedBufferTooSmall", { name: "S1", size: 2, population: 8 }))).toContain("room for only 2 of the 8 customers");
    expect(sentence(d("closedRoutingLeaks", { name: "S1", sum: 0.9 }))).toContain("add up to 0.90");
    expect(sentence(d("closedUnreachable", { name: "S3" }))).toContain("never come back");
    expect(sentence(d("closedReducible", { name: "S1", other: "S3" }))).toContain("separate groups");
    expect(sentence(d("closedMultiClass"))).toContain("one customer class");
    for (const code of ["closedCandidate", "populationIgnored", "closedPopulationRange", "closedMultiClass", "closedNotExponential", "closedBufferTooSmall", "closedRoutingLeaks", "closedUnreachable", "closedReducible"]) {
      expect(sentence(d(code, { name: "S1" }))).not.toContain("cannot describe");
    }
  });

  it("offer the fix that cures them: make closed, remove the population, infinite buffers", () => {
    const { closedPopulation: _n, ...bare } = central();
    const id = tabWith(bare as BnetDocument);
    const editor = editorFor(id);
    const fix = fixesFor(d("closedCandidate", { population: 6 }), editor);
    expect(fix[0].label).toBe("Make this a closed network with 6 customers");
    fix[0].run();
    expect(editor.closedPopulation).toBe(6);
    fixesFor(d("populationIgnored", { population: 6 }), editor)[0].run();
    expect(editor.closedPopulation).toBeUndefined();
    editor.setInfiniteBuffers(false);
    fixesFor(d("closedBufferTooSmall", { name: "S1", size: 2, population: 8 }), editor)[0].run();
    expect(editor.infiniteBuffers).toBe(true);
  });

  it("offer to close a network whose work never leaves, when Rust names a population", () => {
    const id = tabWith(jackson());
    const editor = editorFor(id);
    const s2 = editor.nodes.find((n) => n.name === "S2")!;
    expect(fixesFor(d("closedLoop", { name: "S2", classIndex: 0 }, [s2.id]), editor).map((f) => f.id)).not.toContain("make-closed");
    const fix = fixesFor(d("closedLoop", { name: "S2", classIndex: 0, population: 4 }, [s2.id]), editor).find((f) => f.id === "make-closed")!;
    expect(fix.label).toBe("Make this a closed network with 4 customers");
    fix.run();
    expect(editor.nodes.some((n) => n.kind === "source" || n.kind === "sink")).toBe(false);
    expect(editor.closedPopulation).toBe(4);
  });

  it("the preview's diagnostics drop 'no source' and 'no sink' for a closed network and offer to close an unclosed one", async () => {
    expect(await api.networkDiagnostics(central())).toEqual([]);
    const { closedPopulation: _n, ...bare } = central();
    const ds = await api.networkDiagnostics(bare as BnetDocument);
    expect(ds.map((x) => x.code)).toEqual(["noSource", "noSink", "closedCandidate"]);
    expect(ds[2].values.population).toBe(6);
  });
});

// ── Methods ──────────────────────────────────────────────────────────────────────────────────

describe("methods for a closed network", () => {
  const domain = (closed: MethodDomain["closed"]): MethodDomain => ({
    infiniteBuffers: true, stationCount: 3, classCount: 1, warningCount: 0, hasFeedback: false, analytical: null, sourcesArePoisson: true, servicesAreExponential: true,
    classTransitions: false, classIndependentService: true, heavyJackson: false, productFormRefusal: "The network has no source node.", qbdRefusal: "The network has no source node.", replicatedSimulationRefusal: closed?.refusal ?? null, closed,
  });

  it("the Chooser recommends Exact Closed Product Form, offers Replicated Simulation as the second opinion, and says why every other method cannot be used", () => {
    const rows = recommendations(domain({ population: 8, refusal: null }), []);
    expect(rows[0]).toMatchObject({ id: "closed-product-form", suitability: "recommended", layer: "exactQueue", helpTopic: "closedNetworks" });
    expect(rows[0].summary).toContain("8 customers");
    // New in 2.1 (ledger SIM-107): the one other method that takes a closed network.
    expect(rows[1]).toMatchObject({ id: "simulation-inprocess", name: "Replicated Simulation", suitability: "applicable", layer: "queueSimulation", helpTopic: "replicatedSimulation" });
    expect(rows[1].summary).toMatch(/^A second, independent opinion for this closed network/);
    expect(rows.filter((r) => r.id === "simulation-inprocess")).toHaveLength(1);
    expect(rows.slice(2).every((r) => r.suitability === "unavailable" && r.summary.startsWith("This is a closed network"))).toBe(true);
    // Check with Another Method, once the exact method has run: the simulation, and then nothing.
    const cands = candidates(rows, true);
    const next = pickNext(cands, new Set([IDENTIFIER.closed_pf]), false);
    expect([next?.candidate.label, next?.candidate.identifier, next?.why]).toEqual(["sim_inproc", "queue.des-replications", "simulation"]);
    expect(pickNext(cands, new Set([IDENTIFIER.closed_pf, IDENTIFIER.sim_inproc]), true)).toBeNull();
    expect(recommendedPlan(cands).map((c) => c.label)).toEqual(["closed_pf", "sim_inproc"]);
    // The same with finite buffers (room for everyone): the row does not depend on the buffer mode.
    expect(recommendations({ ...domain({ population: 8, refusal: null }), infiniteBuffers: false }, []).slice(0, 2).map((r) => r.id)).toEqual(["closed-product-form", "simulation-inprocess"]);
    expect(commandFor("closed-product-form", true)).toBe("run:closed-product-form");
    // Solve picks it: the one exact candidate.
    const choice = solveChoice(candidates(rows, true));
    expect([choice?.candidate.label, choice?.candidate.identifier, choice?.why]).toEqual(["closed_pf", IDENTIFIER.closed_pf, "exact"]);
  });

  it("a refusal from core makes it unavailable with core's sentence; an open network has no such row", () => {
    const rows = recommendations(domain({ population: 8, refusal: "The closed product form needs exponential service times; S2 has another distribution." }), []);
    const row = rows.find((r) => r.id === "closed-product-form")!;
    expect([row.suitability, row.summary]).toEqual(["unavailable", "The closed product form needs exponential service times; S2 has another distribution."]);
    expect(solveChoice(candidates(rows, true))).toBeNull();
    // The simulator reads a closed network as the exact method does, so it refuses with the same sentence.
    expect(rows.find((r) => r.id === "simulation-inprocess")).toMatchObject({ suitability: "unavailable", summary: "The closed product form needs exponential service times; S2 has another distribution." });
    expect(recommendations(domain(undefined), []).some((r) => r.id === "closed-product-form")).toBe(false);
  });

  it("the Run menu dims every other method for a closed network with the reason, and this one for an open network", () => {
    tabWith(central());
    expect(runWhen("run:closed-product-form")).toBe(true);
    expect(runWhen("run:replicated-simulation")).toBe(true);
    expect(runWhen("run:qna")).toBe("This is a closed network (no source and no sink): use Exact Closed Product Form");
    expect(runWhen("run:monte-carlo-finite")).toContain("closed network");
    tabWith(jackson());
    expect(runWhen("run:qna")).toBe(true);
    expect(runWhen("run:closed-product-form")).toBe("This needs a closed network: no source, no sink and a population");
    // An open network with infinite buffers takes Replicated Simulation; one with finite buffers does not.
    expect(runWhen("run:replicated-simulation")).toBe(true);
    tabWith({ ...jackson(), infiniteBuffers: false });
    expect(runWhen("run:replicated-simulation")).toBe("This network has finite buffers: Replicated Simulation covers infinite buffers and closed networks");
  });

  it("Solve runs the exact method, Check with Another Method then runs Replicated Simulation, and the verdict is that they agree (SIM-108)", async () => {
    const id = tabWith(central(), "ClosedCentralServer.d3.N8.bnet");
    expect((await solve(id))?.label).toBe("closed_pf");
    expect((await checkWithAnother(id))?.label).toBe("sim_inproc");
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["closed_pf", "sim_inproc"]);
    // Nothing else applies to a closed network: a third press says so and starts nothing.
    expect(await checkWithAnother(id)).toBeNull();
    expect(mockRuns.starts).toHaveLength(2);
    const a = agreement(currentRuns(mockRuns.records as unknown as ResultRecord[], await api.resultsFingerprint(central())));
    expect(a.methods.map((m) => [m.shortName, m.tier])).toEqual([["Closed PF", "exact"], ["Replicated Sim", "simulation"]]);
    expect([a.compared, a.comparedWithExact, a.verdict]).toEqual([18, 18, "agree"]);
    const b = bannerFor(a, 4)!;
    expect([b.kind, b.title, b.detail]).toEqual(["exact", "Exact result available — Closed PF solves this network exactly.", ["The other 1 method agrees with it (within 2 %)."]]);
  });

  it("a run of Replicated Simulation files a simulation record with an interval on each of the same 18 measures (the preview's stand-in says it is one)", async () => {
    const id = tabWith(central(), "ClosedCentralServer.d3.N8.bnet");
    await act(async () => {
      expect(await startRun(id, "closed_pf")).toBe(true);
    });
    await waitFor(() => expect(mockRuns.records).toHaveLength(1), { timeout: 5000 });
    await waitFor(() => expect(getRunState().active).toBeNull(), { timeout: 5000 });
    await act(async () => {
      expect(await startRun(id, "sim_inproc")).toBe(true);
    });
    await waitFor(() => expect(mockRuns.records).toHaveLength(2), { timeout: 5000 });
    type M = { metric: string; stationName: string; estimate: number; uncertainty?: { lowerBound: number; upperBound: number; confidenceLevel: number } };
    const [exact, simulated] = mockRuns.records as unknown as { method: { identifier: string; fidelity: string }; measurements: M[]; warnings: string[]; provenance: { networkFingerprint: string } }[];
    expect([simulated.method.identifier, simulated.method.fidelity]).toEqual(["queue.des-replications", "Queue simulation"]);
    expect(simulated.provenance.networkFingerprint).toBe(exact.provenance.networkFingerprint);
    expect(simulated.measurements.map((m) => `${m.stationName}|${m.metric}`)).toEqual(exact.measurements.map((m) => `${m.stationName}|${m.metric}`));
    expect(simulated.measurements.every((m) => m.uncertainty && m.uncertainty.confidenceLevel === 0.95 && m.uncertainty.lowerBound < m.estimate && m.estimate < m.uncertainty.upperBound)).toBe(true);
    // The browser has no simulator: the stand-in's record and text say that it is not a simulation.
    expect(simulated.warnings.join(" ")).toContain("PREVIEW STAND-IN: not a simulation");
  });

  it("a run files an exact record with six measures per station, which the canvas and Results read like any other", async () => {
    const id = tabWith(central(), "ClosedCentralServer.d3.N8.bnet");
    await act(async () => {
      expect(await startRun(id, "closed_pf")).toBe(true);
    });
    await waitFor(() => expect(mockRuns.records).toHaveLength(1), { timeout: 5000 });
    const record = mockRuns.records[0] as unknown as { method: { identifier: string; fidelity: string }; measurements: { metric: string; stationName: string }[]; provenance: { networkSnapshot: BnetDocument } };
    expect([record.method.identifier, record.method.fidelity]).toEqual(["queue.closed-product-form", "Exact queueing result"]);
    expect(record.measurements).toHaveLength(18);
    expect(record.provenance.networkSnapshot.closedPopulation).toBe(8);
    // The run is of the network with 8 customers: another population, or none, is another network.
    const fp = await api.resultsFingerprint(central());
    expect((mockRuns.records[0].provenance as { networkFingerprint?: string }).networkFingerprint).toBe(fp);
    expect(await api.resultsFingerprint({ ...central(), closedPopulation: 9 })).not.toBe(fp);
    const { closedPopulation: _n, ...bare } = central();
    expect(await api.resultsFingerprint(bare as BnetDocument)).not.toBe(fp);
    // Another method on the same network is refused with the reason.
    const before = activeTab().log.length;
    await act(async () => {
      expect(await startRun(id, "qna")).toBe(false);
    });
    expect(activeTab().log.slice(before).map((l) => l.text).join(" ")).toContain("this is a closed network");
  });
});

// ── Live results ─────────────────────────────────────────────────────────────────────────────

describe("live results of a closed network", () => {
  it("are exact, say what a closed network's throughput means, and read out the cycle time", () => {
    const r = closedLive(central());
    expect([r.tier, r.closed]).toEqual(["exact", { population: 8, referenceStation: "S1" }]);
    expect(markFor(r).chip).toBe("Live · exact");
    expect(markFor(r).help).toContain("closed network of 8 customers");
    expect(markFor(r).help).toContain("S1 is the reference station");
    const s1 = central().nodes.find((n) => n.name === "S1")!;
    const readout = readoutFor(r, s1.id, 3)!;
    expect(readout.parts.map((p) => `${p.label} ${p.number} ${p.unit}`)).toEqual(["ρ 63.3 %", "L 1.521 customers", "W 0.240 time units"]);
    // The bundled example has a self-loop at S1 (p11 = 0.1): X counts every pass through S1, and
    // N/X is the time between a customer's successive visits, never a "mean delay".
    expect(readout.help).toContain("Closed network: N = 8 customers. Throughput at S1 (visits per time unit): 6.332. Cycle time between visits to S1: 1.263 time units.");
    expect(readout.help).toContain("every pass through it counts");
    expect(readout.help).toContain("not the response time of a job");
    expect(readout.help).not.toMatch(/mean delay|T = /i);
    expect(liveRecord(r, "T").measurements.filter((m) => m.metric === "Throughput")).toHaveLength(3);
  });

  it("without a population say what to do instead of showing numbers", async () => {
    const { closedPopulation: _n, ...bare } = central();
    const r = await api.liveResults(bare as BnetDocument);
    expect([r.tier, r.reasonIfPartial]).toEqual(["none", "closedNoPopulation"]);
    expect(markFor(r).help).toContain("Set a population");
  });
});

// ── The preview's stand-in against Rust ──────────────────────────────────────────────────────

describe("the preview's stand-in solver", () => {
  it("gives the numbers core printed for the bundled example (qnet-cli run closed_pf, 12 digits)", () => {
    const a = standInClosed(central());
    if (!a.ok) throw new Error(a.sentence);
    const rust = [
      { name: "S1", visits: 1, x: 6.33179053313, n: 1.52132411501, q: 0.888145061693, util: 0.633179053313, t: 0.240267599985 },
      { name: "S2", visits: 0.6, x: 3.79907431988, n: 4.56798901188, q: 3.61822043191, util: 0.94976857997, t: 1.20239527507 },
      { name: "S3", visits: 0.3, x: 1.89953715994, n: 1.91068687312, q: 0.644328766491, util: 0.633179053313, t: 1.00586969995 },
    ];
    expect(a.throughput).toBeCloseTo(6.33179053313, 9);
    a.stations.forEach((s, i) => {
      expect(s.name).toBe(rust[i].name);
      expect(s.visits).toBeCloseTo(rust[i].visits, 9);
      expect(s.throughput).toBeCloseTo(rust[i].x, 9);
      expect(s.number).toBeCloseTo(rust[i].n, 9);
      expect(s.queue).toBeCloseTo(rust[i].q, 9);
      expect(s.utilisation).toBeCloseTo(rust[i].util, 9);
      expect(s.residence).toBeCloseTo(rust[i].t, 9);
    });
    expect(closedRecord({ tabId: "t", title: "x" }, central(), a).measurements).toHaveLength(18);
  });

  it("refuses what core refuses, by the same codes", () => {
    const doc = central();
    const code = (d: BnetDocument) => {
      const a = standInClosed(d);
      return a.ok ? "ok" : a.code;
    };
    expect(code({ ...doc, closedPopulation: 0 })).toBe("closedPopulationRange");
    expect(code({ ...doc, nodes: doc.nodes.map((n) => (n.name === "S2" ? { ...n, distribution: "erlang" } : n)) })).toBe("closedNotExponential");
    const s1 = doc.nodes.find((n) => n.name === "S1")!.id;
    expect(code({ ...doc, links: doc.links.map((l) => (l.fromNodeID === s1 && l.routingProbability === 0.3 ? { ...l, routingProbability: 0.2 } : l)) })).toBe("closedRoutingLeaks");
    expect(code({ ...doc, links: doc.links.map((l, i) => (i === 0 ? { ...l, customerClass: 1 } : l)) })).toBe("closedMultiClass");
  });
});

// ── The sweep over N ─────────────────────────────────────────────────────────────────────────

describe("a what-if sweep over the population", () => {
  it("offers Exact Closed Product Form, exact and ticked, and Replicated Simulation beside it, slow and not ticked", async () => {
    const id = tabWith(central());
    const methods = await methodsFor({ id, document: central() });
    expect(methods.map((m) => [m.label, m.tier, m.preferred, m.slow])).toEqual([["closed_pf", "exact", true, false], ["sim_inproc", "simulation", false, true]]);
  });

  it("offers N for a closed network only, as a whole number from 1 to 10000", () => {
    const ps = discoverParameters(central());
    expect(ps[0]).toMatchObject({ id: "population", kind: "population", label: "Population (customers circulating)", axis: "Population N", current: 8, integer: true, min: 1, max: 10000, unit: "customers" });
    expect(ps.some((p) => p.kind === "load" || p.kind === "arrival")).toBe(false);
    expect(ps.filter((p) => p.kind === "servers").map((p) => p.label)).toEqual(["S1 number of servers", "S2 number of servers", "S3 number of servers"]);
    expect(discoverParameters(jackson()).some((p) => p.kind === "population")).toBe(false);
    const n = ps[0];
    expect([allowed(n, 1), allowed(n, 0), allowed(n, 2.5), allowed(n, 10001)]).toEqual([true, false, false, false]);
  });

  it("substitutes N and nothing else, defaults to 1…2N, and throughput rises with N to the bottleneck's capacity", async () => {
    const doc = central();
    const n = discoverParameters(doc)[0];
    const at20 = substitute(doc, n, 20)!;
    expect(at20.closedPopulation).toBe(20);
    expect(at20.nodes).toBe(doc.nodes);
    expect(substitute(doc, n, 8)).toBe(doc);
    expect(await defaultRange(doc, n)).toEqual({ from: 1, to: 16, edge: null });
    expect(POINT_SECONDS.closed_pf).toBeLessThan(0.1);
    // The curve the sweep draws, by the stand-in: increasing, below μ₂/v₂ = 4/0.6.
    let last = 0;
    for (const k of [1, 2, 4, 8, 16, 32]) {
      const out = await api.quietRun({ tabId: "t", title: "x", document: substitute(doc, n, k)!, method: "closed_pf", settings: {}, overrides: {} } as never);
      expect(out.kind).toBe("record");
      const a = standInClosed(substitute(doc, n, k)!);
      if (!a.ok) throw new Error(a.sentence);
      expect(a.throughput).toBeGreaterThan(last);
      expect(a.throughput).toBeLessThan(4 / 0.6);
      last = a.throughput;
    }
    expect(last).toBeGreaterThan(0.999 * (4 / 0.6));
  });

  it("applies a chosen N to the network as one undoable step", async () => {
    const id = tabWith(central());
    await Promise.resolve();
    const n = discoverParameters(central())[0];
    expect(applySweepValue(id, n, 12)).toBe(true);
    await Promise.resolve();
    expect(activeTab().document.closedPopulation).toBe(12);
    editorFor(id).undoManager.undo();
    expect(activeTab().document.closedPopulation).toBe(8);
  });
});
