// Scenarios (src/scenarios; ledger WF-101…): the override rules as pure functions, the editor's
// recording of edits and its undo, the file form (with and without scenarios), which runs are a
// scenario's, the Compare table's tiers and warnings, the topology rule, the switcher, the
// inspector's mark, Save as Scenario and Solve All Scenarios.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockLive, standInLive } from "../dev/mock/live";
import { mockRuns } from "../dev/mock/runs";
import { defaultHandlers } from "../dev/mockBackend";
import { editorFor, resetEditors } from "../editor";
import { api } from "../lib/api";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, unavailableReason } from "../lib/commands";
import { loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC, specItem } from "../lib/menuSpec";
import { resetOverlays } from "../lib/overlays";
import { resetAdvice } from "../panes/results/agreement/chooser";
import { resetAgreementCommands } from "../panes/results/agreement/commands";
import { resetSequence } from "../panes/results/agreement/runner";
import { fingerprintNow } from "../panes/results/fingerprint";
import type { ResultRecord } from "../panes/results/model";
import { resetStructures } from "../results/current";
import { bestRun, currentRuns } from "../results/insight";
import { resetRuns } from "../runs/state";
import { mockTauri } from "../test/tauri";
import { addTab, documentSignature, isDirty, markSaved, resetWorkspace, tabById } from "../workspace/store";
import { askScenarioName, confirmScenarioName, createScenario, nameProblem, openCompare, removeScenario, renameScenarioTo, resetScenarioCommands, resetToBaseline, saveAsScenario, showScenario, startScenarioCommands } from "./commands";
import { compareChart, compareCsv, compareTable, diffText, type Variant } from "./compare";
import { resetScenarioEdits } from "./edits";
import { ScenarioHost } from "./Host";
import { activeId, activeScenario, applyOverrides, baselineDocument, baselineValue, deleteScenario, MISSING, newScenario, plain, readField, reconcile, renameScenario, resetOverride, scenarioDocument, scenariosOf, switchScenario, uniqueName, writeField } from "./model";
import { baselineText, OverrideMark } from "./OverrideMark";
import { getSolveAll, resetSolveAll, solveAllScenarios, stopSolveAll } from "./solveAll";
import { ScenarioSwitcher } from "./Switcher";
import { scenarioWords as w } from "./words";

const examples = import.meta.glob("../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const resaved = import.meta.glob("../../golden/*/resave.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const records = import.meta.glob("../../golden/runs/OpenJackson.d2.feedback.p30.inf/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/** γ = 1; S1 → S2 with 0.7, back to S1 with 0.3: a Jackson network, one server at each station. */
const FEEDBACK = "OpenJackson.d2.feedback.p30.inf";
const example = (stem: string) => JSON.parse(resaved[`../../golden/${stem}/resave.bnet`]) as BnetDocument;
const openExample = (stem: string = FEEDBACK) => addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: example(stem) });
const docOf = (id: string) => tabById(id)!.document;
const station = (doc: BnetDocument, name: string) => doc.nodes.find((n) => n.kind === "station" && n.name === name)!;
const record = (method: string) => JSON.parse(records[`../../golden/runs/${FEEDBACK}/${method}/record.json`]) as ResultRecord;
const WAIT = { timeout: 8000 };
const frames: HTMLIFrameElement[] = [];

beforeEach(async () => {
  mockTauri(defaultHandlers());
  mockRuns.replayMs = 5;
  resetKv();
  await loadKv();
  resetWorkspace();
  resetEditors();
  resetRuns();
  resetSequence();
  resetAdvice();
  resetAgreementCommands();
  resetOverlays();
  resetStructures();
  resetScenarioCommands();
  resetScenarioEdits();
  resetSolveAll();
  startScenarioCommands();
  vi.spyOn(window, "open").mockImplementation(() => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frames.push(frame);
    return frame.contentWindow!;
  });
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 10));
  frames.splice(0).forEach((f) => f.remove());
  vi.restoreAllMocks();
});

