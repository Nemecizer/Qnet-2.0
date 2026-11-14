// `sensitivity_analyze` in the browser preview and the tests (src-tauri/src/sensitivity.rs). The
// preview can't run core, so this is a stand-in with the same shape: for a single-class
// exponential network with infinite buffers it differentiates the preview's own stand-in model
// (./sweeps2: traffic by substitution, M/M/c by a one-line form that is exact for one server)
// numerically and searches it for "what would it take"; anything else is answered "no closed
// formula", as the app answers it. The numbers are a preview's, never Qnet's: the app's are
// core/src/sensitivity.rs, which has the exact checks. Tests set `mockSensitivity.run` to answer
// exactly what a case needs, and read `calls`.
import type { BnetDocument } from "../../lib/bnet";
import { openOnly } from "../../closed/shape";
import { asResult } from "../../panes/results/model";
import { mostLoaded } from "../../results/insight";
import { readMeasure, measureOptions, type AnalysisRow, type InversionAnswer, type SensitivityAnalysis, type SensitivityRequest } from "../../sensitivity/model";
import { allowed, discoverParameters, substitute, type SweepParameter } from "../../sweeps/model";
import type { MockHandlers } from "../../test/tauri";
import { mockProbe, mockQuietRecord, mockTraffic } from "./sweeps2";

export const mockSensitivity = {
  /** Answers instead of the stand-in, when set. */
  run: null as null | ((request: SensitivityRequest) => SensitivityAnalysis),
  calls: [] as SensitivityRequest[],
};

const none = (reason: SensitivityAnalysis["reason"], sentence: string): SensitivityAnalysis => ({ available: false, reason, sentence, value: null, unit: null, target: null, stations: [], bottlenecks: [], rows: [] });

export const NOT_JACKSON =
  "The network is not an open Jackson network (Poisson arrivals, exponential service times, infinite buffers and one customer class at each station), so no closed formula applies.";

/** The stand-in's answer. */
export function standInSensitivity(request: SensitivityRequest): SensitivityAnalysis {
  const doc = request.document as BnetDocument;
  const stationsOf = doc.nodes.filter((n) => n.kind === "station");
  if (!stationsOf.length) return none("network", "The network has no stations.");
  const refusal = openOnly(doc, "Sensitivity analysis");
  if (refusal) return none(refusal.reason, refusal.sentence);
  if (!doc.nodes.some((n) => n.kind === "source")) return none("network", "The network has no source node.");
  if (!doc.nodes.some((n) => n.kind === "sink")) return none("network", "The network has no sink node.");
  const traffic = mockTraffic(doc);
  const over = traffic.find((s) => s.utilisation >= 1);
  if (doc.infiniteBuffers && over) return none("unstable", `${over.name} is overloaded (utilisation ${over.utilisation.toFixed(3)}), so the network has no steady state.`);
  const exponential = doc.nodes.every((n) => (n.kind !== "station" && n.kind !== "source") || n.distribution === "exponential" || (n.kind === "source" && n.distribution === "poisson"));
  const perClass = stationsOf.some((n) => Object.values(n.serviceDistributions ?? {}).some((l) => l.distribution !== "exponential"));
  if (!doc.infiniteBuffers || !exponential || perClass || traffic.some((s) => s.flows.size !== 1)) return none("notJackson", NOT_JACKSON);

  const measure = measureOptions(doc).find((m) => m.kind === request.measure.kind && m.stationId === request.measure.stationId);
  if (!measure) throw { kind: "invalid", message: "The station this measure belongs to is no longer in the network." };
  const parameters = discoverParameters(doc);
  const evaluate = (d: BnetDocument): number | null => {
    if (!mockProbe(d).stable) return null;
    return readMeasure(asResult(mockQuietRecord({ tabId: "preview", title: "preview", method: "product_form" }, d)), measure, d, );
  };
  const value = evaluate(doc);
  if (value === null) return none("notJackson", NOT_JACKSON);
  const target = request.targetChange ? value * (1 + request.targetChange) : null;
  const at = (p: SweepParameter, x: number) => {
    const d = allowed(p, x) ? substitute(doc, p, x) : null;
    return d ? evaluate(d) : null;
  };
  const rows: AnalysisRow[] = request.parameters.map((asked) => {
    const p = parameters.find((x) => x.id === asked.id);
    const row: AnalysisRow = { id: asked.id, current: p?.current ?? null, integer: !!p?.integer, derivative: null, elasticity: null, oneMore: null, inversion: null, note: null };
    if (!p) return { ...row, note: "The parameter is no longer in the network." };
    if (p.integer) {
      row.oneMore = at(p, p.current + 1);
      if (target !== null) row.inversion = invertWhole(p, value, target, at);
      return row;
    }
    const h = 1e-5 * (p.kind === "routing" ? (p.rowSum ?? 1) : p.current);
    const [lo, hi] = [allowed(p, p.current - h) ? p.current - h : p.current, allowed(p, p.current + h) ? p.current + h : p.current];
    const [a, b] = [at(p, lo), at(p, hi)];
    if (a === null || b === null || hi === lo) return row;
    row.derivative = Math.abs(b - a) < 1e-13 ? 0 : (b - a) / (hi - lo);
    row.elasticity = value !== 0 ? (row.derivative * p.current) / value : null;
    if (target !== null) row.inversion = invert(p, value, target, row.derivative, at);
    return row;
  });
  const stations = traffic.map((s) => ({ id: s.id, name: s.name, utilisation: s.utilisation }));
  return { available: true, reason: null, sentence: null, value, unit: measure.unit, target, stations, bottlenecks: mostLoaded(stations, (s) => s.utilisation).map((s) => s.id), rows };
}

