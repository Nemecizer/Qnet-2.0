// What the assistant may quote (new in 2.1, ROADMAP E4): every number an analysis tool hands the
// model is a *fact* with a handle — `run:1a2b3c4d:S2:utilisation`, `live:S2:rho`,
// `sens:delay:mu_S2` — its unit, its tier and where it came from. The facts a conversation has
// been given are kept here per tab, so that an answer can be checked against them afterwards
// (./verify.ts) and a handle in the answer can be drawn as a chip that opens its source (./open.ts).
//
// Nothing here computes a result: a fact's value is the number a Qnet command or shared function
// answered with. The only arithmetic is the text form of a number (six significant digits) and a
// ratio said again as a percentage.
import { structureKey } from "../../../results/current";
import { tabById } from "../../../workspace/store";

/** What a chip opens when it is clicked. */
export type FactTarget =
  | { kind: "run"; runId: string; stationId: string | null }
  | { kind: "agreement"; stationId: string | null }
  | { kind: "station"; stationId: string }
  | { kind: "view"; view: "sensitivity" | "capacity" | "uncertainty" | "transient" | "sweep" }
  | { kind: "problem"; nodeId: string | null; linkId: string | null }
  | { kind: "help"; topic: string }
  | { kind: "none" };

export interface NumberFact {
  kind: "number";
  handle: string;
  /** "Utilization at S2". */
  what: string;
  value: number;
  /** An interval's ends, citable under the same handle. */
  low?: number;
  high?: number;
  /** As result records name it: "ratio", "customers", "time", "customers / time"; "" for a pure number. */
  unit: string;
  /** "exact", "simulation", "approximation", "diffusion", "bound", "input", … */
  tier: string;
  /** "Product form (run 1a2b3c4d)", "Live results", "Sensitivity, closed formula". */
  source: string;
  target: FactTarget;
  /** The network's structure when the fact was read; a fact of another structure is stale. */
  networkKey: string | null;
}

/** A passage the assistant may quote from: a Help article, the version string. */
export interface TextFact {
  kind: "text";
  handle: string;
  what: string;
  /** What the assistant was handed of it: every part of the article it has read, and no more. */
  text: string;
  source: string;
  target: FactTarget;
  networkKey: null;
}

export type Fact = NumberFact | TextFact;

/** The kinds a handle may start with; anything else in square brackets is not a handle. */
export const HANDLE_KINDS = ["run", "agree", "live", "problem", "sens", "cap", "unc", "trans", "sweep", "net", "method", "help", "app"] as const;
/** `[run:1a2b3c4d:S2:utilisation]` in an answer or a tool result. */
export const HANDLE = new RegExp(`\\[((?:${HANDLE_KINDS.join("|")}):[^\\]\\s\\[]{1,120})\\]`, "g");

// ── The ledger ──────────────────────────────────────────────────────────────────────────────────

const ledgers = new Map<string, Map<string, Fact>>();

/** The facts the conversation of `tabId` has been given, by handle. */
export function factsOf(tabId: string): ReadonlyMap<string, Fact> {
  return ledgers.get(tabId) ?? EMPTY;
}
const EMPTY: ReadonlyMap<string, Fact> = new Map();

export const factFor = (tabId: string, handle: string): Fact | undefined => ledgers.get(tabId)?.get(handle);

/** Forgets a tab's facts (Clear Conversation, a closed tab); with no id, everyone's (tests). */
export function forgetFacts(tabId?: string) {
  if (tabId === undefined) ledgers.clear();
  else ledgers.delete(tabId);
}

/** The structure of the tab's network as it is now (what a fact is stale against). */
export const networkKeyOf = (tabId: string): string | null => structureKey(tabById(tabId)?.document) ?? null;

// ── Text forms ──────────────────────────────────────────────────────────────────────────────────

/** A number as the model is told it: six significant digits, no locale, no exponent games for ordinary sizes. */
export function num(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "not a number" : x > 0 ? "infinite" : "minus infinite";
  if (x === 0) return "0";
  const r = Number(x.toPrecision(6));
  const abs = Math.abs(r);
  return abs >= 1e9 || abs < 1e-6 ? r.toExponential() : String(r);
}

/** A part of a handle: a name without spaces or brackets ("Station 2" → "Station_2"). */
export const slug = (s: string) => {
  // A name is the person's text (./guard.ts): no control characters, and no more of it in a
  // handle than tells one node from another. A long name is cut and told apart by a short hash.
  const whole = s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim().replace(/[\s[\]:‹›]+/g, "_").replace(/^_+|_+$/g, "") || "x";
  if (whole.length <= SLUG_MAX) return whole;
  let h = 0;
  for (let i = 0; i < whole.length; i++) h = (Math.imul(h, 31) + whole.charCodeAt(i)) >>> 0;
  return `${whole.slice(0, SLUG_MAX - 5)}~${(h % 0x10000).toString(16).padStart(4, "0")}`;
};
/** The longest part of a handle a name may give. */
export const SLUG_MAX = 32;

