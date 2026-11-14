// The flag bar's pills, tooltips and popovers in 0.90.34's words (ledger LOG-031, LOG-033…039).
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { blankAnalysis, mockAnalysis } from "../../dev/mock/status";
import { defaultHandlers } from "../../dev/mockBackend";
import { emptyDocument, type BnetDocument } from "../../lib/bnet";
import type { SilentAnalysis } from "../../lib/types";
import { mockTauri } from "../../test/tauri";
import { replaceWorkspace, setDocument } from "../../workspace/store";
import { resetSilentAnalysis } from "./analysis";
import { readout } from "./FlagBar";
import { StatusPane, useStatusCommands } from "./index";
import { resetPaneStates } from "./state";

const doc = (): BnetDocument => ({
  ...emptyDocument(),
  nodes: [{ id: "S1", kind: "station", name: "S1", position: [0, 0], bufferSize: 0, distribution: "exponential", distributionParameters: "rate=1.0", numberOfServers: 1, serviceDistributions: {}, picture: "" }],
});

function Host() {
  useStatusCommands();
  return <StatusPane />;
}

async function show(a: SilentAnalysis | null, document: BnetDocument = doc()) {
  if (a) mockAnalysis.run = () => a;
  act(() => replaceWorkspace({ tabs: [{ id: "T", title: "t", path: null, document, revision: 0, savedRevision: 0, log: [] }], activeId: "T" }));
  render(<Host />);
  await act(async () => {});
}

const pill = (name: RegExp) => screen.getByRole("button", { name });
const open = (name: RegExp) => {
  fireEvent.click(pill(name));
  return screen.getByRole("dialog");
};

const jackson: SilentAnalysis = {
  ...blankAnalysis(),
  isAnalyticallyTractable: true,
  tractabilityIsExact: true,
  tractabilityTitle: "This network is analytically tractable",
  tractabilityDetail: "Open Jackson network — exact M/M/s product form",
  tractabilityMeansLabel: "Exact E[N]  (Jackson)",
  tractabilityMeans: [2.333333333333333, "NaN"],
  tractabilityExplanation: "All inter-arrival and service distributions are exponential.",
  stationNames: ["S1", "S2"],
  throughputs: [2, 1],
  hasFeedback: true,
  feedbackDescription: "Self-loop(s): S1.",
  feedbackQuality: "green",
  feedbackCriteria: [
    { label: "Per-station ρ < 0.85", ok: true, detail: "max ρ = 0.700" },
    { label: "Service SCV in [0.5, 2]", ok: false, detail: "worst c²_s = 2.020 (extreme variance breaks 2-moment methods)" },
  ],
};

beforeEach(() => {
  mockTauri(defaultHandlers());
  resetSilentAnalysis();
  resetPaneStates();
});

describe("the pills", () => {
  it("are Analytical, Re-entrant and Warnings, unlit with their why-not tooltips (LOG-031, LOG-033, LOG-036, LOG-038)", async () => {
    await show(blankAnalysis());
    expect(screen.getAllByRole("button", { name: /: (on|off)/ }).map((b) => b.textContent)).toEqual(["Analytical", "Re-entrant", "Warnings"]);
    expect(pill(/^Analytical: off$/)).toHaveAttribute("title", "Not analytically tractable. Click to see why.");
    expect(pill(/^Re-entrant: off$/)).toHaveAttribute("title", "Routing is feed-forward (no cycles). Click for details.");
    expect(pill(/^Warnings: off$/)).toHaveAttribute("title", "No warnings from the latest analysis.");
  });

  it("light from the analysis, tinted by quality, with a warnings count (LOG-033, LOG-036, LOG-038)", async () => {
    await show({ ...jackson, feedbackQuality: "red", warnings: ["w1", "w2"] });
    expect(pill(/^Analytical: on$/)).toHaveAttribute("title", "This network is analytically tractable");
    expect(pill(/^Re-entrant: on$/)).toHaveAttribute("data-tint", "crit");
    expect(pill(/^Re-entrant: on$/)).toHaveAttribute("title", "Re-entrant routing with a Kumar–Seidman / Bramson-style pathology. Diffusion methods will under-predict; trust the simulator.");
    expect(pill(/^Warnings: on, 2$/)).toHaveAttribute("title", "The latest analysis produced 2 warnings. Click to list them.");
    expect(pill(/^Warnings: on, 2$/)).toHaveTextContent("Warnings2");
  });

  it("has a tooltip per re-entrant quality", async () => {
    await show({ ...jackson, feedbackQuality: "yellow" });
    expect(pill(/^Re-entrant: on$/)).toHaveAttribute("data-tint", "warn");
    expect(pill(/^Re-entrant: on$/)).toHaveAttribute("title", "Re-entrant routing; some criteria failed. Expect 10–30% under-prediction versus simulation. Click for details.");
  });
});

