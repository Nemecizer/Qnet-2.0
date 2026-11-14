// Live results while drawing (ROADMAP Phase D): what the canvas shows before any run, how it is
// marked, that a recorded run of the network as it is always wins, when a request is made (and
// when not), and what an unstable network shows. The numbers themselves are checked in Rust
// (core/src/jackson.rs); the preview's stand-in answers here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { CanvasView } from "../canvas/CanvasView";
import { byName, example } from "../canvas/layers/testkit";
import { overlayModel } from "../canvas/overlay/model";
import { CanvasStatusBar } from "../canvas/StatusBar";
import { defaultHandlers } from "../dev/mockBackend";
import { mockLive, standInLive } from "../dev/mock/live";
import { mockRuns } from "../dev/mock/runs";
import { editorFor } from "../editor";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, runCommand } from "../lib/commands";
import { getStateValue, loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC } from "../lib/menuSpec";
import type { ResultRecord } from "../panes/results/model";
import { resetStructures, structureKey } from "../results/current";
import { resetSelectedRuns } from "../results/selectedRun";
import { onRunFinished, resetRuns, startRun } from "../runs/state";
import { mockTauri } from "../test/tauri";
import { addTab } from "../workspace/store";
import { LIVE_COMMAND } from "./commands";
import { chipFor, chooseModel, isLiveModel, LIVE_METHOD, liveOverlayModel, liveRecord, readoutFor, recordedIsCurrent, type LiveResults } from "./model";
import { LIVE_KEY, liveShown } from "./state";
import { forgetLive, LIVE_DEBOUNCE_MS, liveOf, liveStats, requestLive } from "./store";
import { liveWords as w } from "./words";

