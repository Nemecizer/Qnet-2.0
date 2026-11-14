// Results ▸ Sensitivity (src/sensitivity; ledger SCI-101…): the measures offered, the difference
// step and the bounded search of the numerical route against closed forms, the readings and the
// ranking, the view on a Jackson network (exact route, answered here by the preview's stand-in:
// the app's own formulas are checked in Rust, core/src/sensitivity.rs), "what would it take" with
// Apply as one undo step and Try as What-If Sweep, and the numerical route over quiet runs —
// its agreement with the formula route, its bound on runs, Stop, and the refusal of simulation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockSensitivity, standInSensitivity } from "../dev/mock/sensitivity";
import { mockQuiet } from "../dev/mock/sweeps2";
import { defaultHandlers } from "../dev/mockBackend";
import { editorFor } from "../editor";
import type { BnetDocument } from "../lib/bnet";
import { getCommand, unavailableReason } from "../lib/commands";
import { loadKv, resetKv } from "../lib/kv";
import { MENU_SPEC } from "../lib/menuSpec";
import { resetOverlays } from "../lib/overlays";
import { getRunState, resetRuns, startRun, stopRun } from "../runs/state";
import { cannotCloseSentence, liveRun } from "../runs/ui/live";
import { RunSegment } from "../runs/ui/RunSegment";
import { displayLabel, runWords } from "../runs/ui/words";
import { currentSweepPanel, resetSweepCommands } from "../sweeps/commands";
import { discoverParameters } from "../sweeps/model";
import { SweepHost } from "../sweeps/SweepPanel";
import { resetSweepRunner, type MethodChoice } from "../sweeps/runner";
import { mockTauri } from "../test/tauri";
import { addTab, resetWorkspace, tabById } from "../workspace/store";
import { SENSITIVITY_COMMAND, startSensitivityCommands } from "./commands";
import { bottleneckSentence, difference, FIND_EVALUATIONS, FIND_TOLERANCE, findValue, fromAnalysis, measureOptions, options, pickMeasure, ranked, reading, requestFor, STEP, stepPlan, targetChangeOf, type FindProblem, type SensitivityResult } from "./model";
import { chosenParameters, differentiable, MAX_OPTIONS, MAX_PARAMETERS, numericPlan, resetSensitivityRunner, runCount, runDifferences, runOptions, SENSITIVITY_METHOD } from "./runner";
import { SensitivityView } from "./SensitivityView";
import { resetSensitivityStore, sensitivityEstimate, takeSensitivityViewRequest } from "./store";
import { pctText, signed, sensitivityWords as w } from "./words";

const examples = import.meta.glob("../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const example = (stem: string) => ({ canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(examples[`../../examples/${stem}.bnet`]) }) as BnetDocument;
const openExample = (stem: string) => tabById(addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: example(stem) }))!;

/** γ = 1; S1 → S2 with 0.7, back to S1 with 0.3; ρ₁ = ρ₂ = 0.7, L = 14/3, W = 14/3. */
const FEEDBACK = "OpenJackson.d2.feedback.p30.inf";
/** Two classes sharing stations: no closed formula. */
const MULTI = "3d2ctandem.inf";
const WAIT = { timeout: 8000 };

const EXACT: MethodChoice = { label: "product_form", name: "Exact Open Product Form", tier: "exact", seconds: 1, slow: false, preferred: true };
const byLabel = (doc: BnetDocument, label: string) => discoverParameters(doc).find((p) => p.label.startsWith(label))!;

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
  resetSensitivityStore();
  resetSensitivityRunner();
  startSensitivityCommands();
  mockQuiet.pointMs = 1;
  // A panel opens in a window of its own; here, in a frame.
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

describe("the measures", () => {
  it("offers the network's two, then four per station, and opens on the delay", () => {
    const doc = example(FEEDBACK);
    const ms = measureOptions(doc);
    expect(ms.map((m) => m.label)).toEqual([
      "Mean number in the network",
      "Mean delay through the network",
      "S1: mean number in system", "S1: mean queue length", "S1: mean sojourn time", "S1: utilisation",
      "S2: mean number in system", "S2: mean queue length", "S2: mean sojourn time", "S2: utilisation",
    ]);
    expect(pickMeasure(ms, null)?.kind).toBe("networkSojourn");
    expect(pickMeasure(ms, ms[5].key)).toBe(ms[5]);
    expect(ms.map((m) => m.unit).slice(0, 6)).toEqual(["customers", "time", "customers", "customers", "time", "ratio"]);
    expect(measureOptions({ ...doc, nodes: [] })).toEqual([]);
  });

  it("reads a target percentage, and refuses what is not one", () => {
    expect(targetChangeOf("10", "cut")).toBeCloseTo(-0.1, 12);
    expect(targetChangeOf("12,5 %", "raise")).toBeCloseTo(0.125, 12);
    for (const bad of ["", "0", "-5", "100", "abc"]) expect(targetChangeOf(bad, "cut")).toBeNull();
  });
});