describe("overrides as pure functions (WF-102)", () => {
  it("reads and writes each field a scenario may override, and nothing for a target that is gone", () => {
    const doc = example(FEEDBACK);
    const s1 = station(doc, "S1");
    const link = doc.links[0];
    expect(readField(doc, { node: s1.id, field: "numberOfServers" })).toBe(1);
    expect(readField(doc, { node: s1.id, field: "distribution" })).toEqual({ distribution: s1.distribution, distributionParameters: s1.distributionParameters });
    expect(readField(doc, { link: link.id, field: "routingProbability" })).toBe(link.routingProbability);
    expect(readField(doc, { field: "closedPopulation" })).toBeNull();
    expect(readField(doc, { node: "NOT-THERE", field: "bufferSize" })).toBe(MISSING);
    const next = applyOverrides(doc, [
      { node: s1.id, field: "numberOfServers", value: 2 },
      { node: s1.id, field: "distribution", value: { distribution: "erlang", distributionParameters: "k=2,rate=3" } },
      { link: link.id, field: "routingProbability", value: 0.25 },
      { field: "closedPopulation", value: 12 },
      { node: "NOT-THERE", field: "bufferSize", value: 9 },
    ]);
    expect(station(next, "S1")).toMatchObject({ numberOfServers: 2, distribution: "erlang", distributionParameters: "k=2,rate=3" });
    expect(next.links[0].routingProbability).toBe(0.25);
    expect(next.closedPopulation).toBe(12);
    expect(doc.closedPopulation).toBeUndefined();
    expect(station(doc, "S1").numberOfServers).toBe(1);
    expect("closedPopulation" in writeField(next, { field: "closedPopulation", value: null })).toBe(false);
    expect(writeField(doc, { node: s1.id, field: "numberOfServers", value: 1 })).toBe(doc);
  });

  it("switching puts a scenario's values into the network and keeps the baseline's beside them", () => {
    const doc = example(FEEDBACK);
    const s2 = station(doc, "S2").id;
    let d = newScenario(doc, "A", "Add a server at S2");
    expect(activeId(d)).toBe("A");
    expect(d.nodes).toBe(doc.nodes);
    // An edit under A: S2 gets a second server.
    d = reconcile(d, writeField(d, { node: s2, field: "numberOfServers", value: 2 })).doc;
    expect(activeScenario(d)!.overrides).toEqual([{ node: s2, field: "numberOfServers", value: 2 }]);
    expect(d.scenarios!.baseline).toEqual([{ node: s2, field: "numberOfServers", value: 1 }]);
    expect(baselineValue(d, { node: s2, field: "numberOfServers" })).toBe(1);
    expect(plain(baselineDocument(d))).toEqual(doc);
    const base = switchScenario(d, null);
    expect(station(base, "S2").numberOfServers).toBe(1);
    expect(base.scenarios).toEqual({ items: [{ id: "A", name: "Add a server at S2", overrides: [{ node: s2, field: "numberOfServers", value: 2 }] }] });
    const back = switchScenario(base, "A");
    expect(station(back, "S2").numberOfServers).toBe(2);
    expect(back.scenarios).toEqual(d.scenarios);
    expect(station(scenarioDocument(base, "A"), "S2").numberOfServers).toBe(2);
    expect(scenarioDocument(base, "A").scenarios).toBeUndefined();
    expect(scenarioDocument(back, null)).toEqual(doc);
    expect(switchScenario(back, "A")).toBe(back);
    expect(switchScenario(back, "NOPE")).toBe(back);
  });

  it("an edit back to the baseline's value ends the override; a baseline edit is no override", () => {
    const doc = example(FEEDBACK);
    const s2 = station(doc, "S2").id;
    let d = newScenario(doc, "A", "A");
    d = reconcile(d, writeField(d, { node: s2, field: "numberOfServers", value: 3 })).doc;
    d = reconcile(d, writeField(d, { node: s2, field: "numberOfServers", value: 4 })).doc;
    expect(activeScenario(d)!.overrides).toEqual([{ node: s2, field: "numberOfServers", value: 4 }]);
    expect(d.scenarios!.baseline).toEqual([{ node: s2, field: "numberOfServers", value: 1 }]);
    d = reconcile(d, writeField(d, { node: s2, field: "numberOfServers", value: 1 })).doc;
    expect(activeScenario(d)!.overrides).toEqual([]);
    expect(d.scenarios!.baseline).toEqual([]);
    // With the baseline shown, a changed value is the baseline's: A, which does not override it, follows.
    let b = switchScenario(d, null);
    const edited = writeField(b, { node: s2, field: "numberOfServers", value: 5 });
    const out = reconcile(b, edited);
    expect(out.doc).toBe(edited);
    b = out.doc;
    expect(station(scenarioDocument(b, "A"), "S2").numberOfServers).toBe(5);
  });

  it("a per-class entry that only repeats the station's own law is not an override", () => {
    const doc = example(FEEDBACK);
    const s2 = station(doc, "S2");
    const d = newScenario(doc, "A", "A");
    const same = { ...d, nodes: d.nodes.map((n) => (n.id === s2.id ? { ...n, serviceDistributions: { "0": { distribution: n.distribution, distributionParameters: n.distributionParameters } } } : n)) };
    expect(activeScenario(reconcile(d, same).doc)!.overrides).toEqual([]);
    const other = writeField(d, { node: s2.id, field: "serviceDistributions", value: { "0": { distribution: "erlang", distributionParameters: "k=2,rate=4" } } });
    expect(activeScenario(reconcile(d, other).doc)!.overrides).toHaveLength(1);
  });

  it("reset, rename, delete and names", () => {
    const doc = example(FEEDBACK);
    const s2 = station(doc, "S2").id;
    let d = newScenario(doc, "A", "Peak hour");
    d = reconcile(d, writeField(d, { node: s2, field: "numberOfServers", value: 2 })).doc;
    const reset = resetOverride(d, { node: s2, field: "numberOfServers" });
    expect(station(reset, "S2").numberOfServers).toBe(1);
    expect(activeScenario(reset)!.overrides).toEqual([]);
    expect(resetOverride(reset, { node: s2, field: "numberOfServers" })).toBe(reset);
    expect(scenariosOf(renameScenario(d, "A", "Rush")).map((s) => s.name)).toEqual(["Rush"]);
    expect(uniqueName(d, "Peak hour", w.baseline)).toBe("Peak hour 2");
    expect(uniqueName(d, "baseline", w.baseline)).toBe("baseline 2");
    expect(uniqueName(d, "Peak hour", w.baseline, "A")).toBe("Peak hour");
    // Deleting the scenario shown goes back to the baseline; the last one gone, no key is left.
    const gone = deleteScenario(d, "A");
    expect(gone).toEqual(doc);
    expect("scenarios" in gone).toBe(false);
  });
});

