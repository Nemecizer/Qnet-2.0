// `uncertainty_analyze` and `uncertainty_linear` in the browser preview and the tests
// (src-tauri/src/uncertainty.rs). The preview can't run core, so this is a stand-in with the same
// shape: for a single-class exponential network with infinite buffers it samples the preview's
// own stand-in model (./sweeps2: M/M/c by a one-line form that is exact for one server) with a
// small seeded generator, 4 000 draws, and reports the same quantities; anything else is answered
// "no closed formula", as the app answers it. The numbers are a preview's, never Qnet's: the
// app's are core/src/uncertainty.rs, which has the exact checks. Tests set `mockUncertainty.run`
// to answer exactly what a case needs, and read `calls`.
import type { BnetDocument } from "../../lib/bnet";
import { discoverParameters, substitute } from "../../sweeps/model";
import { channelSend, type MockHandlers } from "../../test/tauri";
import type { Estimate, InputRow, LinearRequest, ShareRow, Spread, UncertaintyAnalysis, UncertaintyRequest } from "../../uncertainty/model";
import { standInSensitivity } from "./sensitivity";
import { mockTraffic } from "./sweeps2";

export const mockUncertainty = {
  /** Answers instead of the stand-in, when set. */
  run: null as null | ((request: UncertaintyRequest) => UncertaintyAnalysis),
  calls: [] as UncertaintyRequest[],
  linearCalls: [] as LinearRequest[],
  /** The stand-in's draws. */
  samples: 4000,
};

const Z = 1.959963984540054;
const THRESHOLD = 0.1;
const none = (reason: UncertaintyAnalysis["reason"], sentence: string | null): UncertaintyAnalysis => ({ available: false, reason, sentence, value: null, unit: null, inputs: [], shares: [], linear: null, sampling: null, disagreement: null, threshold: THRESHOLD });

/** Φ, to about 1e-7 (Abramowitz & Stegun 26.2.17): enough for a preview. */
function phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

interface Law {
  name: InputRow["law"];
  at: (z: number) => number;
  mean: number;
  sd: number;
  low: number;
  high: number;
}

function lawOf(spread: Spread, current: number): Law {
  const lognormal = (m: number, s: number): Law => {
    const mean = Math.exp(m + (s * s) / 2);
    return { name: "lognormal", at: (z) => Math.exp(m + s * z), mean, sd: mean * Math.sqrt(Math.exp(s * s) - 1), low: Math.exp(m - Z * s), high: Math.exp(m + Z * s) };
  };
  const uniform = (lo: number, hi: number): Law => ({ name: "uniform", at: (z) => lo + (hi - lo) * phi(z), mean: (lo + hi) / 2, sd: (hi - lo) / Math.sqrt(12), low: lo + 0.025 * (hi - lo), high: lo + 0.975 * (hi - lo) });
  switch (spread.kind) {
    case "relativeSd": {
      const s2 = Math.log(1 + spread.value * spread.value);
      return lognormal(Math.log(current) - s2 / 2, Math.sqrt(s2));
    }
    case "relativeRange":
      if (spread.value >= 1) throw { kind: "invalid", message: "A range of ±100 % or more would let the rate reach zero: choose less, or read the uncertainty as a standard deviation." };
      return uniform(current * (1 - spread.value), current * (1 + spread.value));
    case "interval95":
      return lognormal((Math.log(spread.low) + Math.log(spread.high)) / 2, (Math.log(spread.high) - Math.log(spread.low)) / (2 * Z));
    case "intervalRange":
      return uniform(spread.low, spread.high);
  }
}

const factorsOf = (kinds: string[], together: boolean): number[][] => {
  const out: number[][] = [];
  let arrivals = -1;
  kinds.forEach((k, i) => {
    if (together && k === "arrival") {
      if (arrivals < 0) arrivals = out.push([i]) - 1;
      else out[arrivals].push(i);
    } else out.push([i]);
  });
  return out;
};

function linearPart(value: number, ids: string[], laws: Law[], derivatives: number[], factors: number[][]) {
  const parts = factors.map((members) => members.reduce((sum, i) => sum + derivatives[i] * laws[i].sd, 0) ** 2);
  const variance = parts.reduce((a, b) => a + b, 0);
  const sd = Math.sqrt(variance);
  const inputs: InputRow[] = ids.map((id, i) => ({ id, law: laws[i].name, mean: laws[i].mean, sd: laws[i].sd, low: laws[i].low, high: laws[i].high, derivative: derivatives[i] }));
  const shares: ShareRow[] = factors.map((members, g) => ({ ids: members.map((i) => ids[i]), linear: variance > 0 ? parts[g] / variance : 0, first: null, total: null }));
  return { inputs, shares, linear: { sd, low: value - Z * sd, high: value + Z * sd } };
}