const UNIT_WORDS: Record<string, string> = { ratio: "", customers: " customers", time: " time units", "customers / time": " customers per time unit", servers: " servers", "per time unit": " per time unit", probability: "" };
/** The unit as the model should say it. */
export const unitWords = (unit: string) => UNIT_WORDS[unit] ?? (unit ? ` ${unit}` : "");
/** A ratio is a fraction that may also be said as a percentage. */
export const isRatio = (unit: string) => unit === "ratio" || unit === "probability";

/** One fact as a line of a tool result: `[handle] what = value unit · tier`. */
export function factLine(f: Fact): string {
  if (f.kind === "text") return `[${f.handle}] ${f.what}: ${f.text}`;
  let value = num(f.value) + unitWords(f.unit);
  if (isRatio(f.unit) && Number.isFinite(f.value)) value += ` (= ${num(f.value * 100)} %)`;
  if (f.low !== undefined && f.high !== undefined) value += `, interval ${num(f.low)} to ${num(f.high)}`;
  return `[${f.handle}] ${f.what} = ${value} · ${f.tier}`;
}

// ── A tool result being written ─────────────────────────────────────────────────────────────────

/** A tool result is cut to these: the model's context is small, and a table nobody asked for is noise. */
export const MAX_FACTS = 60;
export const MAX_RESULT_CHARS = 6000;

/**
 * Collects one tool result: lines of text and facts. `text()` is what the model reads — never
 * more than `MAX_FACTS` facts or `MAX_RESULT_CHARS` characters, and it says what was left out.
 * Only the facts that fit are entered in the ledger: a handle the model never saw cannot be cited.
 */
export class Sheet {
  private lines: string[] = [];
  private kept: Fact[] = [];
  private dropped = 0;
  private readonly key: string | null;
  constructor(private readonly tabId: string, private readonly limit = MAX_FACTS) {
    this.key = networkKeyOf(tabId);
  }
  /** A line without a number to cite. */
  say(line: string): this {
    this.lines.push(line);
    return this;
  }
  /** A number with its handle; left out (and counted) when it is not finite or the sheet is full. */
  fact(f: Omit<NumberFact, "kind" | "networkKey">): this {
    if (typeof f.value !== "number" || !Number.isFinite(f.value)) return this;
    if (this.kept.length >= this.limit) {
      this.dropped++;
      return this;
    }
    const fact: NumberFact = { ...f, kind: "number", networkKey: this.key };
    this.kept.push(fact);
    this.lines.push(factLine(fact));
    return this;
  }
  /**
   * A passage to quote from; `shown` is what the model reads of it, and only that is what a
   * quoted number is checked against: a number elsewhere in the article was never handed over
   * (ledger WF-505). The parts of one article read in several calls add up (`text()`).
   */
  passage(f: Omit<TextFact, "kind" | "networkKey">, shown: string = f.text): this {
    this.kept.push({ ...f, text: shown, kind: "text", networkKey: null });
    this.lines.push(`[${f.handle}] ${f.what}:${shown.length < 80 && !shown.includes("\n") ? " " : "\n"}${shown}`);
    return this;
  }
  get count() {
    return this.kept.length;
  }
  get full() {
    return this.kept.length >= this.limit;
  }
  /** Enters the facts in the tab's ledger and answers with the text. */
  text(narrowWith = ""): string {
    let ledger = ledgers.get(this.tabId);
    if (!ledger) ledgers.set(this.tabId, (ledger = new Map()));
    for (const f of this.kept) {
      const had = ledger.get(f.handle);
      // Another part of a passage already read: the assistant now holds both.
      if (f.kind === "text" && had?.kind === "text") ledger.set(f.handle, { ...f, text: had.text.includes(f.text) ? had.text : `${had.text}\n${f.text}` });
      else ledger.set(f.handle, f);
    }
    const out = [...this.lines];
    if (this.dropped) out.push(`(${this.dropped} more numbers were left out to keep this short.${narrowWith ? ` ${narrowWith}` : ""})`);
    let text = out.join("\n");
    if (text.length > MAX_RESULT_CHARS) {
      const cut = text.lastIndexOf("\n", MAX_RESULT_CHARS - 80);
      const body = text.slice(0, cut > 0 ? cut : MAX_RESULT_CHARS - 80);
      // A fact whose line was cut was never shown: it cannot be cited.
      for (const f of this.kept) if (!body.includes(`[${f.handle}]`)) ledger.delete(f.handle);
      text = `${body}\n(The rest was cut to keep this short.${narrowWith ? ` ${narrowWith}` : ""})`;
    }
    return text;
  }
}