describe("the topology rule (WF-105)", () => {
  it("a deleted station takes the overrides of it with it, in every scenario, and says so", () => {
    const doc = example(FEEDBACK);
    const s2 = station(doc, "S2").id;
    let d = newScenario(doc, "A", "A");
    d = reconcile(d, writeField(d, { node: s2, field: "numberOfServers", value: 2 })).doc;
    d = switchScenario(d, null);
    const without = { ...d, nodes: d.nodes.filter((n) => n.id !== s2), links: d.links.filter((l) => l.fromNodeID !== s2 && l.toNodeID !== s2) };
    const out = reconcile(d, without);
    expect(out.topology).toBe(true);
    expect(out.dropped).toEqual([{ name: "A", count: 1 }]);
    expect(scenariosOf(out.doc)[0].overrides).toEqual([]);
    // A move is neither topology nor a value.
    const moved = { ...d, nodes: d.nodes.map((n) => (n.id === s2 ? { ...n, position: [5, 5] as [number, number] } : n)) };
    expect(reconcile(d, moved)).toEqual({ doc: moved, dropped: [], topology: false });
  });

  it("the editor says once that a change to the network itself is every scenario's, and notes each dropped override", () => {
    const id = openExample();
    const editor = editorFor(id);
    const s2 = station(docOf(id), "S2").id;
    createScenario(id, "Peak hour");
    editor.updateNumberOfServers(s2, 2);
    showScenario(id, null);
    const lines = () => tabById(id)!.log.map((l) => l.text);
    const once = w.topologyOnce([w.baseline, "Peak hour"]);
    editor.addNode("station", { x: 400, y: 400 });
    expect(lines().filter((l) => l === once)).toHaveLength(1);
    editor.addNode("station", { x: 500, y: 400 });
    expect(lines().filter((l) => l === once)).toHaveLength(1);
    // The new stations are in the scenario too.
    expect(scenarioDocument(docOf(id), scenariosOf(docOf(id))[0].id).nodes).toHaveLength(docOf(id).nodes.length);
    editor.undoManager.closeGroup();
    editor.deleteNode(s2);
    expect(lines()).toContain(w.dropped("Peak hour", 1));
    expect(scenariosOf(docOf(id))[0].overrides).toEqual([]);
    // Undo brings the station and the override back together.
    act(() => editor.undo());
    expect(scenariosOf(docOf(id))[0].overrides).toEqual([{ node: s2, field: "numberOfServers", value: 2 }]);
  });
});

