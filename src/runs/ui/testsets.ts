// Test ▸ Run Infinite / Finite Test Set… and Run Infinite Spectral Convergence… as data (0.90.34
// TestSetRunner.swift `TestSetParameterSheet`, `SpectralConvergenceParameterSheet`,
// `SpectralConvergenceParameters.rhoValues`; QnetGUIApp.swift `loadTestSetDefaults`,
// `loadSpectralConvergenceDefaults`; ledger METH-132…137, METH-146, METH-147, TEST-002…006,
// TEST-021…023): the forms' starting values from Settings ▸ Test Sets (never written back; the
// seed always opens off at 12345), their first blocking problem in row order, the footers, and
// the parameters a sweep is started with.
import { getSetting } from "../../lib/kv";
import { parseCount } from "../../components/CountField";
import { parseNumber } from "../../workspace/files/generate";
import type { SweepParams } from "../../lib/types";
import { runWords as w } from "./words";

export interface TestSetForm {
  stationsLower: string;
  stationsUpper: string;
  classesLower: string;
  classesUpper: string;
  rhoLower: string;
  rhoUpper: string;
  numCases: string;
  /** 0 feed-forward, 1 Jackson feedback, 2 general P-matrix, 3 re-entrant. */
  topology: number;
  fixedSeed: boolean;
  seed: string;
}

export interface SpectralConvergenceForm {
  stationsLower: string;
  stationsUpper: string;
  classesLower: string;
  classesUpper: string;
  rhoStart: string;
  rhoEnd: string;
  rhoStep: string;
  numCases: string;
  topology: number;
  fixedSeed: boolean;
  seed: string;
}

export const STATION_RANGE: [number, number] = [1, 32];
export const CLASS_RANGE: [number, number] = [1, 16];
export const RHO_RANGE: [number, number] = [0.01, 0.99];
export const TEST_CASES: [number, number] = [1, 1000];
export const SPC_CASES: [number, number] = [1, 200];
export const SEED_RANGE: [number, number] = [0, 2_147_483_647];
const DEFAULT_SEED = 12_345;

/** ρ as the sheet's fields show it: two decimals. */
export const rhoText = (v: number) => v.toFixed(2);

/** `Topology(rawValue:) ?? .feedForward`. */
const topology = (raw: unknown) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0;
};

const n = (key: string, fallback: number) => Number(getSetting<unknown>(key, fallback));

/** `loadTestSetDefaults(infinite:)`: Settings ▸ Test Sets, with 0.90.34's defaults. */
export function testSetDefaults(infinite: boolean): TestSetForm {
  const p = infinite ? "testset.inf" : "testset.fin";
  const d = infinite ? { s: [3, 6], c: [1, 3], cases: 20 } : { s: [2, 4], c: [1, 2], cases: 10 };
  return {
    stationsLower: String(n(`${p}.stationsLo`, d.s[0])),
    stationsUpper: String(n(`${p}.stationsHi`, d.s[1])),
    classesLower: String(n(`${p}.classesLo`, d.c[0])),
    classesUpper: String(n(`${p}.classesHi`, d.c[1])),
    rhoLower: rhoText(n(`${p}.rhoLo`, 0.5)),
    rhoUpper: rhoText(n(`${p}.rhoHi`, 0.85)),
    numCases: String(n(`${p}.numCases`, d.cases)),
    topology: topology(getSetting<unknown>(`${p}.topology`, 0)),
    fixedSeed: false,
    seed: String(DEFAULT_SEED),
  };
}

/** `loadSpectralConvergenceDefaults()`. */
export function spectralConvergenceDefaults(): SpectralConvergenceForm {
  return {
    stationsLower: String(n("testset.spc.stationsLo", 3)),
    stationsUpper: String(n("testset.spc.stationsHi", 6)),
    classesLower: String(n("testset.spc.classesLo", 1)),
    classesUpper: String(n("testset.spc.classesHi", 3)),
    rhoStart: rhoText(n("testset.spc.rhoStart", 0.5)),
    rhoEnd: rhoText(n("testset.spc.rhoEnd", 0.95)),
    rhoStep: rhoText(n("testset.spc.rhoStep", 0.05)),
    numCases: String(n("testset.spc.numCases", 10)),
    topology: topology(getSetting<unknown>("testset.spc.topology", 0)),
    fixedSeed: false,
    seed: String(DEFAULT_SEED),
  };
}

