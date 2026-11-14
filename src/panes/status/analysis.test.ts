// When the silent analysis runs and what it writes (ledger ANA-015, ANA-020…027, LOG-032).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankAnalysis, mockAnalysis } from "../../dev/mock/status";
import { defaultHandlers } from "../../dev/mockBackend";
import { emptyDocument, type BnetDocument, type BnetNode } from "../../lib/bnet";
import type { SilentAnalysis } from "../../lib/types";
import { mockTauri } from "../../test/tauri";
import { addTab, getWorkspace, removeTabs, selectTab, setDocument, tabById, updateTab } from "../../workspace/store";
import { ANALYSIS_DEBOUNCE_MS, analysisKey, analysisOf, hasBeenAnalyzed, resetSilentAnalysis, startSilentAnalysis } from "./analysis";

function node(id: string, extra: Partial<BnetNode> = {}): BnetNode {
  return { id, kind: "station", name: id, position: [0, 0], bufferSize: 0, distribution: "exponential", distributionParameters: "rate=1.0", numberOfServers: 1, serviceDistributions: {}, picture: "", ...extra };
}
const doc = (n = 2, extra: Partial<BnetDocument> = {}): BnetDocument => ({ ...emptyDocument(), nodes: Array.from({ length: n }, (_, i) => node(`S${i + 1}`)), ...extra });

const result = (over: Partial<SilentAnalysis> = {}): SilentAnalysis => ({
  ...blankAnalysis(),
  utilisation: { S1: 0.7 },
  status: ["Silent analysis ρ:  S1=0.7000  S2=0.7000", "No warnings — banner hidden."],
  ...over,
});

const texts = (id: string) => tabById(id)!.log.map((e) => [e.severity, e.text]);
const flush = () => vi.advanceTimersByTimeAsync(0);

let stop: () => void = () => {};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mockTauri(defaultHandlers());
  resetSilentAnalysis();
  mockAnalysis.run = () => result();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("what the analysis reads (ANA-021)", () => {
  it("ignores position, picture and zoom but not anything an exporter reads", () => {
    const d = doc();
    const k = analysisKey(d);
    expect(analysisKey({ ...d, canvasScale: 2, nodes: d.nodes.map((n) => ({ ...n, position: [9, 9] as [number, number], picture: "server.rack" })) })).toBe(k);
    for (const change of [{ name: "S9" }, { kind: "buffer" as const }, { bufferSize: 3 }, { numberOfServers: 2 }, { distribution: "gamma" }, { distributionParameters: "rate=2.0" }, { serviceDistributions: { "0": { distribution: "gamma", distributionParameters: "" } } }, { id: "Z" }]) {
      expect(analysisKey({ ...d, nodes: [{ ...d.nodes[0], ...change }, d.nodes[1]] }), JSON.stringify(change)).not.toBe(k);
    }
    expect(analysisKey({ ...d, infiniteBuffers: true })).not.toBe(k);
    expect(analysisKey({ ...d, nodes: d.nodes.slice(1) })).not.toBe(k);
    expect(analysisKey({ ...d, links: [{ id: "L", fromNodeID: "S1", toNodeID: "S2", routingProbability: 1, customerClass: 0 }] })).not.toBe(k);
  });
});

