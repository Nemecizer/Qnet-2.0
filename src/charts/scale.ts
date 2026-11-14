// Scales and ticks for the charts (new in 2.1, ROADMAP B1). Pure numbers, no DOM: a linear scale
// with "nice" ticks (1, 2, 2.5 or 5 × a power of ten), and a band scale for categories.

/** The finite numbers among `values` (NaN, ±∞, null and undefined are left out). */
export function finite(values: Iterable<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  return out;
}

/** [min, max] of the finite values, or null when there are none. */
export function extent(values: Iterable<number | null | undefined>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of finite(values)) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

const STEPS = [1, 2, 2.5, 5, 10];

/** The nice step nearest to `(max − min) / count` from above: 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceStep(min: number, max: number, count = 5): number {
  const span = Math.abs(max - min);
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, count);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const unit = raw / pow;
  return (STEPS.find((s) => s >= unit - 1e-12) ?? 10) * pow;
}

/** How many fraction digits a tick at `step` needs (0.25 → 2, 5 → 0, 1e-7 → 7). */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  for (let d = 0; d <= 12; d++) {
    const scaled = step * Math.pow(10, d);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return 12;
}

export interface Ticks {
  /** The nice domain: the first and last tick. */
  min: number;
  max: number;
  step: number;
  values: number[];
  /** Fraction digits that write every tick exactly. */
  decimals: number;
}

/**
 * Nice ticks covering [min, max]. A single value, or all values equal, gets a domain around it
 * (0 … 2v for a positive v, so a bar still has a baseline; ±1 round 0); the ends may be swapped;
 * a non-finite end reads as 0.
 */
export function niceTicks(min: number, max: number, count = 5): Ticks {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo === 0) [lo, hi] = [0, 1];
    else if (lo > 0) [lo, hi] = [0, lo * 2];
    else [lo, hi] = [lo * 2, 0];
  }
  const step = niceStep(lo, hi, count);
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  const decimals = stepDecimals(step);
  const values: number[] = [];
  // Multiply rather than accumulate, then round to the step's own digits: no 0.30000000000000004.
  for (let i = first; i <= last; i++) values.push(Number((i * step).toFixed(Math.min(decimals, 12))) || 0);
  return { min: values[0], max: values[values.length - 1], step, values, decimals };
}

export interface LinearScale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
  ticks: Ticks;
  invert(px: number): number;
}

export interface LinearOptions {
  /** Keep 0 in the domain (bars: a length must start at zero). */
  zero?: boolean;
  /** About how many ticks. */
  count?: number;
}

/** A linear scale over the nice domain of `values`, onto `range` (pixels; may run downward). */
export function linearScale(values: Iterable<number | null | undefined>, range: [number, number], options: LinearOptions = {}): LinearScale {
  const e = extent(values) ?? [0, 1];
  let [lo, hi] = e;
  if (options.zero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const ticks = niceTicks(lo, hi, options.count ?? 5);
  const [d0, d1] = [ticks.min, ticks.max];
  const [r0, r1] = range;
  const k = (r1 - r0) / (d1 - d0);
  const scale = ((v: number) => r0 + (v - d0) * k) as LinearScale;
  scale.domain = [d0, d1];
  scale.range = range;
  scale.ticks = ticks;
  scale.invert = (px: number) => (k === 0 ? d0 : d0 + (px - r0) / k);
  return scale;
}

export interface BandScale {
  /** The band's start, or NaN for an unknown key. */
  (key: string): number;
  keys: string[];
  bandwidth: number;
  step: number;
  center(key: string): number;
}

/** Equal bands for `keys` along `range`, with `padding` (a share of the step) between and half of it outside. */
export function bandScale(keys: readonly string[], range: [number, number], padding = 0.2): BandScale {
  const n = Math.max(1, keys.length);
  const [r0, r1] = range;
  const step = (r1 - r0) / n;
  const bandwidth = step * (1 - Math.max(0, Math.min(0.95, padding)));
  const index = new Map(keys.map((k, i) => [k, i]));
  const at = (key: string) => {
    const i = index.get(key);
    return i === undefined ? NaN : r0 + i * step + (step - bandwidth) / 2;
  };
  const scale = at as BandScale;
  scale.keys = [...keys];
  scale.bandwidth = Math.abs(bandwidth);
  scale.step = step;
  scale.center = (key: string) => at(key) + bandwidth / 2;
  return scale;
}

/** A tick's text: the step's own digits, grouped thousands off, scientific for very large or small steps. */
export function tickLabel(value: number, ticks: Pick<Ticks, "step" | "decimals">): string {
  if (!Number.isFinite(value)) return "";
  const big = Math.abs(value) >= 1e6 || (ticks.step >= 1e6);
  const tiny = ticks.step > 0 && ticks.step < 1e-4;
  if (value !== 0 && (big || tiny)) {
    const [m, e] = value.toExponential(2).split("e");
    return `${Number(m)}e${Number(e)}`;
  }
  const text = value.toFixed(Math.min(ticks.decimals, 8));
  return text.replace(/^-(0(\.0+)?)$/, "$1").replace("-", "−");
}