describe("edits and undo through the editor (WF-103, WF-104)", () => {
  it("a value changed while a scenario is shown is that scenario's, and every operation is one undo step", () => {
    const id = openExample();
    const editor = editorFor(id);
    const original = docOf(id);
    const s2 = station(original, "S2").id;
    const a = createScenario(id, "Add a server at S2")!;
    expect(editor.undoManager.undoActionName).toBe(w.undo.new);
    editor.undoManager.closeGroup();
    editor.updateNumberOfServers(s2, 2);
    editor.undoManager.closeGroup();
    expect(activeScenario(docOf(id))!.overrides).toEqual([{ node: s2, field: "numberOfServers", value: 2 }]);
    expect(showScenario(id, null)).toBe(true);
    editor.undoManager.closeGroup();
    expect(station(docOf(id), "S2").numberOfServers).toBe(1);
    expect(showScenario(id, null)).toBe(false);
    // Undo the switch: A is shown again, with its value.
    act(() => editor.undo());
    expect(activeId(docOf(id))).toBe(a);
    expect(station(docOf(id), "S2").numberOfServers).toBe(2);
    // Undo the edit: A no longer overrides anything.
    act(() => editor.undo());
    expect(station(docOf(id), "S2").numberOfServers).toBe(1);
    expect(activeScenario(docOf(id))!.overrides).toEqual([]);
    // Undo the creation: no scenarios, and the tab is clean again.
    act(() => editor.undo());
    expect(docOf(id).scenarios).toBeUndefined();
    expect(docOf(id).nodes).toEqual(original.nodes);
    expect(isDirty(tabById(id)!)).toBe(false);
    // Redo all three.
    act(() => editor.redo());
    act(() => editor.redo());
    act(() => editor.redo());
    expect(activeId(docOf(id))).toBeNull();
    expect(station(scenarioDocument(docOf(id), a), "S2").numberOfServers).toBe(2);
    expect(isDirty(tabById(id)!)).toBe(true);
  });

  it("rename, delete and reset are undoable, with a Status line each", () => {
    const id = openExample();
    const editor = editorFor(id);
    const s2 = station(docOf(id), "S2").id;
    const a = createScenario(id, "A")!;
    editor.undoManager.closeGroup();
    editor.updateNumberOfServers(s2, 2);
    editor.undoManager.closeGroup();
    expect(renameScenarioTo(id, a, "Peak hour")).toBe(true);
    editor.undoManager.closeGroup();
    expect(resetToBaseline(id, { node: s2, field: "numberOfServers" })).toBe(true);
    editor.undoManager.closeGroup();
    expect(station(docOf(id), "S2").numberOfServers).toBe(1);
    act(() => editor.undo());
    expect(station(docOf(id), "S2").numberOfServers).toBe(2);
    expect(removeScenario(id, a)).toBe(true);
    editor.undoManager.closeGroup();
    expect(docOf(id).scenarios).toBeUndefined();
    expect(station(docOf(id), "S2").numberOfServers).toBe(1);
    act(() => editor.undo());
    expect(activeScenario(docOf(id))).toMatchObject({ name: "Peak hour", overrides: [{ node: s2, field: "numberOfServers", value: 2 }] });
    const lines = tabById(id)!.log.map((l) => l.text);
    expect(lines).toEqual(expect.arrayContaining([w.created("A"), w.renamed("A", "Peak hour"), w.resetDone(w.fields.numberOfServers), w.deleted("Peak hour")]));
  });

  it("the name prompt refuses an empty or taken name", () => {
    const id = openExample();
    createScenario(id, "Peak hour");
    askScenarioName("new", id);
    const r = { tabId: id, mode: "new" as const, initial: "" };
    expect(nameProblem(r, "  ")).toBe(w.nameEmpty);
    expect(nameProblem(r, "peak hour")).toBe(w.nameTaken("peak hour"));
    expect(nameProblem(r, "Baseline")).toBe(w.nameTaken("Baseline"));
    expect(confirmScenarioName(r, "peak hour")).toBe(false);
    expect(confirmScenarioName(r, "Night")).toBe(true);
    expect(scenariosOf(docOf(id)).map((s) => s.name)).toEqual(["Peak hour", "Night"]);
  });
});