describe("the numerical route's arithmetic", () => {
  it("steps 0.5 % either side, and one side only at the end of a probability's range", () => {
    const doc = example(FEEDBACK);
    const mu = byLabel(doc, "S1 service rate");
    const plan = stepPlan(mu)!;
    expect(plan.oneSided).toBe(false);
    expect((plan.high - plan.low) / mu.current).toBeCloseTo(2 * STEP, 9);
    // d(x²)/dx at 3 by the plan's difference: exact for a parabola.
    expect(difference({ low: 2.985, high: 3.015, oneSided: false }, 2.985 ** 2, 3.015 ** 2)).toBeCloseTo(6, 9);
    const p = byLabel(doc, "S1 → B2 probability");
    expect(stepPlan(p)).toMatchObject({ low: 0.695, high: 0.705, oneSided: false });
    expect(stepPlan({ ...p, current: 1, max: 1 })).toMatchObject({ low: 0.995, high: 1, oneSided: true });
    expect(stepPlan({ ...p, current: 0 })).toMatchObject({ low: 0, high: 0.005, oneSided: true });
    expect(stepPlan(byLabel(doc, "S1 number of servers"))).toBeNull();
  });

  // M/M/1: W(μ) = 1/(μ − λ) (Gross et al., Fundamentals of Queueing Theory, §2.2), dW/dμ = −W².
  const mm1 = (lambda: number, mu: number, cut: number): FindProblem => ({ current: mu, value: 1 / (mu - lambda), derivative: -1 / (mu - lambda) ** 2, target: (1 - cut) / (mu - lambda), allowed: (x) => x > 0, min: null, max: null });

  it("finds the value that reaches a target within its tolerance and its bound on evaluations", async () => {
    for (const [lambda, mu, cut] of [[0.8, 1, 0.1], [0.5, 1, 0.3], [0.95, 1, 0.5], [3, 4, 0.02]]) {
      let used = 0;
      const problem = mm1(lambda, mu, cut);
      const answer = await findValue(problem, async (x) => {
        used++;
        return x > lambda ? 1 / (x - lambda) : null;
      });
      expect(used).toBeLessThanOrEqual(FIND_EVALUATIONS);
      if (answer === "stopped" || answer.kind !== "achieved") throw new Error(`λ = ${lambda}: ${JSON.stringify(answer)}`);
      // Within 2 % of the change asked for — and the measure reported is the one at the value proposed.
      expect(Math.abs(answer.measure - problem.target)).toBeLessThanOrEqual(FIND_TOLERANCE * Math.abs(problem.target - problem.value));
      expect(answer.measure).toBeCloseTo(1 / (answer.value - lambda), 12);
      // The closed form: μ* = λ + (μ − λ)/(1 − cut); the search is within the tolerance's reach of it.
      expect(Math.abs(answer.value - (lambda + (mu - lambda) / (1 - cut))) / mu).toBeLessThan(0.02);
    }
  });

  it("says why when no value does: no effect, the end of the range, overload, Stop", async () => {
    const flat = await findValue({ ...mm1(0.8, 1, 0.1), derivative: 0 }, async () => 1);
    expect(flat).toMatchObject({ kind: "infeasible", why: "noEffect" });
    // A probability in [0, 1] whose measure 5 − p cannot fall below 4: a cut to 3 is out of range.
    const ends = await findValue({ current: 0.5, value: 4.5, derivative: -1, target: 3, allowed: (x) => x >= 0 && x <= 1, min: 0, max: 1 }, async (x) => 5 - x);
    expect(ends).toEqual({ kind: "infeasible", why: "rangeEnds", limitValue: 1, limitMeasure: 4 });
    // Nothing nearby can be solved.
    let used = 0;
    const over = await findValue(mm1(0.8, 1, 0.1), async () => {
      used++;
      return null;
    });
    expect(over).toMatchObject({ kind: "infeasible", why: "overload" });
    expect(used).toBeLessThanOrEqual(FIND_EVALUATIONS);
    expect(await findValue(mm1(0.8, 1, 0.1), async () => "stopped")).toBe("stopped");
  });

  it("bounds the runs: the parameters taken, two runs each at most, and one for the network as it is", () => {
    const doc = example(FEEDBACK);
    const { parameters, leftOut } = chosenParameters(doc);
    // One source: the load factor is that source's rate again, and is not run twice.
    expect(parameters.map((p) => p.kind)).toEqual(["service", "service", "arrival", "servers", "servers", "routing", "routing"]);
    expect(leftOut).toBe(0);
    expect(runCount(parameters)).toBe(1 + 2 * 5 + 2);
    const big = chosenParameters(example("20stationtandem.inf"));
    expect(big.parameters).toHaveLength(MAX_PARAMETERS);
    expect(big.leftOut).toBeGreaterThan(0);
    expect(runCount(big.parameters)).toBeLessThanOrEqual(1 + 2 * MAX_PARAMETERS);
  });

  it("never differentiates a simulation: the next method that is not one is taken, or none", () => {
    const sim: MethodChoice = { label: "inf_sim", name: "Monte Carlo", tier: "simulation", seconds: 10, slow: true, preferred: false };
    const qna: MethodChoice = { label: "qna", name: "Whitt QNA", tier: "approximation", seconds: 0.1, slow: false, preferred: true };
    expect(differentiable([sim, qna, EXACT])).toBe(EXACT);
    expect(differentiable([sim, qna])).toBe(qna);
    expect(differentiable([sim])).toBeNull();
    expect(w.simulationOnly).toContain("does not differentiate a simulation");
  });
});

