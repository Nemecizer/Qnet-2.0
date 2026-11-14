// Results ▸ Capacity (src/optimise; ledger SCI-701…): the problem as the form states it, the
// greedy search over evaluations against an exhaustive optimum on M/M/c closed forms, its bounds
// (runs, limits, Stop), the plan read in a sentence and drawn as a trade-off curve, the view on a
// Jackson network (exact route, answered here by the preview's stand-in: the app's own
// allocation is checked in Rust, core/src/optimise.rs), infeasible targets explained, Apply as
// one undo step, Try as What-If Sweep, and the route over quiet runs under its own run label.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockCapacity, standInCapacity } from "../dev/mock/optimise";
import { mockQuiet } from "../dev/mock/sweeps2";
import { defaultHandlers } from "../dev/mockBackend";
import { editorFor } from "../editor";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, unavailableReason } from "../lib/commands";
import { loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC } from "../lib/menuSpec";
import { resetOverlays } from "../lib/overlays";
import { getRunState, resetRuns, stopRun } from "../runs/state";
import { displayLabel } from "../runs/ui/words";
import { currentSweepPanel, resetSweepCommands } from "../sweeps/commands";
import { SweepHost } from "../sweeps/SweepPanel";
import { resetSweepRunner, type MethodChoice } from "../sweeps/runner";
import { mockTauri } from "../test/tauri";
import { addTab, resetWorkspace, tabById } from "../workspace/store";
import { CapacityView } from "./CapacityView";
import { applyCapacityPlan, CAPACITY_COMMAND, rateToApply, startCapacityCommands } from "./commands";
import { capacityChart, DEFAULT_FORM, fewestServers, greedySearch, infeasibleSentence, MAX_RUNS, problemKey, proofLine, readForm, reading, stationsOf, suggestedDelay, unavailable, violation, type CapacityForm, type CapacityPlan, type CapacityRequest, type CapacityResult, type Evaluation, type SearchStation } from "./model";
import { CAPACITY_METHOD, resetCapacityRunner, runCapacitySearch, searchRoute, withServers } from "./runner";
import { capacityPlanOf, resetCapacityStore, setCapacityForm, takeCapacityViewRequest } from "./store";
import { capacityWords as w } from "./words";

const examples = import.meta.glob("../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const example = (stem: string) => ({ canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(examples[`../../examples/${stem}.bnet`]) }) as BnetDocument;
const openExample = (stem: string) => tabById(addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: example(stem) }))!;

/** γ = 1; S1 → S2 with 0.7, back to S1 with 0.3; a₁ = a₂ = 0.7, one server each, L = 14/3, W = 14/3; the delay's floor is 1.4. */
const FEEDBACK = "OpenJackson.d2.feedback.p30.inf";
/** Two classes sharing stations: no closed formula. */
const MULTI = "3d2ctandem.inf";
const WAIT = { timeout: 8000 };
const EXACT: MethodChoice = { label: "product_form", name: "Exact Open Product Form", tier: "exact", seconds: 1, slow: false, preferred: true };
const fmt = (x: number) => x.toFixed(3);
const servers = (doc: BnetDocument) => stationsOf(doc).map((s) => s.servers);

const frames: HTMLIFrameElement[] = [];

beforeEach(async () => {
  mockTauri(defaultHandlers());
  resetKv();
  await loadKv();
  resetWorkspace();
  resetRuns();
  resetOverlays();
  resetSweepRunner();
  resetSweepCommands();
  resetCapacityStore();
  resetCapacityRunner();
  startCapacityCommands();
  mockQuiet.pointMs = 1;
  vi.spyOn(window, "open").mockImplementation(() => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frames.push(frame);
    return frame.contentWindow!;
  });
});
afterEach(async () => {
  if (getRunState().active) await act(async () => void (await stopRun()));
  await new Promise((r) => setTimeout(r, 10));
  frames.splice(0).forEach((f) => f.remove());
  vi.restoreAllMocks();
});

const form = (patch: Partial<CapacityForm>): CapacityForm => ({ ...DEFAULT_FORM, ...patch, touched: true });
const target = (kind: keyof CapacityForm["targets"], text: string) => ({ ...DEFAULT_FORM.targets, [kind]: { on: true, text } });

