// Results ▸ Uncertainty (src/uncertainty; ledger SCI-801…): which rates can be uncertain, how the
// fields are read into what Rust is asked, the answer in plain words, and the view on its three
// routes — a Jackson network (sampled; answered here by a canned answer or by the preview's
// stand-in: the app's own arithmetic is checked in Rust, core/src/uncertainty.rs), a network with
// no closed formula (the linear approximation from numerical derivatives over quiet runs,
// Experimental) and a closed network (refused in a sentence).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockQuiet } from "../dev/mock/sweeps2";
import { mockUncertainty, standInLinear, standInUncertainty } from "../dev/mock/uncertainty";
import { defaultHandlers } from "../dev/mockBackend";
import { editorFor } from "../editor";
import { api } from "../lib/api";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, unavailableReason } from "../lib/commands";
import { loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC } from "../lib/menuSpec";
import { resetOverlays } from "../lib/overlays";
import { getRunState, resetRuns, stopRun } from "../runs/state";
import { measureOptions, pickMeasure } from "../sensitivity/model";
import { numericPlan, resetSensitivityRunner } from "../sensitivity/runner";
import { resetSensitivityStore, sensitivityEstimate } from "../sensitivity/store";
import { resetSweepCommands } from "../sweeps/commands";
import { resetSweepRunner } from "../sweeps/runner";
import { mockTauri } from "../test/tauri";
import { addTab, resetWorkspace, tabById } from "../workspace/store";
import { startUncertaintyCommands, UNCERTAINTY_COMMAND } from "./commands";
import { DEFAULT_SETTINGS, linearIsOff, percentOf, planKey, planOf, rankedShares, recommendation, requestFor, shareLabel, spreadOf, uncertainParameters, type UncertaintyAnalysis, type UncertaintySettings } from "./model";
import { resetUncertaintyStore, setUncertaintyOverride, setUncertaintySettings, takeUncertaintyViewRequest, uncertaintySettings } from "./store";
import { UncertaintyView } from "./UncertaintyView";
import { count, uncertaintyWords as w } from "./words";

const examples = import.meta.glob("../../examples/**/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const example = (stem: string) => ({ canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(examples[`../../examples/${stem}.bnet`]) }) as BnetDocument;
const openExample = (stem: string, patch: Partial<BnetDocument> = {}) => tabById(addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: { ...example(stem), ...patch } }))!;

/** γ = 1; S1 → S2 with 0.7, back to S1 with 0.3; ρ₁ = ρ₂ = 0.7, L = 14/3, W = 14/3. */
const FEEDBACK = "OpenJackson.d2.feedback.p30.inf";
/** Two classes sharing stations: no closed formula; two sources. */
const MULTI = "3d2ctandem.inf";
const WAIT = { timeout: 8000 };

const settingsWith = (patch: Partial<UncertaintySettings>): UncertaintySettings => ({ ...DEFAULT_SETTINGS, ...patch });