describe("a result read in plain words", () => {
  const doc = example(FEEDBACK);
  const measures = measureOptions(doc);
  const delay = pickMeasure(measures, "networkSojourn")!;
  const parameters = discoverParameters(doc);
  const result = fromAnalysis(standInSensitivity(requestFor(doc, delay, parameters, -0.1)), delay, parameters, -0.1) as SensitivityResult;

  it("ranks by the size of the elasticity and names the bottleneck", () => {
    // ρ = 0.7 at both stations: W = L/γ, so the elasticity of W in γ is 1/(1 − ρ) − 1 = 7/3, and
    // in each service rate −(1/2)/(1 − ρ) = −5/3 (the stand-in is exact for one server).
    const order = ranked(result.rows);
    expect(Math.abs(order[0].elasticity!)).toBeGreaterThanOrEqual(Math.abs(order[order.length - 1].elasticity!));
    const e = (label: string) => result.rows.find((r) => r.parameter.label.startsWith(label))!.elasticity!;
    expect(e("Src1 arrival rate")).toBeCloseTo(7 / 3, 4);
    expect(e("S1 service rate")).toBeCloseTo(-5 / 3, 4);
    expect(e("S2 service rate")).toBeCloseTo(-5 / 3, 4);
    expect(e("S1 → B2 probability")).toBeCloseTo(-5 / 3, 4);
    expect(bottleneckSentence(result)).toBe("S1 and S2 share the highest utilisation, 70 %: the network has no single bottleneck.");
    expect(bottleneckSentence({ stations: [{ id: "a", name: "S1", utilisation: 0.5 }, { id: "b", name: "S2", utilisation: 0.9 }] })).toBe("The bottleneck is S2: its utilisation, 90 %, is the highest.");
  });

  it("writes one sentence per parameter, with the direction in words", () => {
    const row = (label: string) => result.rows.find((r) => r.parameter.label.startsWith(label))!;
    expect(reading(row("S1 service rate"), delay, result)).toBe("Raising the S1 service rate by 1 % shortens the average delay through the network by about 1.67 %.");
    expect(reading(row("Src1 arrival rate"), delay, result)).toBe("Raising the Src1 arrival rate by 1 % lengthens the average delay through the network by about 2.33 %.");
    expect(reading(row("S1 number of servers"), delay, result)).toMatch(/^Adding one server at S1 \(1 → 2\) shortens the average delay through the network by \d+(\.\d+)? %\.$/);
    // A single bottleneck is named on its own service rate.
    const lone = { ...result, stations: [{ ...result.stations[0], utilisation: 0.9 }, result.stations[1]] };
    expect(reading(row("S1 service rate"), delay, lone)).toMatch(/; it is the bottleneck\.$/);
    expect(reading(row("S2 service rate"), delay, lone)).not.toMatch(/bottleneck/);
    expect([signed(3.333), signed(-1.667), signed(0), pctText(3.21), pctText(43.2), pctText(0.05)]).toEqual(["+3.33", "−1.67", "+0.00", "3.21 %", "43.2 %", "0.05 %"]);
  });

  it("lists what would do it from the smallest relative change, and what cannot", () => {
    const { feasible, infeasible } = options(result.rows);
    expect(feasible.length).toBeGreaterThanOrEqual(4);
    const rel = feasible.map((r) => Math.abs((r.inversion as { value: number }).value - r.parameter.current) / r.parameter.current);
    expect([...rel].sort((a, b) => a - b)).toEqual(rel);
    // Every proposed value gives the target (W cut by 10 %: 4.2).
    for (const r of feasible.filter((x) => !x.parameter.integer)) expect((r.inversion as { measure: number }).measure).toBeCloseTo(4.2, 5);
    expect(feasible.some((r) => r.parameter.kind === "load")).toBe(false);
    expect(infeasible.every((r) => r.inversion?.kind === "infeasible")).toBe(true);
  });
});