describe("the triggers", () => {
  it("analyses the active tab at launch and writes its Status lines (ANA-023, ANA-026)", async () => {
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    expect(texts(id)).toEqual([
      ["info", "Silent analysis ρ:  S1=0.7000  S2=0.7000"],
      ["success", "No warnings — banner hidden."],
    ]);
    expect(analysisOf(id)?.utilisation).toEqual({ S1: 0.7 });
    expect(hasBeenAnalyzed(tabById(id)!)).toBe(true);
  });

  it("writes the warnings summary with one bullet per warning", async () => {
    mockAnalysis.run = () => result({ warnings: ["a", "b"], status: ["Silent analysis ρ:  S1=1.0000", "Banner triggered by 2 warning(s):", "  • a", "  • b"] });
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    expect(texts(id).map((t) => t[0])).toEqual(["info", "warning", "info", "info"]);
    expect(texts(id)[1][1]).toBe("Banner triggered by 2 warning(s):");
  });

  it("re-analyses quietly 150 ms after the last change the analysis reads, once per burst (ANA-020, ANA-022)", async () => {
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    const calls = mockAnalysis.calls;
    const logged = tabById(id)!.log.length;
    for (let i = 0; i < 5; i++) {
      setDocument(id, doc(2, { infiniteBuffers: i % 2 === 0 }));
      await vi.advanceTimersByTimeAsync(ANALYSIS_DEBOUNCE_MS - 10);
    }
    expect(mockAnalysis.calls).toBe(calls);
    expect(hasBeenAnalyzed(tabById(id)!)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(mockAnalysis.calls).toBe(calls + 1);
    expect(tabById(id)!.log.length).toBe(logged);
    expect(hasBeenAnalyzed(tabById(id)!)).toBe(true);
  });

  it("does not re-analyse after a move: position is not something the analysis reads", async () => {
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    const calls = mockAnalysis.calls;
    const d = tabById(id)!.document;
    setDocument(id, { ...d, nodes: d.nodes.map((n) => ({ ...n, position: [50, 50] as [number, number] })) });
    await vi.advanceTimersByTimeAsync(ANALYSIS_DEBOUNCE_MS + 10);
    expect(mockAnalysis.calls).toBe(calls);
    expect(hasBeenAnalyzed(tabById(id)!)).toBe(true);
  });

  it("leaves a background tab's change until it is activated, then analyses it with Status lines (ANA-022, ANA-023)", async () => {
    const a = addTab({ document: doc() });
    const b = addTab({ document: doc(3) });
    stop = startSilentAnalysis();
    await flush();
    selectTab(a);
    await flush();
    const calls = mockAnalysis.calls;
    setDocument(b, doc(4));
    await vi.advanceTimersByTimeAsync(ANALYSIS_DEBOUNCE_MS + 10);
    expect(mockAnalysis.calls).toBe(calls);
    const before = tabById(b)!.log.length;
    selectTab(b);
    await flush();
    expect(mockAnalysis.calls).toBe(calls + 1);
    expect(tabById(b)!.log.length).toBe(before + 2);
  });

  it("does not analyse an activated tab again when nothing changed since", async () => {
    const a = addTab({ document: doc() });
    const b = addTab({ document: doc(3) });
    stop = startSilentAnalysis();
    await flush();
    selectTab(a);
    await flush();
    const calls = mockAnalysis.calls;
    selectTab(b);
    await flush();
    selectTab(a);
    await flush();
    expect(mockAnalysis.calls).toBe(calls);
  });

  it("on an empty canvas: a quiet run clears the flags and marks it analysed; a non-quiet run does nothing (ANA-024)", async () => {
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    expect(analysisOf(id)?.utilisation).toEqual({ S1: 0.7 });
    const calls = mockAnalysis.calls;
    setDocument(id, emptyDocument());
    await vi.advanceTimersByTimeAsync(ANALYSIS_DEBOUNCE_MS + 10);
    expect(mockAnalysis.calls).toBe(calls);
    expect(analysisOf(id)).toMatchObject({ outcome: "empty", utilisation: {}, warnings: [], hasFeedback: false });
    expect(hasBeenAnalyzed(tabById(id)!)).toBe(true);

    const fresh = addTab();
    await flush();
    expect(tabById(fresh)!.log).toEqual([]);
    expect(hasBeenAnalyzed(tabById(fresh)!)).toBe(false);
  });

  it("logs a failure as an error and clears every flag (ANA-027)", async () => {
    mockAnalysis.run = () => ({ ...blankAnalysis("failed"), error: "The network has no sink node.", status: ["Silent analysis failed: The network has no sink node."] });
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    expect(texts(id)).toEqual([["error", "Silent analysis failed: The network has no sink node."]]);
    expect(analysisOf(id)).toMatchObject({ outcome: "failed", isAnalyticallyTractable: false, warnings: [], utilisation: {} });
    expect(hasBeenAnalyzed(tabById(id)!)).toBe(true);
  });

  it("reports a document Rust refuses as a failed analysis", async () => {
    mockAnalysis.run = () => {
      throw { kind: "invalid", message: "Qnet couldn't analyse this network: it isn't complete." };
    };
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    expect(texts(id)).toEqual([["error", "Silent analysis failed: Qnet couldn't analyse this network: it isn't complete."]]);
  });

  it("forgets a closed tab's results", async () => {
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    expect(analysisOf(id)).not.toBeNull();
    removeTabs([id]);
    expect(analysisOf(id)).toBeNull();
    expect(getWorkspace().tabs.some((t) => t.id === id)).toBe(false);
  });

  it("re-analyses a document replaced in place without a new revision (a file opened into the tab)", async () => {
    const id = addTab({ document: doc() });
    stop = startSilentAnalysis();
    await flush();
    const calls = mockAnalysis.calls;
    updateTab(id, { document: doc(5) });
    await vi.advanceTimersByTimeAsync(ANALYSIS_DEBOUNCE_MS + 10);
    expect(mockAnalysis.calls).toBe(calls + 1);
  });
});