const records = import.meta.glob("../../golden/runs/OpenJackson.d2.feedback.p30.inf/product_form/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const recorded = JSON.parse(Object.values(records)[0]) as ResultRecord;

const JACKSON = "OpenJackson.d2.feedback.p30.inf.bnet";
const jackson = () => example(JACKSON);
/** The same network with one service rate changed. */
const withRate = (doc: BnetDocument, station: string, rate: number): BnetDocument => ({ ...doc, nodes: doc.nodes.map((n) => (n.name === station ? { ...n, distributionParameters: `rate=${rate}` } : n)) });
const withSource = (doc: BnetDocument, lambda: number): BnetDocument => ({ ...doc, nodes: doc.nodes.map((n) => (n.kind === "source" ? { ...n, distributionParameters: `lambda=${lambda}` } : n)) });
const moved = (doc: BnetDocument): BnetDocument => ({ ...doc, nodes: doc.nodes.map((n, i) => (i === 0 ? { ...n, position: [n.position[0] + 40, n.position[1] + 8] } : n)) });

class FixedResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, contentRect: { width: 1200, height: 800, x: 0, y: 0 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(async () => {
  vi.stubGlobal("ResizeObserver", FixedResizeObserver);
  document.documentElement.setAttribute("data-motion", "reduce");
  mockTauri(defaultHandlers());
  mockRuns.replayMs = 1;
  resetKv();
  resetRuns();
  resetSelectedRuns();
  resetStructures();
  forgetLive();
  await loadKv();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-motion");
});

// ── The model ────────────────────────────────────────────────────────────────────────────────

describe("a live answer as the overlay reads it", () => {
  it("is marked live and exact for a Jackson network, with every metric", () => {
    const r = standInLive(jackson());
    expect(r.tier).toBe("exact");
    const model = liveOverlayModel(r, "T", "Mean number in system", 6)!;
    expect(isLiveModel(model)).toBe(true);
    expect(model.live).toMatchObject({ tier: "exact", chip: "Live · exact", unstable: false });
    expect(model.run.method.identifier).toBe(LIVE_METHOD);
    expect(model.method).toBe("Live");
    // The caption is the quantity alone: the chip, not a method name, says where it is from.
    expect(model.caption).toBe("Mean number in system");
    expect(model.stale).toBe(false);
    expect(model.available).toEqual(["Utilization", "Mean number in system", "Mean sojourn time", "Mean queue length", "Throughput"]);
    // L = 7/3 at both stations (golden/runs/…/product_form: 2.33333333), with its unit.
    const s1 = [...model.items.values()].find((i) => i.stationName === "S1")!;
    expect(s1.text).toBe("2.333 customers");
    expect(s1.lines.join("\n")).toContain("Live · Exact");
  });

  it("agrees with the recorded product-form run of the same example to the digits the record prints", () => {
    // The stand-in is not the app's arithmetic, but it must not drift from it on the example the
    // preview shows: each recorded value against the live record's.
    const live = liveRecord(standInLive(jackson()), "T");
    const name: Record<string, string> = { "Server utilization": "Utilization", "Mean number in system": "Mean number in system", Throughput: "Throughput" };
    let compared = 0;
    for (const m of recorded.measurements) {
      if (!name[m.metric]) continue;
      const ours = live.measurements.find((x) => x.metric === name[m.metric] && x.stationID!.toUpperCase() === m.stationID!.toUpperCase())!;
      expect(Math.abs(ours.estimate - m.estimate)).toBeLessThan(1e-8);
      compared++;
    }
    expect(compared).toBe(6);
  });

  it("shows utilisation only, and says why, where there is no closed form", () => {
    const d = jackson();
    const det: BnetDocument = { ...d, nodes: d.nodes.map((n) => (n.name === "S2" ? { ...n, distribution: "constant", distributionParameters: "value=0.5" } : n)) };
    const r = standInLive(det);
    expect([r.tier, r.reasonIfPartial, r.utilisationExact]).toEqual(["utilisation", "notExponential", true]);
    // Asked for queue lengths: utilisation is shown instead, never a blank canvas or a made-up number.
    const model = liveOverlayModel(r, "T", "Mean number in system", 6)!;
    expect(model.metric).toBe("Utilization");
    expect(model.available).toEqual(["Utilization"]);
    expect(model.live.chip).toBe("Live · utilisation only");
    expect(model.live.help).toContain("S2 is not exponential");
    expect(model.live.help).toContain("Press Solve for queue lengths");
    expect(model.run.measurements.every((m) => m.metric === "Utilization")).toBe(true);
  });

  it("calls ρ the offered load, and an approximation, when buffers are finite", () => {
    const r = standInLive({ ...jackson(), infiniteBuffers: false });
    expect([r.tier, r.reasonIfPartial, r.utilisationExact]).toEqual(["utilisation", "finiteBuffers", false]);
    expect(chipFor(r)).toBe("Live · offered load only");
    const model = liveOverlayModel(r, "T", "Utilization", 6)!;
    expect(model.tier).toBe("approximation");
    expect(model.live.help).toContain("offered load");
  });

  it("shows no queue length for an unstable network: ρ and 'no steady state'", () => {
    const d = withSource(jackson(), 2);
    const r = standInLive(d);
    expect([r.tier, r.reasonIfPartial]).toEqual(["utilisation", "unstable"]);
    expect(r.perStation.every((s) => s.meanInSystem === null && s.meanSojourn === null && s.meanWaiting === null)).toBe(true);
    expect(r.network).toBeNull();
    const model = liveOverlayModel(r, "T", "Mean number in system", 6)!;
    expect(model.live).toMatchObject({ chip: "Live · no steady state", unstable: true });
    expect(model.live.help).toContain("no steady state exists");
    expect(model.run.measurements.map((m) => m.metric).every((m) => m === "Utilization")).toBe(true);
    const s1 = byName(d, "S1");
    const read = readoutFor(r, s1.id, 6)!;
    expect(read.parts.map((p) => p.key)).toEqual(["rho"]);
    expect(read.note).toBeNull();
    expect(read.tier).toBe("Live · no steady state");
    expect(read.spoken).toContain("no steady state");
  });

  it("does not call a finite-buffer network unstable, whatever its offered load: ρ = 140 % is 'offered load only'", () => {
    // M/M/1/K with λ > μ always has a steady state (blocking or loss absorbs the excess); so has
    // any finite network. Rust's answer for one (core/src/jackson.rs
    // `a_finite_network_offered_more_than_it_can_serve_is_not_called_unstable`), then the stand-in's.
    const s = { stationId: "S", stationName: "S1", servers: 1, throughput: 1.2, serviceRate: 1, utilisation: 1.2, meanInSystem: null, meanWaiting: null, meanSojourn: null, meanWait: null };
    const rust: LiveResults = { tier: "utilisation", perStation: [s], network: null, reasonIfPartial: "finiteBuffers", reasonDetail: "", utilisationExact: false, bottlenecks: ["S"] };
    const d: BnetDocument = { ...withSource(jackson(), 2), infiniteBuffers: false };
    const standIn = standInLive(d);
    expect([standIn.tier, standIn.reasonIfPartial, standIn.reasonDetail, standIn.utilisationExact]).toEqual(["utilisation", "finiteBuffers", "", false]);
    expect(standIn.perStation.find((x) => x.stationName === "S1")!.utilisation).toBeCloseTo(1.4, 9);
    for (const [r, id] of [[rust, "S"], [standIn, byName(d, "S1").id]] as const) {
      expect(chipFor(r)).toBe("Live · offered load only");
      const model = liveOverlayModel(r, "T", "Utilization", 6)!;
      expect(model.live).toMatchObject({ chip: "Live · offered load only", unstable: false, tier: "utilisation" });
      expect(model.tier).toBe("approximation");
      expect(model.live.help).not.toContain("no steady state");
      expect(model.live.help).toContain("With finite buffers there is a steady state even at ρ ≥ 1: blocking or loss absorbs the excess.");
      const read = readoutFor(r, id, 6)!;
      expect(read.tier).toBe("Live · offered load only");
      expect(read.note).toBe(w.pressSolve);
      expect(read.parts[0].help).toBe(w.readout.rhoOfferedHelp);
      expect(read.spoken).not.toContain("no steady state");
    }
    // With infinite buffers the same load has no steady state.
    expect(standInLive(withSource(jackson(), 2)).reasonIfPartial).toBe("unstable");
  });

  it("marks stations that tie for the highest utilisation as equally loaded, and crowns none", () => {
    // ρ₁ = ρ₂ = 0.7 in the shipped example: both carry the marker, neither is "the bottleneck".
    const r = standInLive(jackson());
    const [s1, s2] = [byName(jackson(), "S1"), byName(jackson(), "S2")];
    expect(r.bottlenecks).toEqual([s1.id, s2.id]);
    const model = liveOverlayModel(r, "T", "Mean number in system", 6)!;
    const items = [...model.items.values()];
    expect(items.map((i) => [i.stationName, i.bottleneck, i.tied])).toEqual([["S1", true, true], ["S2", true, true]]);
    expect(items[0].label).toContain("Equally loaded");
    expect(items[0].label).not.toContain("Bottleneck");
    expect(items[0].lines).toContain("Equally loaded: the highest utilisation, shared with S2. No single bottleneck.");
    expect(items[1].lines).toContain("Equally loaded: the highest utilisation, shared with S1. No single bottleneck.");
    // One station ahead by more than the tolerance is the bottleneck again, alone.
    const lone = standInLive(withRate(jackson(), "S1", 5));
    expect(lone.bottlenecks).toEqual([s2.id]);
    const after = [...liveOverlayModel(lone, "T", "Utilization", 6)!.items.values()];
    expect(after.map((i) => [i.stationName, i.bottleneck, i.tied])).toEqual([["S1", false, false], ["S2", true, false]]);
    expect(after[1].label).toContain("Bottleneck");
  });

  it("has nothing to show when the traffic equations have no solution", () => {
    const r = standInLive({ ...jackson(), nodes: jackson().nodes.filter((n) => n.kind !== "sink") });
    expect(r.tier).toBe("none");
    expect(liveOverlayModel(r, "T", "Utilization", 6)).toBeNull();
    expect(readoutFor(r, "x", 6)).toBeNull();
    expect(w.reason(r.reasonIfPartial, r.reasonDetail)).toBe("The network has no sink node.");
  });

  it("reads out ρ, L and W for a station, each with its unit, and the tier", () => {
    const d = jackson();
    const read = readoutFor(standInLive(d), byName(d, "S1").id, 6)!;
    // ρ = 0.7, L = 7/3, W = L/α = (7/3)·0.7 = 49/30.
    expect(read.parts.map((p) => `${p.label} ${p.number} ${p.unit}`)).toEqual(["ρ 70.0 %", "L 2.333 customers", "W 1.633 time units"]);
    expect(read.tier).toBe("Live · exact");
    expect(read.note).toBeNull();
    expect(read.help).toContain("N = 4.667 customers");
  });
});

// ── Precedence ───────────────────────────────────────────────────────────────────────────────

describe("a recorded run against live values", () => {
  const snapshot = recorded.provenance.networkSnapshot as BnetDocument;
  const recordedModel = (fingerprint: string | null) => overlayModel({ records: [recorded], fingerprint, metric: "Utilization", decimals: 6 })!;
  const liveModel = (doc: BnetDocument) => liveOverlayModel(standInLive(doc), "T", "Utilization", 6);

  it("wins while it is a run of the network as it is now", () => {
    const model = recordedModel(recorded.provenance.networkFingerprint);
    expect(recordedIsCurrent(model, structureKey(snapshot))).toBe(true);
    const shown = chooseModel(model, liveModel(jackson()), structureKey(snapshot));
    expect(shown).toBe(model);
    expect(isLiveModel(shown)).toBe(false);
    expect(shown!.caption).toBe("Utilization · Product Form · Exact");
  });

  it("still wins after a move alone: layout is not structure", () => {
    const model = recordedModel(recorded.provenance.networkFingerprint);
    expect(chooseModel(model, liveModel(jackson()), structureKey(moved(snapshot)))).toBe(model);
  });

  it("gives way to live values once the network has changed, without waiting for a fingerprint", () => {
    // The fingerprint has not been asked again yet, so the overlay's own model does not read as stale.
    const model = recordedModel(recorded.provenance.networkFingerprint);
    expect(model.stale).toBe(false);
    const changed = withRate(snapshot, "S1", 3);
    const live = liveModel(changed);
    const shown = chooseModel(model, live, structureKey(changed));
    expect(shown).toBe(live);
    expect(isLiveModel(shown)).toBe(true);
  });

  it("is kept, stale, when there is no live answer to put in its place", () => {
    const model = recordedModel("another-fingerprint");
    expect(model.stale).toBe(true);
    expect(chooseModel(model, null, structureKey(withRate(snapshot, "S1", 3)))).toBe(model);
  });

  it("is kept when the person picked it in the Results pane, changed network or not", () => {
    const model = overlayModel({ records: [recorded], fingerprint: "another-fingerprint", metric: "Utilization", selectedRunId: recorded.id, decimals: 6 })!;
    expect(model.pinned).toBe(true);
    const changed = withRate(snapshot, "S1", 3);
    expect(chooseModel(model, liveModel(changed), structureKey(changed))).toBe(model);
  });

  it("shows live values when the tab has no run at all", () => {
    const live = liveModel(jackson());
    expect(chooseModel(null, live, structureKey(jackson()))).toBe(live);
  });
});

// ── When it is computed ──────────────────────────────────────────────────────────────────────

describe("when live results are asked for", () => {
  const flush = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it("asks once for a burst of edits, with the newest network, after the debounce", async () => {
    vi.useFakeTimers();
    const seen: BnetDocument[] = [];
    mockLive.run = (doc) => (seen.push(doc), standInLive(doc));
    const base = jackson();
    // Five keystrokes 20 ms apart.
    for (let i = 1; i <= 5; i++) {
      requestLive("T", withRate(base, "S1", 2 + i / 10));
      await flush(20);
    }
    expect(mockLive.calls).toBe(0);
    await flush(LIVE_DEBOUNCE_MS);
    expect(mockLive.calls).toBe(1);
    expect(byName(seen[0], "S1").distributionParameters).toBe("rate=2.5");
    expect(liveOf("T").results!.perStation[0].utilisation).toBeCloseTo(1 / 0.7 / 2.5, 10);
  });

  it("keeps the canvas moving while a number is scrubbed: one request per debounce, not one at the end", async () => {
    vi.useFakeTimers();
    const base = jackson();
    // A scrub of 600 ms, a new value every 16 ms.
    for (let t = 0; t < 600; t += 16) {
      requestLive("T", withRate(base, "S1", 2.1 + t / 1000));
      await flush(16);
    }
    await flush(LIVE_DEBOUNCE_MS);
    expect(mockLive.calls).toBeGreaterThanOrEqual(4);
    expect(mockLive.calls).toBeLessThanOrEqual(7);
  });

  it("asks nothing when a node is moved, the canvas is zoomed or the same network is asked again", async () => {
    vi.useFakeTimers();
    const base = jackson();
    requestLive("T", base);
    await flush(LIVE_DEBOUNCE_MS + 10);
    expect(mockLive.calls).toBe(1);
    requestLive("T", moved(base));
    requestLive("T", { ...base, canvasScale: 2, canvasPanOffset: [30, 40] });
    requestLive("T", { ...base, nodes: base.nodes.map((n) => ({ ...n, picture: "gear" })) });
    requestLive("T", base);
    await flush(LIVE_DEBOUNCE_MS * 3);
    expect(mockLive.calls).toBe(1);
  });

  it("drops an answer a newer request has overtaken", async () => {
    vi.useFakeTimers();
    const base = jackson();
    const waiting: (() => void)[] = [];
    mockLive.run = (doc) => new Promise<LiveResults>((resolve) => waiting.push(() => resolve(standInLive(doc))));
    requestLive("T", withRate(base, "S1", 2.5));
    await flush(LIVE_DEBOUNCE_MS + 1);
    expect(waiting).toHaveLength(1);
    // A newer edit while the first is in flight.
    requestLive("T", withRate(base, "S1", 4));
    await flush(LIVE_DEBOUNCE_MS + 1);
    expect(waiting).toHaveLength(2);
    // The answers come back out of order: the old one last.
    waiting[1]();
    await flush(1);
    expect(liveOf("T").results!.perStation[0].utilisation).toBeCloseTo(1 / 0.7 / 4, 10);
    waiting[0]();
    await flush(1);
    expect(liveOf("T").results!.perStation[0].utilisation).toBeCloseTo(1 / 0.7 / 4, 10);
    expect(liveStats.dropped).toBe(1);
  });

  it("cancels what was waiting when the network goes back to the one already answered", async () => {
    vi.useFakeTimers();
    const base = jackson();
    requestLive("T", base);
    await flush(LIVE_DEBOUNCE_MS + 10);
    requestLive("T", withRate(base, "S1", 9));
    requestLive("T", base); // Undo, inside the debounce.
    await flush(LIVE_DEBOUNCE_MS * 2);
    expect(mockLive.calls).toBe(1);
    expect(liveOf("T").key).toBe(structureKey(base));
  });

  it("shows nothing for an empty canvas or after a failed request, and asks nothing for the empty one", async () => {
    vi.useFakeTimers();
    requestLive("T", jackson());
    await flush(LIVE_DEBOUNCE_MS + 10);
    expect(liveOf("T").results).not.toBeNull();
    requestLive("T", { ...jackson(), nodes: [], links: [] });
    expect(liveOf("T").results).toBeNull();
    await flush(LIVE_DEBOUNCE_MS + 10);
    expect(mockLive.calls).toBe(1);
    mockLive.run = () => {
      throw { kind: "invalid", message: "no" };
    };
    requestLive("T", jackson());
    await flush(LIVE_DEBOUNCE_MS + 10);
    expect(mockLive.calls).toBe(2);
    expect(liveOf("T").results).toBeNull();
  });

  it("makes the structure key of a 500-node network in a few milliseconds, once", () => {
    const nodes: BnetDocument["nodes"] = [];
    const links: BnetDocument["links"] = [];
    for (let i = 0; i < 500; i++) nodes.push({ id: `N${i}`, kind: i % 2 ? "station" : "buffer", name: `${i % 2 ? "S" : "B"}${i >> 1}`, position: [i * 10, 0], bufferSize: 10, distribution: "exponential", distributionParameters: "rate=1.0", numberOfServers: 1, serviceDistributions: {}, picture: "" });
    for (let i = 0; i < 999; i++) links.push({ id: `L${i}`, fromNodeID: `N${i % 500}`, toNodeID: `N${(i + 1) % 500}`, routingProbability: 0.5, customerClass: 0 });
    const doc: BnetDocument = { nodes, links, infiniteBuffers: true, canvasScale: 1, canvasPanOffset: [0, 0] };
    let best = Infinity;
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      structureKey(doc);
      best = Math.min(best, performance.now() - t0);
    }
    console.log(`structureKey, 500 nodes / 999 links: ${best.toFixed(2)} ms`);
    // Generous for a busy machine; it is paid once per structural edit, never per frame.
    expect(best).toBeLessThan(60);
    // The other cost of an answer on the interface's side: turning 250 stations' values into the overlay's model.
    const answer: LiveResults = {
      tier: "exact", network: { throughput: 1, meanNumber: 250, meanDelay: 250 }, reasonIfPartial: null, reasonDetail: "", utilisationExact: true, bottlenecks: ["N1"],
      perStation: nodes.filter((n) => n.kind === "station").map((n, i) => ({ stationId: n.id, stationName: n.name, servers: 1, throughput: 1, serviceRate: 2, utilisation: 0.3 + (i % 60) / 100, meanInSystem: 1 + i / 100, meanWaiting: 0.5, meanSojourn: 1, meanWait: 0.5 })),
    };
    let build = Infinity;
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      const model = liveOverlayModel(answer, "T", "Mean number in system", 6)!;
      build = Math.min(build, performance.now() - t0);
      expect(model.items.size).toBe(250);
    }
    console.log(`live overlay model, 250 stations: ${build.toFixed(2)} ms`);
    expect(build).toBeLessThan(120);
  });
});