describe("the problem as stated", () => {
  it("reads targets, costs and limits into a request, a utilisation as a percentage", () => {
    const doc = example(FEEDBACK);
    const [s1, s2] = stationsOf(doc);
    const r = readForm(doc, form({ targets: { ...target("networkSojourn", "3,5"), utilisation: { on: true, text: "80 %" }, stationWait: { on: true, text: "0.25" } }, waitStationId: s2.id, stations: { [s1.id]: { free: true, cost: "2.5", rateCost: "1", lower: "2", upper: "6" }, [s2.id]: { free: false, cost: "1", rateCost: "1", lower: "1", upper: "" } } }));
    expect(r.problem).toBeNull();
    expect(r.request.decision).toBe("servers");
    expect(r.request.constraints).toEqual([
      { kind: "networkSojourn", stationId: null, target: 3.5 },
      { kind: "utilisation", stationId: null, target: 0.8 },
      { kind: "stationWait", stationId: s2.id, target: 0.25 },
    ]);
    expect(r.request.stations).toEqual([
      { id: s1.id, free: true, cost: 2.5, rateCost: 1, lower: 2, upper: 6 },
      { id: s2.id, free: false, cost: 1, rateCost: 1, lower: 1, upper: null },
    ]);
    // The same problem has the same key; another target is another problem.
    expect(problemKey(r.request)).toBe(problemKey(readForm(doc, form({ ...JSON.parse(JSON.stringify({ targets: { ...target("networkSojourn", "3.5"), utilisation: { on: true, text: "80" }, stationWait: { on: true, text: "0.25" } } })), waitStationId: s2.id, stations: { [s1.id]: { free: true, cost: "2.5", rateCost: "1", lower: "2", upper: "6" }, [s2.id]: { free: false, cost: "1", rateCost: "1", lower: "1", upper: "" } } })).request));
    expect(problemKey(r.request)).not.toBe(problemKey(readForm(doc, form({ targets: target("networkSojourn", "3") })).request));
  });

  it("says the first thing wrong and leaves an unreadable target out", () => {
    const doc = example(FEEDBACK);
    const [s1] = stationsOf(doc);
    expect(readForm(doc, form({})).problem).toBe(w.problems.noTarget);
    expect(readForm(doc, form({})).request.constraints).toEqual([]);
    expect(readForm(doc, form({ targets: target("networkSojourn", "abc") })).problem).toBe(w.problems.badTarget("Mean delay through the network"));
    expect(readForm(doc, form({ targets: target("networkNumber", "0") })).problem).toBe(w.problems.badTarget("Mean number in the network"));
    for (const bad of ["0", "120", "x"]) expect(readForm(doc, form({ targets: target("utilisation", bad) })).problem).toBe(w.problems.badUtilisation);
    const station = (patch: object) => readForm(doc, form({ targets: target("utilisation", "80"), stations: { [s1.id]: { free: true, cost: "1", rateCost: "1", lower: "1", upper: "", ...patch } } })).problem;
    expect(station({ cost: "-1" })).toBe(w.problems.badCost("S1"));
    expect(station({ lower: "1.5" })).toBe(w.problems.badLimit("S1"));
    expect(station({ lower: "4", upper: "3" })).toBe(w.problems.badLimit("S1"));
    expect(station({ lower: "2", upper: "2" })).toBeNull();
    // A held station's cost and limits are not read.
    expect(station({ free: false, cost: "x", lower: "0" })).toBeNull();
  });

  it("suggests a first delay target above the floor", () => {
    expect(suggestedDelay(14 / 3, 1.4)).toBe("3.73");
    // A fifth off would be at the floor: half-way instead.
    expect(suggestedDelay(1.5, 1.4)).toBe("1.45");
    expect(Number(suggestedDelay(2, null))).toBeCloseTo(1.6, 12);
  });

  it("starts a station at the fewest servers that keep up and meet a utilisation", () => {
    expect(fewestServers(0.7, null)).toBe(1);
    expect(fewestServers(2, null)).toBe(3);
    expect(fewestServers(2.1, 0.8)).toBe(3);
    expect(fewestServers(2, 0.5)).toBe(4);
    expect(fewestServers(3, 0.6)).toBe(5);
    expect(fewestServers(0.7, 0.5)).toBe(2);
  });
});

// The M/M/c mean number in system by Erlang's formulas (Gross, Shortle, Thompson & Harris,
// Fundamentals of Queueing Theory, 4th ed., §2.3): B by the recursion B(n) = aB(n−1)/(n + aB(n−1)),
// C = B/(1 − ρ(1 − B)), L = Cρ/(1 − ρ) + a. C(3, 2) = 4/9 → L = 2 + 8/9; C(4, 2) = 4/23.
function mmc(c: number, a: number): number {
  if (c <= a) return Infinity;
  let b = 1;
  for (let n = 1; n <= c; n++) b = (a * b) / (n + a * b);
  const rho = a / c;
  return ((b / (1 - rho * (1 - b))) * rho) / (1 - rho) + a;
}