/** An answer in the shape Rust gives, for the three rates of FEEDBACK, with numbers easy to recognise. */
function canned(patch: Partial<UncertaintyAnalysis> = {}, unstable = 620): UncertaintyAnalysis {
  const doc = example(FEEDBACK);
  const [arrival, s1, s2] = uncertainParameters(doc).map((p) => p.id);
  const input = (id: string, mean: number, derivative: number) => ({ id, law: "lognormal" as const, mean, sd: 0.1 * mean, low: 0.82 * mean, high: 1.21 * mean, derivative });
  return {
    available: true,
    reason: null,
    sentence: null,
    value: 4.6667,
    unit: "time",
    inputs: [input(arrival, 1, 10.9), input(s1, 2.04, -3.8), input(s2, 1.43, -5.4)],
    shares: [
      { ids: [arrival], linear: 0.5, first: { value: 0.72, se: 0.012 }, total: { value: 0.78, se: 0.01 } },
      { ids: [s1], linear: 0.25, first: { value: 0.11, se: 0.013 }, total: { value: 0.15, se: 0.004 } },
      { ids: [s2], linear: 0.25, first: { value: 0.09, se: 0.013 }, total: { value: 0.13, se: 0.004 } },
    ],
    linear: { sd: 1.9, low: 0.94, high: 8.39 },
    sampling: {
      samples: 20000,
      seed: 2021,
      unstable,
      pUnstable: { value: unstable / 20000, se: 0.00122 },
      meanExists: true,
      mean: { value: 5.61, se: 0.031 },
      sd: 4.31,
      median: { value: 4.83, se: 0.021 },
      q025: { value: 2.91, se: 0.018 },
      q975: { value: 14.2, se: 0.34 },
      min: 2.1,
      max: 310,
      histogram: { low: 2.1, high: 20.2, counts: Array.from({ length: 40 }, (_x, i) => Math.round(1800 * Math.exp(-((i - 6) ** 2) / 30))), above: 400 },
      shareRows: 20000,
      evaluations: 100000,
    },
    disagreement: 0.47,
    threshold: 0.1,
    ...patch,
  };
}

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetWorkspace();
  resetRuns();
  resetOverlays();
  resetSweepRunner();
  resetSweepCommands();
  resetSensitivityStore();
  resetSensitivityRunner();
  resetUncertaintyStore();
  startUncertaintyCommands();
  mockQuiet.pointMs = 1;
});
afterEach(async () => {
  if (getRunState().active) await act(async () => void (await stopRun()));
  await new Promise((r) => setTimeout(r, 10));
  vi.restoreAllMocks();
});

describe("what can be uncertain, and how the fields are read", () => {
  it("offers every arrival rate and service rate, and nothing else", () => {
    const ps = uncertainParameters(example(FEEDBACK));
    expect(ps.map((p) => p.label.replace(/ \(.*\)$/, ""))).toEqual(["Src1 arrival rate", "S1 service rate", "S2 service rate"]);
    expect(ps.every((p) => !p.integer && (p.kind === "arrival" || p.kind === "service"))).toBe(true);
    expect(uncertainParameters(example(MULTI)).filter((p) => p.kind === "arrival")).toHaveLength(2);
  });

  it("reads ± as a standard deviation or as a range, and refuses a range that reaches zero", () => {
    expect(percentOf("10", "sd")).toBeCloseTo(0.1, 12);
    expect(percentOf("12,5 %", "range")).toBeCloseTo(0.125, 12);
    expect(percentOf("150", "sd")).toBeCloseTo(1.5, 12);
    expect(percentOf("100", "range")).toBe(w.bad.range);
    for (const bad of ["", "-1", "abc", "301"]) expect(percentOf(bad, "sd")).toBe(w.bad.percent);
    expect(spreadOf(settingsWith({ percent: "10" }), "x")).toEqual({ kind: "relativeSd", value: 0.1 });
    expect(spreadOf(settingsWith({ percent: "10", reading: "range" }), "x")).toEqual({ kind: "relativeRange", value: 0.1 });
    expect(spreadOf(settingsWith({ percent: "0" }), "x")).toBeNull();
  });

  it("lets one rate say otherwise: its own percentage, an interval, or known exactly", () => {
    const over = (o: object) => settingsWith({ overrides: { x: { how: "default", percent: "", low: "", high: "", ...o } } });
    expect(spreadOf(over({ how: "percent", percent: "3" }), "x")).toEqual({ kind: "relativeSd", value: 0.03 });
    expect(spreadOf(over({ how: "exact" }), "x")).toBeNull();
    expect(spreadOf(over({ how: "interval", low: "0.7", high: "0.95" }), "x")).toEqual({ kind: "interval95", low: 0.7, high: 0.95 });
    expect(spreadOf({ ...over({ how: "interval", low: "0.7", high: "0.95" }), reading: "range" }, "x")).toEqual({ kind: "intervalRange", low: 0.7, high: 0.95 });
    for (const [low, high] of [["0.9", "0.7"], ["0", "1"], ["", "1"], ["a", "b"]]) expect(spreadOf(over({ how: "interval", low, high }), "x")).toBe(w.bad.interval);
  });

  it("plans the request: the uncertain rates only, blocked by a bad field or by nothing uncertain", () => {
    const doc = example(FEEDBACK);
    const ps = uncertainParameters(doc);
    const measure = pickMeasure(measureOptions(doc), null)!;
    const plan = planOf(ps, settingsWith({ overrides: { [ps[1].id]: { how: "exact", percent: "", low: "", high: "" } } }));
    expect(plan.blocked).toBeNull();
    expect(plan.inputs.map((i) => i.parameter.id)).toEqual([ps[0].id, ps[2].id]);
    const request = requestFor(doc, measure, plan, true);
    expect(request.measure).toEqual({ kind: "networkSojourn", stationId: null });
    expect(request.inputs).toEqual([
      { id: ps[0].id, kind: "arrival", nodeId: ps[0].nodeId, customerClass: null, spread: { kind: "relativeSd", value: 0.1 } },
      { id: ps[2].id, kind: "service", nodeId: ps[2].nodeId, customerClass: ps[2].customerClass ?? null, spread: { kind: "relativeSd", value: 0.1 } },
    ]);
    expect(request.arrivalsTogether).toBe(true);
    expect(request.samples).toBeUndefined();
    expect(planOf(ps, settingsWith({ percent: "0" })).blocked).toBe(w.bad.nothing);
    const bad = planOf(ps, settingsWith({ percent: "100", reading: "range" }));
    expect(bad.blocked).toBe(w.bad.range);
    expect(Object.keys(bad.problems)).toHaveLength(3);
    // The key changes with the question, and only with it.
    expect(planKey(measure, plan, false)).not.toBe(planKey(measure, plan, true));
    expect(planKey(measure, plan, false)).toBe(planKey(measure, planOf(ps, settingsWith({ mode: "table", overrides: { [ps[1].id]: { how: "exact", percent: "9", low: "", high: "" } } })), false));
  });
});

