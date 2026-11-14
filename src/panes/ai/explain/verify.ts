// Checking an answer against what the assistant was told (new in 2.1, ROADMAP E4). The model is
// asked to put a handle after every number; this is the part that does not take its word for it.
//
// THE RULE, in full:
//
// 1. A *number* is a run of digits written in the answer (with decimals, thousands commas or an
//    exponent). Numbers written as words ("two") are not numbers here.
// 2. The answer is read clause by clause: a clause ends at a line break, a semicolon, a table bar
//    or the end of a sentence. Inside a clause, a handle `[kind:…]` (or several in a row) vouches
//    for the numbers written BEFORE it, back to the previous handle or the start of the clause.
//    A number with no handle after it in its clause is UNVERIFIED.
// 3. A number matches a cited fact when it equals the fact's value — or an end of its interval —
//    rounded to the decimals the number was written with, and is within 10 % of it (so "1" does
//    not pass for 1.4). Written with "%", it is compared with a ratio times one hundred, and only
//    a ratio may be written that way (an elasticity, which has no unit, may carry "%" unscaled).
//    Written without a sign it may match a negative fact's size ("3 % below"). Followed by a unit
//    word that is not the fact's unit ("customers" after a utilisation) it is a WRONG UNIT.
//    Cited to a Help article or the version, it must occur in that text — the passage the
//    assistant was actually handed, not the rest of the article — and a number found in Help is
//    FROM HELP, never "verified": Help describes methods, it does not vouch for a result of this
//    network. A number that a result handle and a Help handle are both cited for is verified
//    only if the result has it.
// 4. A fact read from a network that has since changed is STALE; a handle the assistant was never
//    given is UNKNOWN. Both are flagged, like a number that does not match (MISMATCH).
// 5. Not results, and never flagged:
//    a. digits inside a name — S2, Src1, M/M/1 (a letter directly before them, or "/" after one);
//    b. a whole number counting parts of the model or of the text ("2 stations", "3 methods",
//       "step 2", "Class 1", a list's "1."), and ordinals ("2nd"). Servers, customers, runs and
//       samples are results or parameters and are NOT in this list;
//    c. a confidence level ("95 % interval");
//    d. a year after a name ("Whitt 1983");
//    e. the bounds 0, 1 and 100 % in a comparison or a formula ("ρ < 1", "1 − ρ", "1/μ");
//    f. a number the assistant itself passed to a tool since the last question, as a number
//       (or in a parameter text, "rate=1.5"), or a parameter of the network as get_parameters
//       gave it: an input, shown plain — neither flagged nor called verified. Digits in a name
//       the assistant passed ("S2", "Server 12") are not inputs.
//    Everything else needs a handle, a number in a code block included.
import { HANDLE, isRatio, num, type Fact } from "./facts";

export type NumberStatus = "verified" | "help" | "input" | "unverified" | "mismatch" | "unit" | "stale" | "unknown";

export interface Finding {
  /** Where the number is in the answer's text. */
  start: number;
  end: number;
  text: string;
  status: NumberStatus;
  /** The handle that vouched for it, or was meant to. */
  handle: string | null;
  /** For a mismatch or a wrong unit: what the cited fact says. */
  cited: string | null;
}

export interface HandleUse {
  start: number;
  end: number;
  handle: string;
  status: "known" | "stale" | "unknown";
}

export interface AnswerCheck {
  /** Every number that is a claim (rule 5's are left out), in order. */
  numbers: Finding[];
  /** Those that are not verified, not from Help and not inputs. */
  flagged: Finding[];
  handles: HandleUse[];
}

export interface VerifyContext {
  facts: ReadonlyMap<string, Fact>;
  /** The network's structure now. */
  networkKey: string | null;
  /** Numbers the assistant gave to tools since the last question (rule 5f). */
  inputs: readonly number[];
}

