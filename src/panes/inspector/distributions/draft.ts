// One distribution being edited (0.90.34 DistributionDraft.swift, ledger DIST-033…043): a source's
// arrival law, a station's fallback service law, or one class's service law. It keeps the raw text
// the user typed, so validation runs on every keystroke, and converts between the native parameters
// and (mean, SCV) without losing input. Swift's draft is a value type; this one is immutable: every
// edit returns a new draft, so a snapshot compares by `draftsEqual`.
import {
  card,
  computeMean,
  computeSCV,
  DEFAULT_PARAMETERS,
  fixedSCV,
  hasDiscreteSCV,
  hasFixedSCV,
  parameterDefs,
  parametersFromMoments,
  parseParameterStrings,
  validateParameters,
  type Distribution,
  type Params,
} from "./families";
import { cG, fieldText, formatSig, isPartialNumber, parseNumber, READOUT_DIGITS } from "./numbers";

export type EntryMode = "native" | "moments";

/** `ParameterEntryMode` raw values, the segmented picker's labels. */
export const ENTRY_MODE_NAMES: Record<EntryMode, string> = { native: "Native", moments: "Mean & SCV" };

export const MEAN_KEY = "mean";
export const SCV_KEY = "scv";

export interface DistributionDraft {
  readonly distribution: Distribution;
  /** Native parameter text keyed by the parameter's key. */
  readonly params: Readonly<Record<string, string>>;
  readonly meanText: string;
  readonly scvText: string;
  /** Keys (params, "mean", "scv") the user typed this session: shown verbatim, never shortened. */
  readonly userEditedKeys: ReadonlySet<string>;
}

/** `init(distribution:parameterString:)`: each defined key's value when it parses (as `%.10g`), else the default. */
export function makeDraft(distribution: Distribution, parameterString: string): DistributionDraft {
  const stored = parseParameterStrings(parameterString);
  const params: Record<string, string> = {};
  for (const d of parameterDefs(distribution)) {
    const raw = stored[d.key];
    const v = raw !== undefined ? parseNumber(raw) : null;
    params[d.key] = fieldText(v !== null ? v : d.defaultValue);
  }
  return seedMomentsFromNative({ distribution, params, meanText: "", scvText: "", userEditedKeys: new Set() });
}

export const defaultDraft = (d: Distribution) => makeDraft(d, DEFAULT_PARAMETERS[d]);

/** The values of `params` that parse. */
export function parsedParams(d: DistributionDraft): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(d.params)) {
    const x = parseNumber(v);
    if (x !== null) out[k] = x;
  }
  return out;
}

export const nativeMean = (d: DistributionDraft) => computeMean(d.distribution, parsedParams(d));
export const nativeSCV = (d: DistributionDraft) => computeSCV(d.distribution, parsedParams(d));

/** `seedMomentsFromNative`: mean and SCV text from the native values; both shown as generated. */
export function seedMomentsFromNative(d: DistributionDraft): DistributionDraft {
  const m = nativeMean(d);
  const s = nativeSCV(d);
  const edited = new Set(d.userEditedKeys);
  edited.delete(MEAN_KEY);
  edited.delete(SCV_KEY);
  return {
    ...d,
    meanText: m !== null && m > 0 ? fieldText(m) : d.meanText,
    scvText: s !== null && Number.isFinite(s) ? fieldText(s) : d.scvText,
    userEditedKeys: edited,
  };
}

/** `derivedFromMoments`: native parameters solved from the mean and SCV, with the realised moments. */
export function derivedFromMoments(d: DistributionDraft): { params: Params; mean: number; scv: number } | null {
  const mean = parseNumber(d.meanText);
  if (mean === null || !(mean > 0)) return null;
  const scv = fixedSCV(d.distribution) ?? parseNumber(d.scvText) ?? -1;
  if (!(scv >= 0)) return null;
  const params = parametersFromMoments(d.distribution, mean, scv);
  if (!params) return null;
  return { params, mean: computeMean(d.distribution, params) ?? mean, scv: computeSCV(d.distribution, params) ?? scv };
}

/** The (mean, SCV) the readouts show in `mode`: realised values, or the raw typed ones without a solution. */
export function moments(d: DistributionDraft, mode: EntryMode): { mean: number | null; scv: number | null } {
  if (mode === "native") return { mean: nativeMean(d), scv: nativeSCV(d) };
  const r = derivedFromMoments(d);
  if (r) return { mean: r.mean, scv: r.scv };
  return { mean: parseNumber(d.meanText), scv: fixedSCV(d.distribution) ?? parseNumber(d.scvText) };
}

/** The native parameters Save writes in `mode`, or null when they are not all there. */
export function effectiveParams(d: DistributionDraft, mode: EntryMode): Params | null {
  if (mode === "native") {
    const parsed = parsedParams(d);
    return parameterDefs(d.distribution).every((p) => parsed[p.key] !== undefined) ? parsed : null;
  }
  return derivedFromMoments(d)?.params ?? null;
}