describe("the file (WF-101)", () => {
  it("a network without scenarios is saved exactly as before, also after scenarios came and went", async () => {
    const id = openExample();
    const before = JSON.stringify(docOf(id));
    const a = createScenario(id, "A")!;
    editorFor(id).updateNumberOfServers(station(docOf(id), "S2").id, 2);
    removeScenario(id, a);
    expect(JSON.stringify(docOf(id))).toBe(before);
    expect(Object.keys(docOf(id))).not.toContain("scenarios");
    expect((await api.documentWrite("/tmp/plain.bnet", docOf(id))).text).toBe(JSON.stringify(example(FEEDBACK), null, 2));
  });

  it("scenarios are written with the network as shown and read back as they were", async () => {
    const id = openExample();
    const s2 = station(docOf(id), "S2").id;
    const a = createScenario(id, "Add a server at S2")!;
    editorFor(id).updateNumberOfServers(s2, 2);
    const saved = await api.documentWrite("/tmp/with.bnet", docOf(id));
    const read = JSON.parse((await api.documentRead("/tmp/with.bnet")).text) as BnetDocument;
    expect(saved.text).toContain('"scenarios"');
    expect(read).toEqual(docOf(id));
    // What a reader that ignores the key sees is the network as shown: S2 with two servers.
    expect(station(plain(read), "S2").numberOfServers).toBe(2);
    expect(read.scenarios).toEqual({ active: a, baseline: [{ node: s2, field: "numberOfServers", value: 1 }], items: [{ id: a, name: "Add a server at S2", overrides: [{ node: s2, field: "numberOfServers", value: 2 }] }] });
    // Scenarios count as content: saving makes the tab clean, renaming one makes it dirty again.
    markSaved(id, "/tmp/with.bnet", "with.bnet");
    expect(isDirty(tabById(id)!)).toBe(false);
    renameScenarioTo(id, a, "Two servers");
    expect(isDirty(tabById(id)!)).toBe(true);
  });

  // The file is written by Rust with every object's keys in alphabetical order (core/src/bnet.rs:
  // field, node, value); the interface builds its entries as node, field, value. The same content
  // in another key order, or the same overrides in another order, is not an edit.
  const asRustWrites = (id: string): BnetDocument => {
    const d = docOf(id);
    const entry = (o: { node?: string; link?: string; field: string; value: unknown }) => JSON.parse(JSON.stringify({ field: o.field, link: o.link, node: o.node, value: o.value }));
    const set = d.scenarios!;
    return { ...d, scenarios: { active: set.active, baseline: set.baseline?.map(entry), items: set.items.map((s) => ({ id: s.id, name: s.name, overrides: s.overrides.map(entry) })) } } as BnetDocument;
  };
  const openSavedWithScenario = () => {
    const made = openExample();
    const s1 = station(docOf(made), "S1").id;
    const s2 = station(docOf(made), "S2").id;
    createScenario(made, "Peak hour");
    editorFor(made).updateNumberOfServers(s2, 2);
    editorFor(made).updateNumberOfServers(s1, 3);
    const file = asRustWrites(made);
    expect(Object.keys(file.scenarios!.baseline![0])).toEqual(["field", "node", "value"]);
    return addTab({ title: "saved.bnet", path: "/tmp/saved.bnet", document: file });
  };

  it("a file saved with a scenario shown is not edited by Solve All Scenarios (WF-502)", async () => {
    const id = openSavedWithScenario();
    const shown = activeId(docOf(id));
    expect(isDirty(tabById(id)!)).toBe(false);
    let done = 0;
    await act(async () => void (done = await solveAllScenarios(id)));
    expect(done).toBe(2);
    expect(activeId(docOf(id))).toBe(shown);
    expect(isDirty(tabById(id)!)).toBe(false);
  });

  it("nor by showing the baseline and then the scenario again, while a real change still is (WF-502)", () => {
    const id = openSavedWithScenario();
    const shown = activeId(docOf(id))!;
    showScenario(id, null);
    expect(isDirty(tabById(id)!)).toBe(true);
    showScenario(id, shown);
    expect(isDirty(tabById(id)!)).toBe(false);
    // The order of a scenario's overrides is not content either; a value is.
    const d = docOf(id);
    const set = d.scenarios!;
    expect(documentSignature({ ...d, scenarios: { ...set, items: set.items.map((s) => ({ ...s, overrides: [...s.overrides].reverse() })) } })).toBe(documentSignature(d));
    expect(documentSignature({ ...d, scenarios: { ...set, items: set.items.map((s) => ({ ...s, overrides: s.overrides.map((o) => ({ ...o, value: 9 })) })) } })).not.toBe(documentSignature(d));
    expect(documentSignature({ ...d, scenarios: { ...set, items: [...set.items, { id: "B", name: "B", overrides: [] }] } })).not.toBe(documentSignature(d));
    editorFor(id).updateNumberOfServers(station(docOf(id), "S2").id, 5);
    expect(isDirty(tabById(id)!)).toBe(true);
  });

  it("every bundled example still has no scenarios key", () => {
    for (const text of Object.values(examples)) expect(text).not.toContain('"scenarios"');
  });
});

describe("whose runs (WF-106)", () => {
  it("a run made under a scenario is current while that scenario is shown, and never under another", async () => {
    const id = openExample();
    const s2 = station(docOf(id), "S2").id;
    const a = createScenario(id, "A")!;
    editorFor(id).updateNumberOfServers(s2, 2);
    editorFor(id).undoManager.closeGroup();
    const b = createScenario(id, "B")!;
    editorFor(id).updateNumberOfServers(s2, 3);
    const doc = docOf(id);
    const fp = async (v: string | null) => (await fingerprintNow(scenarioDocument(doc, v)))!;
    const [fBase, fA, fB] = [await fp(null), await fp(a), await fp(b)];
    expect(new Set([fBase, fA, fB]).size).toBe(3);
    // The fingerprint does not read the scenarios: A's network is A's whether or not it is the one shown.
    expect(await fingerprintNow(switchScenario(doc, a))).toBe(fA);
    expect(await fingerprintNow(renameScenario(doc, a, "Renamed"))).toBe(fB);
    const run = (v: string | null, f: string): ResultRecord => ({ ...record("product_form"), id: `run-${v}`, provenance: { ...record("product_form").provenance, tabID: id, networkFingerprint: f, networkSnapshot: scenarioDocument(doc, v) } });
    const all = [run(a, fA), run(null, fBase)];
    expect(currentRuns(all, fA).map((r) => r.id)).toEqual([`run-${a}`]);
    expect(currentRuns(all, fBase).map((r) => r.id)).toEqual(["run-null"]);
    expect(currentRuns(all, fB)).toEqual([]);
    expect(bestRun(currentRuns(all, fB))).toBeNull();
  });
});

