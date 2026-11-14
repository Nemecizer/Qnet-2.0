// The nine distribution families (0.90.34 Models.swift `QueueDistribution`, ledger DIST-001…032):
// their parameters, validation, mean and SCV, the solve from (mean, SCV) and the words the
// inspector shows for each. core/src/dist.rs is the Rust twin the exporters use; the two agree
// (the inspector needs these numbers synchronously, on every keystroke).
import { DISTRIBUTIONS, type Distribution } from "../../../editor/distributions";
import { formatSig } from "./numbers";

export { DISTRIBUTIONS, type Distribution };

export interface ParameterDef {
  key: string;
  displayName: string;
  defaultValue: number;
  /** "time", "1/time", or null for a pure number. */
  unit: string | null;
  minValue: number | null;
  maxValue: number | null;
  /** The lower bound is strict (> min). */
  exclusiveMin: boolean;
  help: string;
  isInteger: boolean;
}

const def = (key: string, displayName: string, defaultValue: number, o: Partial<Omit<ParameterDef, "key" | "displayName" | "defaultValue">> = {}): ParameterDef => ({
  key,
  displayName,
  defaultValue,
  unit: o.unit ?? null,
  minValue: o.minValue ?? null,
  maxValue: o.maxValue ?? null,
  exclusiveMin: o.exclusiveMin ?? false,
  help: o.help ?? "",
  isInteger: o.isInteger ?? false,
});

const DEFS: Record<Distribution, ParameterDef[]> = {
  exponential: [def("rate", "Rate (λ)", 1.0, { unit: "1/time", minValue: 0, exclusiveMin: true, help: "Events per unit time; mean = 1/λ." })],
  gamma: [
    def("shape", "Shape (k)", 2.0, { minValue: 0, exclusiveMin: true, help: "k > 0. Larger k means less variability (c² = 1/k)." }),
    def("scale", "Scale (θ)", 1.0, { unit: "time", minValue: 0, exclusiveMin: true, help: "θ > 0. Mean = k·θ." }),
  ],
  uniform: [
    def("min", "Min (a)", 0.5, { unit: "time", minValue: 0, help: "Lower bound, a ≥ 0 and a < b." }),
    def("max", "Max (b)", 1.5, { unit: "time", minValue: 0, exclusiveMin: true, help: "Upper bound, b > a." }),
  ],
  constant: [def("value", "Value (v)", 1.0, { unit: "time", minValue: 0, exclusiveMin: true, help: "Deterministic duration, v > 0." })],
  weibull: [
    def("shape", "Shape (k)", 1.5, { minValue: 0, exclusiveMin: true, help: "k > 0. k = 1 is Exponential; k > 1 is less variable." }),
    def("scale", "Scale (λ)", 1.0, { unit: "time", minValue: 0, exclusiveMin: true, help: "λ > 0. Mean = λ·Γ(1 + 1/k)." }),
  ],
  erlang: [
    def("k", "Stages (k)", 2.0, { minValue: 1, help: "Whole number k ≥ 1; c² = 1/k.", isInteger: true }),
    def("rate", "Rate (μ)", 1.0, { unit: "1/time", minValue: 0, exclusiveMin: true, help: "Per-stage rate μ > 0; mean = k/μ." }),
  ],
  lognormal: [
    def("mu", "μ (log-mean)", 0.0, { help: "Mean of ln X (any real number)." }),
    def("sigma", "σ (log-sd)", 0.25, { minValue: 0, exclusiveMin: true, help: "σ > 0. c² = e^σ² − 1." }),
  ],
  // DIST-025 (Changed, D5): 0.90.34's field said α > 1 while Save needed α > 2; the field now states
  // the rule Save enforces, in core/src/dist.rs's words.
  pareto: [
    def("shape", "Shape (α)", 2.5, { minValue: 2, exclusiveMin: true, help: "α > 2: Qnet needs a finite variance (SCV), which a Pareto law has only for α > 2." }),
    def("scale", "Scale (xₘ)", 1.0, { unit: "time", minValue: 0, exclusiveMin: true, help: "Minimum value xₘ > 0." }),
  ],
  poisson: [def("lambda", "Rate (λ)", 1.0, { unit: "1/time", minValue: 0, exclusiveMin: true, help: "Arrival rate; inter-arrivals are Exp(λ) with mean 1/λ." })],
};

export interface FamilyCard {
  displayName: string;
  pickerName: string;
  formula: string;
  meanFormula: string;
  scvFormula: string;
  menuSubtitle: string;
  /** The SF Symbol 0.90.34 drew; 2.0 draws a lucide icon for it (src/panes/inspector/icons.ts). */
  symbol: string;
}