function withSolved(d: DistributionDraft, solved: Params): DistributionDraft {
  const params: Record<string, string> = {};
  for (const p of parameterDefs(d.distribution)) params[p.key] = fieldText(solved[p.key] ?? p.defaultValue);
  const edited = new Set(d.userEditedKeys);
  for (const p of parameterDefs(d.distribution)) edited.delete(p.key);
  return { ...d, params, userEditedKeys: edited };
}

/**
 * `changeDistribution(to:mode:)`: keep the current mean (when > 0); the SCV is the new family's
 * fixed one, else max(current SCV ?? 1, 1e-9); fall back to the new family's defaults if that fails.
 */
export function changeDistribution(d: DistributionDraft, to: Distribution, mode: EntryMode): DistributionDraft {
  if (to === d.distribution) return d;
  const { mean, scv } = moments(d, mode);
  let next = defaultDraft(to);
  if (mean !== null && mean > 0) {
    const target = fixedSCV(to) ?? Math.max(scv ?? 1, 1e-9);
    const solved = parametersFromMoments(to, mean, target);
    if (solved) {
      const params: Record<string, string> = {};
      for (const p of parameterDefs(to)) params[p.key] = fieldText(solved[p.key] ?? p.defaultValue);
      next = seedMomentsFromNative({ ...next, params });
    }
  }
  return next;
}

// ── Typing ───────────────────────────────────────────────────────────────────────────────────

/** `setParam`: the user's text for a native parameter, shown verbatim from now on. */
export function setParam(d: DistributionDraft, key: string, text: string): DistributionDraft {
  const edited = new Set(d.userEditedKeys);
  edited.add(key);
  return { ...d, params: { ...d.params, [key]: text }, userEditedKeys: edited };
}

export function setMeanText(d: DistributionDraft, text: string): DistributionDraft {
  const edited = new Set(d.userEditedKeys);
  edited.add(MEAN_KEY);
  return { ...d, meanText: text, userEditedKeys: edited };
}

export function setScvText(d: DistributionDraft, text: string): DistributionDraft {
  const edited = new Set(d.userEditedKeys);
  edited.add(SCV_KEY);
  return { ...d, scvText: text, userEditedKeys: edited };
}

/** `displayText`: a generated value longer than 8 characters is shown at `%.6g`; anything else verbatim. */
export function displayText(raw: string): string {
  if ([...raw].length <= 8) return raw;
  const v = parseNumber(raw);
  if (v === null) return raw;
  const short = cG(v, 6);
  return parseNumber(short) === null ? raw : short;
}

export const displayParam = (d: DistributionDraft, key: string) => (d.userEditedKeys.has(key) ? (d.params[key] ?? "") : displayText(d.params[key] ?? ""));
export const displayMeanText = (d: DistributionDraft) => (d.userEditedKeys.has(MEAN_KEY) ? d.meanText : displayText(d.meanText));
export const displayScvText = (d: DistributionDraft) => (d.userEditedKeys.has(SCV_KEY) ? d.scvText : displayText(d.scvText));

// ── Validation ───────────────────────────────────────────────────────────────────────────────

/** Native mode: the family validation plus "Enter a number for <label>." for text that doesn't parse. */
export function nativeErrors(d: DistributionDraft): Record<string, string> {
  const parsed = parsedParams(d);
  const errors = validateParameters(d.distribution, parsed);
  for (const p of parameterDefs(d.distribution)) if (parsed[p.key] === undefined) errors[p.key] = `Enter a number for ${p.displayName}.`;
  return errors;
}

export function meanError(d: DistributionDraft): string | null {
  const m = parseNumber(d.meanText);
  if (m === null) return "Enter a positive mean.";
  return m > 0 ? null : "Mean must be > 0.";
}

export function scvError(d: DistributionDraft): string | null {
  if (hasFixedSCV(d.distribution)) return null;
  const s = parseNumber(d.scvText);
  if (s === null) return "Enter an SCV (c²) ≥ 0.";
  if (s < 0) return "SCV must be ≥ 0.";
  if (s === 0) return "SCV 0 is Deterministic — pick that family.";
  const m = parseNumber(d.meanText);
  if (m !== null && m > 0 && parametersFromMoments(d.distribution, m, s) === null) return `Mean and SCV infeasible for ${card(d.distribution).displayName}.`;
  return null;
}

/** Messages for `mode`, keyed by parameter key (native) or "mean" / "scv" (moments). */
export function draftErrors(d: DistributionDraft, mode: EntryMode): Record<string, string> {
  if (mode === "native") return nativeErrors(d);
  const e: Record<string, string> = {};
  const m = meanError(d);
  if (m) e[MEAN_KEY] = m;
  const s = scvError(d);
  if (s) e[SCV_KEY] = s;
  return e;
}

export const draftIsValid = (d: DistributionDraft, mode: EntryMode) => Object.keys(draftErrors(d, mode)).length === 0;

const textPending = (t: string) => parseNumber(t) === null && isPartialNumber(t);