describe("Compare Scenarios as numbers (WF-107)", () => {
  const variants = (): Variant[] => {
    const doc = example(FEEDBACK);
    const s2 = station(doc, "S2").id;
    const two = writeField(doc, { node: s2, field: "numberOfServers", value: 2 });
    const qna = record("qna");
    return [
      { id: null, name: w.baseline, doc, overrides: null, run: null, live: standInLive(doc) },
      { id: "A", name: "Add a server at S2", doc: two, overrides: 1, run: null, live: standInLive(two) },
      { id: "Q", name: "QNA", doc, overrides: 0, run: qna, live: standInLive(doc) },
    ];
  };

  it("fills each cell from the scenario's run, else the exact formula, and labels the tier per cell", () => {
    const t = compareTable(variants());
    expect(t.rows.map((r) => r.key).slice(0, 3)).toEqual(["networkNumber", "networkDelay", "throughput"]);
    expect(t.rows).toHaveLength(3 + 2 * 2);
    const n = t.rows[0];
    // L = 14/3 for the baseline (the example's closed form); the second server at S2 lowers it.
    expect(n.cells[0]).toMatchObject({ tier: "exact", source: "live", diff: null });
    expect(n.cells[0].value).toBeCloseTo(14 / 3, 6);
    expect(n.cells[1].value!).toBeLessThan(n.cells[0].value!);
    expect(n.cells[1].diff).toBeCloseTo(n.cells[1].value! - 14 / 3, 9);
    expect(n.cells[1].pct).toBeCloseTo((n.cells[1].value! - 14 / 3) / (14 / 3), 9);
    // The third column has a run: its cells are the run's, at the run's tier.
    expect(n.cells[2]).toMatchObject({ tier: "approximation", source: "run", method: record("qna").method.shortName });
    // (QNA's recorded answer for this feedback network is 4.211, not the exact 14/3: why the row is marked.)
    expect(n.cells[2].value).toBeCloseTo(4.211, 2);
    // Delay is number over the arrival rate (γ = 1), throughput the arrival rate.
    expect(t.rows[1].cells[2].value).toBeCloseTo(n.cells[2].value!, 9);
    expect(t.rows[2].cells.map((c) => c.value)).toEqual([1, 1, 1]);
  });

  it("warns on every row that sets an exact value beside an approximation, and on none when the tiers match", () => {
    const t = compareTable(variants());
    expect(t.rows[0].mixed).toEqual(["exact", "approximation"]);
    expect(t.mixedRows).toBeGreaterThan(0);
    const same = compareTable(variants().slice(0, 2));
    expect(same.rows.every((r) => r.mixed === null)).toBe(true);
    expect(same.mixedRows).toBe(0);
    // No run and no closed form: an empty cell, never a guess.
    const none = compareTable([{ ...variants()[0], live: null }]);
    expect(none.rows[0].cells[0]).toMatchObject({ value: null, tier: null, source: null });
    const partial = compareTable([{ ...variants()[0], live: { ...standInLive(example(FEEDBACK)), tier: "utilisation" } }]);
    expect(partial.rows.every((r) => r.cells[0].value === null)).toBe(true);
  });

  it("writes the difference from the baseline in absolute and relative terms, the CSV and the chart", () => {
    const t = compareTable(variants());
    const util = t.rows.find((r) => r.kind === "utilisation" && r.group === "S2")!;
    expect(util.cells[0].value).toBeCloseTo(0.7, 6);
    expect(diffText(util.cells[1], util.unit, 3)).toMatch(/^−\d+\.\d pts \(−50\.0 %\)$/);
    expect(diffText(t.rows[0].cells[0], "customers", 3)).toBeNull();
    expect(diffText(t.rows[2].cells[1], "rate", 3)).toBe(w.sameAsBaseline);
    const csv = compareCsv(t).split("\n");
    expect(csv[0]).toBe("Measure,Unit,Baseline value,Baseline tier,Baseline source,Add a server at S2 value,Add a server at S2 tier,Add a server at S2 source,Add a server at S2 difference from baseline,Add a server at S2 difference %,QNA value,QNA tier,QNA source,QNA difference from baseline,QNA difference %");
    expect(csv[1]).toMatch(/^Mean number in the network,customers,4\.66666666667,Exact \(formula\),"exact formula, no run",/);
    expect(csv[1]).toContain(",Approximation,QNA,");
    expect(csv).toHaveLength(1 + t.rows.length + 1);
    const chart = compareChart(t, "utilisation", 3)!;
    expect(chart.series.map((s) => s.label)).toEqual(["Baseline", "Add a server at S2", "QNA"]);
    expect(chart.rows.map((r) => r.label)).toEqual(["S1", "S2"]);
    expect(chart.rows[1].values[1]!.value).toBeCloseTo(chart.rows[1].values[0]!.value / 2, 6);
    expect(compareChart(t, "networkDelay", 3)!.rows).toHaveLength(1);
    expect(compareChart(compareTable([{ ...variants()[0], live: null }]), "queue", 3)).toBeNull();
  });
});