const CARDS: Record<Distribution, FamilyCard> = {
  exponential: { displayName: "Exponential", pickerName: "Exponential", formula: "f(x) = λ e^(−λx),  x ≥ 0", meanFormula: "E[X] = 1/λ", scvFormula: "c² = 1", menuSubtitle: "c² = 1", symbol: "chart.line.downtrend.xyaxis" },
  gamma: { displayName: "Gamma", pickerName: "Gamma", formula: "f(x) = x^(k−1) e^(−x/θ) / (Γ(k) θ^k),  x > 0", meanFormula: "E[X] = k·θ", scvFormula: "c² = 1/k", menuSubtitle: "c² = 1/k", symbol: "waveform.path" },
  uniform: { displayName: "Uniform", pickerName: "Uniform", formula: "f(x) = 1 / (b − a),  a ≤ x ≤ b", meanFormula: "E[X] = (a + b)/2", scvFormula: "c² = (b − a)² / 3(a + b)²", menuSubtitle: "c² from (a, b)", symbol: "rectangle.fill" },
  constant: { displayName: "Deterministic", pickerName: "Deterministic", formula: "P(X = v) = 1  (no variability)", meanFormula: "E[X] = v", scvFormula: "c² = 0", menuSubtitle: "c² = 0", symbol: "minus" },
  weibull: { displayName: "Weibull", pickerName: "Weibull", formula: "f(x) = (k/λ)(x/λ)^(k−1) e^(−(x/λ)^k),  x ≥ 0", meanFormula: "E[X] = λ·Γ(1 + 1/k)", scvFormula: "c² = Γ(1 + 2/k)/Γ(1 + 1/k)² − 1", menuSubtitle: "c² from k", symbol: "waveform.path.ecg" },
  erlang: { displayName: "Erlang", pickerName: "Erlang", formula: "f(x) = μ^k x^(k−1) e^(−μx) / (k−1)!,  x ≥ 0", meanFormula: "E[X] = k/μ", scvFormula: "c² = 1/k", menuSubtitle: "c² = 1/k", symbol: "chart.bar.fill" },
  lognormal: { displayName: "Lognormal", pickerName: "Lognormal", formula: "f(x) = e^(−(ln x − μ)² / 2σ²) / (x σ √(2π)),  x > 0", meanFormula: "E[X] = e^(μ + σ²/2)", scvFormula: "c² = e^(σ²) − 1", menuSubtitle: "c² = e^σ² − 1", symbol: "chart.line.uptrend.xyaxis" },
  pareto: { displayName: "Pareto", pickerName: "Pareto", formula: "f(x) = α xₘ^α / x^(α+1),  x ≥ xₘ", meanFormula: "E[X] = α·xₘ/(α − 1),  α > 1", scvFormula: "c² = 1/(α(α − 2)),  α > 2", menuSubtitle: "c² = 1/α(α−2)", symbol: "chart.line.flattrend.xyaxis" },
  poisson: { displayName: "Poisson", pickerName: "Poisson process (Exp. inter-arrivals)", formula: "N(t) ~ Poisson(λt);  inter-arrivals ~ Exp(λ)", meanFormula: "E[X] = 1/λ  (inter-arrival)", scvFormula: "c² = 1", menuSubtitle: "c² = 1", symbol: "circle.grid.cross" },
};

export const DEFAULT_PARAMETERS: Record<Distribution, string> = {
  exponential: "rate=1.0",
  gamma: "shape=2.0,scale=1.0",
  uniform: "min=0.5,max=1.5",
  constant: "value=1.0",
  weibull: "shape=1.5,scale=1.0",
  erlang: "k=2,rate=1.0",
  lognormal: "mu=0.0,sigma=0.25",
  pareto: "shape=2.5,scale=1.0",
  poisson: "lambda=1.0",
};

export type Params = Record<string, number>;

/** A stored family name read as one; an unknown name is read as Exponential, as a decode fallback. */
export function asDistribution(s: string): Distribution {
  return (DISTRIBUTIONS as readonly string[]).includes(s) ? (s as Distribution) : "exponential";
}

export const parameterDefs = (d: Distribution): ParameterDef[] => DEFS[d];
export const card = (d: Distribution): FamilyCard => CARDS[d];

/** `QueueDistribution.cases(for:)`: every family for a source, all but Poisson for a station. */
export function familiesFor(kind: "station" | "source"): Distribution[] {
  return kind === "station" ? DISTRIBUTIONS.filter((d) => d !== "poisson") : [...DISTRIBUTIONS];
}

/** `hasFixedSCV` / `fixedSCV`: Exponential and Poisson 1, Deterministic 0. */
export function fixedSCV(d: Distribution): number | null {
  return d === "exponential" || d === "poisson" ? 1 : d === "constant" ? 0 : null;
}