describe("the answer in plain words", () => {
  const doc = example(FEEDBACK);
  const ps = uncertainParameters(doc);

  it("ranks the inputs by their sampled share and says which to measure better", () => {
    const a = canned({}, 0);
    expect(rankedShares(a.shares).map((r) => shareLabel(r, ps))).toEqual(["Src1 arrival rate", "S1 service rate", "S2 service rate"]);
    expect(recommendation(a, ps, "the average delay through the network")).toBe("Measure the Src1 arrival rate better: it explains 72 % of the uncertainty in the average delay through the network.");
    // No input stands out: nothing is recommended.
    expect(recommendation({ ...a, shares: a.shares.map((s) => ({ ...s, linear: 0.02, first: { value: 0.02, se: 0.01 } })) }, ps, "x")).toBeNull();
    // The arrival rates as one factor.
    const together = { ...a, shares: [{ ids: [ps[0].id, "arrival:other"], linear: 0.9, first: { value: 0.9, se: 0.01 }, total: null }] };
    expect(shareLabel(together.shares[0], ps)).toBe(w.arrivalsTogether);
    expect(recommendation(together, ps, "x")).toContain("Measure the arrival rates better: it explains 90 %");
  });

  it("falls back to the linear shares, and says so, once sampled cases overload", () => {
    const a = canned();
    expect(recommendation(a, ps, "the delay")).toBe("Measure the Src1 arrival rate better: close to the network as drawn it carries 50 % of the uncertainty in the delay (linear approximation).");
    expect(recommendation({ ...a, sampling: null }, ps, "the delay")).toContain("(linear approximation)");
  });

  it("flags the linear approximation beyond the stated amount, or when any case overloads", () => {
    expect(linearIsOff(canned({ disagreement: 0.04 }, 0))).toBe(false);
    expect(linearIsOff(canned({ disagreement: 0.11 }, 0))).toBe(true);
    expect(linearIsOff(canned({ disagreement: 0.04 }, 3))).toBe(true);
    expect(linearIsOff(canned({ disagreement: null }, 0))).toBe(false);
  });

  it("writes large counts with a narrow space", () => {
    expect([count(950), count(20000), count(1234567)]).toEqual(["950", "20\u202f000", "1\u202f234\u202f567"]);
  });
});