describe("on screen", () => {
  it("the switcher always names what is shown, and its menu shows, makes and removes scenarios (WF-108)", async () => {
    const id = openExample();
    render(
      <>
        <ScenarioSwitcher />
        <ScenarioHost />
      </>,
    );
    const button = () => screen.getByRole("button", { name: /^Scenario: / });
    expect(button()).toHaveTextContent("Baseline");
    fireEvent.click(button());
    const menu = screen.getByRole("menu", { name: w.menuLabel });
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Baseline" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByText(w.rename).closest("[role]")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(menu).getByText(w.newFromCurrent));
    const dialog = await screen.findByRole("dialog", { name: w.nameTitle.new });
    const input = within(dialog).getByRole("textbox");
    expect(input).toHaveValue("Scenario");
    fireEvent.change(input, { target: { value: "Peak hour" } });
    fireEvent.click(within(dialog).getByRole("button", { name: w.create }));
    await waitFor(() => expect(button()).toHaveTextContent("Peak hour"), WAIT);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button());
    const again = screen.getByRole("menu", { name: w.menuLabel });
    expect(within(again).getByRole("menuitemcheckbox", { name: "Peak hour" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(again).getByRole("menuitemcheckbox", { name: "Baseline" }));
    await waitFor(() => expect(button()).toHaveTextContent("Baseline"), WAIT);
    expect(activeId(docOf(id))).toBeNull();
    expect(scenariosOf(docOf(id))).toHaveLength(1);
  });

  it("the menu has the two commands, dimmed with a reason when they cannot run", () => {
    expect(specItem("scenario:compare", MENU_SPEC)).toMatchObject({ label: "Compare Scenarios…" });
    expect(specItem("scenario:new", MENU_SPEC)).toMatchObject({ label: "New Scenario from Current Values…" });
    expect(unavailableReason(getCommand("scenario:new")!)).toBe(w.noNetwork);
    openExample();
    expect(unavailableReason(getCommand("scenario:new")!)).toBeNull();
    expect(unavailableReason(getCommand("scenario:delete")!)).toBe(w.onlyForScenario);
  });

  it("the inspector marks an overridden field with the baseline's value and resets it (WF-109)", () => {
    const id = openExample();
    const editor = editorFor(id);
    const s2 = station(docOf(id), "S2").id;
    const view = render(<OverrideMark editor={editor} node={s2} field="numberOfServers" />);
    expect(view.container).toBeEmptyDOMElement();
    act(() => void createScenario(id, "A"));
    act(() => editor.updateNumberOfServers(s2, 2));
    expect(screen.getByText(w.baselineIs("1"))).toBeInTheDocument();
    expect(view.container.querySelector(".scn-mark-dot")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: w.reset }));
    expect(station(docOf(id), "S2").numberOfServers).toBe(1);
    expect(view.container).toBeEmptyDOMElement();
    expect(baselineText("distribution", { distribution: "exponential", distributionParameters: "rate=1.25" })).toBe("Exponential (rate=1.25)");
    expect(baselineText("routingProbability", 0.3)).toBe("0.3");
    expect(baselineText("closedPopulation", null)).toBe(w.noPopulation);
  });

  it("Save as Scenario keeps a view's change as a new scenario, in one undo step, and leaves nothing behind when nothing applies (WF-110)", () => {
    const id = openExample();
    const editor = editorFor(id);
    const s2 = station(docOf(id), "S2").id;
    const before = docOf(id);
    expect(saveAsScenario(id, w.capacityName, () => editor.performParameterEdit("Apply Capacity Plan", null, () => editor.updateNumberOfServers(s2, 2)))).toBe(true);
    expect(activeScenario(docOf(id))).toMatchObject({ name: w.capacityName, overrides: [{ node: s2, field: "numberOfServers", value: 2 }] });
    expect(station(baselineDocument(docOf(id)), "S2").numberOfServers).toBe(1);
    expect(editor.undoManager.undoActionName).toBe(w.undo.saveAs);
    act(() => editor.undo());
    expect(docOf(id).scenarios).toBeUndefined();
    expect(docOf(id).nodes).toEqual(before.nodes);
    expect(saveAsScenario(id, "Nothing", () => false)).toBe(false);
    expect(docOf(id).scenarios).toBeUndefined();
  });

  it("Compare Scenarios shows the table with a tier in every cell, the chart, and the scenario shown (WF-111)", async () => {
    const id = openExample();
    const s2 = station(docOf(id), "S2").id;
    createScenario(id, "Add a server at S2");
    editorFor(id).updateNumberOfServers(s2, 2);
    render(<ScenarioHost />);
    act(() => openCompare(id));
    await waitFor(() => expect(frames.length).toBe(1), WAIT);
    const body = () => frames[0].contentDocument!.body;
    await waitFor(() => expect(body().querySelector("table.scn-table")).not.toBeNull(), WAIT);
    const table = within(body()).getByRole("table", { name: w.tableLabel });
    const heads = within(table).getAllByRole("columnheader");
    expect(heads.map((h) => h.textContent)).toEqual([w.measure, expect.stringContaining("Baseline"), expect.stringContaining("Add a server at S2")]);
    expect(heads[2]).toHaveClass("is-shown");
    const row = body().querySelector('tr[data-row="networkNumber"]')!;
    const cells = row.querySelectorAll("td");
    expect(cells[0]).toHaveTextContent("4.6667 customers");
    expect(cells[0]).toHaveTextContent(w.liveTier);
    expect(cells[1].querySelector(".scn-diff")!.textContent).toMatch(/^−\d\.\d{4} \(−\d+\.\d %\)$/);
    expect(body().querySelectorAll("td.scn-cell:not(.is-empty)").length).toBe(body().querySelectorAll("td.scn-cell .scn-tier").length);
    expect(body().querySelector("[data-mixed-rows]")).toBeNull();
    expect(body().querySelector('svg[data-chart="bar"]')).not.toBeNull();
    expect(mockLive.calls).toBeGreaterThanOrEqual(2);
    // A column's name shows that scenario.
    fireEvent.click(within(table).getByRole("button", { name: "Baseline" }));
    expect(activeId(docOf(id))).toBeNull();
  });
});