const int = (t: string) => parseCount(t) ?? NaN;
const dbl = (t: string) => parseNumber(t) ?? NaN;
const within = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi;

/** The station and class checks both sheets make first, in row order. */
function rangeProblem(f: { stationsLower: string; stationsUpper: string; classesLower: string; classesUpper: string }): string | null {
  const [sl, su, cl, cu] = [int(f.stationsLower), int(f.stationsUpper), int(f.classesLower), int(f.classesUpper)];
  if (!within(sl, STATION_RANGE) || !within(su, STATION_RANGE)) return w.stationsRange;
  if (sl > su) return w.stationsOrder;
  if (!within(cl, CLASS_RANGE) || !within(cu, CLASS_RANGE)) return w.classesRange;
  if (cl > cu) return w.classesOrder;
  return null;
}

/** `TestSetParameterSheet.problem`. */
export function testSetProblem(f: TestSetForm): string | null {
  const r = rangeProblem(f);
  if (r) return r;
  const [lo, hi] = [dbl(f.rhoLower), dbl(f.rhoUpper)];
  if (!(lo > 0 && hi < 1)) return w.rhoRange;
  if (lo > hi) return w.rhoOrder;
  if (!within(int(f.numCases), TEST_CASES)) return w.casesRange;
  return null;
}

/** `sweepValid`: 0 < start < end < 1 and 0 < step ≤ end − start (+1e-9). */
export function sweepValid(f: SpectralConvergenceForm): boolean {
  const [s, e, st] = [dbl(f.rhoStart), dbl(f.rhoEnd), dbl(f.rhoStep)];
  return s > 0 && e > s && e < 1 && st > 0 && st <= e - s + 1e-9;
}

/** `SpectralConvergenceParameterSheet.problem`. */
export function spectralConvergenceProblem(f: SpectralConvergenceForm): string | null {
  const r = rangeProblem(f);
  if (r) return r;
  if (!sweepValid(f)) return w.spcSweepInvalid;
  if (!within(int(f.numCases), SPC_CASES)) return w.spcCasesRange;
  return null;
}

/** `SpectralConvergenceParameters.rhoValues`: start, start + step, … ≤ end + 1e-9, end appended when missed. */
export function rhoValues(start: number, end: number, step: number): number[] {
  if (!(step > 1e-9)) return [start];
  const out: number[] = [];
  for (let v = start; v <= end + 1e-9; v += step) out.push(end < v ? end : v);
  const last = out[out.length - 1];
  if (last !== undefined && Math.abs(last - end) > 1e-9 && last < end) out.push(end);
  return out;
}

/** The test-set sheet's Sweep footer (`sweepSummary`). */
export function testSetSummary(f: TestSetForm, infinite: boolean): string {
  return w.sweepSummary(int(f.numCases), infinite ? "infinite" : "finite");
}

/** The convergence sheet's Sweep footer (`solveSummary`). */
export function spectralConvergenceSummary(f: SpectralConvergenceForm): string {
  if (!sweepValid(f)) return w.solveSummaryInvalid;
  return w.solveSummary(int(f.numCases), rhoValues(dbl(f.rhoStart), dbl(f.rhoEnd), dbl(f.rhoStep)).length);
}

const seedOf = (f: { fixedSeed: boolean; seed: string }) => (f.fixedSeed ? int(f.seed) : null);

/** `runTapped`: the parameters a test set runs with; call only when there is no problem. */
export function testSetParams(f: TestSetForm): SweepParams {
  return {
    stationsLower: int(f.stationsLower),
    stationsUpper: int(f.stationsUpper),
    classesLower: int(f.classesLower),
    classesUpper: int(f.classesUpper),
    rhoLower: dbl(f.rhoLower),
    rhoUpper: dbl(f.rhoUpper),
    numTestCases: int(f.numCases),
    topology: f.topology,
    seed: seedOf(f),
  };
}

export function spectralConvergenceParams(f: SpectralConvergenceForm): SweepParams {
  return {
    stationsLower: int(f.stationsLower),
    stationsUpper: int(f.stationsUpper),
    classesLower: int(f.classesLower),
    classesUpper: int(f.classesUpper),
    rhoStart: dbl(f.rhoStart),
    rhoEnd: dbl(f.rhoEnd),
    rhoStep: dbl(f.rhoStep),
    numTestCases: int(f.numCases),
    topology: f.topology,
    seed: seedOf(f),
  };
}