describe("the greedy search over evaluations", () => {
  const problem = (loads: number[], costs: number[], uppers: (number | null)[] = loads.map(() => null)): SearchStation[] => loads.map((a, i) => ({ id: `s${i}`, free: true, cost: costs[i], start: Math.floor(a) + 1, upper: uppers[i] }));
  const evaluator = (loads: number[], calls: { n: number }) => async (allocation: number[]): Promise<Evaluation> => {
    calls.n++;
    const number = allocation.reduce((s, c, i) => s + mmc(c, loads[i]), 0);
    return { values: [number], delay: null, number };
  };

  it("holds the test's M/M/c to its textbook values", () => {
    expect(mmc(3, 2)).toBeCloseTo(2 + 8 / 9, 12);
    expect(mmc(4, 2)).toBeCloseTo(2 + 4 / 23, 12);
    expect(mmc(1, 0.7)).toBeCloseTo(7 / 3, 12);
  });

  it("finds the exhaustive optimum on M/M/c stations with equal costs (40 problems, fixed seed)", async () => {
    // Marginal allocation is optimal for equal costs (Fox 1966): its cost must equal the cheapest
    // of every allocation within its own total of added servers plus one, at each station.
    let seed = 2026;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let trial = 0; trial < 40; trial++) {
      const loads = Array.from({ length: 2 + (trial % 2) }, () => 0.2 + 3.5 * random());
      const stations = problem(loads, loads.map(() => 1));
      const start = stations.reduce((s, x, i) => s + mmc(x.start, loads[i]), 0);
      const floor = loads.reduce((s, a) => s + a, 0);
      const cap = floor + (start - floor) * (0.05 + 0.8 * random());
      const calls = { n: 0 };
      const out = await greedySearch(stations, [cap], evaluator(loads, calls), 10_000);
      expect(out.ended).toBe("met");
      const chosen = out.path[out.chosen];
      expect(chosen.evaluation.number!).toBeLessThanOrEqual(cap);
      expect(out.runs).toBe(calls.n);
      const added = chosen.allocation.reduce((s, c, i) => s + c - stations[i].start, 0);
      let best = Infinity;
      const walk = (i: number, alloc: number[]) => {
        if (i === loads.length) {
          if (alloc.reduce((s, c, k) => s + mmc(c, loads[k]), 0) <= cap) best = Math.min(best, alloc.reduce((s, c) => s + c, 0));
          return;
        }
        for (let c = stations[i].start; c <= stations[i].start + added + 1; c++) walk(i + 1, [...alloc, c]);
      };
      walk(0, []);
      expect(chosen.allocation.reduce((s, c) => s + c, 0)).toBe(best);
      // The path costs one server more at each step and the mean number only falls.
      for (let k = 1; k < out.path.length; k++) expect(out.path[k].evaluation.number!).toBeLessThan(out.path[k - 1].evaluation.number!);
    }
  });

  it("takes the cheapest last step, stops at its bound on runs, at the limits, and on Stop", async () => {
    const loads = [2, 2];
    const calls = { n: 0 };
    // Start (3, 3): L = 5.778. One more at either gives 5.063: the cheaper station gets it.
    const dear = await greedySearch(problem(loads, [5, 1]), [5.1], evaluator(loads, calls), 100);
    expect(dear.path[dear.chosen].allocation).toEqual([3, 4]);
    expect(dear.runs).toBe(3);
    // Already met at the start: one run, nothing added.
    const met = await greedySearch(problem(loads, [1, 1]), [6], evaluator(loads, calls), 100);
    expect([met.ended, met.runs, met.chosen]).toEqual(["met", 1, 0]);
    // A tail of steps after the target, for the curve; the plan stays the first that met it.
    const tail = await greedySearch(problem(loads, [1, 1]), [5.1], evaluator(loads, calls), 100, 3);
    expect([tail.chosen, tail.path.length]).toEqual([1, 5]);
    // Out of runs: a step needs two runs and only one is left.
    const short = await greedySearch(problem(loads, [1, 1]), [4.01], evaluator(loads, calls), 4);
    expect([short.ended, short.runs]).toEqual(["outOfRuns", 3]);
    expect(short.path[short.chosen].allocation.reduce((s, c) => s + c, 0)).toBe(7);
    // Limits: nothing may be added.
    const limited = await greedySearch(problem(loads, [1, 1], [3, 3]), [5], evaluator(loads, calls), 100);
    expect([limited.ended, limited.runs]).toEqual(["limits", 1]);
    // Stop during the second step keeps the first.
    let n = 0;
    const stopped = await greedySearch(problem(loads, [1, 1]), [4.01], async (a) => (++n > 4 ? "stopped" : evaluator(loads, calls)(a)), 100);
    expect([stopped.ended, stopped.path.length]).toEqual(["stopped", 2]);
    // A start that cannot be solved gives nothing.
    expect((await greedySearch(problem(loads, [1, 1]), [5], async () => null, 100)).path).toEqual([]);
    expect(violation({ values: [2, 1, null], delay: null, number: null }, [1, 2, 1])).toBe(Infinity);
    expect(violation({ values: [3, 1], delay: null, number: null }, [2, 2])).toBeCloseTo(0.5, 12);
  });
});

