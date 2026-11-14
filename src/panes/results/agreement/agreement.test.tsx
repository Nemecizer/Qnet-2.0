// The Agreement view, its plan and its runner (new in 2.1, ROADMAP B3 and C3; ledger VIZ-200…)
// against 0.90.34's own recorded runs (golden/runs/) and the preview's replay of them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../../dev/mockBackend";
import { mockRuns } from "../../../dev/mock/runs";
import { editorFor } from "../../../editor";
import { api } from "../../../lib/api";
import { getCommand } from "../../../lib/commands";
import { loadKv } from "../../../lib/kv";
import { MENU_SPEC, specItem } from "../../../lib/menuSpec";
import { agreement, currentRuns, tierOf } from "../../../results/insight";
import { holdModal, resetOverlays } from "../../../lib/overlays";
import type { RunMessage } from "../../../lib/types";
import { agreementWords as vocabularyWords } from "../../../lib/vocabulary";
import { noteStructure, resetStructures } from "../../../results/current";
import { resetRuns, startRun } from "../../../runs/state";
import { mockTauri } from "../../../test/tauri";
import { recommendations } from "../../../windows/methodchooser/advice";
import { addTab, removeTabs, selectTab, tabById } from "../../../workspace/store";
import type { ResultRecord } from "../model";
import { ResultsPane } from "../ResultsPane";
import twoOpinionsJson from "./fixtures/closed-two-opinions.json";
import { AgreementView } from "./AgreementView";
import { resetAdvice } from "./chooser";
import { checkWithAnother, resetAgreementCommands, runRecommended, solve, solveHelp, solvePreview } from "./commands";
import { attemptedIdentifiers, candidates, disagreementReasons, HEADLINE_METRICS, headlineOverlap, IDENTIFIER, labelFor, pickNext, recommendedPlan, REPORTS, rowFor as chooserRow, solveChoice } from "./plan";
import { ARROW_LEFT, ARROW_RIGHT, axisPosition, bannerFor, deviationText, markNotes, rowFor, rowsFor } from "./rows";
import { getSequence, permanentRefusal, resetSequence, runSequence, stopSequence } from "./runner";
import { showResultsView } from "./view";
import { agreementWords as w, pct, signedPct } from "./words";