describe("the Uncertainty view", () => {
  it("is a Run-menu command that asks the Results pane for the view", async () => {
    const run = MENU_SPEC.find((m) => typeof m === "object" && "submenu" in m && m.submenu === "Run") as unknown as { items: unknown[] };
    expect(JSON.stringify(run.items)).toContain(`"${UNCERTAINTY_COMMAND}"`);
    expect(unavailableReason(getCommand(UNCERTAINTY_COMMAND)!)).toBe(w.noNetwork);
    openExample(FEEDBACK);
    expect(unavailableReason(getCommand(UNCERTAINTY_COMMAND)!)).toBeNull();
    await act(async () => void (await getCommand(UNCERTAINTY_COMMAND)!.run()));
    expect(takeUncertaintyViewRequest()).toBe(true);
  });

  it("shows a Jackson network sampled: tier, the chance of overload, the reading, the interval on the chart, the shares", async () => {
    const tab = openExample(FEEDBACK);
    mockUncertainty.run = () => canned();
    const { container } = render(<UncertaintyView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-uncertainty='sampled']")).not.toBeNull(), WAIT);
    // What was asked: every rate ±10 % as a standard deviation, independent, the delay.
    expect(mockUncertainty.calls).toHaveLength(1);
    expect(mockUncertainty.calls[0].inputs.map((i) => i.spread)).toEqual(Array(3).fill({ kind: "relativeSd", value: 0.1 }));
    expect(mockUncertainty.calls[0].arrivalsTogether).toBe(false);
    expect(container.querySelector("[data-uncertainty-independence]")).toHaveTextContent(w.independent);
    // The tier, with the value and its unit.
    const tier = container.querySelector("[data-uncertainty-tier]")!;
    expect(tier).toHaveAttribute("data-uncertainty-tier", "exact");
    expect(tier).toHaveTextContent("Exact solutions of 20 000 sampled cases (Jackson network)");
    expect(tier).toHaveTextContent("Mean delay through the network as drawn: 4.667 time units");
    expect(tier.getAttribute("title")).toContain("100\u202f000 exact solutions");
    // The chance of overload, prominently, and that what follows is conditional on stability.
    const overload = container.querySelector("[data-uncertainty-overload]")!;
    expect(overload).toHaveAttribute("data-tone", "warning");
    expect(overload).toHaveTextContent("In 3.1 % of plausible cases the network is overloaded (± 0.122 %).");
    expect(overload).toHaveTextContent(w.conditional);
    expect(container.querySelector("[data-uncertainty-reading]")).toHaveTextContent("With these uncertainties the average delay through the network is between 2.91 and 14.2 time units in 95 % of the cases (median 4.83); as drawn it is 4.67.");
    // The linear approximation is flagged, by the stated amount.
    const note = container.querySelector("[data-uncertainty-linear]")!;
    expect(note).toHaveAttribute("data-uncertainty-linear", "off");
    expect(note).toHaveTextContent("off here by 47 % (more than 10 %)");
    expect(note).toHaveTextContent("Read the median and the interval.");
    // The histogram: its bins, the band, the median, the value as drawn and the linear bracket.
    const hist = container.querySelector("svg[data-chart='histogram']")!;
    expect(hist.querySelectorAll("[data-bin]")).toHaveLength(40);
    for (const mark of ["[data-band]", "[data-median]", "[data-nominal]", "[data-linear]"]) expect(hist.querySelector(mark)).not.toBeNull();
    expect(hist.getAttribute("aria-label")).toContain("19\u202f380 sampled cases with a steady state");
    expect(container).toHaveTextContent("The top 2.06 % of cases, above 20.2, are left off");
    // The shares: two series per input, sampled with a whisker and linear, the largest first.
    const bars = container.querySelector("svg[data-chart='bar']")!;
    expect([...bars.querySelectorAll("[data-row-label]")].map((e) => e.textContent)).toEqual(["Src1 arrival rate", "S1 service rate", "S2 service rate"]);
    expect(bars.querySelectorAll("[data-bar]")).toHaveLength(6);
    expect(bars.querySelectorAll("[data-whisker]")).toHaveLength(3);
    expect(container.querySelector("[data-uncertainty-recommendation]")).toHaveTextContent("Measure the Src1 arrival rate better");
    // How each rate was read.
    expect(container.querySelector("[data-uncertainty-inputs]")).toHaveTextContent("lognormal, mean 1, s.d. 0.1; 95 %: 0.82 to 1.21");
  });

  it("gives every number with its standard error in the table, the linear approximation alongside", async () => {
    const tab = openExample(FEEDBACK);
    mockUncertainty.run = () => canned({}, 0);
    setUncertaintySettings(tab.id, { mode: "table" });
    const { container } = render(<UncertaintyView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-uncertainty-table]")).not.toBeNull(), WAIT);
    const rows = [...container.querySelectorAll("[data-uncertainty-table] tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(rows).toEqual([
      [w.rows.nominal, "4.667", "4.667"],
      [w.rows.mean, "5.610 ± 0.031", "4.667"],
      [w.rows.sd, "4.310", "1.900"],
      [w.rows.median, "4.830 ± 0.021", "4.667"],
      [w.rows.q025, "2.910 ± 0.018", "0.940"],
      [w.rows.q975, "14.200 ± 0.34", "8.390"],
      [w.rows.overload, "0 % ± 0.122 %", w.notSeen],
    ]);
    expect(container.querySelector("[data-uncertainty-table] thead")).toHaveTextContent("Sampled (± standard error) time units");
    const shares = [...container.querySelectorAll("[data-uncertainty-shares] tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(shares[0]).toEqual(["Src1 arrival rate", "72 % ± 1.2 %", "78 % ± 1 %", "50 %", "10.9"]);
    expect(container).toHaveTextContent("Shares from 20 000 rows of a pick-freeze design");
    // No case overloads: said quietly, and the recommendation is the sampled share's.
    expect(container.querySelector("[data-uncertainty-overload]")).toHaveAttribute("data-tone", "quiet");
    expect(container.querySelector("[data-uncertainty-overload]")).toHaveTextContent(w.noOverload("20 000"));
    expect(container.querySelector("[data-uncertainty-recommendation]")).toHaveTextContent("it explains 72 % of the uncertainty");
    expect(container.querySelector("svg[data-chart]")).toBeNull();
  });

  it("prints no mean, standard deviation or sampled share where the model allows overload", async () => {
    const tab = openExample(FEEDBACK);
    const base = canned({ disagreement: 0.04 }, 0);
    // What Rust answers when `meanExists` is false, although no sampled case overloaded.
    mockUncertainty.run = () => ({ ...base, shares: base.shares.map((r) => ({ ...r, first: null, total: null })), sampling: { ...base.sampling!, meanExists: false, mean: null, sd: null, shareRows: 0, evaluations: 20000 } });
    setUncertaintySettings(tab.id, { mode: "table" });
    const { container } = render(<UncertaintyView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-uncertainty-table]")).not.toBeNull(), WAIT);
    const rows = [...container.querySelectorAll("[data-uncertainty-table] tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
    // The median, the interval and the chance of overload lead; the mean and the s.d. are words, not numbers.
    expect(rows).toEqual([
      [w.rows.nominal, "4.667", "4.667"],
      [w.rows.median, "4.830 ± 0.021", "4.667"],
      [w.rows.q025, "2.910 ± 0.018", "0.940"],
      [w.rows.q975, "14.200 ± 0.34", "8.390"],
      [w.rows.overload, "0 % ± 0.122 %", w.notSeen],
      [w.rows.mean, "no finite mean (the model allows overload)", "4.667"],
      [w.rows.sd, w.noFiniteSd, "1.900"],
    ]);
    // The note is shown although the two routes agree and no case overloaded.
    const note = container.querySelector("[data-uncertainty-no-mean]")!;
    expect(note).toHaveTextContent(w.noFiniteMeanNote);
    expect(note).toHaveTextContent(w.intervalAgrees("10 %"));
    expect(container.querySelector("[data-uncertainty-reading]")).toHaveTextContent("median 4.83");
    // Shares: the linear route's only, labelled as such.
    const shares = [...container.querySelectorAll("[data-uncertainty-shares] tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(shares[0]).toEqual(["Src1 arrival rate", "50 %", "10.9"]);
    expect(container.querySelector("[data-uncertainty-shares] thead")).toHaveTextContent(w.colLinearShare);
    expect(container).not.toHaveTextContent("pick-freeze");
    expect(container.querySelector("[data-uncertainty-recommendation]")).toHaveTextContent("(linear approximation)");
    expect(linearIsOff(mockUncertainty.run!({} as never) as UncertaintyAnalysis)).toBe(true);
  });

  it("asks again when an uncertainty changes, reads it as asked, and blocks on a field it cannot read", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<UncertaintyView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-uncertainty='sampled']")).not.toBeNull(), WAIT);
    expect(mockUncertainty.calls).toHaveLength(1);
    // The stand-in answered: a preview's numbers, in the app's shape.
    expect(container.querySelector("svg[data-chart='histogram']")).not.toBeNull();
    await act(async () => fireEvent.change(screen.getByLabelText(w.allRatesLabel), { target: { value: "4" } }));
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: w.readings.range })));
    await waitFor(() => expect(mockUncertainty.calls.length).toBeGreaterThanOrEqual(2), WAIT);
    await waitFor(() => expect(mockUncertainty.calls[mockUncertainty.calls.length - 1].inputs[0].spread).toEqual({ kind: "relativeRange", value: 0.04 }), WAIT);
    await waitFor(() => expect(container.querySelector("[data-uncertainty-inputs]")).toHaveTextContent("uniform; 95 %:"), WAIT);
    // One rate by an interval, one known exactly.
    const [arrival, s1] = uncertainParameters(tab.document);
    await act(async () => fireEvent.change(screen.getByLabelText(w.howLabel("Src1 arrival rate")), { target: { value: "interval" } }));
    expect(container.querySelector("[data-uncertainty-problem]")).toHaveTextContent(w.bad.interval);
    const before = mockUncertainty.calls.length;
    await act(async () => fireEvent.change(screen.getByLabelText(w.lowLabel("Src1 arrival rate")), { target: { value: "0.95" } }));
    await act(async () => fireEvent.change(screen.getByLabelText(w.highLabel("Src1 arrival rate")), { target: { value: "1.05" } }));
    await act(async () => setUncertaintyOverride(tab.id, s1.id, { how: "exact" }));
    await waitFor(() => expect(mockUncertainty.calls.length).toBeGreaterThan(before), WAIT);
    await waitFor(() => {
      const last = mockUncertainty.calls[mockUncertainty.calls.length - 1];
      expect(last.inputs.map((i) => i.id)).not.toContain(s1.id);
      expect(last.inputs.find((i) => i.id === arrival.id)!.spread).toEqual({ kind: "intervalRange", low: 0.95, high: 1.05 });
    }, WAIT);
    expect(container.querySelector("[data-uncertainty-problem]")).toBeNull();
    expect(uncertaintySettings(tab.id).overrides[s1.id].how).toBe("exact");
    // Nothing uncertain: said, and nothing asked.
    await act(async () => setUncertaintySettings(tab.id, { percent: "0", overrides: {} }));
    expect(container.querySelector("[data-uncertainty-problem]")).toHaveTextContent(w.bad.nothing);
  });

  it("passes the solver's progress on, and offers the together switch only with several arrival rates", async () => {
    const tab = openExample(FEEDBACK);
    const seen: number[] = [];
    const doc = tab.document;
    const measure = pickMeasure(measureOptions(doc), null)!;
    const a = await api.uncertaintyAnalyze(requestFor(doc, measure, planOf(uncertainParameters(doc), DEFAULT_SETTINGS), false), (p) => seen.push(p.done / p.total));
    expect(a.available).toBe(true);
    expect(seen).toEqual([1]);
    const one = render(<UncertaintyView tabId={tab.id} decimals={3} />);
    expect(screen.queryByLabelText(w.together)).toBeNull();
    one.unmount();
    const multi = openExample(MULTI);
    const { container } = render(<UncertaintyView tabId={multi.id} decimals={3} />);
    await act(async () => fireEvent.click(screen.getByLabelText(w.together)));
    expect(container.querySelector("[data-uncertainty-independence]")).toHaveTextContent(w.independentTogether);
    await waitFor(() => expect(mockUncertainty.calls[mockUncertainty.calls.length - 1].arrivalsTogether).toBe(true), WAIT);
  });

  it("says why there is nothing to show: no network, an overloaded one, a closed one", async () => {
    const blank = tabById(addTab({ title: "Untitled", path: null, document: { ...example(FEEDBACK), nodes: [], links: [] } }))!;
    const none = render(<UncertaintyView tabId={blank.id} decimals={3} />);
    expect(none.container).toHaveTextContent(w.emptyTitle);
    none.unmount();
    const tab = openExample(FEEDBACK);
    mockUncertainty.run = () => ({ ...canned(), available: false, reason: "unstable", sentence: "S1 is overloaded (utilisation 1.200), so the network has no steady state.", sampling: null });
    const over = render(<UncertaintyView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(over.container).toHaveTextContent(w.unstableTitle), WAIT);
    expect(over.container).toHaveTextContent("S1 is overloaded");
    over.unmount();
    // Closed by the one rule (no source and no sink): the bundled closed example.
    const closed = openExample("closed/ClosedCentralServer.d3.N8");
    const calls = mockUncertainty.calls.length;
    const c = render(<UncertaintyView tabId={closed.id} decimals={3} />);
    expect(c.container).toHaveTextContent(w.closedTitle);
    expect(c.container).toHaveTextContent("This is a closed network: a fixed number of customers circulates and nothing arrives from outside. Uncertainty analysis covers open networks.");
    await new Promise((r) => setTimeout(r, 400));
    expect(mockUncertainty.calls.length).toBe(calls);
    c.unmount();
    // With its population taken away it is not closed yet, and is told that no population is set.
    const bare = openExample("closed/ClosedCentralServer.d3.N8", { closedPopulation: undefined });
    const b = render(<UncertaintyView tabId={bare.id} decimals={3} />);
    expect(b.container).toHaveTextContent("no number of customers is set");
    b.unmount();
    // An open network that carries a population (a closed one given a source and a sink) is open.
    mockUncertainty.run = null;
    const open = openExample(FEEDBACK, { closedPopulation: 5 });
    const o = render(<UncertaintyView tabId={open.id} decimals={3} />);
    expect(o.container).not.toHaveTextContent(w.closedTitle);
    await waitFor(() => expect(mockUncertainty.calls.length).toBeGreaterThan(calls), WAIT);
  });
});