const NUMBER = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)*(?:[eE][-+−]?\d+)?/g;
const COUNT_AFTER = /^[\s -]*(?:(?:more|extra|additional|other|further|new|separate|different|open|closed|parallel|identical|main|simple|customer|applicable|exact|approximate)\s+)?(?:stations?|nodes?|sources?|sinks?|buffers?|links?|class(?:es)?|methods?|steps?|options?|parameters?|reasons?|ways?|tiers?|questions?|experiments?|things?|kinds?|parts?|cases?|sentences?|paragraphs?|tools?)\b/i;
const NOUN_BEFORE = /(?:\b(?:step|option|class|phase|part|figure|table|section|item|equation|chapter|appendix|tier|case|question|experiment|number)|\bfig\.|\beq\.|\bno\.|#)\s*\(?$/i;
const COMPARE_BEFORE = /(?:[<>≤≥]|\b(?:below|above|under|over|exceeds?|reach(?:es)?|approach(?:es)?|than|to|near|towards?))\s*$/i;
const LEVEL_AFTER = /^[\s ]*(?:%|percent)[\s-]*(?:confidence|credible|interval|ci\b|level)/i;
const YEAR_BEFORE = /(?:[A-Z][\w.'’-]*,?\s+(?:et al\.?,?\s+)?\(?|\()$/;

type WrittenUnit = "pct" | "customers" | "time" | "rate" | "servers" | null;

function unitAfter(after: string): { pct: boolean; unit: WrittenUnit } {
  const p = /^[\s ]*(%|percent\b|per cent\b)/i.exec(after);
  if (p) return { pct: true, unit: "pct" };
  if (/^[\s ]*(?:customers?|jobs?)\s+per\s+(?:unit\s+(?:of\s+)?time|time\s+unit)/i.test(after)) return { pct: false, unit: "rate" };
  if (/^[\s ]*(?:customers?|jobs?)\b/i.test(after)) return { pct: false, unit: "customers" };
  if (/^[\s ]*time[\s-]units?\b/i.test(after)) return { pct: false, unit: "time" };
  if (/^[\s ]*servers?\b/i.test(after)) return { pct: false, unit: "servers" };
  return { pct: false, unit: null };
}

/** Whether a written unit can be the unit of a fact. */
function unitFits(written: WrittenUnit, factUnit: string): boolean {
  if (written === null) return true;
  if (isRatio(factUnit)) return written === "pct";
  if (written === "pct") return factUnit === "";
  if (factUnit === "customers") return written === "customers";
  if (factUnit === "time") return written === "time";
  if (factUnit === "customers / time" || factUnit === "per time unit") return written === "rate";
  if (factUnit === "servers") return written === "servers";
  return true;
}

interface Token {
  start: number;
  end: number;
  text: string;
  value: number;
  /** Decimals as written; null for an exponent form (judged relatively). */
  decimals: number | null;
  signed: boolean;
  dotted: boolean;
  pct: boolean;
  unit: WrittenUnit;
}

/** Rule 3 for one candidate value. */
function near(t: Token, written: number, v: number): boolean {
  if (!Number.isFinite(v)) return false;
  const tolerance = t.decimals === null ? Math.abs(v) * 5e-3 : 0.5 * Math.pow(10, -t.decimals) * (1 + 1e-9) + 1e-12;
  const close = (a: number, b: number) => Math.abs(a - b) <= tolerance && (b === 0 || Math.abs(a - b) <= 0.1 * Math.abs(b) + 1e-12);
  return close(written, v) || (!t.signed && close(written, Math.abs(v)));
}

function matches(t: Token, f: Fact): "yes" | "unit" | "no" {
  if (f.kind === "text") {
    // The number as written must stand in the passage, not inside a longer number.
    const at = new RegExp(`(?<![\\d.,])${t.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d])`);
    return at.test(f.text) ? "yes" : "no";
  }
  if (t.dotted) return "no";
  const scale = t.pct && isRatio(f.unit) ? 100 : 1;
  const hit = [f.value, f.low, f.high].some((v) => typeof v === "number" && near(t, t.value, v * scale));
  if (!unitFits(t.unit, f.unit)) return hit || [f.value, f.low, f.high].some((v) => typeof v === "number" && near(t, t.value, v)) ? "unit" : "no";
  return hit ? "yes" : "no";
}

/** Rule 5a–5e: a number that is not a result. */
function exempt(text: string, t: Token): boolean {
  const before = text.slice(Math.max(0, t.start - 40), t.start);
  const after = text.slice(t.end, t.end + 60);
  const prev = before.slice(-1);
  // a. Inside a name.
  if (/[\p{L}_]/u.test(prev)) return true;
  if (prev === "/" && /[\p{L}]\/$/u.test(before)) return true;
  const whole = /^\d+$/.test(t.text);
  if (whole) {
    // b. Counting, numbering, list markers, ordinals.
    if (COUNT_AFTER.test(after) || NOUN_BEFORE.test(before)) return true;
    const line = text.slice(text.lastIndexOf("\n", t.start - 1) + 1, t.start);
    if (/^[\s>#*]*$/.test(line) && /^[.)]\s/.test(after)) return true;
    if (/^(?:st|nd|rd|th)\b/i.test(after)) return true;
    // c. A confidence level.
    if (LEVEL_AFTER.test(after)) return true;
    // d. A year after a name.
    if (t.text.length === 4 && t.value >= 1800 && t.value <= 2099 && YEAR_BEFORE.test(before)) return true;
    // e. The bounds 0, 1 and 100 %.
    const bound = t.value === 0 || t.value === 1 ? !t.pct : t.value === 100 && t.pct;
    if (bound && !t.signed) {
      if (COMPARE_BEFORE.test(before)) return true;
      if (/^\s*\/\s*[\p{L}(]/u.test(after) || /^\s*[−-]\s*[\p{L}(]/u.test(after)) return true;
      if (/[\p{L})]\s*\/\s*\(?$/u.test(before) && /^\s*[−-]/.test(after)) return true;
    }
  }
  return false;
}

/** The numbers in `text` outside the handle spans, with what is written around them. */
function tokens(text: string, masked: string): Token[] {
  const out: Token[] = [];
  NUMBER.lastIndex = 0;
  for (let m = NUMBER.exec(masked); m; m = NUMBER.exec(masked)) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    const dotted = (raw.match(/\./g) ?? []).length > 1;
    const plain = raw.replace(/,/g, "").replace("−", "-");
    const value = dotted ? NaN : Number(plain);
    const exp = /[eE]/.test(plain);
    const decimals = exp ? null : (plain.split(".")[1]?.length ?? 0);
    // A minus sign: directly before the digits, and not the dash of a range or a name.
    const sign = text[start - 1];
    const beforeSign = text[start - 2] ?? " ";
    const signed = (sign === "-" || sign === "−") && !/[\p{L}\d)\]%]/u.test(beforeSign);
    const { pct, unit } = unitAfter(text.slice(end, end + 40));
    out.push({ start: signed ? start - 1 : start, end, text: raw, value: signed ? -value : value, decimals, signed, dotted, pct, unit });
  }
  return out;
}

/** Where clauses end (rule 2): offsets just past each boundary. */
function clauseEnds(masked: string): number[] {
  const ends: number[] = [];
  const re = /\n|;|\||[.!?](?=\s|$)|[.!?](?=["'”’)*_]+(?:\s|$))/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) ends.push(m.index + 1);
  ends.push(masked.length + 1);
  return ends;
}

const isInput = (t: Token, inputs: readonly number[]) =>
  !t.dotted &&
  inputs.some((x) => {
    const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
    return same(t.value, x) || same(Math.abs(t.value), Math.abs(x)) || (t.pct && same(Math.abs(t.value) / 100, Math.abs(x)));
  });

/** Checks every number of an answer against the facts it cites. */
export function verifyAnswer(text: string, ctx: VerifyContext): AnswerCheck {
  const handles: HandleUse[] = [];
  let masked = text;
  HANDLE.lastIndex = 0;
  for (let m = HANDLE.exec(text); m; m = HANDLE.exec(text)) {
    const f = ctx.facts.get(m[1]);
    const stale = !!f && f.networkKey !== null && ctx.networkKey !== null && f.networkKey !== ctx.networkKey;
    handles.push({ start: m.index, end: m.index + m[0].length, handle: m[1], status: !f ? "unknown" : stale ? "stale" : "known" });
    // Same length, no digits and no clause ends: the handle's own text is never read as an answer.
    masked = masked.slice(0, m.index) + "[" + "~".repeat(m[0].length - 2) + "]" + masked.slice(m.index + m[0].length);
  }
  const ends = clauseEnds(masked);
  const numbers: Finding[] = [];
  let pending: Token[] = [];
  let clause = 0;
  const all = tokens(text, masked);
  let ti = 0;
  let hi = 0;
  const flush = () => {
    for (const t of pending) numbers.push({ start: t.start, end: t.end, text: text.slice(t.start, t.end), status: isInput(t, ctx.inputs) ? "input" : "unverified", handle: null, cited: null });
    pending = [];
  };
  while (ti < all.length || hi < handles.length) {
    const nextNumber = ti < all.length ? all[ti].start : Infinity;
    const nextHandle = hi < handles.length ? handles[hi].start : Infinity;
    const at = Math.min(nextNumber, nextHandle);
    while (ends[clause] <= at) {
      flush();
      clause++;
    }
    if (nextNumber < nextHandle) {
      const t = all[ti++];
      if (!exempt(text, t)) pending.push(t);
      continue;
    }
    // A group: handles in a row with only spaces, commas or "and" between them.
    const group: HandleUse[] = [handles[hi++]];
    while (hi < handles.length && /^[\s,]*(?:and\s+)?$/.test(masked.slice(group[group.length - 1].end, handles[hi].start)) && (ti >= all.length || all[ti].start > handles[hi].start)) group.push(handles[hi++]);
    for (const t of pending) {
      let status: NumberStatus = group.every((h) => h.status === "unknown") ? "unknown" : "mismatch";
      let handle = group[0].handle;
      let cited: string | null = null;
      for (const h of group) {
        const f = ctx.facts.get(h.handle);
        if (!f) continue;
        const how = matches(t, f);
        if (how === "yes") {
          // A Help passage that has the number says where it was read, not that a result has it.
          const found: NumberStatus = h.status === "stale" ? "stale" : f.kind === "text" && h.handle.startsWith("help:") ? "help" : "verified";
          if (found === "help" && status === "stale") continue;
          status = found;
          handle = h.handle;
          cited = null;
          if (status === "verified") break;
        } else if (status !== "stale" && status !== "help" && (how === "unit" || status !== "unit")) {
          status = how === "unit" ? "unit" : "mismatch";
          handle = h.handle;
          cited = f.kind === "number" ? `${num(f.value)}${f.unit ? ` (${f.unit})` : ""}` : null;
        }
      }
      if (status !== "verified" && status !== "help" && status !== "stale" && isInput(t, ctx.inputs)) status = "input";
      numbers.push({ start: t.start, end: t.end, text: text.slice(t.start, t.end), status, handle, cited });
    }
    pending = [];
  }
  flush();
  numbers.sort((a, b) => a.start - b.start);
  return { numbers, flagged: numbers.filter((n) => n.status !== "verified" && n.status !== "help" && n.status !== "input"), handles };
}

/**
 * The numbers the assistant chose in a tool call's arguments (rule 5f): every argument that IS a
 * number, and the values of a parameter text ("rate=1.5,k=2" under a key named …parameters).
 * No other string is read: a station called "S2" or "Server 12" is a name, and its digits are
 * not numbers the assistant chose — read as inputs they let a made-up 2 or 12 pass unmarked.
 */
export function numbersIn(input: unknown, out: number[] = [], key = ""): number[] {
  if (typeof input === "number" && Number.isFinite(input)) out.push(input);
  else if (typeof input === "string") {
    if (/parameters?$/i.test(key)) for (const m of input.matchAll(/=\s*([-+−]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)(?![\w.])/g)) out.push(Number(m[1].replace("−", "-")));
  } else if (Array.isArray(input)) for (const x of input) numbersIn(x, out, key);
  else if (input && typeof input === "object") for (const [k, x] of Object.entries(input)) numbersIn(x, out, k);
  return out;
}

/** The network's parameters as get_parameters gave them and as they still are (rule 5f). */
export function parameterInputs(facts: ReadonlyMap<string, Fact>, networkKey: string | null): number[] {
  const out: number[] = [];
  for (const f of facts.values()) if (f.kind === "number" && f.tier === "input" && f.handle.startsWith("net:") && (f.networkKey === null || networkKey === null || f.networkKey === networkKey)) out.push(f.value);
  return out;
}

// ── Marking the flagged numbers for the renderer ────────────────────────────────────────────────

/** Private-use marks around a flagged number: OPEN index MID number CLOSE. Markdown passes them through as text. */
export const FLAG_OPEN = "";
export const FLAG_MID = "";
export const FLAG_CLOSE = "";
export const FLAGGED = /(\d+)([^]*)/g;

/** The answer with each flagged number wrapped in marks carrying its index in `check.flagged`. */
export function withFlags(text: string, check: AnswerCheck | null | undefined): string {
  if (!check?.flagged.length) return text;
  let out = "";
  let at = 0;
  check.flagged.forEach((f, i) => {
    if (f.start < at || text.slice(f.start, f.end) !== f.text) return;
    out += text.slice(at, f.start) + FLAG_OPEN + i + FLAG_MID + f.text + FLAG_CLOSE;
    at = f.end;
  });
  return out + text.slice(at);
}

/** Text without the marks. */
export const withoutFlags = (s: string) => s.replace(FLAGGED, "$2");