const planOf = async (doc: BnetDocument, patch: Partial<CapacityForm>): Promise<{ plan: CapacityPlan; request: CapacityRequest }> => {
  const { request } = readForm(doc, form(patch));
  return { plan: await standInCapacity(request), request };
};
const asResult = (plan: CapacityPlan, request: CapacityRequest): CapacityResult => ({ route: "formula", tier: "exact", method: null, plan, ended: "met", runs: 0, key: problemKey(request) });

describe("a plan read in plain words", () => {
  it("says what changes, what it costs and what the delay becomes", async () => {
    const doc = example(FEEDBACK);
    const { plan, request } = await planOf(doc, { targets: target("networkSojourn", "3.73") });
    expect(plan.stations.map((s) => [s.serversNow, s.servers])).toEqual([[1, 2], [1, 1]]);
    expect(reading(plan, fmt)).toMatch(/^Add 1 server at S1: the cost rises from 2 to 3, the least that meets every target\. The mean delay goes from 4\.667 to 3\.\d{3} time units\.$/);
    expect(proofLine(asResult(plan, request))).toMatchObject({ text: w.proof.marginal, proven: true });
    // Already met: nothing to do. Over-provisioned: servers come off.
    const loose = await planOf(doc, { targets: target("networkSojourn", "5") });
    expect(reading(loose.plan, fmt)).toBe(w.reading.same("2"));
    const rich = await planOf(withServers(doc, stationsOf(doc).map((s) => s.id), [4, 3]), { targets: target("networkSojourn", "5") });
    expect(reading(rich.plan, fmt)).toMatch(/^Remove 3 servers at S1 and remove 2 servers at S2: every target is still met and the cost falls from 7 to 2\./);
    // Unequal costs and no exact search (the stand-in has none): good, not proven.
    const [s1, s2] = stationsOf(doc);
    const dear = await planOf(doc, { targets: target("networkSojourn", "3.73"), stations: { [s1.id]: { free: true, cost: "3", rateCost: "1", lower: "1", upper: "" }, [s2.id]: { free: true, cost: "1", rateCost: "1", lower: "1", upper: "" } } });
    expect(dear.plan.stations.map((s) => s.servers)).toEqual([1, 2]);
    expect(proofLine(asResult(dear.plan, dear.request)).proven).toBe(false);
    expect(proofLine({ ...asResult(plan, request), plan: { ...plan, proof: "search", searchNodes: 1234 } }).text).toBe(w.proof.search("1,234"));
  });

  it("draws cost against delay along the path, with the target, now and the proposal", async () => {
    const doc = example(FEEDBACK);
    const { plan, request } = await planOf(doc, { targets: target("networkSojourn", "3.73") });
    const chart = capacityChart(asResult(plan, request), fmt)!;
    expect(chart.series.map((s) => s.key)).toEqual(["path", "target", "now"]);
    const path = chart.series[0].points;
    // The start costs 2; every step one more; the delay falls, by less each time (the curve flattens).
    expect(path.map((p) => p.x)).toEqual(path.map((_p, k) => 2 + k));
    const falls = path.slice(1).map((p, k) => path[k].y - p.y);
    expect(falls.every((f) => f > 0)).toBe(true);
    expect(falls[0]).toBeGreaterThan(falls[falls.length - 1]);
    expect(chart.series[1].points.map((p) => p.y)).toEqual([3.73, 3.73]);
    expect(chart.series[2].points).toEqual([{ x: 2, y: plan.delayNow }]);
    expect(chart.rules).toEqual([{ x: 3, label: w.ruleProposed, tone: "current" }]);
    expect(chart.caption).toContain("The proposed plan costs 3.");
    expect(chart.yLabel).toBe(w.chartY.delay);
    // A target on the mean number alone is drawn as the mean number.
    const n = await planOf(doc, { targets: target("networkNumber", "3.5") });
    expect(capacityChart(asResult(n.plan, n.request), fmt)!.yLabel).toBe(w.chartY.number);
    expect(capacityChart(asResult({ ...plan, path: plan.path.slice(0, 1) }, request), fmt)).toBeNull();
  });

  it("explains a target that cannot be met", async () => {
    const doc = example(FEEDBACK);
    const floor = await planOf(doc, { targets: target("networkSojourn", "1.2") });
    expect(floor.plan.infeasible).toMatchObject({ why: "serviceFloor", constraint: 0 });
    expect(infeasibleSentence(floor.plan, fmt)).toBe(w.infeasible.serviceFloor("Mean delay through the network", "1.400 time units"));
    expect(reading(floor.plan, fmt)).toBeNull();
    const [s1] = stationsOf(doc);
    const held = await planOf(doc, { targets: target("utilisation", "50"), stations: { [s1.id]: { free: true, cost: "1", rateCost: "1", lower: "1", upper: "1" } } });
    expect(held.plan.infeasible).toMatchObject({ why: "stationLimit", stationId: s1.id });
    expect(infeasibleSentence(held.plan, fmt)).toBe(w.infeasible.stationLimit("Highest utilisation", "S1", "70 %"));
    const every = ["badTarget", "badStation", "fixedOverloaded", "limitOverloaded", "floor", "tooMany", "ratesTarget", "severalServers", "nothingFree", "fixedTooFull"] as const;
    for (const why of every) expect(infeasibleSentence({ ...floor.plan, infeasible: { why, constraint: 0, stationId: s1.id, value: 2 } }, fmt).length).toBeGreaterThan(20);
  });

  it("plans service rates by the square-root rule in the stand-in too", async () => {
    const doc = example(FEEDBACK);
    const { plan, request } = await planOf(doc, { decision: "rates", targets: target("networkNumber", "2") });
    // α = (1/0.7, 1), d = 1: S = √α₁ + 1, μᵢ = αᵢ + √αᵢ·S/2 (Kleinrock vol. 2, §5.7); Σ αᵢ/(μᵢ − αᵢ) = 2.
    const a1 = 1 / 0.7;
    const S = Math.sqrt(a1) + 1;
    expect(plan.stations[0].rate).toBeCloseTo(a1 + (Math.sqrt(a1) * S) / 2, 9);
    expect(plan.stations[1].rate).toBeCloseTo(1 + S / 2, 9);
    expect(plan.stations.reduce((s, x, i) => s + [a1, 1][i] / (x.rate - [a1, 1][i]), 0)).toBeCloseTo(2, 9);
    expect(proofLine(asResult(plan, request)).text).toBe(w.proof.closedForm);
    expect(reading(plan, fmt)).toMatch(/^Speed S\d up from .* to .* and s(peed|low) S\d (up|down) from/);
    expect((await planOf(doc, { decision: "rates", targets: target("utilisation", "50") })).plan.infeasible?.why).toBe("ratesTarget");
    // Written into the network rounded up at the sixth digit, so the target is still met.
    expect(rateToApply(2.04081632653)).toBe(2.04082);
    expect(rateToApply(1.5)).toBe(1.5);
    expect(rateToApply(0.0123456789)).toBe(0.0123457);
  });
});