describe("Solve All Scenarios (WF-112)", () => {
  it("solves the baseline and each scenario in turn through Solve, then shows again what was shown", async () => {
    const id = openExample();
    const s2 = station(docOf(id), "S2").id;
    const a = createScenario(id, "Add a server at S2")!;
    editorFor(id).updateNumberOfServers(s2, 2);
    const editor = editorFor(id);
    editor.undoManager.closeGroup();
    const undoName = editor.undoManager.undoActionName;
    let done = 0;
    await act(async () => void (done = await solveAllScenarios(id)));
    expect(done).toBe(2);
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["product_form", "product_form"]);
    const servers = mockRuns.starts.map((s) => station(s.document as BnetDocument, "S2").numberOfServers);
    expect(servers).toEqual([1, 2]);
    expect(activeId(docOf(id))).toBe(a);
    expect(station(docOf(id), "S2").numberOfServers).toBe(2);
    expect(getSolveAll()).toBeNull();
    // Visiting the scenarios left no undo step behind.
    expect(editor.undoManager.undoActionName).toBe(undoName);
    expect(tabById(id)!.log.map((l) => l.text)).toContain(w.solveAllDone(2));
  });

  it("Stop ends it after the run in progress and comes back to what was shown", async () => {
    const id = openExample();
    createScenario(id, "A");
    editorFor(id).updateNumberOfServers(station(docOf(id), "S2").id, 2);
    showScenario(id, null);
    mockRuns.replayMs = 400;
    let all!: Promise<number>;
    act(() => void (all = solveAllScenarios(id)));
    await waitFor(() => expect(mockRuns.starts).toHaveLength(1), WAIT);
    expect(getSolveAll()).toMatchObject({ index: 1, total: 2, name: w.baseline });
    // Nothing about the scenarios changes while it runs.
    expect(showScenario(id, scenariosOf(docOf(id))[0].id)).toBe(false);
    await act(async () => void (await stopSolveAll()));
    await act(async () => void (await all));
    expect(mockRuns.starts).toHaveLength(1);
    expect(activeId(docOf(id))).toBeNull();
    expect(tabById(id)!.log.map((l) => l.text)).toContain(w.solveAllStopped(0, 2));
  });
});