/** Keys whose text is a legal prefix of a number: still being typed, reported calmly. */
export function pendingKeys(d: DistributionDraft, mode: EntryMode): string[] {
  if (mode === "native") return parameterDefs(d.distribution).map((p) => p.key).filter((k) => textPending(d.params[k] ?? ""));
  const keys: string[] = [];
  if (textPending(d.meanText)) keys.push(MEAN_KEY);
  if (!hasFixedSCV(d.distribution) && textPending(d.scvText)) keys.push(SCV_KEY);
  return keys;
}

/** The field's name for the "Still typing" note. */
export function fieldName(d: DistributionDraft, key: string): string {
  if (key === MEAN_KEY) return "Mean";
  if (key === SCV_KEY) return "SCV (c²)";
  return parameterDefs(d.distribution).find((p) => p.key === key)?.displayName ?? key;
}

export const pendingFieldNames = (d: DistributionDraft, mode: EntryMode) => pendingKeys(d, mode).map((k) => fieldName(d, k));

/** The draft's messages without the fields still being typed, sorted (Swift's `.values.sorted()`). */
export function settledErrors(d: DistributionDraft, mode: EntryMode): string[] {
  const pending = new Set(pendingKeys(d, mode));
  return Object.entries(draftErrors(d, mode))
    .filter(([k]) => !pending.has(k))
    .map(([, v]) => v)
    .sort(swiftLess);
}

// ── Mode switching and commit ────────────────────────────────────────────────────────────────

/** `syncMode(to:)`: Native → Mean & SCV seeds the moments; back writes the solved parameters when there are some. */
export function syncMode(d: DistributionDraft, to: EntryMode): DistributionDraft {
  if (to === "moments") return seedMomentsFromNative(d);
  const r = derivedFromMoments(d);
  return r ? withSolved(d, r.params) : d;
}

/**
 * `commitMomentsToNative(label:)`: the solved parameters replace the native text; a note when the
 * realised SCV differs from the typed one by more than max(1e-6, 0.1 %) (Erlang's snap).
 */
export function commitMomentsToNative(d: DistributionDraft, label: string): { draft: DistributionDraft; note: string | null } {
  const r = derivedFromMoments(d);
  if (!r) return { draft: d, note: null };
  const next = withSolved(d, r.params);
  const requested = parseNumber(d.scvText);
  if (hasFixedSCV(d.distribution) || requested === null || !(Math.abs(r.scv - requested) > Math.max(1e-6, 0.001 * Math.abs(requested)))) return { draft: next, note: null };
  return {
    draft: next,
    note: `${label}${card(d.distribution).displayName} snapped SCV to ${formatSig(r.scv, READOUT_DIGITS)} (you entered ${formatSig(requested, READOUT_DIGITS)}).`,
  };
}

/** `parameterString()`: "key=value" in definition order, parsed values as `%.10g`, unparsed text verbatim. */
export function parameterString(d: DistributionDraft): string {
  return parameterDefs(d.distribution)
    .map((p) => {
      const text = d.params[p.key] ?? fieldText(p.defaultValue);
      const v = parseNumber(text);
      return `${p.key}=${v !== null ? fieldText(v) : text}`;
    })
    .join(",");
}

/** "k=2, θ=0.5": short labels, five significant digits, "?" for text that doesn't parse. */
export function compactSummary(d: DistributionDraft): string {
  return parameterDefs(d.distribution)
    .map((p) => {
      const v = parseNumber(d.params[p.key] ?? "");
      return `${shortLabel(p.displayName)}=${v !== null ? formatSig(v, READOUT_DIGITS) : "?"}`;
    })
    .join(", ");
}

/** "Shape (k)" → "k", "μ (log-mean)" → "μ", "Rate (λ)" → "λ". */
export function shortLabel(displayName: string): string {
  const open = displayName.indexOf("(");
  const close = displayName.indexOf(")");
  if (open >= 0 && close >= 0 && open < close) {
    const inner = displayName.slice(open + 1, close);
    if ([...inner].length <= 2) return inner;
  }
  return displayName.split(" ").filter(Boolean)[0] ?? displayName;
}

/** `parameterString(_:_:)` of NodeParameterDraft: a solved parameter set written in definition order. */
export function paramsString(dist: Distribution, params: Params): string {
  return parameterDefs(dist).map((p) => `${p.key}=${fieldText(params[p.key] ?? p.defaultValue)}`).join(",");
}

export { hasDiscreteSCV, hasFixedSCV, fixedSCV };

/** Swift's Equatable on the struct. */
export function draftsEqual(a: DistributionDraft, b: DistributionDraft): boolean {
  if (a === b) return true;
  if (a.distribution !== b.distribution || a.meanText !== b.meanText || a.scvText !== b.scvText) return false;
  const ka = Object.keys(a.params);
  if (ka.length !== Object.keys(b.params).length || ka.some((k) => a.params[k] !== b.params[k])) return false;
  if (a.userEditedKeys.size !== b.userEditedKeys.size) return false;
  for (const k of a.userEditedKeys) if (!b.userEditedKeys.has(k)) return false;
  return true;
}

/** Swift's `String <` (by Unicode scalars). */
function swiftLess(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
