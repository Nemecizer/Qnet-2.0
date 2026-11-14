// The Results workspace's derivations on 0.90.34's own records (golden/runs): the previous comparable
// run and the cross-run change (RES-051, RES-064), the Quality Evidence panel (RES-063), the evidence
// cell and its tooltip (RES-068), the run filter and sorts (RES-055, RES-056, RES-066).
import { describe, expect, it } from "vitest";
import { crossRunDelta, evidenceItems, evidenceLabel, filterRuns, measurementHelp, previousComparableRun, sortMeasurements, type ResultRecord } from "./model";

const records = import.meta.glob("../../../golden/runs/*/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const golden = (example: string, method: string): ResultRecord => JSON.parse(records[`../../../golden/runs/${example}/${method}/record.json`]);

/** A copy of `r` as a later run: a new id, started `seconds` later. */
function later(r: ResultRecord, seconds: number, patch: Partial<ResultRecord> = {}): ResultRecord {
  return { ...structuredClone(r), id: `${r.id.slice(0, -4)}${String(seconds).padStart(4, "0")}`, startedAt: new Date(Date.parse(r.startedAt) + seconds * 1000).toISOString(), ...patch };
}

describe("the previous comparable run", () => {
  it("is the latest older completed run of the same method and network snapshot (RES-051)", () => {
    const a = golden("2dtandem", "sim");
    const b = later(a, 10);
    const c = later(a, 20);
    const failed = later(a, 15, { status: "failed" });
    const otherNet = later(a, 18, { provenance: { ...a.provenance, networkFingerprint: "f".repeat(64) } });
    const otherMethod = { ...later(golden("2dtandem", "sm"), 19) };
    const tab = [c, failed, otherNet, otherMethod, b, a];
    expect(previousComparableRun(tab, c)?.id).toBe(b.id);
    expect(previousComparableRun(tab, b)?.id).toBe(a.id);
    expect(previousComparableRun(tab, a)).toBeNull();
  });

  it("gives the change over matching measurements, and names changed parameters (RES-063, RES-064)", () => {
    const a = golden("2dtandem", "sim");
    const b = later(a, 10);
    b.measurements[0].estimate = 0.99; // S1 utilization, was 0.984
    b.provenance = { ...b.provenance, parameters: { ...b.provenance.parameters, replications: "16" } };
    const d = crossRunDelta(b, a)!;
    expect(d.count).toBe(8);
    expect(d.maximumAbsolute).toBeCloseTo(0.006, 12);
    expect(d.maximumRelative).toBeCloseTo(0.006 / 0.984, 12);
    expect(d.changedParameters).toEqual(["replications"]);
    const items = evidenceItems(b, a, 6)!;
    const cross = items.find((i) => i.label === "Change from prior matching run")!;
    expect(cross.value).toMatch(/^max \|Δ\| 0\.006000 · max relative 0\.61\d?%$/);
    expect(cross.help).toBe("Compared 8 matching measurements with the most recent older run of the same method and network snapshot. Changed parameters: replications.");
    expect(evidenceItems(later(a, 10), a, 6)!.find((i) => i.label === "Change from prior matching run")!.help).toMatch(/The recorded solver parameters are unchanged\.$/);
  });

  it("shows no Quality Evidence for a run with none, and 'Uncertainty missing' for a simulation without intervals", () => {
    const qna = golden("5stationtandem.inf", "qna");
    expect(evidenceItems(qna, null, 6)).toBeNull();
    const sim = golden("2dtandem", "sim");
    const bare = { ...sim, measurements: sim.measurements.map((m) => ({ ...m, uncertainty: undefined })) };
    expect(evidenceItems(bare, null, 6)).toEqual([{ label: "Uncertainty missing", value: "Treat point estimates cautiously; no interval or standard error was parsed." }]);
  });
});

describe("the evidence cell", () => {
  it("reads an interval, a standard error, a residual, a Δ, a discretization, or —, with 0.90.34's tooltip (RES-068)", () => {
    const m = { id: "A", stationName: "S1", metric: "m", estimate: 1, unit: "" };
    expect(evidenceLabel({ ...m, uncertainty: { lowerBound: 0.5, upperBound: 1.5, confidenceLevel: 0.9 } }, 2)).toBe("90% [0.50, 1.50]");
    expect(evidenceLabel({ ...m, uncertainty: { lowerBound: 0.5, upperBound: 1.5 } }, 2)).toBe("[0.50, 1.50]");
    expect(evidenceLabel({ ...m, uncertainty: { standardError: 0.25 } }, 2)).toBe("SE 0.25");
    expect(evidenceLabel({ ...m, numericalEvidence: { residual: 1e-9, refinementDelta: 2 } }, 6)).toBe("residual 1.00000e-09");
    expect(evidenceLabel({ ...m, numericalEvidence: { refinementDelta: 0.5 } }, 1)).toBe("Δ 0.5");
    expect(evidenceLabel({ ...m, numericalEvidence: { discretization: "degree 6" } }, 1)).toBe("degree 6");
    expect(evidenceLabel(m, 1)).toBe("—");
    expect(measurementHelp(m, 1)).toBe("No uncertainty or numerical evidence was reported");
    expect(measurementHelp({ ...m, note: "a note" }, 1)).toBe("a note");
    expect(measurementHelp({ ...m, uncertainty: { lowerBound: 0.5, upperBound: 1.5, standardError: 0.2, sampleSize: 30 }, numericalEvidence: { residual: 0.001, convergenceNote: "ok" } }, 3)).toBe(
      "Interval: [0.500, 1.500] · Standard error: 0.200 · Sample size: 30 · Residual: 0.001 · ok",
    );
  });
});

describe("the run list and grid", () => {
  it("sorts runs newest first, by method or by network, and filters on warnings too (RES-055, RES-056)", () => {
    const sim = golden("2dtandem", "sim");
    const cmp = later(golden("2dtandem", "cmp"), 60);
    const fm = later(golden("2dtandem", "fm"), 30);
    expect(filterRuns([sim, cmp, fm], "", "all", "newest").map((r) => r.method.shortName)).toEqual(["Comparison", "FEM", "Monte Carlo"]);
    expect(filterRuns([sim, cmp, fm], "", "all", "method").map((r) => r.method.displayName)).toEqual(["Finite Element Method", "Method Comparison", "Monte Carlo"]);
    expect(filterRuns([sim, cmp, fm], "first value in each", "all", "newest").map((r) => r.method.shortName)).toEqual(["Comparison"]);
    expect(filterRuns([sim, cmp, fm], "", "mixed", "newest").map((r) => r.method.shortName)).toEqual(["Comparison"]);
  });

  it("breaks ties by id and sorts runs with no uncertainty last ascending (RES-066)", () => {
    const sim = golden("2dtandem", "sim");
    sim.measurements[3].uncertainty = undefined;
    const asc = sortMeasurements(sim, "", "uncertainty", true);
    expect(asc.at(-1)!.id).toBe(sim.measurements[3].id);
    const byClass = sortMeasurements(sim, "", "customerClass", true).map((m) => m.id);
    expect(byClass).toEqual([...sim.measurements.map((m) => m.id)].sort());
    const desc = sortMeasurements(sim, "", "customerClass", false).map((m) => m.id);
    expect(desc).toEqual(byClass);
  });
});