export const hasFixedSCV = (d: Distribution) => fixedSCV(d) !== null;
export const hasDiscreteSCV = (d: Distribution) => d === "erlang";

/** `DistributionParameterDef.validate`. Bounds are written with DS.Number.format (6 digits). */
export function validateValue(p: ParameterDef, value: number): string | null {
  if (!Number.isFinite(value)) return `${p.displayName} must be a finite number.`;
  if (p.isInteger && value !== roundAway(value)) return `${p.displayName} must be a whole number.`;
  if (p.minValue !== null) {
    if (p.exclusiveMin && value <= p.minValue) return `${p.displayName} must be > ${formatSig(p.minValue)}.`;
    if (!p.exclusiveMin && value < p.minValue) return `${p.displayName} must be ≥ ${formatSig(p.minValue)}.`;
  }
  if (p.maxValue !== null && value > p.maxValue) return `${p.displayName} must be ≤ ${formatSig(p.maxValue)}.`;
  return null;
}

/** `validateParameters`: each def's bound, then Uniform's b > a and Pareto's α > 2. */
export function validateParameters(d: Distribution, params: Params): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const p of DEFS[d]) {
    const v = params[p.key];
    if (v === undefined) continue;
    const m = validateValue(p, v);
    if (m) errors[p.key] = m;
  }
  if (d === "uniform") {
    const a = params.min;
    const b = params.max;
    if (!Object.keys(errors).length && a !== undefined && b !== undefined && b <= a) errors.max = "Max must be greater than Min.";
  } else if (d === "pareto") {
    const alpha = params.shape;
    if (errors.shape === undefined && alpha !== undefined && alpha <= 2) errors.shape = "Pareto SCV is finite only for α > 2.";
  }
  return errors;
}

/** `parseParameterStrings`: split on ",", then "="; only two-part pairs, trimmed; the last key wins. */
export function parseParameterStrings(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(",").filter((x) => x.length)) {
    const parts = pair.split("=").filter((x) => x.length);
    if (parts.length === 2) out[parts[0].replace(/^[ \t]+|[ \t]+$/g, "")] = parts[1].replace(/^[ \t]+|[ \t]+$/g, "");
  }
  return out;
}

/** Swift's `Double(String)` (no locale, no comma), as `meanFromParameterString` reads a stored value. */
export function swiftDoubleOf(s: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  return null;
}

/** The stored string's values that parse, keyed (`compactMapValues { Double($0) }`). */
export function storedParams(s: string): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(parseParameterStrings(s))) {
    const x = swiftDoubleOf(v);
    if (x !== null) out[k] = x;
  }
  return out;
}

const get = (p: Params, k: string) => (k in p ? p[k] : undefined);

/** `computeMean(params:)`: the mean service or inter-arrival time, or null. */
export function computeMean(d: Distribution, p: Params): number | null {
  switch (d) {
    case "exponential": {
      const r = get(p, "rate");
      return r !== undefined && r > 0 ? 1 / r : null;
    }
    case "gamma": {
      const k = get(p, "shape");
      const t = get(p, "scale");
      return k !== undefined && t !== undefined && k > 0 && t > 0 ? k * t : null;
    }
    case "uniform": {
      const a = get(p, "min");
      const b = get(p, "max");
      return a !== undefined && b !== undefined ? (a + b) / 2 : null;
    }
    case "constant": {
      const v = get(p, "value");
      return v !== undefined ? v : null;
    }
    case "weibull": {
      const k = get(p, "shape");
      const l = get(p, "scale");
      return k !== undefined && l !== undefined && k > 0 && l > 0 ? l * tgamma(1 + 1 / k) : null;
    }
    case "erlang": {
      const k = get(p, "k");
      const r = get(p, "rate");
      return k !== undefined && r !== undefined && k > 0 && r > 0 ? k / r : null;
    }
    case "lognormal": {
      const mu = get(p, "mu");
      const s = get(p, "sigma");
      return mu !== undefined && s !== undefined ? Math.exp(mu + (s * s) / 2) : null;
    }
    case "pareto": {
      const a = get(p, "shape");
      const xm = get(p, "scale");
      return a !== undefined && xm !== undefined && a > 1 && xm > 0 ? (a * xm) / (a - 1) : null;
    }
    case "poisson": {
      const l = get(p, "lambda");
      return l !== undefined && l > 0 ? 1 / l : null;
    }
  }
}