describe("the Capacity view", () => {
  it("is a Run-menu command that asks the Results pane for the view", async () => {
    expect(JSON.stringify(MENU_SPEC)).toContain(`"${CAPACITY_COMMAND}"`);
    expect(unavailableReason(getCommand(CAPACITY_COMMAND)!)).toBe(w.noNetwork);
    openExample(FEEDBACK);
    expect(unavailableReason(getCommand(CAPACITY_COMMAND)!)).toBeNull();
    await act(async () => void (await getCommand(CAPACITY_COMMAND)!.run()));
    expect(takeCapacityViewRequest()).toBe(true);
  });

  it("opens on a suggested delay target and shows the plan: tier, proof, sentence, tables, curve", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<CapacityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-capacity='formula']")).not.toBeNull(), WAIT);
    expect((screen.getByLabelText(w.targetValue(w.targets.networkSojourn)) as HTMLInputElement).value).toBe("3.73");
    expect(container.querySelector("[data-capacity-tier]")).toHaveAttribute("data-capacity-tier", "exact");
    expect(screen.getByText(w.tierFormula)).toBeInTheDocument();
    expect(container.querySelector("[data-capacity-proof]")).toHaveAttribute("data-proven", "true");
    expect(container.querySelector("[data-capacity-reading]")!.textContent).toContain("Add 1 server at S1: the cost rises from 2 to 3");
    // The hints beside the targets: the value now, and the floor no number of servers beats.
    const hints = [...container.querySelectorAll("[data-target='networkSojourn'] [data-capacity-hint]")].map((h) => h.textContent);
    expect(hints).toEqual([w.hintNow("4.667"), w.hintFloor("1.400")]);
    // The plan table: station, now, proposed, change, costs; totals.
    const rows = [...container.querySelectorAll("[data-capacity-plan] tbody tr")].map((r) => [...r.children].map((c) => c.textContent));
    expect(rows).toEqual([["S1", "1", "2", "+1", "1", "2"], ["S2", "1", "1", "—", "1", "1"]]);
    expect(container.querySelector("[data-capacity-cost-now]")).toHaveTextContent("2");
    expect(container.querySelector("[data-capacity-cost]")).toHaveTextContent("3");
    // The target: its limit, now and proposed, the unit, met.
    const c = [...container.querySelectorAll("[data-capacity-constraints] tbody tr")][0];
    expect([...c.children].map((x) => x.textContent).filter((_t, i) => i !== 3)).toEqual(["Mean delay through the network", "3.730", "4.667", "time units", w.met]);
    await waitFor(() => expect(container.querySelector("svg[data-chart='line']")).not.toBeNull(), WAIT);
    expect(container.querySelector("svg[data-chart='line']")).toHaveAttribute("aria-describedby");
    expect(container.querySelector("[data-rule='current']")).not.toBeNull();
    expect(mockQuiet.runs).toHaveLength(0);
  });

  it("explains an infeasible target in place of a plan, and a form that is not a problem yet", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<CapacityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-capacity='formula']")).not.toBeNull(), WAIT);
    fireEvent.change(screen.getByLabelText(w.targetValue(w.targets.networkSojourn)), { target: { value: "1.2" } });
    await waitFor(() => expect(container.querySelector("[data-capacity-infeasible='serviceFloor']")).not.toBeNull(), WAIT);
    expect(container.querySelector("[data-capacity-infeasible]")!.textContent).toContain("can never be 1.400 time units or less");
    expect(container.querySelector("[data-capacity-plan]")).toBeNull();
    expect(screen.queryByRole("button", { name: w.apply })).toBeNull();
    fireEvent.change(screen.getByLabelText(w.targetValue(w.targets.networkSojourn)), { target: { value: "abc" } });
    await waitFor(() => expect(container.querySelector("[data-capacity-problem]")).toHaveTextContent(w.problems.badTarget("Mean delay through the network")), WAIT);
    expect(container.querySelector("[data-capacity='none']")).not.toBeNull();
    // Several targets at once.
    fireEvent.change(screen.getByLabelText(w.targetValue(w.targets.networkSojourn)), { target: { value: "3.73" } });
    fireEvent.change(screen.getByLabelText(w.targetValue(w.targets.utilisation)), { target: { value: "50" } });
    await waitFor(() => expect(container.querySelectorAll("[data-capacity-constraints] tbody tr")).toHaveLength(2), WAIT);
    await waitFor(() => expect([...container.querySelectorAll("[data-capacity-plan] tbody tr")].map((r) => r.children[2].textContent)).toEqual(["2", "2"]), WAIT);
  });

  it("Apply is one undo step of its own, and Try as What-If Sweep opens the panel on the changed station", async () => {
    const tab = openExample(FEEDBACK);
    render(<SweepHost />);
    const { container } = render(<CapacityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-capacity-plan]")).not.toBeNull(), WAIT);
    fireEvent.change(screen.getByLabelText(w.targetValue(w.targets.networkSojourn)), { target: { value: "2" } });
    await waitFor(() => expect([...container.querySelectorAll("[data-capacity-plan] tbody tr")].map((r) => r.children[2].textContent)).toEqual(["2", "2"]), WAIT);
    fireEvent.click(screen.getByRole("button", { name: w.trySweep }));
    const asked = currentSweepPanel()!;
    expect(asked.from!.parameter.label).toBe("S1 number of servers");
    expect([asked.from!.from, asked.from!.to]).toEqual([1, 4]);

    expect(servers(tabById(tab.id)!.document)).toEqual([1, 1]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: w.apply })));
    expect(servers(tabById(tab.id)!.document)).toEqual([2, 2]);
    expect(w.applyUndoName).toBe("Apply Capacity Plan");
    expect(editorFor(tab.id).undoManager.undoActionName).toBe(w.applyUndoName);
    // The view follows the network: nothing left to change.
    await waitFor(() => expect(container.querySelector("[data-capacity-reading]")).toHaveTextContent(w.reading.same("4")), WAIT);
    expect(screen.getByRole("button", { name: w.apply })).toBeDisabled();
    await act(async () => editorFor(tab.id).undo());
    expect(servers(tabById(tab.id)!.document)).toEqual([1, 1]);
    // A plan for a station the network no longer has applies nothing.
    const gone: CapacityPlan = { ...(await planOf(tab.document, { targets: target("networkSojourn", "2") })).plan };
    gone.stations = gone.stations.map((s, i) => (i ? s : { ...s, id: "NOT-THERE" }));
    expect(applyCapacityPlan(tab.id, gone)).toBe(false);
    expect(servers(tabById(tab.id)!.document)).toEqual([1, 1]);
  });

  it("plans service rates, and applies them as rates", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<CapacityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-capacity-plan]")).not.toBeNull(), WAIT);
    fireEvent.click(screen.getByRole("radio", { name: w.decisions.rates }));
    await waitFor(() => expect(container.querySelector("[data-capacity-proof='closedForm']")).not.toBeNull(), WAIT);
    expect(container.querySelector("[data-capacity-stations]")!.textContent).toContain(w.colCostRate);
    expect(container.querySelector("[data-capacity-stations]")!.textContent).not.toContain(w.colUpper);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: w.apply })));
    expect(editorFor(tab.id).undoManager.undoActionName).toBe(w.applyUndoName);
    expect(servers(tabById(tab.id)!.document)).toEqual([1, 1]);
    // Solved again at the applied rates, the delay meets the 3.73 asked for.
    await waitFor(() => expect(Number(container.querySelector("[data-target='networkSojourn'] [data-capacity-hint]")!.textContent!.replace("now ", ""))).toBeLessThanOrEqual(3.73), WAIT);
  });

  it("says why there is nothing to plan: no network, a closed one", async () => {
    const empty = tabById(addTab({ title: "Untitled.bnet", path: null, document: { ...example(FEEDBACK), nodes: [], links: [] } }))!;
    const a = render(<CapacityView tabId={empty.id} decimals={3} />);
    expect(a.container).toHaveTextContent(w.emptyTitle);
    a.unmount();
    const doc = example(FEEDBACK);
    // Closed by the one rule: no source and no sink (and a population).
    const closed = tabById(addTab({ title: "closed.bnet", path: null, document: { ...doc, closedPopulation: 5, nodes: doc.nodes.filter((n) => n.kind !== "source" && n.kind !== "sink") } }))!;
    const b = render(<CapacityView tabId={closed.id} decimals={3} />);
    await waitFor(() => expect(b.container).toHaveTextContent(w.closedTitle), WAIT);
    expect(b.container).toHaveTextContent("Capacity planning covers open networks.");
    expect(b.container.querySelector("[data-capacity-targets]")).toBeNull();
    b.unmount();
    // The same with no population: told that none is set.
    const bare = tabById(addTab({ title: "bare.bnet", path: null, document: { ...doc, nodes: doc.nodes.filter((n) => n.kind !== "source" && n.kind !== "sink") } }))!;
    const c = render(<CapacityView tabId={bare.id} decimals={3} />);
    await waitFor(() => expect(c.container).toHaveTextContent("no number of customers is set"), WAIT);
    c.unmount();
    // An open network that carries a population (a closed one given a source and a sink) is planned.
    const open = tabById(addTab({ title: "open.bnet", path: null, document: { ...doc, closedPopulation: 5 } }))!;
    const d = render(<CapacityView tabId={open.id} decimals={3} />);
    await waitFor(() => expect(d.container.querySelector("[data-capacity-targets]")).not.toBeNull(), WAIT);
    expect(d.container).not.toHaveTextContent(w.closedTitle);
  });

  it("answers what Rust answers, in Rust's shape", async () => {
    const tab = openExample(FEEDBACK);
    const answer: CapacityPlan = { ...(await planOf(tab.document, { targets: target("networkSojourn", "3.73") })).plan, proof: "search", searched: true, searchNodes: 17, improved: true };
    mockCapacity.run = () => answer;
    const { container } = render(<CapacityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-capacity-proof='search']")).toHaveTextContent(w.proof.improved("17")), WAIT);
    expect(mockCapacity.calls[mockCapacity.calls.length - 1]).toMatchObject({ decision: "servers", constraints: [{ kind: "networkSojourn", target: 3.73 }], stations: [{ free: true, cost: 1, lower: 1, upper: null }, {}] });
    mockCapacity.run = () => unavailable("network", "The network has no sink node.");
    setCapacityForm(tab.id, { targets: target("networkSojourn", "3") });
    await waitFor(() => expect(container).toHaveTextContent("The network has no sink node."), WAIT);
  });
});