const examples = import.meta.glob("../../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const records = import.meta.glob("../../../../golden/runs/*/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const recorded = (example: string, only?: string[]) =>
  Object.entries(records)
    .filter(([k]) => k.includes(`/${example}/`) && (!only || only.some((m) => k.includes(`/${m}/`))))
    .map(([, t]) => JSON.parse(t) as ResultRecord);
const read = (example: string, only?: string[]) => agreement(currentRuns(recorded(example, only), null));
const twoOpinions = twoOpinionsJson as unknown as ResultRecord[];
const documentOf = (stem: string) => ({ infiniteBuffers: false, canvasScale: 1, canvasPanOffset: [0, 0], ...JSON.parse(examples[`../../../../examples/${stem}.bnet`]) });

function openExample(stem: string): string {
  let id = "";
  act(() => {
    id = addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: documentOf(stem) });
  });
  return id;
}

async function ranking(stem: string) {
  const d = await api.methodDomain(documentOf(stem));
  return candidates(recommendations(d, await api.methodAvailability()), d.infiniteBuffers);
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(async () => {
  mockTauri(defaultHandlers());
  mockRuns.replayMs = 5;
  resetRuns();
  resetSequence();
  resetAdvice();
  resetAgreementCommands();
  resetOverlays();
  resetStructures();
  await loadKv();
});
afterEach(() => vi.restoreAllMocks());

describe("the verdict banner on recorded runs", () => {
  it("names the exact method when one has run, with how the others do against it (VIZ-200)", () => {
    const b = bannerFor(read("5stationtandem.inf", ["product_form", "qna", "rqna", "inf_sim"]), 4)!;
    expect(b.kind).toBe("exact");
    expect(b.title).toBe("Exact result available — Product Form solves this network exactly.");
    expect(b.detail[0]).toMatch(/^The other (methods are within 10 % of it; the largest gap is Monte Carlo at|3 methods agree with it)/);
    expect(bannerFor(read("5stationtandem.inf", ["product_form", "qna"]), 4)!.detail).toEqual(["The other 1 method agrees with it (within 2 %)."]);
    expect(bannerFor(read("5stationtandem.inf", ["product_form"]), 4)!.detail).toEqual([w.exactAlone]);
  });

  it("a closed network's exact result alone names the simulation that would check it (SIM-108)", () => {
    const run = (identifier: string, shortName: string) =>
      agreement([{ id: "r1", method: { identifier, displayName: shortName, shortName, layer: "Queueing process", fidelity: "Exact queueing result" }, status: "completed", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z", warnings: [], provenance: {}, measurements: [{ id: "m", stationID: "s", stationName: "S1", metric: "Throughput", estimate: 6.3, unit: "customers / time" }] } as never]);
    const closed = bannerFor(run("queue.closed-product-form", "Closed Product Form"), 4)!;
    expect(closed.kind).toBe("exact");
    expect(closed.detail).toEqual([w.exactAloneClosed]);
    expect(closed.detail[0]).toBe("No other method is needed to trust it; Check with Another Method simulates the network and shows the exact values inside the simulation's intervals.");
    expect(closed.detail[0]).not.toMatch(/no second method|yet/);
    expect(bannerFor(run("queue.open-bcmp-product-form", "Product Form"), 4)!.detail).toEqual([w.exactAlone]);
  });

  it("the closed example's exact solution lies inside Replicated Simulation's intervals, and the banner says the two agree (SIM-108)", () => {
    // Two real records of ClosedCentralServer.d3.N8, as `qnet-cli run closed_pf` and
    // `qnet-cli run sim_inproc` (defaults, seed 12345) filed them: the fixture is written by
    // cli/tests/cli_json.rs, which holds the same statement on a fresh run.
    const runs = currentRuns(twoOpinions, null);
    expect(runs.map((r) => [r.method.identifier, tierOf(r)])).toEqual([["queue.closed-product-form", "exact"], ["queue.des-replications", "simulation"]]);
    const a = agreement(runs);
    expect([a.quantities.length, a.compared, a.comparedWithExact, a.hasExact]).toEqual([18, 18, 18, true]);
    for (const q of a.quantities) {
      const exact = q.values.find((v) => v.tier === "exact")!;
      const simulated = q.values.find((v) => v.tier === "simulation")!;
      expect(q.reference, `${q.stationName} ${q.metric}`).toBe(exact);
      expect(simulated.interval, `${q.stationName} ${q.metric}`).not.toBeNull();
      // The exact value is inside the simulation's 95 % Student interval…
      expect(simulated.interval!.low).toBeLessThanOrEqual(exact.estimate);
      expect(simulated.interval!.high).toBeGreaterThanOrEqual(exact.estimate);
      // …which is a real interval (tight, and not a point), and the two are within 2 %.
      expect((simulated.interval!.high - simulated.interval!.low) / 2 / exact.estimate).toBeLessThan(0.02);
      expect(simulated.interval!.high).toBeGreaterThan(simulated.interval!.low);
      expect(q.verdict, `${q.stationName} ${q.metric}`).toBe("agree");
    }
    expect(a.verdict).toBe("agree");
    const b = bannerFor(a, 4)!;
    expect([b.kind, b.title, b.detail]).toEqual(["exact", "Exact result available — Closed PF solves this network exactly.", ["The other 1 method agrees with it (within 2 %)."]]);
    // Read alone, the simulation is a simulation: its own tier, its intervals, not "exact".
    const alone = bannerFor(agreement(runs.slice(1)), 4)!;
    expect([alone.kind, alone.detail]).toEqual(["single", ["Replicated Sim (Simulation) is the only evidence so far."]]);
  });

  it("says the methods agree with the simulation, counting them (VIZ-200)", () => {
    const b = bannerFor(read("5stationtandem.inf", ["inf_sim", "qna", "rqna", "sbd", "inf_sm"]), 4)!;
    expect(b.kind).toBe("agree");
    expect(b.title).toBe("The methods agree: 4 methods are within 2 % of the simulation.");
  });

  it("names the quantity and its range on a re-entrant network where the approximations differ (VIZ-200)", () => {
    const b = bannerFor(read("KumarSeidman90.d2.c4.reentrant.inf"), 4)!;
    expect(b.kind).toBe("disagree");
    expect(b.title).toBe("The methods disagree on S2: Mean sojourn time ranges from 1.5830 to 5.0740 time.");
    expect(b.detail[0]).toBe("MC SRBM is +138 % from the simulation (Monte Carlo).");
  });

  it("reads a finite-buffer network: exact when the CTMC ran, close to the simulation when only diffusion methods did (VIZ-200)", () => {
    const exact = bannerFor(read("MM1K.d1.c1.fin"), 4)!;
    expect(exact.title).toBe("Exact result available — CTMC solves this network exactly.");
    expect(exact.detail[0]).toBe("The other methods are within 10 % of it; the largest gap is FEM at 5.1 % on S1: Mean sojourn time.");
    const close = bannerFor(read("DaiHarrison91.d2.c1.fin"), 4)!;
    expect(close.kind).toBe("close");
    expect(close.title).toBe("The methods are close: every method is within 10 % of the simulation.");
    expect(close.detail[0]).toBe("The largest gap is FEM at 8.6 % on S2: Mean reported occupancy.");
  });

  it("asks for a second method when one has run, a reference when none arbitrates, and says when nothing is shared (VIZ-201)", () => {
    const single = bannerFor(read("5stationtandem.inf", ["qna"]), 4)!;
    expect(single.kind).toBe("single");
    expect(single.title).toBe("Only one method has run: run another to see how sure to be.");
    expect(single.detail).toEqual(["QNA (Approximation) is the only evidence so far."]);
    const pair = bannerFor(read("5stationtandem.inf", ["qna", "rqna"]), 4)!;
    expect(pair.title).toBe("The methods agree: 2 methods are within 2 % of each other.");
    expect(pair.wantsReference).toBe(true);
    expect(bannerFor(read("5stationtandem.inf", ["qna", "lp"]), 4)!.kind).toBe("incomparable");
    expect(bannerFor(agreement([]), 4)).toBeNull();
  });
});

describe("the rows and their marks", () => {
  it("places a deviation on the −10 % … +10 % axis and clips beyond it to an arrow (VIZ-202)", () => {
    expect(axisPosition(0).x).toBe(50);
    expect(axisPosition(-0.1)).toEqual({ x: 8, clipped: 0 });
    expect(axisPosition(0.1)).toEqual({ x: 92, clipped: 0 });
    expect(axisPosition(0.05).x).toBeCloseTo(71, 5);
    expect(axisPosition(0.4)).toEqual({ x: ARROW_RIGHT, clipped: 1 });
    expect(axisPosition(-3)).toEqual({ x: ARROW_LEFT, clipped: -1 });
    expect(pct(0.02)).toBe("2 %");
    expect(pct(0.0617)).toBe("6.2 %");
    expect(signedPct(-0.004)).toBe("−0.4 %");
    expect(signedPct(0)).toBe("0 %");
  });

  it("measures every other method from the reference, keeps coincident marks apart and draws the simulation's interval (VIZ-202)", () => {
    const a = read("KumarSeidman90.d2.c4.reentrant.inf");
    const row = rowFor(a.quantities.find((q) => q.stationName === "S2" && q.metric === "Mean sojourn time")!);
    expect(row.q.reference?.shortName).toBe("Monte Carlo");
    expect(row.marks.map((m) => m.value.shortName)).not.toContain("Monte Carlo");
    const mc = row.marks.find((m) => m.value.shortName === "MC SRBM")!;
    expect(mc.clipped).toBe(1);
    expect(row.worst).toBe(mc);
    const clippedLeft = row.marks.filter((m) => m.clipped === -1);
    expect(clippedLeft.length).toBeGreaterThan(1);
    expect(new Set(clippedLeft.map((m) => m.lane)).size).toBe(clippedLeft.length);
    const tandem = rowFor(read("5stationtandem.inf", ["inf_sim", "qna"]).quantities.find((q) => q.stationName === "S2" && q.metric === "Mean number in system")!);
    expect(tandem.marks[0].value.withinInterval).toBe(true);
    expect(tandem.marks[0].clipped).toBe(0);
    expect(tandem.band!.x1).toBeLessThan(50);
    expect(tandem.band!.x2).toBeGreaterThan(50);
  });

  it("lists the headline metrics first by station, sorts by largest disagreement, and filters by station or metric (VIZ-203)", () => {
    const a = read("KumarSeidman90.d2.c4.reentrant.inf");
    const base = { station: null, metric: null, uncompared: false, sort: "station" as const };
    const byStation = rowsFor(a, base);
    expect(byStation.filter((r) => r.q.stationName === "S1").slice(0, 4).map((r) => r.q.metric)).toEqual(["Mean number in system", "Mean sojourn time", "Utilization", "Throughput"]);
    expect(byStation.every((r) => r.compared)).toBe(true);
    const worstFirst = rowsFor(a, { ...base, sort: "disagreement" });
    expect(worstFirst[0].q.worst).toBe(Math.max(...worstFirst.map((r) => r.q.worst ?? 0)));
    expect(rowsFor(a, { ...base, station: "S2" }).every((r) => r.q.stationName === "S2")).toBe(true);
    expect(rowsFor(a, { ...base, metric: "Utilization" }).every((r) => r.q.metric === "Utilization")).toBe(true);
    expect(rowsFor(a, { ...base, uncompared: true }).length).toBeGreaterThan(byStation.length);
    // With one method there is nothing compared, so its quantities are all listed.
    expect(rowsFor(read("5stationtandem.inf", ["qna"]), base)).toHaveLength(20);
  });
});

describe("which method to run next, by the Method Chooser's ranking", () => {
  const walk = (cands: Awaited<ReturnType<typeof ranking>>, n: number) => {
    const tried = new Set<string>();
    const out: string[] = [];
    let sim = false;
    for (let i = 0; i < n; i++) {
      const p = pickNext(cands, tried, sim);
      if (!p) break;
      tried.add(p.candidate.identifier);
      sim ||= p.candidate.kind === "simulation";
      out.push(`${p.candidate.advice.id}:${p.why}`);
    }
    return out;
  };

  it("knows the record identifier of every run label 0.90.34 filed (VIZ-204)", () => {
    for (const [path, text] of Object.entries(records)) {
      const label = path.split("/").slice(-2)[0];
      if (/cmp|testset|spc/.test(label)) continue;
      expect(IDENTIFIER[label], label).toBe((JSON.parse(text) as ResultRecord).method.identifier);
    }
    expect(labelFor("queue.des", true)).toBe("inf_sim");
    expect(labelFor("queue.des", false)).toBe("sim");
    expect(labelFor("srbm.lp", false)).toBe("flp");
  });

  it("starts with the exact method on a product-form network, then a simulation, then the best approximation (VIZ-204)", async () => {
    const c = await ranking("5stationtandem.inf");
    expect(walk(c, 3)).toEqual(["open-product-form:exact", "simulation-infinite:simulation", "qna:approximation"]);
    expect(solveChoice(c)?.candidate.label).toBe("product_form");
    expect(recommendedPlan(c).map((x) => x.label)).toEqual(["product_form", "inf_sim", "qna", "sbd"]);
  });

  it("starts with a simulation when nothing is exact, and prefers RQNA under feedback (VIZ-204)", async () => {
    const c = await ranking("KumarSeidman90.d2.c4.reentrant.inf");
    expect(walk(c, 2)).toEqual(["simulation-infinite:simulation", "rqna:approximation"]);
    expect(c.some((x) => x.kind === "exact")).toBe(false);
    expect(recommendedPlan(c).map((x) => x.label).slice(0, 2)).toEqual(["inf_sim", "rqna"]);
  });

  it("uses the finite-buffer methods on a finite network: the exact CTMC when it applies (VIZ-204)", async () => {
    expect(walk(await ranking("MM1K.d1.c1.fin"), 3)).toEqual(["ctmc:exact", "simulation-finite:simulation", "finite-decomposition:approximation"]);
    expect(walk(await ranking("DaiHarrison91.d2.c1.fin"), 2)).toEqual(["simulation-finite:simulation", "fem-finite:approximation"]);
  });

  it("ranks a multiclass product-form network the same way, and never offers a method twice (VIZ-204)", async () => {
    const c = await ranking("3d2ctandem.inf");
    const all = walk(c, 40);
    expect(all.slice(0, 2)).toEqual(["open-product-form:exact", "simulation-infinite:simulation"]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(c.length);
    // A simulation already there: the next pick after the exact method is an approximation.
    expect(pickNext(c, new Set(["queue.open-bcmp-product-form"]), true)?.why).toBe("approximation");
  });

  it("gives a likely reason only when the Chooser's rules do (VIZ-205)", async () => {
    const doc = documentOf("KumarSeidman90.d2.c4.reentrant.inf");
    const domain = await api.methodDomain(doc);
    const rows = recommendations(domain, await api.methodAvailability());
    const a = read("KumarSeidman90.d2.c4.reentrant.inf");
    const q = a.quantities.find((x) => x.stationName === "S2" && x.metric === "Mean sojourn time")!;
    const of = (short: string) => q.values.find((v) => v.shortName === short)!;
    const rho = (x: number) => x.toFixed(2);
    // QNA under feedback: the Chooser's own caution.
    expect(disagreementReasons(q, of("QNA"), chooserRow("queue-approx.qna", rows, true), domain, 0.9, rho)).toEqual(["Fast two-moment approximation; feedback can weaken renewal assumptions."]);
    // A heavy-traffic model at a lightly loaded station.
    expect(disagreementReasons(q, of("Spectral"), chooserRow("srbm.spectral", rows, true), domain, 0.45, rho)).toEqual([
      "Spectral is a heavy-traffic model (Heavy-traffic Brownian model); S2 runs at a utilization of 0.45, and such a model is generally less accurate the further a station is from full load.",
    ]);
    // The sentence claims no threshold: 0.8 only decides when it is offered (plan.ts `LIGHT_LOAD_DISPLAY`).
    expect(w.heavyTraffic("M", "a", "S", "0.45")).not.toMatch(/0\.8|below|threshold/);
    // In heavy traffic, and for RQNA, the rules give nothing: say nothing.
    expect(disagreementReasons(q, of("Spectral"), chooserRow("srbm.spectral", rows, true), domain, 0.95, rho)).toEqual([]);
    expect(disagreementReasons(q, of("RQNA"), chooserRow("queue-approx.rqna", rows, true), domain, 0.45, rho)).toEqual([]);
    expect(disagreementReasons(q, of("RQNA"), null, domain, 0.45, rho)).toEqual([]);
  });
});

describe("running methods one after another", () => {
  it("waits for each to finish, notes a refused method and goes on (VIZ-206)", async () => {
    const id = openExample("5stationtandem.inf");
    const seen: string[] = [];
    const done = await runSequence(id, [
      { label: "qna", command: "run:qna", name: "Whitt QNA" },
      { label: "qbd", command: "run:qbd", name: "Exact Matrix-Analytic QBD" },
      { label: "rqna", command: "run:rqna", name: "Whitt–You RQNA" },
    ]);
    mockRuns.starts.forEach((s) => seen.push(s.method));
    expect(seen).toEqual(["qna", "qbd", "rqna"]);
    expect(done?.steps.map((s) => s.state)).toEqual(["done", "refused", "done"]);
    expect(done?.finished).toBe(true);
    expect(mockRuns.records.map((r) => (r as unknown as ResultRecord).method.identifier)).toEqual(["queue-approx.qna", "queue-approx.rqna"]);
  });

  it("refuses a method whose Run-menu gate is closed, with the gate's reason (VIZ-206)", async () => {
    const id = openExample("5stationtandem.inf");
    const done = await runSequence(id, [{ label: "sim", command: "run:monte-carlo-finite", name: "Monte Carlo" }]);
    expect(done?.steps[0]).toMatchObject({ state: "refused", reason: expect.stringMatching(/infinite buffers/i) });
    expect(mockRuns.starts).toHaveLength(0);
  });

  it("Stop interrupts the method in progress and leaves the rest unrun (VIZ-207)", async () => {
    mockRuns.replayMs = 400;
    const id = openExample("5stationtandem.inf");
    const whole = runSequence(id, [
      { label: "inf_sim", command: "run:monte-carlo-infinite", name: "Monte Carlo" },
      { label: "qna", command: "run:qna", name: "Whitt QNA" },
    ]);
    await waitFor(() => expect(mockRuns.starts).toHaveLength(1));
    expect(getSequence()).toMatchObject({ index: 0, finished: false });
    // A second sequence does not start while one runs.
    expect(await runSequence(id, [{ label: "rqna", command: "run:rqna", name: "RQNA" }])).toBeNull();
    await stopSequence();
    const done = await whole;
    expect(done?.steps.map((s) => s.state)).toEqual(["stopped", "skipped"]);
    expect(done?.stopping).toBe(true);
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["inf_sim"]);
  });

  it("Run Recommended Methods runs the exact method, a simulation and two approximations, skipping what has run (VIZ-208)", async () => {
    const id = openExample("5stationtandem.inf");
    await act(async () => void (await runSequence(id, [{ label: "qna", command: "run:qna", name: "Whitt QNA" }])));
    mockRuns.starts.length = 0;
    await act(async () => void (await runRecommended(id)));
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["product_form", "inf_sim", "sbd"]);
    // No sheet opened and no overrides were sent: the settings' defaults.
    expect(mockRuns.starts.every((s) => Object.keys(s.overrides ?? {}).length === 0)).toBe(true);
    mockRuns.starts.length = 0;
    await act(async () => void (await runRecommended(id)));
    expect(mockRuns.starts).toHaveLength(0);
    expect(tabById(id)!.log.at(-1)!.text).toBe(w.recommendedNone);
  });

  it("Check with Another Method walks the ranking over what has been tried (VIZ-209)", async () => {
    const id = openExample("KumarSeidman90.d2.c4.reentrant.inf");
    expect((await checkWithAnother(id))?.label).toBe("inf_sim");
    expect((await checkWithAnother(id))?.label).toBe("rqna");
    expect((await checkWithAnother(id))?.label).toBe("lp");
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["inf_sim", "rqna", "lp"]);
  });
});

describe("Run ▸ Solve and the menu", () => {
  it("adds Solve (⌘↩), Check with Another Method and Run Recommended Methods to the Run menu, each registered (VIZ-210)", () => {
    render(<ResultsPane />);
    expect(specItem("run:solve", MENU_SPEC)).toMatchObject({ label: "Solve", accel: "CmdOrCtrl+Enter" });
    expect(specItem("run:check-another", MENU_SPEC)?.label).toBe("Check with Another Method");
    expect(specItem("run:recommended", MENU_SPEC)?.label).toBe("Run Recommended Methods");
    for (const id of ["run:solve", "run:check-another", "run:recommended"]) expect(getCommand(id), id).toBeDefined();
  });

  it("names in its tooltip the method it will run and why (VIZ-210)", async () => {
    const id = openExample("5stationtandem.inf");
    expect(getCommand("run:solve")!.subtitle).toBe(w.solveHelpIdle);
    await waitFor(() => expect(solvePreview(tabById(id)!)).not.toBeNull());
    expect(solveHelp(solvePreview(tabById(id)!))).toBe(
      "Runs Exact Open Product Form: an exact method applies to this network. Computes exact M/M/c station measures analytically without truncating the infinite state space.",
    );
    expect(getCommand("run:solve")!.subtitle).toMatch(/^Runs Exact Open Product Form: an exact method applies/);
    const other = openExample("KumarSeidman90.d2.c4.reentrant.inf");
    await waitFor(() => expect(solvePreview(tabById(other)!)).not.toBeNull());
    expect(solveHelp(solvePreview(tabById(other)!))).toMatch(/^Runs Monte Carlo: no exact method applies, so a simulation is the reference\. Directly simulates/);
  });

  it("is dimmed without a network (VIZ-210)", () => {
    act(() => void addTab({ title: "Untitled" }));
    expect(getCommand("run:solve")!.when!()).toBe("Draw or open a network first");
  });
});

describe("the view in the Results pane", () => {
  const agreementTab = () => screen.getByRole("radio", { name: "Agreement" });
  const view = () => document.querySelector(".agr-view") as HTMLElement;

  it("is reached from the header's Table | Agreement switch (VIZ-211)", async () => {
    openExample("5stationtandem.inf");
    render(<ResultsPane />);
    await settle();
    const group = screen.getByRole("radiogroup", { name: "Results view" });
    expect(within(group).getByRole("radio", { name: "Table" })).toHaveAttribute("aria-checked", "true");
    expect(view()).toBeNull();
    fireEvent.click(agreementTab());
    expect(agreementTab()).toHaveAttribute("aria-checked", "true");
    expect(view()).toHaveAttribute("aria-label", "Agreement");
    expect(document.querySelector(".results-split")).toHaveAttribute("hidden");
    fireEvent.click(within(group).getByRole("radio", { name: "Table" }));
    expect(view()).toBeNull();
  });

  it("with no runs says what to press, and Solve runs the best method and shows the exact verdict (VIZ-212)", async () => {
    const id = openExample("5stationtandem.inf");
    render(<ResultsPane />);
    fireEvent.click(agreementTab());
    expect(within(view()).getByText("No Results Yet")).toBeInTheDocument();
    expect(screen.getByText(/^Press Solve \(⌘↩\) to run the best method for this network\./)).toBeInTheDocument();
    const button = await screen.findByRole("button", { name: "Solve with Exact Open Product Form" });
    expect(button).toHaveAttribute("title", expect.stringMatching(/^Runs Exact Open Product Form: an exact method applies/));
    expect(screen.getByRole("button", { name: "Run Recommended Methods" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(button);
      await waitFor(() => expect(mockRuns.records).toHaveLength(1));
    });
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["product_form"]);
    expect(await screen.findByRole("heading", { name: "Exact result available — Product Form solves this network exactly." })).toBeInTheDocument();
    expect(document.querySelector(".agr-banner")).toHaveAttribute("data-verdict", "exact");
    expect(screen.getByText(w.exactAlone)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Check with Monte Carlo" })).toBeInTheDocument();
    // Solve again: the result is there, nothing runs.
    await act(async () => void (await solve(id)));
    expect(mockRuns.starts).toHaveLength(1);
  });

  it("Run ▸ Solve shows the Agreement view from the table (VIZ-212)", async () => {
    const id = openExample("KumarSeidman90.d2.c4.reentrant.inf");
    render(<ResultsPane />);
    await settle();
    expect(view()).toBeNull();
    await act(async () => void (await solve(id)));
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["inf_sim"]);
    expect(view()).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Only one method has run: run another to see how sure to be." })).toBeInTheDocument();
    expect(screen.getByText("Monte Carlo (Simulation) is the only evidence so far.")).toBeInTheDocument();
    // The single-method state offers the next method by the ranking, and the recommended set.
    const check = await screen.findByRole("button", { name: "Check with Whitt–You RQNA" });
    expect(check).toHaveAttribute("title", "Runs Whitt–You RQNA, the most informative method that has not run for this network: it is the best-ranked method left.");
    expect(screen.getByRole("button", { name: "Run Recommended Methods" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(check);
      await waitFor(() => expect(mockRuns.records).toHaveLength(2));
    });
    expect(await screen.findByRole("heading", { name: /^The methods disagree on S\d: / })).toBeInTheDocument();
    expect(document.querySelector(".agr-banner")).toHaveAttribute("data-verdict", "disagree");
  });

  it("draws a row per quantity with named, keyboard-reachable marks and the exact figure on focus (VIZ-213)", async () => {
    const id = openExample("KumarSeidman90.d2.c4.reentrant.inf");
    render(<ResultsPane />);
    showResultsView("agreement");
    await act(async () => void (await runSequence(id, ["inf_sim", "qna", "rqna", "inf_sm"].map((label) => ({ label, command: null, name: label })))));
    const table = await screen.findByRole("table", { name: w.tableLabel });
    expect(table).toHaveAttribute("aria-describedby", document.querySelector(".agr-banner-text")!.id);
    // Grouped by station, the headline metrics first.
    expect([...table.querySelectorAll(".agr-group th")].map((x) => x.textContent)).toEqual(["S1", "S2"]);
    const rows = [...table.querySelectorAll("tr[data-quantity]")] as HTMLElement[];
    expect(rows.slice(0, 4).map((r) => r.querySelector("th")!.textContent)).toEqual(["Mean number in system", "Mean sojourn time", "Utilization", "Throughput"]);
    const row = rows[1];
    expect(within(row).getByText(/^\d+\.\d{6} time$/)).toBeInTheDocument();
    expect(row.querySelector(".agr-reference")).toHaveTextContent("Monte Carlo");
    expect(row.querySelector(".agr-verdict")).toHaveTextContent("Disagree");
    expect(rows[0].querySelector(".agr-band")).not.toBeNull();
    const axis = within(row).getByRole("group", { name: /^Each method's deviation for S1: Mean sojourn time/ });
    const marks = [...axis.querySelectorAll("[data-mark]")] as unknown as HTMLElement[];
    expect(marks.map((m) => m.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(marks[0]).toHaveAttribute("aria-label", expect.stringMatching(/^QNA \(Approximation\): \d+\.\d{6} time, −25\.9 % from Monte Carlo \(Simulation\), beyond the axis$/));
    expect(marks[0]).toHaveAttribute("data-clipped", "-1");
    // The largest gap reads in the row; a focused mark replaces it with its exact figure.
    expect(row.querySelector(".agr-gap")!.textContent).toMatch(/^−25\.9 % · (QNA|RQNA)$/);
    act(() => marks[0].focus());
    expect(row.querySelector(".agr-gap")!.textContent).toMatch(/^QNA: \d+\.\d{6} time \(−25\.9 %\)$/);
    fireEvent.keyDown(marks[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(marks[1]);
    fireEvent.keyDown(marks[1], { key: "End" });
    expect(document.activeElement).toBe(marks[2]);
    fireEvent.keyDown(marks[2], { key: "ArrowDown" });
    expect(rows[2].contains(document.activeElement)).toBe(true);
    // A value inside the simulation's interval says so.
    expect(table.querySelector('[aria-label*="inside the simulation\'s interval"]')).not.toBeNull();

    // Largest disagreement first, and the filters.
    fireEvent.change(screen.getByRole("combobox", { name: "Sort quantities" }), { target: { value: "disagreement" } });
    expect(table.querySelector(".agr-group")).toBeNull();
    expect(table.querySelector("tr[data-quantity] th")!.textContent).toMatch(/^S\d · Mean sojourn time$/);
    fireEvent.change(screen.getByRole("combobox", { name: "Metric" }), { target: { value: "Utilization" } });
    expect(table.querySelectorAll("tr[data-quantity]")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Station" }), { target: { value: "S2" } });
    expect(table.querySelectorAll("tr[data-quantity]")).toHaveLength(1);
  });

  it("explains a method on demand in the Method Chooser's words, with a likely reason when its rules give one (VIZ-214)", async () => {
    const id = openExample("KumarSeidman90.d2.c4.reentrant.inf");
    render(<ResultsPane />);
    showResultsView("agreement");
    await act(async () => void (await runSequence(id, ["inf_sim", "qna", "rqna"].map((label) => ({ label, command: null, name: label })))));
    const methods = await screen.findByRole("group", { name: "Methods read" });
    expect(within(methods).getAllByRole("button").map((b) => b.textContent)).toEqual(["Monte CarloSimulation", "QNAApproximation", "RQNAApproximation"]);
    const button = within(methods).getAllByRole("button")[1];
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = await screen.findByRole("region", { name: "What QNA is and when it can be trusted" });
    await waitFor(() => expect(within(panel).getByText("Whitt QNA")).toBeInTheDocument());
    expect(within(panel).getByText("Fast two-moment approximation; feedback can weaken renewal assumptions.", { selector: "dd" })).toBeInTheDocument();
    expect(within(panel).getByText("Open network, class-blind FCFS station approximation and two-moment arrival/service descriptions.")).toBeInTheDocument();
    // The Chooser's caution is already the "what it is" sentence, so it is not said twice there; the banner gives it as the likely reason.
    expect(within(panel).queryByText("Why it may differ here")).toBeNull();
    expect(document.querySelector(".agr-banner .agr-reason")).toHaveTextContent("A likely reason: Fast two-moment approximation; feedback can weaken renewal assumptions.");
    // RQNA disagrees too, and the Chooser's rules give no reason: nothing is said.
    fireEvent.click(within(methods).getAllByRole("button")[2]);
    const rqna = await screen.findByRole("region", { name: "What RQNA is and when it can be trusted" });
    expect(within(rqna).queryByText("Why it may differ here")).toBeNull();
    fireEvent.click(within(methods).getAllByRole("button")[2]);
    expect(screen.queryByRole("region", { name: /What RQNA is/ })).toBeNull();
  });

  it("shows the runner's progress with Stop, then how it went (VIZ-207)", async () => {
    mockRuns.replayMs = 300;
    const id = openExample("5stationtandem.inf");
    render(<ResultsPane />);
    showResultsView("agreement");
    await settle();
    let whole!: Promise<unknown>;
    act(() => {
      whole = runSequence(id, [
        { label: "inf_sim", command: "run:monte-carlo-infinite", name: "Monte Carlo" },
        { label: "qna", command: "run:qna", name: "Whitt QNA" },
      ]);
    });
    const line = await screen.findByRole("status", { name: "Running methods" });
    expect(line).toHaveTextContent("Running 1 of 2: Monte Carlo…");
    await waitFor(() => expect(mockRuns.starts).toHaveLength(1));
    await act(async () => {
      fireEvent.click(within(line).getByRole("button", { name: "Stop" }));
      await whole;
    });
    const after = screen.getByRole("status", { name: "Running methods" });
    expect(after).toHaveTextContent("Stopped after 0 of 2 methods. Monte Carlo was stopped. Whitt QNA was not run.");
    fireEvent.click(within(after).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status", { name: "Running methods" })).toBeNull();
  });

  it("says the network changed when every run is stale, and runs them again (VIZ-215)", async () => {
    const id = openExample("5stationtandem.inf");
    render(<ResultsPane />);
    showResultsView("agreement");
    await act(async () => void (await runSequence(id, ["product_form", "qna"].map((label) => ({ label, command: null, name: label })))));
    expect(await screen.findByRole("heading", { name: /^Exact result available/ })).toBeInTheDocument();
    const editor = editorFor(id);
    // A change a solver reads; moving a node alone no longer makes a run stale (src/results/current.ts).
    const node = editor.nodes.find((n) => n.kind === "station")!;
    await act(async () => {
      editor.updateNumberOfServers(node.id, 2);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(await screen.findByText("The network changed since these runs")).toBeInTheDocument();
    expect(screen.getByText(/^2 earlier runs belong to the network as it was\./)).toBeInTheDocument();
    mockRuns.starts.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run Them Again" }));
      await waitFor(() => expect(mockRuns.starts).toHaveLength(2));
      await waitFor(() => expect(getSequence()?.finished).toBe(true));
    });
    expect(mockRuns.starts.map((s) => s.method).sort()).toEqual(["product_form", "qna"]);
  });

  it("renders in a detached pane's document through its own elements", async () => {
    const id = openExample("5stationtandem.inf");
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const host = frame.contentDocument!.createElement("div");
    frame.contentDocument!.body.appendChild(host);
    render(<ResultsPane />, { container: host });
    showResultsView("agreement");
    await act(async () => void (await runSequence(id, ["inf_sim", "qna"].map((label) => ({ label, command: null, name: label })))));
    await waitFor(() => expect(host.querySelector(".agr-table")).not.toBeNull());
    const marks = [...host.querySelectorAll("[data-mark]")] as unknown as HTMLElement[];
    act(() => marks[0].focus());
    expect(frame.contentDocument!.activeElement).toBe(marks[0]);
    expect(host.querySelector(".agr-gap")!.textContent).toMatch(/^QNA: /);
    frame.remove();
  });
});

// ── The independent review's defects, each with the test that fails without its fix ─────────────

describe("what the banner and the rows may not overstate (review)", () => {
  type M = ResultRecord["measurements"][number];
  const one = (label: string) => recorded("5stationtandem.inf", [label])[0];
  const as = (r: ResultRecord, change: (m: M) => M, extra: Partial<ResultRecord> = {}): ResultRecord => ({ ...r, measurements: r.measurements.map(change), ...extra });
  const elsewhere = (r: ResultRecord) => as(r, (m) => ({ ...m, metric: `Other ${m.metric}` }));
  const bound = (r: ResultRecord) => as(r, (m) => ({ ...m, estimate: m.estimate * 0.2 }), { id: "BOUND", method: { ...r.method, identifier: "srbm.bar-moment-bounds", shortName: "BAR bounds", fidelity: "SRBM bound relaxation" } as ResultRecord["method"] });
  const nis = (a: ReturnType<typeof agreement>, station = "S2") => a.quantities.find((q) => q.stationName === station && q.metric === "Mean number in system")!;

  it("says Exact only when the exact run was held against something or stands alone", () => {
    // Exact, but no quantity in common with the other run: nothing was compared.
    const apart = bannerFor(agreement([elsewhere(one("product_form")), one("qna")]), 4)!;
    expect(apart.title).toBe("Product Form is exact, but reports different quantities from the other methods, so nothing could be compared.");
    expect(apart.kind).toBe("incomparable");
    expect(apart.title).not.toMatch(/Exact result available/);
    // The others compared among themselves, none with the exact run: their verdict, and that said.
    const aside = bannerFor(agreement([elsewhere(one("product_form")), one("qna"), one("rqna")]), 4)!;
    expect(aside.kind).toBe("agree");
    expect(aside.title).toBe("The methods agree: 2 methods are within 2 % of each other.");
    expect(aside.detail).toEqual([w.exactNotCompared("Product Form")]);
    expect(aside.wantsReference).toBe(false);
    // A partial exact run is not "exact".
    expect(bannerFor(agreement([{ ...one("product_form"), status: "partial" }, one("qna")]), 4)!.kind).not.toBe("exact");
    // Alone, and compared, it still is.
    expect(bannerFor(agreement([one("product_form")]), 4)!.kind).toBe("exact");
    expect(bannerFor(agreement([one("product_form"), one("qna")]), 4)!.title).toMatch(/^Exact result available/);
  });

  it("says a simulation's interval is too wide to judge, on the row and in the banner for a headline quantity", () => {
    const loose = as(one("inf_sim"), (m) => (m.uncertainty ? { ...m, uncertainty: { ...m.uncertainty, lowerBound: m.estimate * 0.5, upperBound: m.estimate * 1.5 } } : m));
    const a = agreement([loose, one("qna")]);
    expect(nis(a).referenceUncertain).toBe(true);
    expect(rowFor(nis(a)).uncertain).toBe("wide");
    expect(bannerFor(a, 4)!.detail).toContain("The simulation's interval is too wide to judge; run it longer.");
    // A quantity the simulation gives no interval for is not called "too wide".
    expect(rowFor(a.quantities.find((q) => q.metric === "Mean sojourn time" && q.reference)!).uncertain).toBe("none");
    // The recorded run's intervals are tight: nothing is said.
    const tight = agreement([one("inf_sim"), one("qna")]);
    expect(rowFor(nis(tight)).uncertain).toBeNull();
    expect(bannerFor(tight, 4)!.detail).not.toContain(w.referenceTooWide);
  });

  it('shows "reference is zero" against a zero reference, never an infinite percentage', () => {
    const zero = as(one("product_form"), (m) => ({ ...m, estimate: 0 }));
    const a = agreement([zero, one("qna")]);
    const row = rowFor(nis(a));
    expect(row.q.referenceZero).toBe(true);
    expect(row.marks[0].unscaled).toBe(true);
    expect(deviationText(row.marks[0])).toBeNull();
    expect(markNotes(row.marks[0], row.q)).toEqual(["reference is zero"]);
    const b = bannerFor(a, 4)!;
    expect(b.detail[0]).toMatch(/^QNA gives \d+\.\d{4} customers on S\d: .*, where the reference is zero\.$/);
    expect(JSON.stringify(b)).not.toContain("∞");
    expect(pct(Number.POSITIVE_INFINITY)).toBe("reference is zero");
    expect(signedPct(Number.NEGATIVE_INFINITY)).toBe("reference is zero");
  });

  it("lists a bound as a bound, with no deviation figure, and never as the largest gap", () => {
    const a = agreement([one("inf_sim"), one("qna"), bound(one("qna"))]);
    const row = rowFor(nis(a));
    const mark = row.marks.find((m) => m.value.isBound)!;
    expect(deviationText(mark)).toBeNull();
    expect(markNotes(mark, row.q)).toEqual(["bound"]);
    expect(row.worst!.value.shortName).toBe("QNA");
    // An estimate and a bound are not two estimates: the row is not "compared".
    const lone = rowFor(nis(agreement([one("qna"), bound(one("qna"))])));
    expect(lone.compared).toBe(false);
    expect(lone.lone!.shortName).toBe("QNA");
    expect(lone.marks.map((m) => m.value.shortName)).toEqual(["BAR bounds"]);
  });

  it("labels partial runs, bounds and an uncertain reference in the view, and gives an incomparable exact run no Exact styling", async () => {
    const id = openExample("5stationtandem.inf");
    const loose = as(one("inf_sim"), (m) => (m.uncertainty ? { ...m, uncertainty: { ...m.uncertainty, lowerBound: m.estimate * 0.5, upperBound: m.estimate * 1.5 } } : m));
    const partial: ResultRecord = { ...one("qna"), status: "partial" };
    const first = render(<AgreementView tab={tabById(id)!} records={[loose, partial, bound(one("qna"))]} fingerprint={null} decimals={4} />);
    await settle();
    const chip = screen.getByRole("button", { name: /QNA/ });
    expect(chip).toHaveAttribute("data-partial", "true");
    expect(chip).toHaveTextContent("partial");
    const row = [...document.querySelectorAll("tr[data-quantity]")].find((r) => r.querySelector("th")!.textContent === "Mean number in system") as HTMLElement;
    const label = (method: string) => row.querySelector(`[data-mark="${method}"]`)!.getAttribute("aria-label")!;
    expect(label("queue-approx.qna")).toMatch(/^QNA \(Approximation\): .* from Monte Carlo \(Simulation\), partial/);
    expect(label("srbm.bar-moment-bounds")).toMatch(/^BAR bounds \(Bound\): \d+\.\d{4} customers, bound/);
    expect(label("srbm.bar-moment-bounds")).not.toMatch(/%/);
    expect(row.querySelector('[data-mark="srbm.bar-moment-bounds"]')).toHaveAttribute("data-bound", "true");
    expect(row.querySelector(".agr-reference")).toHaveTextContent(w.referenceTooWide);
    expect(row.querySelector(".agr-gap")!.textContent).toMatch(/· QNA$/);
    first.unmount();

    render(<AgreementView tab={tabById(id)!} records={[elsewhere(one("product_form")), one("qna")]} fingerprint={null} decimals={4} />);
    await settle();
    expect(screen.getByRole("heading", { name: w.exactNothingShared("Product Form") })).toBeInTheDocument();
    expect(document.querySelector(".agr-banner")).toHaveAttribute("data-verdict", "incomparable");
  });
});

describe("what counts as tried, and what is recommended (review)", () => {
  it("counts a run as tried after a change of layout alone, as currentRuns counts it current", () => {
    const qna = recorded("5stationtandem.inf", ["qna"])[0];
    const snapshot = qna.provenance.networkSnapshot as { nodes: { position: number[] }[]; links: unknown[]; infiniteBuffers: boolean };
    const moved = { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n, position: [n.position[0] + 40, n.position[1]] })) };
    noteStructure("FINGERPRINT-AFTER-THE-DRAG", moved);
    expect(currentRuns([qna], "FINGERPRINT-AFTER-THE-DRAG")).toHaveLength(1);
    expect([...attemptedIdentifiers([qna], "FINGERPRINT-AFTER-THE-DRAG")]).toEqual(["queue-approx.qna"]);
    // A change the solvers read is still a different network.
    noteStructure("ANOTHER-NETWORK", { ...snapshot, nodes: snapshot.nodes.slice(1) });
    expect(attemptedIdentifiers([qna], "ANOTHER-NETWORK").size).toBe(0);
  });

  it("holds the table of what each method reports to the recorded runs", () => {
    const seen = new Map<string, Set<string>>();
    for (const [path, text] of Object.entries(records)) {
      const label = path.split("/").slice(-2)[0];
      if (/cmp|testset|spc/.test(label)) continue;
      const metrics = (JSON.parse(text) as ResultRecord).measurements.map((m) => m.metric);
      if (!metrics.length) continue;
      const set = seen.get(label) ?? new Set<string>();
      metrics.forEach((m) => set.add(m));
      seen.set(label, set);
    }
    expect(Object.fromEntries([...seen].map(([label, set]) => [label, [...set].sort()]))).toEqual(Object.fromEntries(Object.entries(REPORTS).map(([label, list]) => [label, [...list].sort()])));
    // Every label in the table is one the plan can start.
    for (const label of Object.keys(REPORTS)) expect(IDENTIFIER[label], label).toBeDefined();
    expect(HEADLINE_METRICS).toEqual(["Mean number in system", "Mean sojourn time", "Utilization", "Throughput"]);
  });

  it("recommends approximations that share a headline quantity with the others, not Linear Program", async () => {
    for (const stem of ["5stationtandem.inf", "KumarSeidman90.d2.c4.reentrant.inf", "3d2ctandem.inf", "DaiHarrison91.d2.c1.fin"]) {
      const plan = recommendedPlan(await ranking(stem));
      expect(plan.filter((c) => c.kind === "approximation"), stem).toHaveLength(2);
      expect(plan.every((c) => headlineOverlap(c.label) > 0), stem).toBe(true);
      expect(plan.map((c) => c.label), stem).not.toContain("lp");
    }
    expect(headlineOverlap("lp")).toBe(0);
    // With nothing else to offer, a method that shares nothing is still better than none.
    const c = await ranking("5stationtandem.inf");
    const lp = c.filter((x) => x.label === "lp" || x.kind !== "approximation");
    expect(recommendedPlan(lp).map((x) => x.label)).toContain("lp");
  });

  it("re-exports its words through the vocabulary", () => {
    expect(vocabularyWords).toBe(w);
  });
});

describe("the runner's sequence belongs to its tab and to its own launches (review)", () => {
  const finished = (succeeded: boolean): RunMessage => ({ kind: "finished", summary: "", statusBar: "", exitCode: succeeded ? 0 : 1, userStopped: false, succeeded, recordId: null, filed: null, filedReason: null });
  const qnaStep = { label: "qna", command: "run:qna", name: "Whitt QNA" };

  it("does not gate a step against another tab: it ends, saying so, when its tab is not in front", async () => {
    const id = openExample("5stationtandem.inf");
    openExample("MM1K.d1.c1.fin");
    // The finite network is in front: the old gate read it and refused QNA "for a finite network".
    const done = await runSequence(id, [qnaStep, { label: "rqna", command: "run:rqna", name: "RQNA" }]);
    expect(done).toMatchObject({ finished: true, ended: "tab-not-front" });
    expect(done?.steps.map((s) => s.state)).toEqual(["skipped", "skipped"]);
    expect(done?.steps[0].reason).toBeUndefined();
    expect(mockRuns.starts).toHaveLength(0);
  });

  it("ends before the next step when the tab stops being the one in front, or is closed", async () => {
    mockRuns.replayMs = 60;
    const id = openExample("5stationtandem.inf");
    const other = openExample("MM1K.d1.c1.fin");
    act(() => selectTab(id));
    const whole = runSequence(id, [qnaStep, { label: "rqna", command: "run:rqna", name: "RQNA" }]);
    await waitFor(() => expect(mockRuns.starts).toHaveLength(1));
    act(() => selectTab(other));
    const done = await whole;
    expect(done?.steps.map((s) => s.state)).toEqual(["done", "skipped"]);
    expect(done?.ended).toBe("tab-not-front");
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["qna"]);

    resetSequence();
    act(() => removeTabs([id]));
    expect(await runSequence(id, [qnaStep])).toMatchObject({ finished: true, ended: "tab-closed" });
    expect(mockRuns.starts).toHaveLength(1);
  });

  it("says in its summary line that the tab was no longer in front", async () => {
    const id = openExample("5stationtandem.inf");
    const other = openExample("MM1K.d1.c1.fin");
    await act(async () => void (await runSequence(id, [qnaStep, { label: "rqna", command: "run:rqna", name: "RQNA" }])));
    act(() => selectTab(id));
    render(<AgreementView tab={tabById(id)!} records={[]} fingerprint={null} decimals={4} />);
    expect(screen.getByRole("status", { name: "Running methods" })).toHaveTextContent(`Ran 0 of 2 methods. ${w.endedTabNotFront}`);
    expect(other).not.toBe(id);
  });

  it("is not ended by a late finish from an earlier run of the same method on the same tab", async () => {
    const sends: ((m: RunMessage) => void)[] = [];
    vi.spyOn(api, "runStart").mockImplementation(async (_request, onMessage) => {
      sends.push(onMessage);
      return { started: true };
    });
    const id = openExample("5stationtandem.inf");
    // An earlier QNA whose end has not reached the page when the next is accepted.
    await startRun(id, "qna");
    const whole = runSequence(id, [qnaStep]);
    await waitFor(() => expect(sends).toHaveLength(2));
    await settle();
    act(() => sends[0](finished(true)));
    await settle();
    expect(getSequence()).toMatchObject({ finished: false, steps: [{ state: "running" }] });
    act(() => sends[1](finished(false)));
    expect((await whole)?.steps[0].state).toBe("failed");
  });

  it("ends a step whose run is no longer active though no finish ever came", async () => {
    vi.spyOn(api, "runStart").mockImplementation(async () => ({ started: true }));
    const id = openExample("5stationtandem.inf");
    const whole = runSequence(id, [qnaStep]);
    await settle();
    expect(getSequence()).toMatchObject({ finished: false });
    // The run state learns the run is over some other way (a poll of Rust after a reload).
    act(() => resetRuns());
    const done = await whole;
    expect(done?.steps[0].state).toBe("unknown");
    expect(w.stepNote("Whitt QNA", "unknown")).toBe("Whitt QNA ended without reporting how.");
  });
});

describe("which refusals are remembered (review)", () => {
  it("tells a refusal that stays true from one that passes, by what the run path wrote", () => {
    expect(permanentRefusal([])).toBe(false);
    expect(permanentRefusal(["QNA was not started because Monte Carlo is already running for “a.bnet”. Stop or wait for that run first."])).toBe(false);
    expect(permanentRefusal(["Couldn't start the run: the backend went away"])).toBe(false);
    expect(permanentRefusal(["Exact Matrix-Analytic QBD does not apply: service at S1 is not phase-type."])).toBe(true);
  });

  it("marks the run path's own refusal permanent and a closed gate for an open dialog passing", async () => {
    const id = openExample("5stationtandem.inf");
    const refusedByRunner = await runSequence(id, [{ label: "qbd", command: "run:qbd", name: "Exact Matrix-Analytic QBD" }]);
    expect(refusedByRunner?.steps[0]).toMatchObject({ state: "refused", permanent: true });
    resetSequence();
    const release = holdModal();
    const whileDialog = await runSequence(id, [{ label: "qna", command: "run:qna", name: "Whitt QNA" }]);
    release();
    expect(whileDialog?.steps[0]).toMatchObject({ state: "refused", permanent: false });
  });

  it("offers a method again after a refusal that passed (a dialog was open)", async () => {
    const id = openExample("KumarSeidman90.d2.c4.reentrant.inf");
    const release = holdModal();
    expect((await checkWithAnother(id))?.label).toBe("inf_sim");
    expect(mockRuns.starts).toHaveLength(0);
    release();
    expect((await checkWithAnother(id))?.label).toBe("inf_sim");
    expect(mockRuns.starts.map((s) => s.method)).toEqual(["inf_sim"]);
  });
});