type At = (p: SweepParameter, x: number) => number | null;
const infeasible = (why: "noEffect" | "rangeEnds" | "levels" | "overload", limitValue: number | null = null, limitMeasure: number | null = null): InversionAnswer => ({ kind: "infeasible", why, limitValue, limitMeasure });

function invertWhole(p: SweepParameter, value: number, target: number, at: At): InversionAnswer {
  const up = target > value;
  const reached = (m: number) => (up ? m >= target : m <= target);
  const first = at(p, p.current + 1);
  if (first === null || Math.abs(first - value) < 1e-12) return infeasible("noEffect");
  const step = first > value === up ? 1 : -1;
  let last = value;
  for (let x = p.current + step; x >= p.min && x <= p.current + 200; x += step) {
    const m = at(p, x);
    if (m === null) return infeasible("overload", x - step, last);
    if (reached(m)) return { kind: "achieved", value: x, measure: m };
    if (Math.abs(m - last) < 1e-12) break;
    last = m;
  }
  return step > 0 ? infeasible("levels", null, last) : infeasible("rangeEnds", p.min, last);
}

function invert(p: SweepParameter, value: number, target: number, derivative: number, at: At): InversionAnswer {
  if (!derivative) return infeasible("noEffect");
  const up = target > value;
  const rising = derivative > 0 === up;
  const crossed = (x: number) => {
    const m = at(p, x);
    return m === null || (up ? m >= target : m <= target);
  };
  const closedEnd = rising ? p.max : p.kind === "routing" ? p.min : null;
  const points: number[] = [];
  for (let k = 1; k <= 40; k++) {
    if (closedEnd !== null) points.push(k === 40 ? closedEnd : p.current + (closedEnd - p.current) * Math.pow(2, k - 40));
    else points.push(rising ? p.current * Math.pow(2, k / 2) : p.current * Math.pow(2, -k / 2));
  }
  let a = p.current;
  let found: number | null = null;
  for (const x of points) {
    if (x === a) continue;
    if (crossed(x)) {
      found = x;
      break;
    }
    a = x;
  }
  let b: number = found ?? a;
  if (found === null) return infeasible(closedEnd !== null ? "rangeEnds" : "levels", closedEnd !== null ? a : null, at(p, a));
  for (let i = 0; i < 80; i++) {
    const mid = (a + b) / 2;
    if (crossed(mid)) b = mid;
    else a = mid;
  }
  const m = at(p, b);
  return m !== null && Math.abs(m - target) <= 1e-6 * Math.max(Math.abs(target), Math.abs(value - target)) ? { kind: "achieved", value: b, measure: m } : infeasible("overload", a, at(p, a));
}

export function sensitivityHandlers(): MockHandlers {
  mockSensitivity.run = null;
  mockSensitivity.calls = [];
  return {
    sensitivity_analyze: ({ request }: { request: SensitivityRequest }) => {
      mockSensitivity.calls.push(request);
      return (mockSensitivity.run ?? standInSensitivity)(request);
    },
  };
}