/** The stand-in's `uncertainty_linear`: the delta method, as the app computes it. */
export function standInLinear(request: LinearRequest): UncertaintyAnalysis {
  const laws = request.inputs.map((i) => lawOf(i.spread, i.current));
  const part = linearPart(request.value, request.inputs.map((i) => i.id), laws, request.inputs.map((i) => i.derivative), factorsOf(request.inputs.map((i) => i.kind), request.arrivalsTogether));
  return { available: true, reason: null, sentence: null, value: request.value, unit: null, ...part, sampling: null, disagreement: null, threshold: THRESHOLD };
}

const meanSd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return [m, Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, xs.length - 1))] as const;
};

/** The stand-in's `uncertainty_analyze`. */
export function standInUncertainty(request: UncertaintyRequest): UncertaintyAnalysis {
  const doc = request.document as BnetDocument;
  const gate = standInSensitivity({ document: doc, measure: request.measure, parameters: [], targetChange: null });
  if (!gate.available) return none(gate.reason, gate.sentence);
  const parameters = discoverParameters(doc);
  const chosen = request.inputs.map((i) => parameters.find((p) => p.id === i.id));
  if (chosen.some((p) => !p || (p.kind !== "arrival" && p.kind !== "service"))) throw { kind: "invalid", message: "Only arrival rates and service rates can be given an uncertainty." };
  if (!request.inputs.length) throw { kind: "invalid", message: "Nothing is uncertain yet: give at least one rate an uncertainty above zero." };
  const ps = chosen.map((p) => p!);
  const laws = request.inputs.map((i, k) => lawOf(i.spread, ps[k].current));

  // The stand-in model, linear in the arrival rates: α = α₀ + Σ a·(θ − θ₀); ρ ∝ α/μ.
  const base = mockTraffic(doc);
  const lambda0 = parameters.filter((p) => p.kind === "arrival").reduce((sum, p) => sum + p.current, 0);
  const slopes = ps.map((p) => {
    if (p.kind !== "arrival") return null;
    const moved = mockTraffic(substitute(doc, p, p.current * 2)!);
    return base.map((s, i) => (moved[i].arrival - s.arrival) / p.current);
  });
  const stationOf = ps.map((p) => (p.kind === "service" ? base.findIndex((s) => s.id === p.nodeId) : -1));
  const target = request.measure.stationId ? base.findIndex((s) => s.id === request.measure.stationId) : -1;
  const evaluate = (theta: number[]): number | null => {
    const alpha = base.map((s) => s.arrival);
    const mu = base.map(() => 1);
    let lambda = lambda0;
    theta.forEach((t, k) => {
      const slope = slopes[k];
      if (slope) {
        slope.forEach((a, i) => (alpha[i] += a * (t - ps[k].current)));
        lambda += t - ps[k].current;
      } else if (stationOf[k] >= 0) mu[stationOf[k]] = t / ps[k].current;
    });
    const rho = base.map((s, i) => (s.utilisation * alpha[i]) / s.arrival / mu[i]);
    if (rho.some((r) => !(r < 1))) return null;
    const queue = base.map((s, i) => Math.pow(rho[i], Math.sqrt(2 * (s.servers + 1))) / (1 - rho[i]));
    const number = base.map((s, i) => queue[i] + s.servers * rho[i]);
    const total = number.reduce((a, b) => a + b, 0);
    switch (request.measure.kind) {
      case "networkNumber": return total;
      case "networkSojourn": return total / lambda;
      case "stationNumber": return number[target];
      case "stationQueue": return queue[target];
      case "stationSojourn": return number[target] / alpha[target];
      case "stationUtilisation": return rho[target];
    }
  };
  const nominal = ps.map((p) => p.current);
  const value = evaluate(nominal);
  if (value === null) return none("unstable", "A station is overloaded, so the network has no steady state.");
  const derivatives = ps.map((p, k) => {
    const h = 1e-6 * p.current;
    const at = (x: number) => evaluate(nominal.map((t, i) => (i === k ? x : t))) ?? value;
    return (at(p.current + h) - at(p.current - h)) / (2 * h);
  });
  const factors = factorsOf(ps.map((p) => p.kind), request.arrivalsTogether);
  const part = linearPart(value, request.inputs.map((i) => i.id), laws, derivatives, factors);

  // A small seeded generator (mulberry32) and Box–Muller.
  let state = (request.seed ?? 2021) >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const n = Math.max(200, Math.min(request.samples ?? mockUncertainty.samples, 20000));
  const k = factors.length;
  const draw = () => factors.map(() => normal());
  const at = (z: number[]) => {
    const theta = nominal.slice();
    factors.forEach((members, g) => members.forEach((i) => (theta[i] = laws[i].at(z[g]))));
    return evaluate(theta);
  };
  const za = Array.from({ length: n }, draw);
  const ya = za.map(at);
  const stable = ya.filter((y): y is number => y !== null).sort((a, b) => a - b);
  const unstable = n - stable.length;
  const p = unstable / n;
  const quantile = (q: number): Estimate => {
    const m = stable.length;
    const rank = (r: number) => stable[Math.max(1, Math.min(m, r)) - 1];
    const half = Z * Math.sqrt(m * q * (1 - q));
    return { value: rank(Math.ceil(m * q)), se: (rank(Math.ceil(m * q + half)) - rank(Math.floor(m * q - half))) / (2 * Z) };
  };
  // The app decides this from the laws (core `mean_exists`); the preview's stand-in: a lognormal
  // rate always reaches overload, a range does when a sampled case did. A utilisation is bounded.
  const meanExists = request.measure.kind === "stationUtilisation" || (unstable === 0 && laws.every((l) => l.name !== "lognormal"));
  let sampling: UncertaintyAnalysis["sampling"] = { samples: n, seed: request.seed ?? 2021, unstable, pUnstable: { value: p, se: Math.sqrt((p * (1 - p)) / n) }, meanExists, mean: null, sd: null, median: null, q025: null, q975: null, min: null, max: null, histogram: null, shareRows: 0, evaluations: n };
  let disagreement: number | null = null;
  if (stable.length >= 2) {
    const [mean, sd] = meanSd(stable);
    const lo = stable[0];
    const top = Math.min(quantile(0.995).value, quantile(0.5).value + 8 * (quantile(0.5).value - quantile(0.025).value));
    const hi = top > lo ? top : stable[stable.length - 1];
    const counts = new Array<number>(hi > lo ? 40 : 1).fill(0);
    let above = 0;
    for (const x of stable) {
      if (x > hi) above++;
      else counts[hi > lo ? Math.min(39, Math.floor(((x - lo) / (hi - lo)) * 40)) : 0]++;
    }
    const [q025, median, q975] = [quantile(0.025), quantile(0.5), quantile(0.975)];
    sampling = { ...sampling, mean: meanExists ? { value: mean, se: sd / Math.sqrt(stable.length) } : null, sd: meanExists ? sd : null, median, q025, q975, min: lo, max: stable[stable.length - 1], histogram: { low: lo, high: hi, counts, above } };
    const width = q975.value - q025.value;
    if (width > 0 && sd > 0) disagreement = Math.max(meanExists ? Math.abs(part.linear.sd / sd - 1) : 0, Math.abs(part.linear.high - q975.value) / width, Math.abs(part.linear.low - q025.value) / width);
    // Shares: the pick-freeze design, as core does it.
    if (!meanExists) {
      // No mean, no variance to share out: the linear route's shares stand alone.
    } else if (k === 1) part.shares[0] = { ...part.shares[0], first: { value: 1, se: 0 }, total: { value: 1, se: 0 } };
    else if (k > 1) {
      const rows = Math.min(n, 2000);
      const zb = Array.from({ length: rows }, draw);
      const yb = zb.map(at);
      const both = ya.slice(0, rows).flatMap((a, j) => (a !== null && yb[j] !== null ? [a, yb[j]!] : []));
      const [f0, s0] = meanSd(both);
      const v = s0 * s0;
      factors.forEach((_m, i) => {
        const u: number[] = [];
        const e: number[] = [];
        for (let j = 0; j < rows; j++) {
          const ab = at(za[j].map((z, g) => (g === i ? zb[j][g] : z)));
          const [a, b] = [ya[j], yb[j]];
          if (a === null || b === null || ab === null) continue;
          u.push((b - f0) * (ab - a));
          e.push(0.5 * (a - ab) * (a - ab));
        }
        const ratio = (xs: number[]): Estimate => {
          if (xs.length < 2 || !(v > 0)) return { value: 0, se: 0 };
          const [m, s] = meanSd(xs);
          return { value: m / v, se: s / v / Math.sqrt(xs.length) };
        };
        part.shares[i] = { ...part.shares[i], first: ratio(u), total: ratio(e) };
      });
      sampling.shareRows = rows;
      sampling.evaluations = n + rows * (k + 1);
    }
  }
  return { available: true, reason: null, sentence: null, value, unit: gate.unit, ...part, sampling, disagreement, threshold: THRESHOLD };
}

export function uncertaintyHandlers(): MockHandlers {
  mockUncertainty.run = null;
  mockUncertainty.calls = [];
  mockUncertainty.linearCalls = [];
  mockUncertainty.samples = 4000;
  return {
    uncertainty_analyze: ({ request, channel }: { request: UncertaintyRequest; channel: unknown }) => {
      mockUncertainty.calls.push(request);
      const answer = (mockUncertainty.run ?? standInUncertainty)(request);
      if (channel && answer.sampling) channelSend(channel, { done: answer.sampling.evaluations, total: answer.sampling.evaluations });
      return answer;
    },
    uncertainty_linear: ({ request }: { request: LinearRequest }) => {
      mockUncertainty.linearCalls.push(request);
      return standInLinear(request);
    },
  };
}
