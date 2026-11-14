// Run ▸ Choose a Method… against the mock backend (ledger ANA-192…225, INV-033, SET-201): 0.90.34's
// rows for real examples, the rules that pick each row's suitability and summary, the window's
// words, the filter, and Run Method dispatching to the Run menu's own commands.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockAnalysisWindows } from "../../dev/mock/analysis";
import { mockTauri } from "../../test/tauri";
import { api } from "../../lib/api";
import { registerCommands } from "../../lib/commands";
import type { MethodDomain, RuntimeAvailability } from "../../lib/types";
import { editorFeedback } from "../../editor";
import { addTab, removeTabs } from "../../workspace/store";
import { commandFor, filterAdvice, recommendations, type MethodAdvice } from "./advice";
import { METHOD_CHOOSER_FRAME_KEY, MethodChooserView, methodChooserState, openMethodChooser, resetMethodChooser, runAdvised } from "./MethodChooser";
import { methodChooserWords as w } from "./words";

/** An example as Rust's reader hands it over: 0.90.34's own re-save of it. */
const resaved = import.meta.glob("../../../golden/*/resave.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const doc = (stem: string) => JSON.parse(resaved[`../../../golden/${stem}/resave.bnet`]);
const open = (stem: string) => addTab({ title: `${stem}.bnet`, document: doc(stem) });

afterEach(() => resetMethodChooser());

const ALL: RuntimeAvailability[] = ["productForm", "qbd", "regenerative", "truncatedCtmc", "adaptiveBar", "barBounds", "multiclass", "genericCtmc", "decomposition"].map((key) => ({ key: key as RuntimeAvailability["key"], available: true, reason: null }));
const without = (key: string, reason: string | null = null) => ALL.map((r) => (r.key === key ? { ...r, available: false, reason } : r));

async function domainOf(stem: string): Promise<MethodDomain> {
  mockTauri(defaultHandlers());
  return api.methodDomain(doc(stem));
}

const byId = (rows: MethodAdvice[], id: string) => rows.find((r) => r.id === id)!;

describe("the chooser's rows for 0.90.34's examples", () => {
  it("an exact Jackson network with feedback: the analytical row first, ranked, with feedback's QNA caution (ANA-201, ANA-205, ANA-210, ANA-214)", async () => {
    const rows = recommendations(await domainOf("OpenJackson.d2.feedback.p50.inf"), ALL);
    expect(rows[0]).toMatchObject({ id: "analytical", name: "Analytical solution", layer: "exactQueue", suitability: "recommended", summary: "This network is analytically tractable", implementation: "Open Jackson network — exact M/M/s product form", cost: "Immediate" });
    expect(rows[0].assumptions).toMatch(/^All inter-arrival and service distributions are exponential/);
    // Sorted by rank, then by name.
    const ranks = rows.map((r) => ["recommended", "applicable", "caution", "experimental", "unavailable"].indexOf(r.suitability));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(rows.filter((r) => r.suitability === "recommended").map((r) => r.name)).toEqual(["Analytical solution", "Exact Open Product Form", "Monte Carlo", "Whitt–You RQNA"]);
    expect(byId(rows, "qna")).toMatchObject({ suitability: "caution", summary: "Fast two-moment approximation; feedback can weaken renewal assumptions." });
    expect(byId(rows, "qbd")).toMatchObject({ suitability: "unavailable" });
    expect(byId(rows, "multiclass-srbm")).toMatchObject({ suitability: "unavailable", summary: "The current network has only one customer class." });
    expect(byId(rows, "bar-moment-bounds")).toMatchObject({ suitability: "experimental", cost: "Low for exact cases; potentially high for the SDP relaxation" });
    // 0.90.34's fifteen, and Replicated Simulation (new in 2.1): applicable, so behind every
    // recommended method and never Solve's choice here.
    expect(rows).toHaveLength(16);
    expect(byId(rows, "simulation-inprocess")).toMatchObject({ name: "Replicated Simulation", layer: "queueSimulation", helpTopic: "replicatedSimulation" });
    expect(commandFor("simulation-inprocess", true)).toBe("run:replicated-simulation");
    expect(rows.filter((r) => r.layer === "queueSimulation" && r.suitability !== "unavailable")[0].id).toBe("simulation-infinite");
  });

  it("a finite tandem with two warnings: the finite rows, diffusion methods in caution, the warning suffix (ANA-202, ANA-220…224)", async () => {
    const rows = recommendations(await domainOf("2dtandem"), ALL);
    expect(rows.map((r) => r.id).sort()).toEqual(["ctmc", "fem-finite", "finite-decomposition", "lp-finite", "regenerative-mc", "simulation-finite", "spectral-finite"]);
    expect(byId(rows, "spectral-finite")).toMatchObject({ suitability: "caution", assumptions: "Continuous upper-face reflection is not identical to every discrete loss/BAS rule. Review the 2 current network warnings." });
    // S1 is deterministic: the Markov rows are out of the domain.
    expect(byId(rows, "finite-decomposition")).toMatchObject({ suitability: "unavailable", summary: "Requires Poisson arrivals and exponential FCFS service." });
    expect(byId(rows, "ctmc")).toMatchObject({ suitability: "unavailable", summary: "Requires Poisson arrivals and exponential service for every represented class." });
    expect(byId(rows, "simulation-finite").suitability).toBe("recommended");
    const mm1k = recommendations(await domainOf("MM1K.d1.c1.fin"), ALL);
    expect(byId(mm1k, "finite-decomposition").suitability).toBe("recommended");
    expect(byId(mm1k, "ctmc")).toMatchObject({ suitability: "applicable", summary: "Exact queue-process benchmark with reachable-state enumeration and a hard state-space safety limit." });
    expect(byId(mm1k, "regenerative-mc")).toMatchObject({ suitability: "applicable", summary: "Cycle-level fixed-width simulation for the finite loss-on-full queueing process." });
  });

  it("a multi-class re-entrant line: the class tests and Multi-Class SRBM (ANA-209, ANA-211, ANA-219)", async () => {
    const d = await domainOf("KumarSeidman90.d2.c4.reentrant.inf");
    expect(d.classCount).toBeGreaterThan(1);
    const rows = recommendations(d, ALL);
    expect(byId(rows, "multiclass-srbm")).toMatchObject({ suitability: "experimental", summary: "Experimental class-aware service moments, traffic equations and routing covariance." });
    expect(byId(rows, "truncated-ctmc")).toMatchObject({ suitability: "unavailable", summary: "Requires one class, Poisson arrivals and exponential service." });
    expect(byId(recommendations(d, without("multiclass")), "multiclass-srbm").summary).toBe("The optional solver is unavailable in this build; its dependency manifest explains why.");
  });

  it("the exporters' refusals are the exact rows' summaries (ANA-204, ANA-206, ANA-207)", async () => {
    const d = await domainOf("2dtandem");
    const rows = recommendations({ ...d, infiniteBuffers: true }, ALL);
    expect(byId(rows, "open-product-form")).toMatchObject({ suitability: "unavailable", summary: d.productFormRefusal });
    expect(d.productFormRefusal).toBeTruthy();
  });
});

describe("domain and installation are separate questions (INV-033)", () => {
  const base: MethodDomain = {
    infiniteBuffers: true, stationCount: 2, classCount: 1, warningCount: 0, hasFeedback: false, analytical: null, sourcesArePoisson: true, servicesAreExponential: true,
    classTransitions: false, classIndependentService: true, heavyJackson: false, productFormRefusal: null, qbdRefusal: null, replicatedSimulationRefusal: null,
  };

  it("a network in the domain whose solver is missing says so, with the resolver's reason or 0.90.34's last resort (ANA-204, ANA-206)", () => {
    expect(byId(recommendations(base, without("productForm", "Python preflight failed")), "open-product-form")).toMatchObject({ suitability: "unavailable", summary: "The model qualifies, but Python preflight failed." });
    expect(byId(recommendations(base, without("productForm")), "open-product-form").summary).toBe("The model qualifies, but the Python-backed solver support is unavailable in this installation.");
    expect(byId(recommendations(base, without("regenerative", "no python3")), "regenerative-mc")).toMatchObject({ suitability: "unavailable", summary: "no python3" });
    expect(byId(recommendations(base, ALL), "open-product-form")).toMatchObject({ suitability: "recommended", summary: "Computes exact M/M/c station measures analytically without truncating the infinite state space." });
  });

  it("a network outside the domain says that first, whatever is installed", () => {
    const d = { ...base, classTransitions: true };
    expect(byId(recommendations(d, without("regenerative")), "regenerative-mc").summary).toBe("Requires class-preserving Poisson/exponential Markov primitives and one service rate per station across classes.");
  });

  it("follows 0.90.34's thresholds: heavy Jackson, 8, 15 and 32 stations, one station (ANA-209, ANA-212, ANA-213, ANA-216, ANA-218)", () => {
    expect(byId(recommendations({ ...base, heavyJackson: true }, ALL), "regenerative-mc").suitability).toBe("caution");
    expect(byId(recommendations({ ...base, heavyJackson: true }, ALL), "truncated-ctmc").suitability).toBe("caution");
    const nine = recommendations({ ...base, stationCount: 9 }, ALL);
    expect(byId(nine, "spectral-infinite")).toMatchObject({ suitability: "caution", cost: "High at 9 stations" });
    expect(byId(nine, "lp-infinite").suitability).toBe("caution");
    expect(byId(nine, "bar-moment-bounds")).toMatchObject({ suitability: "caution", cost: "High; moment and PSD block counts grow combinatorially" });
    expect(byId(recommendations({ ...base, stationCount: 16 }, ALL), "lp-infinite").suitability).toBe("unavailable");
    expect(byId(recommendations({ ...base, stationCount: 33 }, ALL), "adaptive-low-rank-bar")).toMatchObject({ suitability: "unavailable", summary: "The maintained Halton construction is limited to thirty-two SRBM dimensions." });
    expect(byId(recommendations({ ...base, stationCount: 1 }, ALL), "bar-moment-bounds").summary).toBe("Returns a certified exact stationary workload moment for the one-dimensional SRBM.");
    const finite = { ...base, infiniteBuffers: false };
    expect(byId(recommendations({ ...finite, stationCount: 7 }, ALL), "ctmc")).toMatchObject({ suitability: "unavailable", summary: "The Markov assumptions hold, but the state space may be large; the solver will stop safely at its configured limit." });
    expect(byId(recommendations({ ...finite, servicesAreExponential: false }, ALL), "ctmc").summary).toBe("Requires Poisson arrivals and exponential service for every represented class.");
    expect(byId(recommendations({ ...finite, stationCount: 5 }, ALL), "fem-finite").cost).toBe("High at 5 stations");
    expect(byId(recommendations({ ...base, analytical: { exact: false, title: "T", detail: "D", explanation: "" } }, ALL), "analytical")).toMatchObject({ name: "Asymptotic product form", layer: "srbmAnalytical", assumptions: "The current network passed Qnet's tractability test." });
    expect(w.warningSuffix(1)).toBe(" Review the 1 current network warning.");
  });
});

describe("the filter and Run Method", () => {
  it("filters on name, implementation, layer, suitability, summary, assumptions and outputs, case-insensitively (ANA-195)", async () => {
    const rows = recommendations(await domainOf("OpenJackson.d2.feedback.p50.inf"), ALL);
    expect(filterAdvice(rows, "  ").length).toBe(rows.length);
    expect(filterAdvice(rows, "bna_RQNA").map((r) => r.id)).toEqual(["rqna"]);
    expect(filterAdvice(rows, "queue simulation").map((r) => r.id).sort()).toEqual(["regenerative-mc", "simulation-infinite", "simulation-inprocess"]);
    expect(filterAdvice(rows, "experimental").every((r) => r.suitability === "experimental")).toBe(true);
    expect(filterAdvice(rows, "zzz")).toEqual([]);
  });

  it("maps every row to the Run menu's command, Regenerative by buffer mode (ANA-170, ANA-198)", () => {
    expect(commandFor("analytical", true)).toBe("network:analyze");
    expect(commandFor("qna", true)).toBe("run:qna");
    expect(commandFor("regenerative-mc", true)).toBe("run:regenerative-infinite");
    expect(commandFor("regenerative-mc", false)).toBe("run:regenerative-finite");
    expect(commandFor("lp-finite", false)).toBe("run:finite-lp");
    expect(commandFor("ctmc", false)).toBe("run:generic-ctmc");
    expect(commandFor("nonsense", true)).toBeNull();
  });

  it("closes the window, then runs the command; an unknown id or a missing command beeps (ANA-198)", async () => {
    mockTauri(defaultHandlers());
    const ran = vi.fn();
    const stop = registerCommands([{ id: "run:qna", title: "Run Whitt QNA", group: "Run", run: ran }]);
    const beep = vi.spyOn(editorFeedback, "beep");
    openMethodChooser(open("2dtandem"));
    runAdvised("qna", true);
    expect(methodChooserState()).toBeNull();
    await waitFor(() => expect(ran).toHaveBeenCalledTimes(1));
    runAdvised("nonsense", true);
    runAdvised("sbd", true);
    await waitFor(() => expect(beep).toHaveBeenCalledTimes(2));
    stop();
    beep.mockRestore();
  });
});

describe("the window", () => {
  it("opens for the active tab and is re-pointed, not rebuilt, when asked again; its frame key is 0.90.34's (ANA-193, SET-201)", () => {
    mockTauri(defaultHandlers());
    const a = open("2dtandem");
    openMethodChooser();
    expect(methodChooserState()?.tabId).toBe(a);
    const b = open("OpenJackson.d2.feedback.p50.inf");
    openMethodChooser();
    expect(methodChooserState()?.tabId).toBe(b);
    expect(METHOD_CHOOSER_FRAME_KEY).toBe("WindowFrame.QnetMethodChooserWindow");
  });

  it("shows the header, the summary badges, ranked rows with their grid and buttons, and the footer (ANA-195…197, ANA-199)", async () => {
    mockTauri(defaultHandlers());
    const id = open("OpenJackson.d2.feedback.p50.inf");
    const onClose = vi.fn();
    render(<MethodChooserView tabId={id} opened={1} onClose={onClose} />);
    expect(screen.getByRole("heading", { name: "Choose a Method" })).toBeInTheDocument();
    expect(screen.getByText("Ranked for the active network")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter methods")).toBeInTheDocument();
    expect(screen.getByText("Infinite buffers")).toBeInTheDocument();
    expect(screen.getByText("2 stations")).toBeInTheDocument();
    await screen.findByText("Analytical solution");
    expect(screen.getByText("Feedback")).toBeInTheDocument();
    const rows = screen.getAllByRole("article");
    expect(within(rows[0]).getByRole("heading").textContent).toBe("Analytical solution");
    expect(within(rows[0]).getByText("Assumptions")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("button", { name: "Run Method" })).toBeInTheDocument();
    expect(within(rows[0]).getByRole("button", { name: "Open Method Reference" })).toBeInTheDocument();
    const qbd = screen.getByRole("article", { name: "Exact Matrix-Analytic QBD" });
    expect(within(qbd).queryByRole("button", { name: "Run Method" })).toBeNull();
    expect(screen.getByText("Guidance describes applicability and model scope; it is not an error guarantee.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Filter methods"), { target: { value: "zzz" } });
    expect(screen.getByText("No Results for “zzz”")).toBeInTheDocument();
  });

  it("asks the resolver again on each open and shows a missing solver as unavailable (INV-033)", async () => {
    mockTauri(defaultHandlers());
    mockAnalysisWindows.availability = without("productForm", "python3 could not import numpy");
    const id = open("OpenJackson.d2.feedback.p50.inf");
    render(<MethodChooserView tabId={id} opened={1} onClose={() => {}} />);
    const row = await screen.findByRole("article", { name: "Exact Open Product Form" });
    expect(within(row).getByText("Unavailable")).toBeInTheDocument();
    expect(within(row).getByText("The model qualifies, but python3 could not import numpy.")).toBeInTheDocument();
  });

  it("says No Active Network when its tab has gone (ANA-194)", async () => {
    mockTauri(defaultHandlers());
    const id = open("2dtandem");
    render(<MethodChooserView tabId={id} opened={1} onClose={() => {}} />);
    await screen.findByText("Monte Carlo");
    act(() => removeTabs([id]));
    expect(screen.getByText("No Active Network")).toBeInTheDocument();
    expect(screen.getByText("Open or create a network, then choose a method for it.")).toBeInTheDocument();
  });
});