describe("the Sensitivity view", () => {
  it("is a Run-menu command that asks the Results pane for the view", async () => {
    expect(JSON.stringify(MENU_SPEC)).toContain(`"${SENSITIVITY_COMMAND}"`);
    expect(unavailableReason(getCommand(SENSITIVITY_COMMAND)!)).toBe(w.noNetwork);
    openExample(FEEDBACK);
    expect(unavailableReason(getCommand(SENSITIVITY_COMMAND)!)).toBeNull();
    await act(async () => void (await getCommand(SENSITIVITY_COMMAND)!.run()));
    expect(takeSensitivityViewRequest()).toBe(true);
  });

  it("shows a Jackson network exactly: tier, value with unit, bottleneck, ranked bars with signs, readings", async () => {
    const tab = openExample(FEEDBACK);
    const { container } = render(<SensitivityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-sensitivity='formula']")).not.toBeNull(), WAIT);
    expect(container.querySelector("[data-sensitivity-tier]")).toHaveAttribute("data-sensitivity-tier", "exact");
    expect(screen.getByText(w.tierFormula)).toBeInTheDocument();
    expect(container.querySelector("[data-sensitivity-value]")).toHaveTextContent("Mean delay through the network: 4.667 time units");
    expect(container.querySelector("[data-sensitivity-bottleneck]")).toHaveTextContent("share the highest utilisation, 70 %");
    await waitFor(() => expect(container.querySelectorAll("[data-bar]").length).toBeGreaterThanOrEqual(5), WAIT);
    const bars = [...container.querySelectorAll("[data-bar]")];
    // The sign is on every bar in words of its own: an attribute for the hatch, and the label's + or −.
    expect(bars.filter((b) => b.getAttribute("data-sign") === "lowers").length).toBeGreaterThanOrEqual(3);
    for (const b of bars) expect(b.querySelector("[data-value-label]")!.textContent).toMatch(b.getAttribute("data-sign") === "lowers" ? /^−/ : /^\+/);
    expect(container.querySelector("[data-sensitivity-readings]")!.textContent).toContain("Raising the Src1 arrival rate by 1 % lengthens the average delay through the network by about 2.33 %.");
    // The chart has its table alternative, and the Table mode shows every number with its unit.
    expect(container.querySelector("svg[data-chart='elasticity']")).toHaveAttribute("aria-describedby");
    fireEvent.click(screen.getByRole("radio", { name: w.modes.table }));
    const table = container.querySelector("[data-sensitivity-table]")!;
    expect(table.textContent).toContain("Derivative (time units per unit)");
    expect(table.textContent).toContain("per time unit");
    expect(table.textContent).toContain(w.wholeNumber);
    // Another measure is another question: asked again, nothing run.
    fireEvent.change(screen.getByLabelText(w.measureLabel), { target: { value: "networkNumber" } });
    await waitFor(() => expect(container.querySelector("[data-sensitivity-value]")).toHaveTextContent("Mean number in the network: 4.667 customers"), WAIT);
    expect(mockQuiet.runs).toHaveLength(0);
  });

  it("what would it take: options smallest first, Apply as one undo step, Try as What-If Sweep", async () => {
    const tab = openExample(FEEDBACK);
    render(<SweepHost />);
    const { container } = render(<SensitivityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(container.querySelector("[data-sensitivity-options] li")).not.toBeNull(), WAIT);
    expect(container.querySelector("[data-sensitivity-target]")!.textContent).toContain("To cut the average delay through the network by 10 % (from 4.667 to 4.200 time units), change one of:");
    const first = container.querySelector("[data-sensitivity-options] li")!;
    expect(first.textContent).toMatch(/→ .*[+−]\d.* %.*gives 4\.200 time units/);
    expect(container.textContent).toContain(w.verified);
    // A percentage that is not one says so and offers nothing.
    fireEvent.change(screen.getByLabelText(w.targetPercent), { target: { value: "abc" } });
    expect(screen.getByRole("alert")).toHaveTextContent(w.targetBad);
    expect(container.querySelector("[data-sensitivity-options]")).toBeNull();
    fireEvent.change(screen.getByLabelText(w.targetPercent), { target: { value: "20" } });
    await waitFor(() => expect(container.querySelector("[data-sensitivity-target]")!.textContent).toContain("from 4.667 to 3.733 time units"), WAIT);

    // Try as What-If Sweep: the panel is asked for, from the value now to the proposed one.
    const option = [...container.querySelectorAll("[data-sensitivity-options] li")].find((li) => li.textContent!.includes("S2 service rate"))!;
    fireEvent.click([...option.querySelectorAll("button")].find((b) => b.textContent === w.trySweep)!);
    const asked = currentSweepPanel()!;
    expect(asked.from!.parameter.label).toBe("S2 service rate");
    expect(asked.from!.from).toBeCloseTo(1.4285714286, 9);
    expect(asked.from!.to).toBeGreaterThan(asked.from!.from);

    // Apply: the network takes the value, in one step that Undo takes back; the view follows.
    const before = byLabel(tabById(tab.id)!.document, "S2 service rate").current;
    await act(async () => fireEvent.click([...option.querySelectorAll("button")].find((b) => b.textContent === w.apply)!));
    const after = byLabel(tabById(tab.id)!.document, "S2 service rate").current;
    expect(after).toBeCloseTo(asked.from!.to, 9);
    await waitFor(() => expect(container.querySelector("[data-sensitivity-value]")).toHaveTextContent("3.733 time units"), WAIT);
    // The step is Sensitivity's own: Edit ▸ Undo Apply Sensitivity Value, not the sweep's.
    expect(w.applyUndoName).toBe("Apply Sensitivity Value");
    expect(editorFor(tab.id).undoManager.undoActionName).toBe(w.applyUndoName);
    await act(async () => editorFor(tab.id).undo());
    expect(byLabel(tabById(tab.id)!.document, "S2 service rate").current).toBeCloseTo(before, 12);
  });

  it("says why there is nothing to show: no network, an overloaded one", async () => {
    const empty = tabById(addTab({ title: "Untitled.bnet", path: null, document: { ...example(FEEDBACK), nodes: [], links: [] } }))!;
    const a = render(<SensitivityView tabId={empty.id} decimals={3} />);
    expect(a.container).toHaveTextContent(w.emptyTitle);
    a.unmount();
    const doc = example(FEEDBACK);
    const tab = tabById(addTab({ title: "busy.bnet", path: null, document: { ...doc, nodes: doc.nodes.map((n) => (n.kind === "source" ? { ...n, distributionParameters: "lambda=5" } : n)) } }))!;
    const b = render(<SensitivityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(b.container).toHaveTextContent(w.unstableTitle), WAIT);
    expect(b.container).toHaveTextContent("is overloaded");
    expect(b.container).toHaveTextContent(w.unstableHelp);
  });

  it("tells a closed network that it is one, never that it has no source node", async () => {
    const doc = example(FEEDBACK);
    // Closed by the one rule: no source, no sink, a population.
    const closed = tabById(addTab({ title: "closed.bnet", path: null, document: { ...doc, closedPopulation: 5, nodes: doc.nodes.filter((n) => n.kind !== "source" && n.kind !== "sink") } }))!;
    const c = render(<SensitivityView tabId={closed.id} decimals={3} />);
    await waitFor(() => expect(c.container).toHaveTextContent(w.closedTitle), WAIT);
    expect(c.container).toHaveTextContent("This is a closed network: a fixed number of customers circulates and nothing arrives from outside. Sensitivity analysis covers open networks.");
    expect(c.container).not.toHaveTextContent("no source node");
  });
});