// ── On the canvas ────────────────────────────────────────────────────────────────────────────

const WAIT = { timeout: 8000 };
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });

async function mount(doc: BnetDocument = jackson()) {
  let id = "";
  act(() => {
    id = addTab({ title: JACKSON, path: `/examples/${JACKSON}`, document: doc });
  });
  const editor = editorFor(id);
  render(
    <>
      <CanvasView editor={editor} />
      <CanvasStatusBar editor={editor} />
    </>,
  );
  await settle();
  return { id, editor };
}

async function run(id: string, method: string) {
  const done = new Promise<void>((resolve) => {
    const stop = onRunFinished(() => {
      stop();
      resolve();
    });
  });
  await act(async () => {
    expect(await startRun(id, method)).toBe(true);
    await done;
  });
  await settle();
  await settle();
}

const legend = () => document.querySelector(".canvas-results-legend");
const chip = () => document.querySelector(".live-chip");
const badgeText = (id: string) => [...document.querySelectorAll(`[data-result="${id}"] text`)].map((t) => t.textContent).join(" ");

describe("live results on the canvas", () => {
  it("are on by default, in the View menu, and can be turned off", async () => {
    expect(JSON.stringify(MENU_SPEC)).toContain(`"id":"${LIVE_COMMAND}","label":"Live Results"`);
    expect(liveShown()).toBe(true);
    const { editor } = await mount();
    await waitFor(() => expect(chip()).not.toBeNull(), WAIT);
    expect(getCommand(LIVE_COMMAND)!.checked!()).toBe(true);
    await act(async () => void (await runCommand(LIVE_COMMAND)));
    expect(getStateValue(LIVE_KEY, true)).toBe(false);
    await waitFor(() => expect(legend()).toBeNull(), WAIT);
    expect(document.querySelector("[data-result]")).toBeNull();
    // Off: an edit asks nothing.
    const calls = mockLive.calls;
    const s1 = editor.nodes.find((n) => n.name === "S1")!;
    act(() => editor.updateNodeDistribution(s1.id, "exponential", "rate=5.0"));
    await act(async () => void (await new Promise((r) => setTimeout(r, LIVE_DEBOUNCE_MS + 80))));
    expect(mockLive.calls).toBe(calls);
  });

  it("shows values before any run, marked 'Live · exact', and follows an edit", async () => {
    const { editor } = await mount();
    const s1 = editor.nodes.find((n) => n.name === "S1")!;
    await waitFor(() => expect(badgeText(s1.id)).toBe("70.0 %"), WAIT);
    expect(legend()).toHaveAttribute("data-live", "exact");
    expect(chip()).toHaveTextContent("Live · exact");
    expect(chip()).toHaveAccessibleName("Live · exact. Computed from the network as drawn, not from a run.");
    expect(legend()!.querySelector(".canvas-results-caption")).toHaveTextContent(/^Utilization$/);
    expect(document.querySelector('[data-layer="results"]')).toHaveAccessibleName("Results on canvas: Utilization, Live, Exact");
    // Change a rate: the bottleneck moves. S1 at μ = 5 has ρ = (1/0.7)/5 = 28.6 %; S2 stays at 70 %.
    const s2 = editor.nodes.find((n) => n.name === "S2")!;
    // Before the change both sit at 70 %: both are marked, as equally loaded.
    for (const s of [s1, s2]) {
      expect(document.querySelector(`[data-result="${s.id}"]`)).toHaveAttribute("data-bottleneck", "tied");
      expect(document.querySelector(`[data-result="${s.id}"]`)!.getAttribute("aria-label")).toContain("Equally loaded");
    }
    act(() => editor.updateNodeDistribution(s1.id, "exponential", "rate=5.0"));
    await waitFor(() => expect(badgeText(s1.id)).toBe("28.6 %"), WAIT);
    expect(document.querySelector(`[data-result="${s2.id}"]`)).toHaveAttribute("data-bottleneck", "true");
    expect(document.querySelector(`[data-result="${s1.id}"]`)).not.toHaveAttribute("data-bottleneck");
  });

  it("shows a finite-buffer network offered more than it can serve as 'offered load only', never 'no steady state'", async () => {
    const { editor } = await mount({ ...withSource(jackson(), 2), infiniteBuffers: false });
    const s1 = editor.nodes.find((n) => n.name === "S1")!;
    await waitFor(() => expect(chip()).toHaveTextContent("Live · offered load only"), WAIT);
    expect(chip()).toHaveAttribute("data-live-tier", "utilisation");
    expect(chip()).toHaveAttribute("title", expect.stringContaining("blocking or loss absorbs the excess"));
    expect(chip()!.getAttribute("title")).not.toContain("no steady state");
    expect(badgeText(s1.id)).toBe("140.0 %");
    act(() => editor.setView({ selectedNodeID: s1.id, selectedNodeIDs: new Set([s1.id]) }));
    const read = await screen.findByRole("group", { name: "Live results for S1" }, WAIT);
    expect(read).toHaveTextContent("Press Solve for queue lengths");
    expect(read).not.toHaveTextContent("no steady state");
  });

  it("does not ask again when a node is moved", async () => {
    const { editor } = await mount();
    await waitFor(() => expect(chip()).not.toBeNull(), WAIT);
    const calls = mockLive.calls;
    const s1 = editor.nodes.find((n) => n.name === "S1")!;
    act(() => editor.moveNode(s1.id, { x: s1.position[0] + 60, y: s1.position[1] + 20 }));
    await act(async () => void (await new Promise((r) => setTimeout(r, LIVE_DEBOUNCE_MS + 80))));
    expect(mockLive.calls).toBe(calls);
    expect(chip()).toHaveTextContent("Live · exact");
  });

  it("steps aside for a recorded run, and comes back when the network changes", async () => {
    const { id, editor } = await mount();
    await waitFor(() => expect(chip()).not.toBeNull(), WAIT);
    await run(id, "product_form");
    // The run's legend: its method and tier in words, and no live chip.
    await waitFor(() => expect(legend()!.querySelector(".canvas-results-caption")).toHaveTextContent("Utilization · Product Form · Exact"), WAIT);
    expect(chip()).toBeNull();
    expect(legend()).not.toHaveAttribute("data-live");
    // An edit: the run is of another network now, so live values stand in, marked as such.
    const s1 = editor.nodes.find((n) => n.name === "S1")!;
    act(() => editor.updateNodeDistribution(s1.id, "exponential", "rate=5.0"));
    await waitFor(() => expect(chip()).toHaveTextContent("Live · exact"), WAIT);
    await waitFor(() => expect(badgeText(s1.id)).toBe("28.6 %"), WAIT);
    expect(document.querySelector('[data-layer="results"]')).not.toHaveAttribute("data-stale");
    // Undo: the recorded run is current again and takes the canvas back.
    act(() => editor.undo());
    await waitFor(() => expect(chip()).toBeNull(), WAIT);
    expect(legend()!.querySelector(".canvas-results-caption")).toHaveTextContent("Utilization · Product Form · Exact");
  });

  it("shows ρ only and 'no steady state' for an unstable network, beside the Problems count", async () => {
    const { editor } = await mount(withSource(jackson(), 2));
    const s1 = editor.nodes.find((n) => n.name === "S1")!;
    await waitFor(() => expect(chip()).toHaveTextContent("Live · no steady state"), WAIT);
    expect(legend()).toHaveAttribute("data-live", "utilisation");
    expect(chip()).toHaveAttribute("data-live-tier", "unstable");
    expect(chip()).toHaveAttribute("title", expect.stringContaining("no steady state exists"));
    // ρ = 2·(1/0.7)/2.0408… = 140 %: the offered load, shown; nothing else is.
    expect(badgeText(s1.id)).toBe("140.0 %");
    act(() => editor.setView({ selectedNodeID: s1.id, selectedNodeIDs: new Set([s1.id]) }));
    const read = await screen.findByRole("group", { name: "Live results for S1" }, WAIT);
    expect(read).toHaveTextContent("ρ140.0%");
    expect(read).toHaveTextContent("no steady state");
    expect(read).not.toHaveTextContent("customers");
    // The Problems count is still in the bar.
    await waitFor(() => expect(document.querySelector(".canvas-sb-problems")).not.toBeNull(), WAIT);
  });

  it("reads out ρ, L and W with units for the selected station in the status bar", async () => {
    const { editor } = await mount();
    await waitFor(() => expect(chip()).not.toBeNull(), WAIT);
    expect(screen.queryByRole("group", { name: /Live results for/ })).toBeNull();
    const s1 = editor.nodes.find((n) => n.name === "S1")!;
    act(() => editor.setView({ selectedNodeID: s1.id, selectedNodeIDs: new Set([s1.id]) }));
    const read = screen.getByRole("group", { name: "Live results for S1" });
    expect(read).toHaveAttribute("data-live-readout", "exact");
    expect(read.querySelector(".sr-only")).toHaveTextContent("S1: ρ 70.0 %, L 2.333 customers, W 1.633 time units. Live · exact.");
    expect(read).toHaveTextContent("Live · exact");
    // A source has no read-out; nor do two stations at once.
    const src = editor.nodes.find((n) => n.kind === "source")!;
    act(() => editor.setView({ selectedNodeID: src.id, selectedNodeIDs: new Set([src.id]) }));
    expect(screen.queryByRole("group", { name: /Live results for/ })).toBeNull();
  });
});