describe("a network with no closed formula", () => {
  it("is offered the linear approximation from numerical derivatives, with its runs stated, labelled Experimental", async () => {
    const tab = openExample(MULTI);
    const plan = await numericPlan(tab);
    expect(plan.method).not.toBeNull();
    const { container } = render(<UncertaintyView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(screen.getByRole("button", { name: w.numericAction })).toBeInTheDocument(), WAIT);
    expect(container).toHaveTextContent(w.numericTitle);
    expect(container).toHaveTextContent("not an open Jackson network");
    expect(container).toHaveTextContent(`${plan.runs} solver runs`);
    expect(container).toHaveTextContent("Sampling is not offered here");
    expect(mockQuiet.runs).toHaveLength(0);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: w.numericAction })));
    await waitFor(() => expect(container.querySelector("[data-uncertainty='linear']")).not.toBeNull(), WAIT);
    expect(mockQuiet.runs.length).toBe(plan.runs);
    // The derivatives are the Sensitivity view's estimate; the delta method is Rust's (here its stand-in).
    const estimate = sensitivityEstimate(tab.id)!;
    const request = mockUncertainty.linearCalls[mockUncertainty.linearCalls.length - 1];
    expect(request.value).toBe(estimate.value);
    for (const i of request.inputs) expect(i.derivative).toBe(estimate.rows.find((r) => r.parameter.id === i.id)!.derivative);
    expect(request.inputs.every((i) => i.spread.kind === "relativeSd")).toBe(true);
    const tier = container.querySelector("[data-uncertainty-tier]")!;
    expect(tier).toHaveAttribute("data-uncertainty-tier", "approximation");
    expect(tier).toHaveTextContent(`Linear approximation — from numerical derivatives of ${plan.method!.name}`);
    expect(tier).toHaveTextContent(w.experimental);
    expect(container.querySelector("[data-uncertainty-notes]")).toHaveTextContent(w.linearOnly);
    expect(container.querySelector("[data-uncertainty-reading]")).toHaveTextContent("To first order");
    // No sampled numbers are shown: no histogram, no chance of overload; shares by the linear route only.
    expect(container.querySelector("svg[data-chart='histogram']")).toBeNull();
    expect(container.querySelector("[data-uncertainty-overload]")).toBeNull();
    expect(container.querySelectorAll("svg[data-chart='bar'] [data-whisker]")).toHaveLength(0);
    expect(container.querySelectorAll("svg[data-chart='bar'] [data-bar]").length).toBe(request.inputs.length);
    // Changing an uncertainty needs no new runs: only the delta method is asked again.
    const runs = mockQuiet.runs.length;
    const asked = mockUncertainty.linearCalls.length;
    await act(async () => fireEvent.change(screen.getByLabelText(w.allRatesLabel), { target: { value: "5" } }));
    await waitFor(() => expect(mockUncertainty.linearCalls.length).toBeGreaterThan(asked), WAIT);
    expect(mockQuiet.runs.length).toBe(runs);
    // An edit to the network makes the derivatives stale, and says so.
    await act(async () => editorFor(tab.id).updateNumberOfServers(tab.document.nodes.find((n) => n.kind === "station")!.id, 3));
    await waitFor(() => expect(container).toHaveTextContent(w.stale), WAIT);
  });
});

