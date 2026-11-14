// The agreement model against 0.90.34's own recorded runs of one network (golden/runs/).
import { describe, expect, it } from "vitest";
import type { ResultRecord } from "../panes/results/model";
import { agreement, bestRun, bottleneck, BOTTLENECK_TIE, bottlenecks, currentRuns, interval, mostLoaded, stationValues, tierOf } from "./insight";

const records = import.meta.glob("../../golden/runs/5stationtandem.inf/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const all = Object.values(records).map((t) => JSON.parse(t) as ResultRecord);
const fingerprint = all[0].provenance.networkFingerprint;
const by = (id: string) => all.find((r) => r.method.identifier === id)!;

describe("reading a tab's runs together", () => {
  it("ranks each method's evidence by what it declares", () => {
    expect(tierOf(by("queue.open-bcmp-product-form"))).toBe("exact");
    expect(tierOf(by("queue.des"))).toBe("simulation");
    expect(tierOf(by("queue-approx.qna"))).toBe("approximation");
    expect(tierOf(by("srbm.spectral"))).toBe("diffusion");
  });

  it("keeps the newest completed run of each method for the network as it is, exact first", () => {
    const runs = currentRuns(all, fingerprint);
    expect(new Set(runs.map((r) => r.method.identifier)).size).toBe(runs.length);
    expect(tierOf(runs[0])).toBe("exact");
    expect(runs.some((r) => tierOf(r) === "mixed")).toBe(false);
    expect(currentRuns(all, "another-network")).toEqual([]);
    const older = { ...by("queue-approx.qna"), id: "older", completedAt: "2000-01-01T00:00:00Z" };
    expect(currentRuns([older, ...all], fingerprint).some((r) => r.id === "older")).toBe(false);
  });

  it("measures every method against the exact result and says they agree on a product-form tandem", () => {
    const a = agreement(currentRuns(all, fingerprint));
    expect(a.hasExact).toBe(true);
    const q = a.quantities.find((x) => x.stationName === "S1" && x.metric === "Mean number in system")!;
    expect(q.reference?.method).toBe("queue.open-bcmp-product-form");
    expect(q.reference?.estimate).toBeCloseTo(9, 5);
    const qna = q.values.find((v) => v.method === "queue-approx.qna")!;
    expect(Math.abs(qna.deviation!)).toBeLessThan(1e-6);
    expect(q.values.filter((v) => v.isReference)).toHaveLength(1);
    expect(["agree", "close"]).toContain(q.verdict);
  });

  it("uses the tightest simulation as the reference when nothing is exact, and its interval as agreement", () => {
    const sim = by("queue.des");
    const qna = by("queue-approx.qna");
    const a = agreement([sim, qna]);
    const q = a.quantities.find((x) => x.stationName === "S1" && x.metric === "Mean number in system")!;
    expect(q.reference?.tier).toBe("simulation");
    expect(q.values.find((v) => v.method === "queue-approx.qna")!.withinInterval).toBe(q.reference!.interval!.low <= 9 && 9 <= q.reference!.interval!.high);
  });

  it("calls a 30 % gap a disagreement and a lone method single", () => {
    const qna = by("queue-approx.qna");
    const off: ResultRecord = { ...qna, id: "off", method: { ...qna.method, identifier: "queue-approx.other", shortName: "Other" }, measurements: qna.measurements.map((m) => ({ ...m, estimate: m.estimate * 1.3 })) };
    expect(agreement([by("queue.open-bcmp-product-form"), off]).verdict).toBe("disagree");
    expect(agreement([qna]).verdict).toBe("single");
    expect(agreement([qna, off]).quantities[0].reference).toBeNull();
  });

  it("gives one value per station for the canvas, and names the bottleneck", () => {
    const run = bestRun(currentRuns(all, fingerprint))!;
    expect(tierOf(run)).toBe("exact");
    const u = stationValues(run, "Utilization");
    expect(u).toHaveLength(5);
    expect(u.every((s) => Math.abs(s.value - 0.9) < 1e-5)).toBe(true);
    expect(bottleneck(run)?.value).toBeCloseTo(0.9, 5);
    // All five tie: every one is named, and none alone.
    expect(bottlenecks(run).map((s) => s.stationName)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
  });

  it("ties utilisations within 5e-5, the one tolerance the canvas, live results and Sensitivity share", () => {
    expect(BOTTLENECK_TIE).toBe(5e-5);
    const of = (...u: number[]) => mostLoaded(u, (x) => x);
    expect(of(0.7, 0.70004, 0.5)).toEqual([0.7, 0.70004]);
    expect(of(0.7, 0.70006)).toEqual([0.70006]);
    expect(of(1.3, 0.9)).toEqual([1.3]);
    expect(of(0, 0)).toEqual([]);
    expect(of(Number.NaN, 0.4)).toEqual([0.4]);
    expect(of()).toEqual([]);
  });
});

describe("what the views may not overstate (the Phase B review)", () => {
  const exact = by("queue.open-bcmp-product-form");
  const qna = by("queue-approx.qna");
  const sim = by("queue.des");
  const as = (r: ResultRecord, id: string, change: (m: ResultRecord["measurements"][number]) => ResultRecord["measurements"][number], extra: Partial<ResultRecord> = {}): ResultRecord => ({
    ...r,
    id,
    method: { ...r.method, identifier: `${r.method.identifier}.${id}`, shortName: id },
    measurements: r.measurements.map(change),
    ...extra,
  });

  it("does not let a wide simulation interval certify agreement", () => {
    const loose = as(sim, "loose", (m) => (m.uncertainty ? { ...m, uncertainty: { ...m.uncertainty, lowerBound: m.estimate * 0.5, upperBound: m.estimate * 1.5 } } : m));
    const far = as(qna, "far", (m) => ({ ...m, estimate: m.estimate * 1.3 }));
    const q = agreement([loose, far]).quantities.find((x) => x.metric === "Mean number in system")!;
    expect(q.referenceUncertain).toBe(true);
    expect(q.values.find((v) => v.shortName === "far")!.withinInterval).toBe(false);
    expect(q.verdict).toBe("disagree");
  });

  it("judges against a reference of zero absolutely, never as an infinite percentage", () => {
    const zero = as(exact, "zero", (m) => ({ ...m, estimate: 0 }));
    const tiny = as(qna, "tiny", (m) => ({ ...m, estimate: 1e-12 }));
    const q = agreement([zero, tiny]).quantities.find((x) => x.metric === "Mean number in system")!;
    expect(q.referenceZero).toBe(true);
    expect(q.values.find((v) => v.shortName === "tiny")!.deviation).toBe(0);
    expect(q.verdict).toBe("agree");
    const off = as(qna, "off", (m) => ({ ...m, estimate: 0.5 }));
    const q2 = agreement([zero, off]).quantities.find((x) => x.metric === "Mean number in system")!;
    expect(q2.values.find((v) => v.shortName === "off")!.deviation).toBeNull();
    expect(q2.verdict).toBe("disagree");
  });

  it("never takes a partial run as the reference or as an exact result", () => {
    const partial = { ...exact, status: "partial" as const };
    const a = agreement([partial, qna]);
    expect(a.hasExact).toBe(false);
    expect(a.quantities.every((q) => q.reference === null)).toBe(true);
    expect(a.quantities.find((q) => q.metric === "Mean number in system")!.values.find((v) => v.tier === "exact")!.partial).toBe(true);
  });

  it("says nothing was compared when the exact method shares no quantity with the others", () => {
    const alone = as(exact, "alone", (m) => ({ ...m, metric: `Other ${m.metric}` }));
    const a = agreement([alone, qna]);
    expect(a.hasExact).toBe(true);
    expect(a.compared).toBe(0);
    expect(a.comparedWithExact).toBe(0);
    expect(a.verdict).toBe("single");
    expect(agreement([exact]).verdict).toBe("exact");
    expect(agreement([exact, qna]).comparedWithExact).toBeGreaterThan(0);
  });

  it("lists a bound without scoring it as an estimate", () => {
    const bound = as(qna, "bound", (m) => ({ ...m, estimate: m.estimate * 0.2 }), { method: { ...qna.method, identifier: "srbm.bound", shortName: "bound", fidelity: "SRBM bound relaxation" } });
    const q = agreement([exact, qna, bound]).quantities.find((x) => x.metric === "Mean number in system")!;
    const b = q.values.find((v) => v.shortName === "bound")!;
    expect(b.isBound).toBe(true);
    expect(b.deviation).toBeNull();
    expect(q.verdict).not.toBe("disagree");
  });

  it("adds utilisation over classes, weights sojourn time by throughput, and never shows one class as the station", () => {
    const base = { id: "x", unit: "", stationID: "S", stationName: "S1" };
    const run: ResultRecord = {
      ...qna,
      measurements: [
        { ...base, id: "u0", metric: "Utilization", customerClass: 0, estimate: 0.3, unit: "ratio" },
        { ...base, id: "u1", metric: "Utilization", customerClass: 1, estimate: 0.5, unit: "ratio" },
        { ...base, id: "w0", metric: "Mean sojourn time", customerClass: 0, estimate: 2, unit: "time" },
        { ...base, id: "w1", metric: "Mean sojourn time", customerClass: 1, estimate: 4, unit: "time" },
        { ...base, id: "t0", metric: "Throughput", customerClass: 0, estimate: 1, unit: "customers / time" },
        { ...base, id: "t1", metric: "Throughput", customerClass: 1, estimate: 3, unit: "customers / time" },
      ],
    };
    expect(stationValues(run, "Utilization")[0].value).toBeCloseTo(0.8, 12);
    expect(stationValues(run, "Mean sojourn time")[0].value).toBeCloseTo((1 * 2 + 3 * 4) / 4, 12);
    expect(stationValues(run, "Throughput")[0].value).toBe(4);
    const noRates = { ...run, measurements: run.measurements.filter((m) => m.metric !== "Throughput") };
    expect(stationValues(noRates, "Mean sojourn time")).toEqual([]);
  });

  // cli/src/api.rs `interval` has the same cases (ledger WF-509).
  it("restates an interval from a standard error only at a level whose z it has", () => {
    const m = (uncertainty: object) => ({ ...by("queue.des").measurements[0], estimate: 10, uncertainty }) as ResultRecord["measurements"][number];
    expect(interval(m({ standardError: 1 }))).toEqual({ low: 10 - 1.96, high: 10 + 1.96 });
    expect(interval(m({ standardError: 1, confidenceLevel: 0.95 }))).toEqual({ low: 10 - 1.96, high: 10 + 1.96 });
    expect(interval(m({ standardError: 1, confidenceLevel: 0.9 }))).toEqual({ low: 10 - 1.645, high: 10 + 1.645 });
    expect(interval(m({ standardError: 1, confidenceLevel: 0.99 }))).toEqual({ low: 10 - 2.576, high: 10 + 2.576 });
    // ±1.96 standard errors is a 95 % interval: it is not shown as an 80 % one.
    expect(interval(m({ standardError: 2, lowerBound: 7, confidenceLevel: 0.8 }))).toBeNull();
    expect(interval(m({ standardError: 2, confidenceLevel: 0.975 }))).toBeNull();
    // Bounds the method stated are its own, at its level.
    expect(interval(m({ standardError: 2, lowerBound: 8.5, upperBound: 11.5, confidenceLevel: 0.8 }))).toEqual({ low: 8.5, high: 11.5 });
    expect(interval(m({}))).toBeNull();
  });
});