describe("the route over quiet runs", () => {
  it("finds the plan the formula route finds, under the run label Capacity, within its bound on runs", async () => {
    // The same greedy over the same stand-in model, once through quiet runs and once in the
    // stand-in command: the plumbing (documents sent, records read, the start, the bound) must
    // not change the answer. (The app's exact route is held to exhaustive search in Rust.)
    const tab = openExample(FEEDBACK);
    const { request } = readForm(tab.document, form({ targets: { ...target("networkSojourn", "2"), stationWait: { on: true, text: "0.5" } } }));
    const formula = await standInCapacity(request);
    let found: CapacityResult | null = null;
    let label: string | undefined;
    const seen = setInterval(() => (label ??= getRunState().active?.method), 0);
    await act(async () => void (found = await runCapacitySearch(tab.id, request, EXACT)));
    clearInterval(seen);
    const r = found as unknown as CapacityResult;
    expect(r).toMatchObject({ route: "runs", tier: "exact", method: { label: "product_form" }, ended: "met" });
    expect(r.plan.stations.map((s) => s.servers)).toEqual(formula.stations.map((s) => s.servers));
    expect(r.plan.cost).toBe(formula.cost);
    expect(r.plan.delay).toBeCloseTo(formula.delay!, 9);
    expect(r.plan.constraints.map((c) => c.proposed !== null && c.proposed <= c.target)).toEqual([true, true]);
    expect(r.plan.delayNow).toBeCloseTo(14 / 3, 9);
    expect(mockQuiet.runs.length).toBe(r.runs);
    expect(r.runs).toBeLessThanOrEqual(MAX_RUNS);
    expect(mockQuiet.runs.every((q) => q.method === "product_form" && q.sweepId)).toBe(true);
    expect(capacityPlanOf(tab.id)).toBe(r);
    expect(proofLine(r)).toMatchObject({ text: w.proof.runs, proven: false });
    // Its own name, wherever a run is named; nothing filed; the slot free again.
    expect([CAPACITY_METHOD, displayLabel(CAPACITY_METHOD)]).toEqual(["capacity", "Capacity"]);
    expect(getRunState().active).toBeNull();
    expect(mockQuiet.begun).toBe(mockQuiet.ended);
    void label;
  });

  it("offers the search for a network with no closed formula, labelled Experimental", async () => {
    const tab = openExample(MULTI);
    const route = await searchRoute(tab);
    expect(route.method).not.toBeNull();
    expect(route.method!.tier).not.toBe("simulation");
    expect(route.runs).toBe(MAX_RUNS);
    setCapacityForm(tab.id, { targets: target("utilisation", "60") });
    const { container } = render(<CapacityView tabId={tab.id} decimals={3} />);
    const button = await screen.findByRole("button", { name: w.numericAction }, WAIT);
    expect(container).toHaveTextContent(`at most ${MAX_RUNS} solver runs`);
    await act(async () => fireEvent.click(button));
    await waitFor(() => expect(container.querySelector("[data-capacity='runs']")).not.toBeNull(), WAIT);
    expect(container).toHaveTextContent(w.experimental);
    expect(container.querySelector("[data-capacity-tier]")).toHaveAttribute("data-capacity-tier", route.method!.tier);
    expect(container.querySelector("[data-capacity-proof]")).toHaveAttribute("data-proven", "false");
    const plan = capacityPlanOf(tab.id)!.plan;
    expect(plan.stations.every((s) => s.utilisation <= 0.6)).toBe(true);
    // The utilisation bound is the start itself (exact, from the traffic equations): one run.
    expect(capacityPlanOf(tab.id)!.runs).toBeLessThanOrEqual(2);
    // Another problem is not answered by the old plan.
    fireEvent.change(screen.getByLabelText(w.targetValue(w.targets.utilisation)), { target: { value: "40" } });
    await screen.findByRole("button", { name: w.numericAction }, WAIT);
    // Service rates have no route here.
    fireEvent.click(screen.getByRole("radio", { name: w.decisions.rates }));
    await waitFor(() => expect(container).toHaveTextContent(w.numericRatesOnly), WAIT);
  });

  it("keeps the best plan reached when the runs run out, and says so; a held overloaded station is said without a run", async () => {
    const tab = openExample(FEEDBACK);
    // A delay a hair above the floor (1.4) needs far more than the bound allows.
    const hard = readForm(tab.document, form({ targets: target("networkSojourn", "1.4000000001") })).request;
    let found: CapacityResult | null = null;
    await act(async () => void (found = await runCapacitySearch(tab.id, hard, EXACT)));
    const r = found as unknown as CapacityResult;
    expect(r.ended).toBe("outOfRuns");
    expect(r.runs).toBeLessThanOrEqual(MAX_RUNS);
    expect(mockQuiet.runs.length).toBeLessThanOrEqual(MAX_RUNS);
    expect(r.plan.constraints[0].proposed!).toBeGreaterThan(1.4000000001);
    expect(r.plan.delay!).toBeLessThan(14 / 3);
    // Held at one server while the load is tripled: no plan, and no run.
    const before = mockQuiet.runs.length;
    const [s1] = stationsOf(tab.document);
    const heavy = { ...tab.document, nodes: tab.document.nodes.map((n) => (n.kind === "source" ? { ...n, distributionParameters: "lambda=3.0" } : n)) };
    const over = tabById(addTab({ title: "over.bnet", path: null, document: heavy }))!;
    const held = readForm(heavy, form({ targets: target("utilisation", "80"), stations: { [s1.id]: { free: false, cost: "1", rateCost: "1", lower: "1", upper: "" } } })).request;
    await act(async () => void (found = await runCapacitySearch(over.id, held, EXACT)));
    expect((found as unknown as CapacityResult).plan.infeasible).toMatchObject({ why: "fixedOverloaded", stationId: s1.id });
    expect(mockQuiet.runs.length).toBe(before);
  });

  it("Stop ends the search and frees the slot", async () => {
    mockQuiet.pointMs = 40;
    const tab = openExample(FEEDBACK);
    const request = readForm(tab.document, form({ targets: target("networkSojourn", "1.4000000001") })).request;
    const pending = runCapacitySearch(tab.id, request, EXACT);
    await waitFor(() => expect(getRunState().active?.method).toBe("capacity"), WAIT);
    await waitFor(() => expect(mockQuiet.runs.length).toBeGreaterThanOrEqual(2), WAIT);
    await act(async () => void (await stopRun()));
    await act(async () => void (await pending));
    expect(getRunState().active).toBeNull();
    expect(mockQuiet.runs.length).toBeLessThan(MAX_RUNS);
    expect(mockQuiet.begun).toBe(mockQuiet.ended);
  });
});