describe("the preview's stand-in", () => {
  /** FEEDBACK is single-server: the stand-in's station formula is exact there, so its delta method must be the closed form's. */
  it("has the app's shape, and its linear part is the delta method of the closed form", () => {
    const doc = example(FEEDBACK);
    const ps = uncertainParameters(doc);
    const measure = measureOptions(doc).find((m) => m.kind === "networkNumber")!;
    const a = standInUncertainty(requestFor(doc, measure, planOf(ps, settingsWith({ percent: "3" })), false));
    expect(a.available).toBe(true);
    // L = 14/3; elasticities 10/3, −5/3, −5/3 (src-tauri/src/sensitivity.rs): sd = L·0.03·√(150/9).
    expect(a.value).toBeCloseTo(14 / 3, 6);
    expect(a.linear!.sd).toBeCloseTo((14 / 3) * 0.03 * Math.sqrt(150 / 9), 4);
    expect(a.shares.map((s) => s.linear)[0]).toBeCloseTo(2 / 3, 4);
    expect(a.sampling!.samples).toBe(4000);
    expect(a.sampling!.histogram!.counts.reduce((x, y) => x + y, 0) + a.sampling!.histogram!.above).toBe(4000 - a.sampling!.unstable);
    expect(a.sampling!.q025!.value).toBeLessThan(a.value!);
    expect(a.sampling!.q975!.value).toBeGreaterThan(a.value!);
    // Lognormal rates (the default reading) reach overload: no mean, no sampled shares, as the app answers.
    expect([a.sampling!.meanExists, a.sampling!.mean, a.sampling!.sd, a.shares[0].first]).toEqual([false, null, null, null]);
    // Read as ranges of ±3 % nothing can overload: the mean and the sampled shares are there.
    const ranged = standInUncertainty(requestFor(doc, measure, planOf(ps, settingsWith({ percent: "3", reading: "range" })), false));
    expect(ranged.sampling!.meanExists).toBe(true);
    expect(ranged.sampling!.mean!.value).toBeGreaterThan(ranged.value!);
    for (const s of ranged.shares) expect(Math.abs(s.first!.value - s.linear)).toBeLessThan(0.1 + 4 * s.first!.se);
    // The same seed, the same answer.
    expect(standInUncertainty(requestFor(doc, measure, planOf(ps, settingsWith({ percent: "3" })), false))).toEqual(a);
    const lin = standInLinear({ value: a.value!, inputs: a.inputs.map((i, k) => ({ id: i.id, kind: ps[k].kind, current: ps[k].current, derivative: i.derivative, spread: { kind: "relativeSd", value: 0.03 } })), arrivalsTogether: false });
    expect(lin.linear!.sd).toBeCloseTo(a.linear!.sd, 9);
    expect(standInUncertainty(requestFor(example(MULTI), measure, planOf(ps, DEFAULT_SETTINGS), false)).reason).toBe("notJackson");
  });
});