describe("the numerical route over quiet runs", () => {
  it("agrees with the formula route on the same network, within the difference's stated error", async () => {
    // The preview's exact stand-in differentiated by the runner (h = 0.5 %) against the same
    // model differentiated at h = 10⁻⁵ by the stand-in command. Truncation is about
    // (h·ρ/(1 − ρ))² = 1.4·10⁻⁴ of the derivative at ρ = 0.7; 0.1 % is asked. (The app's two
    // routes are held together the same way in Rust, with the real solver.)
    const tab = openExample(FEEDBACK);
    const doc = tab.document;
    const number = pickMeasure(measureOptions(doc), "networkNumber")!;
    const formula = standInSensitivity(requestFor(doc, number, discoverParameters(doc), null));
    let result: SensitivityResult | null = null;
    await act(async () => void (result = await runDifferences(tab.id, "networkNumber", EXACT)));
    const r = result as unknown as SensitivityResult;
    expect(r).toMatchObject({ route: "difference", tier: "exact", method: { label: "product_form" }, leftOut: 0 });
    expect(r.value).toBeCloseTo(14 / 3, 9);
    expect(mockQuiet.runs).toHaveLength(runCount(chosenParameters(doc).parameters));
    expect(mockQuiet.runs.every((q) => q.method === "product_form" && q.sweepId)).toBe(true);
    for (const row of r.rows.filter((x) => !x.parameter.integer)) {
      const exact = formula.rows.find((x) => x.id === row.parameter.id)!;
      expect(Math.abs(row.derivative! - exact.derivative!)).toBeLessThanOrEqual(1e-3 * Math.abs(exact.derivative!));
      expect(Math.abs(row.elasticity! - exact.elasticity!)).toBeLessThanOrEqual(1e-3 * Math.abs(exact.elasticity!));
    }
    for (const row of r.rows.filter((x) => x.parameter.integer)) expect(row.oneMore).toBeCloseTo(formula.rows.find((x) => x.id === row.parameter.id)!.oneMore!, 9);
    expect(sensitivityEstimate(tab.id)).toBe(r);
    // Nothing was filed and the slot is free again.
    expect(getRunState().active).toBeNull();
    expect(mockQuiet.begun).toBe(mockQuiet.ended);

    // What would it take, by search: bounded runs, each answer solved at its own value.
    const runsBefore = mockQuiet.runs.length;
    let found: SensitivityResult | null = null;
    await act(async () => void (found = await runOptions(tab.id, -0.1, EXACT)));
    const f = found as unknown as SensitivityResult;
    expect(mockQuiet.runs.length - runsBefore).toBeLessThanOrEqual(MAX_OPTIONS * FIND_EVALUATIONS);
    const achieved = f.rows.filter((x) => x.inversion?.kind === "achieved");
    expect(achieved.length).toBeGreaterThanOrEqual(3);
    for (const row of achieved) {
      const a = row.inversion as { value: number; measure: number };
      expect(Math.abs(a.measure - f.target!)).toBeLessThanOrEqual(FIND_TOLERANCE * 0.1 * f.value);
      const again = standInSensitivity(requestFor(doc, number, discoverParameters(doc), -0.1)).rows.find((x) => x.id === row.parameter.id)!.inversion as { value: number };
      expect(Math.abs(a.value - again.value) / again.value).toBeLessThan(0.01);
    }
  });

  // One M/M/1 queue, λ = 0.8, μ = 1, solved by a stand-in that answers the closed form and
  // nothing else (Gross et al., Fundamentals of Queueing Theory, §2.2–2.3): L = ρ/(1 − ρ) for one
  // server, L = 2ρ/(1 − ρ²) for two, ρ = λ/(cμ). The record holds L only, so the network's delay
  // is the runner's own W = L/Λ. In closed form W = 1/(μ − λ) = 5, dW/dλ = 1/(μ − λ)² = 25 and
  // the elasticity of W in λ is λ/(μ − λ) = 4; of L in λ it is 1/(1 − ρ) = 5; of W in μ it is
  // −μ/(μ − λ) = −5. A central difference at h = 0.5 % has a truncation error of about
  // (hλ/(μ − λ))² = 4·10⁻⁴ of the derivative; 0.1 % is asked.
  const mm1Document = (lambda: number, mu: number): BnetDocument => {
    const doc = example("MM1K.d1.c1.fin");
    return { ...doc, infiniteBuffers: true, nodes: doc.nodes.map((n) => (n.kind === "source" ? { ...n, distributionParameters: `lambda=${lambda}` } : n.kind === "station" ? { ...n, distributionParameters: `rate=${mu}` } : n)) };
  };
  const ratesOf = (doc: BnetDocument) => {
    const rate = (kind: string, key: string) => Number(new RegExp(`${key}=([^,]+)`).exec(doc.nodes.find((n) => n.kind === kind)!.distributionParameters)![1]);
    const station = doc.nodes.find((n) => n.kind === "station")!;
    return { lambda: rate("source", "lambda"), mu: rate("station", "rate"), servers: station.numberOfServers ?? 1, station };
  };
  /** Quiet runs answered by the closed form; returns the documents solved. */
  const closedFormSolver = () => {
    const solved: BnetDocument[] = [];
    const handlers = defaultHandlers();
    mockTauri({
      ...handlers,
      quiet_probe: ({ document }: { document: BnetDocument }) => {
        const { lambda, mu, servers } = ratesOf(document);
        return { infiniteBuffers: true, loads: [{ station: "S1", utilisation: lambda / (servers * mu) }], stable: lambda < servers * mu, error: null };
      },
      quiet_run: ({ request }: { request: { document: BnetDocument } }) => {
        const { lambda, mu, servers, station } = ratesOf(request.document);
        solved.push(request.document);
        if (servers > 2) return { kind: "failed", sentence: "no closed form in this stand-in" };
        const rho = lambda / (servers * mu);
        const number = servers === 1 ? rho / (1 - rho) : (2 * rho) / (1 - rho * rho);
        return { kind: "record", elapsedSeconds: 0, record: { id: `R${solved.length}`, method: { identifier: "queue.open-bcmp-product-form", displayName: "Exact Open Product Form", shortName: "Product form", layer: "Queueing process", fidelity: "Exact queueing result" }, provenance: { tabID: "T", networkTitle: "", networkFingerprint: "x", bufferRegime: "infinite", parameters: {} }, status: "completed", startedAt: "", completedAt: "", warnings: [], measurements: [{ id: "m", stationID: station.id, stationName: station.name, metric: "Mean number in system", unit: "customers", estimate: number }] } };
      },
    });
    return solved;
  };

  it("differentiates the network's delay with the arrival rate of the network solved: M/M/1 at ρ = 0.8 has elasticity 4, not 5", async () => {
    const solved = closedFormSolver();
    const tab = tabById(addTab({ title: "mm1.bnet", path: null, document: mm1Document(0.8, 1) }))!;
    let result: SensitivityResult | null = null;
    await act(async () => void (result = await runDifferences(tab.id, "networkSojourn", EXACT)));
    const r = result as unknown as SensitivityResult;
    expect(r.value).toBeCloseTo(5, 12);
    // The runs moved λ to 0.8·(1 ∓ 0.005), and each delay was divided by its own λ.
    expect(solved.map((d) => ratesOf(d).lambda)).toEqual(expect.arrayContaining([0.796, 0.804]));
    const row = (label: string) => r.rows.find((x) => x.parameter.label.startsWith(label))!;
    const near = (got: number | null, want: number) => expect(Math.abs(got! - want)).toBeLessThanOrEqual(1e-3 * Math.abs(want));
    near(row("Src1 arrival rate").derivative, 25);
    near(row("Src1 arrival rate").elasticity, 4);
    near(row("S1 service rate").derivative, -25);
    near(row("S1 service rate").elasticity, -5);
    // One more server: M/M/2 at ρ = 0.4, W = L/λ = (0.8/0.84)/0.8.
    expect(row("S1 number of servers").oneMore).toBeCloseTo(1 / 0.84, 12);

    // The mean number is not divided by anything: its elasticity in λ is 1/(1 − ρ) = 5.
    await act(async () => void (result = await runDifferences(tab.id, "networkNumber", EXACT)));
    const n = result as unknown as SensitivityResult;
    expect(n.value).toBeCloseTo(4, 12);
    near(n.rows.find((x) => x.parameter.label.startsWith("Src1 arrival rate"))!.elasticity, 5);
  });

  it("what would it take, by search on the arrival rate: the λ that cuts the delay by 10 % is 7/9", async () => {
    // W = 1/(μ − λ) = 4.5 at λ = 1 − 1/4.5 = 7/9. Dividing by the base rate 0.8 instead would
    // stop where L/0.8 = 4.5, at λ = 3.6/4.6 = 0.7826. The search stops within 2 % of the change
    // asked for (0.01 time units); dW/dλ ≈ 20 there, so λ is within 5·10⁻⁴ of 7/9: 10⁻³ is asked.
    closedFormSolver();
    const tab = tabById(addTab({ title: "mm1.bnet", path: null, document: mm1Document(0.8, 1) }))!;
    await act(async () => void (await runDifferences(tab.id, "networkSojourn", EXACT)));
    let found: SensitivityResult | null = null;
    await act(async () => void (found = await runOptions(tab.id, -0.1, EXACT)));
    const f = found as unknown as SensitivityResult;
    expect(f.target).toBeCloseTo(4.5, 12);
    const arrival = f.rows.find((x) => x.parameter.kind === "arrival")!.inversion as { kind: string; value: number; measure: number };
    expect(arrival.kind).toBe("achieved");
    expect(Math.abs(arrival.value - 7 / 9)).toBeLessThan(1e-3);
    expect(Math.abs(arrival.measure - 4.5)).toBeLessThanOrEqual(FIND_TOLERANCE * 0.5);
    // The measure reported is the closed form at the value proposed, with that value's own λ.
    expect(arrival.measure).toBeCloseTo(1 / (1 - arrival.value), 9);
    // The service rate: W = 4.5 at μ = λ + 1/4.5.
    const service = f.rows.find((x) => x.parameter.kind === "service")!.inversion as { kind: string; value: number; measure: number };
    expect(service.kind).toBe("achieved");
    expect(Math.abs(service.value - (0.8 + 1 / 4.5))).toBeLessThan(1e-3);
  });

  it("runs under its own name: the status bar, Stop, the busy line and the cannot-close warning say Sensitivity", async () => {
    const tab = openExample(FEEDBACK);
    mockQuiet.pointMs = 40;
    const running = runDifferences(tab.id, "networkNumber", EXACT);
    await waitFor(() => expect(mockQuiet.runs.length).toBeGreaterThanOrEqual(1), WAIT);
    expect(SENSITIVITY_METHOD).toBe("sensitivity");
    expect(liveRun()).toMatchObject({ method: SENSITIVITY_METHOD, tabId: tab.id });
    const name = displayLabel(liveRun()!.method);
    expect(name).toBe("Sensitivity");
    // The status bar's segment and its Stop button.
    const seg = render(<RunSegment />);
    const group = seg.container.querySelector("[data-state='running']")!;
    expect(`${group.getAttribute("aria-label")} ${group.getAttribute("title")}`).toContain("Sensitivity for");
    expect(seg.container.querySelector(".run-seg-stop")!.getAttribute("title")).toContain("Sensitivity");
    expect(seg.container.innerHTML).not.toContain("What-If Sweep");
    seg.unmount();
    // Run ▸ Stop's title, a sheet that cannot open, a tab that cannot close.
    expect(runWords.stopTitle(name)).toBe("Stop Sensitivity");
    expect(runWords.sheetBusy("QNA Parameters", name, tab.title)).toContain("while Sensitivity is running");
    expect(cannotCloseSentence(tab.title, liveRun()!.method)).toBe(`“${tab.title}” cannot be closed while Sensitivity is running. Stop or wait for the run first.`);
    // What the backend holds the slot under, and what a refused run is told.
    expect(await invoke("run_active")).toMatchObject({ label: "sensitivity", displayLabel: "Sensitivity" });
    expect(await startRun(tab.id, "qna")).toBe(false);
    expect(tabById(tab.id)!.log.at(-1)!.text).toBe(`QNA was not started because Sensitivity is already running for “${tab.title}”. Stop or wait for that run first.`);
    await act(async () => void (await stopRun()));
    await act(async () => void (await running));
    await waitFor(() => expect(getRunState().active).toBeNull(), WAIT);
  });

  it("is offered where no formula applies, labelled with its method's tier and as experimental", async () => {
    const tab = openExample(MULTI);
    const plan = await numericPlan(tab);
    expect(plan.method).not.toBeNull();
    expect(plan.method!.tier).not.toBe("simulation");
    const { container } = render(<SensitivityView tabId={tab.id} decimals={3} />);
    await waitFor(() => expect(screen.getByRole("button", { name: w.numericAction })).toBeInTheDocument(), WAIT);
    expect(container).toHaveTextContent(w.numericTitle);
    expect(container).toHaveTextContent("not an open Jackson network");
    expect(container).toHaveTextContent(`using ${plan.method!.name}`);
    expect(container).toHaveTextContent(`${plan.runs} runs`);
    expect(mockQuiet.runs).toHaveLength(0);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: w.numericAction })));
    await waitFor(() => expect(container.querySelector("[data-sensitivity='difference']")).not.toBeNull(), WAIT);
    expect(mockQuiet.runs.length).toBe(plan.runs);
    expect(container.querySelector("[data-sensitivity-tier]")).toHaveAttribute("data-sensitivity-tier", plan.method!.tier);
    expect(container).toHaveTextContent(`numerical derivative of ${plan.method!.name}`);
    expect(container).toHaveTextContent(w.experimental);
    expect(container.querySelectorAll("[data-bar]").length).toBeGreaterThan(0);
    // The search for options is a button with its bound on runs, not something that starts by itself.
    expect(screen.getByRole("button", { name: /^Work Out the Options \(up to \d+ runs\)$/ })).toBeInTheDocument();
    // An edit to the network makes the estimate stale, and says so.
    await act(async () => editorFor(tab.id).updateNumberOfServers(tab.document.nodes.find((n) => n.kind === "station")!.id, 3));
    await waitFor(() => expect(container).toHaveTextContent(w.staleNote), WAIT);
  });

  it("stops with Run ▸ Stop and gives the slot back", async () => {
    const tab = openExample(FEEDBACK);
    mockQuiet.pointMs = 40;
    let done: SensitivityResult | null | undefined;
    const running = runDifferences(tab.id, "networkNumber", EXACT).then((r) => (done = r));
    await waitFor(() => expect(mockQuiet.runs.length).toBeGreaterThanOrEqual(2), WAIT);
    await act(async () => void (await stopRun()));
    await act(async () => void (await running));
    expect(mockQuiet.runs.length).toBeLessThan(runCount(chosenParameters(tab.document).parameters));
    expect(done === null || done?.stopped === true).toBe(true);
    await waitFor(() => expect(getRunState().active).toBeNull(), WAIT);
    expect(mockSensitivity.calls).toHaveLength(0);
  });
});
