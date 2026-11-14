// What `fit_distribution` answers (src-tauri/src/fit.rs; new in 2.1, ROADMAP D2). The arithmetic
// is Rust's alone: these are its shapes, and the few pure helpers the panel needs to show them.

export interface FitSummary {
  n: number;
  mean: number;
  /** Unbiased (divisor n − 1). */
  variance: number;
  sd: number;
  scv: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  zeros: number;
  /** 95 % intervals. */
  meanInterval: [number, number];
  scvInterval: [number, number];
  intervalMethod: "bootstrap" | "asymptotic";
  resamples: number;
}

export interface FittedParam {
  key: string;
  name: string;
  value: number;
  unit: string | null;
}

export interface FitCandidate {
  /** The model's family name ("gamma", "erlang", "poisson", …). */
  family: string;
  name: string;
  applicable: boolean;
  note: string | null;
  params: FittedParam[];
  /** The model's parameter text, "key=value,key=value". */
  parameters: string;
  mean: number | null;
  scv: number | null;
  matchesScv: boolean;
  freeParameters: number;
  logLikelihood: number | null;
  aic: number | null;
  ks: number | null;
  ksP: number | null;
  pdf: (number | null)[];
  cdf: number[];
}

export interface FitReport {
  summary: FitSummary;
  /** Maximum-likelihood fits, best first. */
  mle: FitCandidate[];
  /** The same families matched to the sample's mean and SCV. */
  moments: FitCandidate[];
  recommended: string | null;
  reason: string;
  warnings: string[];
  histogram: { edges: number[]; counts: number[]; density: number[] };
  ecdf: [number, number][];
  grid: number[];
}

export interface FitRequest {
  data: number[];
  kind: "station" | "source";
}

export interface DataFile {
  name: string;
  text: string;
}

export type FitMethod = "mle" | "moments";

export const MIN_POINTS = 10;
export const WARN_POINTS = 30;

/** The candidates a method ranks. */
export const candidatesOf = (report: FitReport, method: FitMethod): FitCandidate[] => (method === "mle" ? report.mle : report.moments);

/** The row the table opens on: the recommended family by maximum likelihood, else the best that applies. */
export function defaultChoice(report: FitReport, method: FitMethod): string | null {
  const list = candidatesOf(report, method);
  if (method === "mle" && report.recommended && list.some((c) => c.family === report.recommended && c.applicable)) return report.recommended;
  // By moments: the first family that takes both the mean and the SCV, else the first that applies.
  return (list.find((c) => c.applicable && c.matchesScv) ?? list.find((c) => c.applicable))?.family ?? null;
}