describe("the popovers", () => {
  it("Analytical, tractable: Exact, title, detail, explanation and the Station / Mean / Γ grid (LOG-034)", async () => {
    await show(jackson);
    const d = open(/^Analytical/);
    expect(d).toHaveTextContent("Exact");
    expect(d).toHaveTextContent("Open Jackson network — exact M/M/s product form");
    expect(within(d).getByText(/and throughput Γ$/).textContent).toBe("Exact E[N]  (Jackson) and throughput Γ");
    const cells = within(d).getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toEqual(["S1", readout(2.333333333333333), readout(2), "S2", "—", readout(1)]);
    expect(readout(2.333333333333333)).toBe(new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(2.3333));
    expect(within(d).getAllByRole("columnheader").map((c) => c.textContent?.trim())).toEqual(["Station", "Mean", "Γ"]);
    expect(d).not.toHaveTextContent("solver index");
  });

  it("Analytical, ambiguous station names: says rows are labelled S1 … Sn", async () => {
    await show({ ...jackson, stationOrderIsAmbiguous: true, throughputs: null, tractabilityIsExact: false });
    const d = open(/^Analytical/);
    expect(d).toHaveTextContent("Asymptotic");
    expect(d).toHaveTextContent("Station names have no distinct numeric suffix, so rows are labelled by solver index (S1 … Sn) rather than by name.");
    expect(within(d).queryAllByRole("columnheader")).toEqual([]);
  });

  it("Analytical, not tractable: why, the non-exponential stations and the tractable cases (LOG-035)", async () => {
    await show({ ...blankAnalysis(), nonExponentialStations: ["S2  (Gamma)"] });
    const d = open(/^Analytical/);
    expect(d).toHaveTextContent("Not tractable");
    expect(d).toHaveTextContent("No known closed-form or asymptotic product-form stationary distribution matches this network.");
    expect(d).toHaveTextContent("Stations with non-exponential service");
    expect(within(d).getByText(/^S2/).textContent).toBe("S2  (Gamma)");
    expect(d).toHaveTextContent("Tractable cases: Jackson (exponential service, Markovian routing), skew-symmetric SRBM, and the GCDG 2025 asymptotic regimes.");
  });

  it("Analytical, empty canvas or not analysed yet", async () => {
    await show(null, emptyDocument());
    expect(open(/^Analytical/)).toHaveTextContent("The canvas is empty — add a source, a station and a sink to analyse the network.");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // An edit not yet re-analysed (inside the 150 ms).
    act(() => setDocument("T", doc()));
    expect(open(/^Analytical/)).toHaveTextContent("The network has not been analysed yet. Analysis runs automatically after edits; run Network ▸ Show Network Primitives for the full report.");
  });

  it("Re-entrant: headline, cycle statement, description, criteria and implication (LOG-037)", async () => {
    await show(jackson);
    const d = open(/^Re-entrant/);
    expect(d).toHaveTextContent("Diffusion-friendly");
    expect(d).toHaveTextContent("The routing graph contains at least one directed cycle, so jobs may revisit a station.");
    expect(d).toHaveTextContent("Self-loop(s): S1.");
    expect(within(d).getByRole("img", { name: "passed" })).toBeInTheDocument();
    expect(within(d).getByRole("img", { name: "failed" })).toBeInTheDocument();
    expect(d).toHaveTextContent("worst c²_s = 2.020 (extreme variance breaks 2-moment methods)");
    expect(d).toHaveTextContent("All criteria pass. Spectral / QNA / RQNA / SBD point estimates should agree with simulation within ~10%.");
  });

  it("Re-entrant, feed-forward", async () => {
    await show(blankAnalysis());
    const d = open(/^Re-entrant/);
    expect(d).toHaveTextContent("Feed-forward");
    expect(d).toHaveTextContent("No directed cycle was found: no self-loop, immediate feedback (A → B → A) or longer rework loop. Every job visits each station at most once.");
    expect(d).toHaveTextContent("Routing is feed-forward; no diffusion-friendliness concern.");
  });

  it("Warnings: the list, or why there is none, and the Primitives hint (LOG-039)", async () => {
    await show({ ...blankAnalysis(), warnings: ["station 1 is overloaded", "station 2 has low utilization"] });
    const d = open(/^Warnings/);
    expect(d).toHaveTextContent("2 issues");
    expect(within(d).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["station 1 is overloaded", "station 2 has low utilization"]);
    expect(d).toHaveTextContent("Run Network ▸ Show Network Primitives for the full primitives report.");
    // A click outside closes it.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Warnings, none", async () => {
    await show(blankAnalysis());
    const d = open(/^Warnings/);
    expect(d).toHaveTextContent("None");
    expect(d).toHaveTextContent("The latest analysis found no problems: every station is stable (ρ < 1) and the routing structure is consistent.");
  });
});
