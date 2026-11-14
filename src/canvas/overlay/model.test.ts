// The overlay's model against 0.90.34's own recorded runs (golden/runs/): which run is shown, each
// station's value and how strongly it is painted, the bottleneck, and what an edit does.
import { describe, expect, it } from "vitest";
import type { ResultRecord } from "../../panes/results/model";
import { bottleneck, bottlenecks, stationValues } from "../../results/insight";
import { chooseRun, classBreakdown, formatValue, intensityOf, overlayModel } from "./model";

const files = import.meta.glob("../../../golden/runs/{5stationtandem.inf,3d2ctandem.inf}/*/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const load = (example: string) =>
  Object.entries(files)
    .filter(([k]) => k.includes(`/${example}/`))
    .map(([, t]) => JSON.parse(t) as ResultRecord);
const tandem = load("5stationtandem.inf");
const fp = tandem[0].provenance.networkFingerprint;
const by = (records: ResultRecord[], id: string) => records.find((r) => r.method.identifier === id)!;
const model = (over: Partial<Parameters<typeof overlayModel>[0]> = {}) => overlayModel({ records: tandem, fingerprint: fp, metric: "Utilization", decimals: 6, ...over })!;
const item = (m: ReturnType<typeof model>, name: string) => [...m.items.values()].find((i) => i.stationName === name)!;

describe("which run the canvas shows", () => {
  it("is the best current run that reports the metric: the exact one for utilisation, a simulation for sojourn time", () => {
    const u = model();
    expect(u.run.method.identifier).toBe("queue.open-bcmp-product-form");
    expect(u.caption).toBe("Utilization · Product Form · Exact");
    expect(u.pinned).toBe(false);
    expect(u.stale).toBe(false);
    // Product Form reports no sojourn time; the best run that does is a simulation.
    const t = model({ metric: "Mean sojourn time" });
    expect(t.tier).toBe("simulation");
    expect(t.items.size).toBe(5);
  });

  it("is the run picked in the Results pane when there is one, whatever its tier", () => {
    const qna = by(tandem, "queue-approx.qna");
    const m = model({ selectedRunId: qna.id, metric: "Mean number in system" });
    expect(m.run.id).toBe(qna.id);
    expect(m.pinned).toBe(true);
    expect(m.caption).toBe("Mean number in system · QNA · Approximation");
    expect(item(m, "S1").value).toBe(9);
    // A pick that names no record (deleted since) falls back to the best run.
    expect(model({ selectedRunId: "gone" }).pinned).toBe(false);
  });

  it("lists the metrics some current run reports, in menu order", () => {
    expect(model().available).toEqual(["Utilization", "Mean number in system", "Mean sojourn time", "Mean queue length", "Throughput"]);
    const onlyExact = overlayModel({ records: [by(tandem, "queue.open-bcmp-product-form")], fingerprint: fp, metric: "Mean sojourn time", decimals: 3 })!;
    expect(onlyExact.available).toEqual(["Utilization", "Mean number in system", "Throughput"]);
    // The chosen metric is not reported: the run is still named, with nothing to draw.
    expect(onlyExact.items.size).toBe(0);
    expect(onlyExact.method).toBe("Product Form");
  });

  it("is nothing for a tab with no completed run", () => {
    expect(overlayModel({ records: [], fingerprint: fp, metric: "Utilization", decimals: 6 })).toBeNull();
    const failed = { ...by(tandem, "queue-approx.qna"), status: "failed" as const };
    expect(overlayModel({ records: [failed], fingerprint: fp, metric: "Utilization", decimals: 6 })).toBeNull();
    expect(chooseRun([failed], fp, "Utilization", failed.id)).toBeNull();
  });
});

describe("the values", () => {
  it("are insight.ts's station values, one per station, keyed by the station's id in upper case", () => {
    const m = model();
    const expected = stationValues(m.run, "Utilization");
    expect(m.items.size).toBe(expected.length);
    for (const v of expected) expect(m.items.get(v.stationID.toUpperCase())!.value).toBe(v.value);
    expect(m.unit).toBe("ratio");
  });

  it("print the number with its unit: a ratio as a percentage, a count in customers, with the interval as ±", () => {
    const sim = by(tandem, "queue.des");
    const u = model({ selectedRunId: sim.id, decimals: 6 });
    // 0.901 with [0.898, 0.904]: the badge keeps three digits whatever output.decimals says.
    expect(item(u, "S1").text).toBe("90.1 %");
    expect([item(u, "S1").number, item(u, "S1").plusMinus, item(u, "S1").unit]).toEqual(["90.1", "± 0.3", "%"]);
    expect(item(u, "S1").lines[0]).toBe("S1 · Utilization: 90.1000 % (interval 89.8000 % to 90.4000 %)");
    const n = model({ selectedRunId: sim.id, metric: "Mean number in system", decimals: 2 });
    expect(item(n, "S1").text).toBe("9.01 customers");
    expect([item(n, "S1").number, item(n, "S1").plusMinus, item(n, "S1").unit]).toEqual(["9.01", "± 0.35", "customers"]);
    // An exact result has no interval and says so by showing none.
    expect(item(model(), "S1").plusMinus).toBeNull();
    expect(item(model({ decimals: 2 }), "S1").text).toBe("90 %");
    expect(formatValue(1.25, "time", 3)).toBe("1.250 time units");
    expect(formatValue(0.9, "customers / time", 1)).toBe("0.9 per time unit");
    expect(formatValue(0.5, "furlongs", 1)).toBe("0.5 furlongs");
  });

  it("name the method and tier on every tooltip, and speak the value", () => {
    const i = item(model(), "S3");
    // Then the tie: all five stations sit at ρ = 0.9, so each says it is equally loaded.
    expect(i.lines.at(-2)).toBe("Product Form · Exact");
    expect(i.lines.at(-1)).toMatch(/^Equally loaded: /);
    expect(i.label).toMatch(/^S3: Utilization 90\.0000 %/);
  });

  it("give a multiclass station the all-classes value, with each class in the tooltip", () => {
    const records = load("3d2ctandem.inf");
    const regen = by(records, "queue.regenerative-mc");
    const m = overlayModel({ records, fingerprint: regen.provenance.networkFingerprint, metric: "Mean number in system", selectedRunId: regen.id, decimals: 3 })!;
    const s1 = item(m, "S1");
    expect(s1.value).toBeCloseTo(9.34992621058199, 12);
    expect(s1.text).toBe("9.350 customers");
    expect(s1.classes).toEqual(["Class 1: 4.667 customers", "Class 2: 4.683 customers"]);
    expect(s1.lines.slice(1, 3)).toEqual(s1.classes);
    // A single-class network's "class 1" row is the station's value again: no breakdown.
    const single = by(tandem, "queue.regenerative-mc");
    expect(classBreakdown(single, "Mean number in system", single.measurements[0].stationID!, 3)).toEqual([]);
  });
});

describe("the scale", () => {
  it("is fixed 0–1 for utilisation and relative to the largest station for anything else", () => {
    const u = model();
    expect(u.fixedScale).toBe(true);
    for (const i of u.items.values()) expect(i.intensity).toBeCloseTo(i.value, 12);
    const qna = by(tandem, "queue-approx.qna");
    const scaled: ResultRecord = { ...qna, id: "scaled", measurements: qna.measurements.map((x) => (x.metric === "Mean number in system" && x.stationName === "S2" ? { ...x, estimate: 3 } : x)) };
    const n = overlayModel({ records: [scaled], fingerprint: fp, metric: "Mean number in system", decimals: 3 })!;
    expect(n.fixedScale).toBe(false);
    expect(n.max).toBe(9);
    expect(item(n, "S1").intensity).toBe(1);
    expect(item(n, "S2").intensity).toBeCloseTo(1 / 3, 12);
  });

  it("clamps: an overloaded station is the top of the scale, a non-number the bottom", () => {
    expect(intensityOf(1.3, true, 0)).toBe(1);
    expect(intensityOf(-0.1, true, 0)).toBe(0);
    expect(intensityOf(Number.NaN, false, 5)).toBe(0);
    expect(intensityOf(2, false, 0)).toBe(0);
  });
});

describe("stations that tie for the highest utilisation", () => {
  it("are all marked, as equally loaded, in a recorded run: none is crowned", () => {
    // The product-form run of the five-station tandem: every station at ρ = 0.9.
    const exact = by(tandem, "queue.open-bcmp-product-form");
    expect(bottlenecks(exact).map((s) => s.stationName)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    const m = model({ selectedRunId: exact.id });
    const items = [...m.items.values()];
    expect(items.every((i) => i.bottleneck && i.tied)).toBe(true);
    expect(item(m, "S1").label).toContain("Equally loaded");
    expect(items.some((i) => i.label.includes("Bottleneck") || i.lines.includes("Bottleneck: the highest utilisation in this run."))).toBe(false);
    expect(item(m, "S1").lines).toContain("Equally loaded: the highest utilisation, shared with S2, S3, S4 and S5. No single bottleneck.");
    // Two utilisations 4·10⁻⁵ apart tie; 6·10⁻⁵ apart do not (the tolerance is 5·10⁻⁵, as in Rust and in Sensitivity).
    const nudged = (by_: number): ResultRecord => ({ ...exact, id: `n${by_}`, measurements: exact.measurements.map((x) => (x.metric === "Server utilization" && x.stationName === "S3" ? { ...x, estimate: x.estimate + by_ } : x)) });
    expect(bottlenecks(nudged(4e-5))).toHaveLength(5);
    expect(bottlenecks(nudged(6e-5)).map((s) => s.stationName)).toEqual(["S3"]);
    const lone = overlayModel({ records: [nudged(6e-5)], fingerprint: fp, metric: "Utilization", decimals: 6 })!;
    expect([...lone.items.values()].filter((i) => i.bottleneck).map((i) => [i.stationName, i.tied, i.label.includes("Bottleneck")])).toEqual([["S3", false, true]]);
  });
});

describe("the bottleneck", () => {
  it("is the station with the highest utilisation in the shown run, whatever metric is shown", () => {
    const sim = by(tandem, "queue.des");
    const neck = bottleneck(sim)!;
    for (const metric of ["Utilization", "Mean number in system", "Throughput"] as const) {
      const m = model({ selectedRunId: sim.id, metric });
      const marked = [...m.items.values()].filter((i) => i.bottleneck);
      expect(marked.map((i) => i.stationID)).toEqual([neck.stationID]);
      expect(marked[0].lines).toContain("Bottleneck: the highest utilisation in this run.");
      expect(marked[0].label).toContain("Bottleneck");
    }
  });
});

describe("after an edit", () => {
  it("keeps the last run's values and says the network changed, instead of showing nothing or showing them as current", () => {
    const m = model({ fingerprint: "the-network-after-an-edit" });
    expect(m.stale).toBe(true);
    expect(m.run.method.identifier).toBe("queue.open-bcmp-product-form");
    expect(m.items.size).toBe(5);
    for (const i of m.items.values()) {
      expect(i.lines.at(-1)).toBe("Network changed since this run");
      expect(i.label).toMatch(/Network changed since this run$/);
    }
  });

  it("prefers a run of the network as it is now over a better-tier run of the old one", () => {
    const qna = by(tandem, "queue-approx.qna");
    const rerun: ResultRecord = { ...qna, id: "rerun", completedAt: "2030-01-01T00:00:00Z", provenance: { ...qna.provenance, networkFingerprint: "new" } };
    const m = overlayModel({ records: [...tandem, rerun], fingerprint: "new", metric: "Utilization", decimals: 3 })!;
    expect(m.run.id).toBe("rerun");
    expect(m.stale).toBe(false);
  });

  it("reads nothing as stale while the fingerprint is not yet known", () => {
    expect(model({ fingerprint: null }).stale).toBe(false);
  });
});