/** `computeSCV(params:)`: variance / mean², or null. */
export function computeSCV(d: Distribution, p: Params): number | null {
  switch (d) {
    case "exponential":
      return 1;
    case "gamma": {
      const k = get(p, "shape");
      return k !== undefined && k > 0 ? 1 / k : null;
    }
    case "uniform": {
      const a = get(p, "min");
      const b = get(p, "max");
      if (a === undefined || b === undefined || a + b === 0) return null;
      const diff = b - a;
      const sum = a + b;
      return (diff * diff) / (3 * sum * sum);
    }
    case "constant":
      return 0;
    case "weibull": {
      const k = get(p, "shape");
      if (k === undefined || !(k > 0)) return null;
      const g1 = tgamma(1 + 1 / k);
      const g2 = tgamma(1 + 2 / k);
      if (!(g1 > 0)) return null;
      return (g2 - g1 * g1) / (g1 * g1);
    }
    case "erlang": {
      const k = get(p, "k");
      return k !== undefined && k > 0 ? 1 / k : null;
    }
    case "lognormal": {
      const s = get(p, "sigma");
      return s !== undefined ? Math.exp(s * s) - 1 : null;
    }
    case "pareto": {
      const a = get(p, "shape");
      return a !== undefined && a > 2 ? 1 / (a * (a - 2)) : null;
    }
    case "poisson": {
      const l = get(p, "lambda");
      return l !== undefined && l > 0 ? 1 : null;
    }
  }
}

/** `meanFromParameterString`. */
export const meanOfString = (d: Distribution, s: string) => computeMean(d, storedParams(s));
/** `scvFromParameterString`. */
export const scvOfString = (d: Distribution, s: string) => computeSCV(d, storedParams(s));

/**
 * `parametersFromMoments(mean:scv:)`: native parameters for a target (mean, SCV), or null when the
 * pair is infeasible for the family. Fixed-SCV families ignore the SCV; Erlang snaps it to 1/k.
 */
export function parametersFromMoments(d: Distribution, mean: number, scv: number): Params | null {
  if (!(mean > 0 && scv >= 0)) return null;
  switch (d) {
    case "exponential":
      return { rate: 1 / mean };
    case "gamma":
      return scv > 0 ? { shape: 1 / scv, scale: mean * scv } : null;
    case "uniform": {
      const h = mean * Math.sqrt(3 * scv);
      const lo = mean - h;
      const hi = mean + h;
      return lo >= 0 ? { min: lo, max: hi } : null;
    }
    case "constant":
      return { value: mean };
    case "weibull": {
      if (!(scv > 0)) return null;
      const target = 1 + scv;
      const f = (k: number) => {
        const g1 = tgamma(1 + 1 / k);
        const g2 = tgamma(1 + 2 / k);
        return g2 / (g1 * g1) - target;
      };
      let lo = 0.05;
      let hi = 50;
      while (f(hi) > 0 && hi < 1e4) hi *= 2;
      if (!(f(lo) > 0 && f(hi) <= 0)) return null;
      for (let i = 0; i < 80; i++) {
        const mid = 0.5 * (lo + hi);
        if (f(mid) > 0) lo = mid;
        else hi = mid;
      }
      const k = 0.5 * (lo + hi);
      return { shape: k, scale: mean / tgamma(1 + 1 / k) };
    }
    case "erlang": {
      if (!(scv > 0)) return null;
      const k = Math.max(1, roundAway(1 / scv));
      return { k, rate: k / mean };
    }
    case "lognormal": {
      const s2 = Math.log(1 + scv);
      return { mu: Math.log(mean) - s2 / 2, sigma: Math.sqrt(s2) };
    }
    case "pareto": {
      if (!(scv > 0)) return null;
      const alpha = 1 + Math.sqrt(1 + 1 / scv);
      if (!(alpha > 2)) return null;
      return { shape: alpha, scale: (mean * (alpha - 1)) / alpha };
    }
    case "poisson":
      return { lambda: 1 / mean };
  }
}

/** Swift's `.rounded()`: to nearest, ties away from zero. */
export function roundAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

// Lanczos (g = 7, n = 9) with the reflection formula: C's tgamma to about 1e-15 relative, which is
// below the five significant digits any readout shows.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Γ(x), as C's `tgamma`. */
export function tgamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (Number.isInteger(x)) {
    if (x <= 0) return NaN;
    if (x <= 171) {
      let r = 1;
      for (let i = 2; i < x; i++) r *= i;
      return r;
    }
    return Infinity;
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * tgamma(1 - x));
  if (x > 171.7) return Infinity;
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  // t^(z+½) in two halves, so Γ(171) doesn't overflow on the way.
  const half = Math.pow(t, (z + 0.5) / 2);
  return Math.sqrt(2 * Math.PI) * half * (half * Math.exp(-t)) * a;
}
