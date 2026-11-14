// The field half of 0.90.34's DS.Number (DesignSystem.swift:1557-1614): the text the app writes
// into a field (`fieldText`, C's `%.10g`), how a field's text is read back (`parse`, `parseInt`) and
// the "still typing" test (`isPartialNumber`). Readouts use `formatSig` from src/editor/numbers.ts
// (DS.Number.format) and are re-exported here so the inspector has one place to import from.
export { formatSig, READOUT_DIGITS } from "../../../editor/numbers";

/**
 * C's `%.<p>g`: `p` significant digits, scientific when the exponent is below -4 or at least `p`,
 * trailing zeros (and a trailing point) removed, a two-digit exponent at least. Non-finite values
 * print as C does ("inf", "-inf", "nan"); callers that must not show those check first.
 */
export function cG(value: number, precision: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  const p = precision === 0 ? 1 : precision;
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  // The exponent after rounding to p digits decides the style, as printf does.
  const exp = value.toExponential(p - 1);
  const x = Number(exp.slice(exp.indexOf("e") + 1));
  if (x < -4 || x >= p) {
    let [mant, e] = exp.split("e");
    if (mant.includes(".")) mant = mant.replace(/0+$/, "").replace(/\.$/, "");
    const sign = e.startsWith("-") ? "-" : "+";
    const digits = e.replace(/^[+-]/, "");
    return `${mant}e${sign}${digits.length < 2 ? "0" + digits : digits}`;
  }
  let fixed = value.toFixed(Math.max(0, p - 1 - x));
  if (fixed.includes(".")) fixed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return fixed;
}

/** `DS.Number.fieldText`: `%.10g`, "" for a non-finite value. */
export function fieldText(value: number): string {
  return Number.isFinite(value) ? cG(value, 10) : "";
}

const WS = /^[\s ]+|[\s ]+$/g;

/** Swift's `Double(String)` on the canonical forms: decimal with optional exponent, inf, nan. */
function swiftDouble(t: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  return null;
}

/** The locale parse (`Double(text, format: .number)`) for an English locale: grouped thousands. */
function localeDouble(t: string): number | null {
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(t)) return Number(t.replace(/,/g, ""));
  return null;
}

/** One comma, no period, and a fraction that isn't the three digits of a grouped thousand. */
function commaIsDecimalSeparator(t: string): boolean {
  if (t.includes(".")) return false;
  const parts = t.split(",");
  if (parts.length !== 2 || !parts[1] || !/^\d+$/.test(parts[1])) return false;
  return parts[1].length !== 3;
}

/**
 * `DS.Number.parse`: the canonical form first ("1e-3"), then a lone comma that can't be a
 * thousands mark as the decimal separator ("0,5" → 0.5, "1,000" → 1000), then the locale form,
 * then comma → period. Non-finite values are refused.
 */
export function parseNumber(text: string): number | null {
  const t = text.replace(WS, "");
  if (!t) return null;
  const canonical = swiftDouble(t);
  if (canonical !== null && Number.isFinite(canonical)) return canonical;
  if (commaIsDecimalSeparator(t)) {
    const v = swiftDouble(t.replace(",", "."));
    if (v !== null && Number.isFinite(v)) return v;
  }
  const loc = localeDouble(t);
  if (loc !== null && Number.isFinite(loc)) return loc;
  const last = swiftDouble(t.replace(/,/g, "."));
  if (last !== null && Number.isFinite(last)) return last;
  return null;
}

/** `DS.Number.parseInt`: trimmed, the locale integer form ("1,000"), then plain `Int`. */
export function parseInteger(text: string): number | null {
  const t = text.replace(WS, "");
  if (!t) return null;
  if (/^[+-]?\d{1,3}(,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ""));
  if (/^[+-]?\d+$/.test(t)) {
    const v = Number(t);
    return Number.isSafeInteger(v) ? v : null;
  }
  return null;
}

/** `DS.Number.isPartialNumber`: "", "-", "+", ".", ",", "-.", "-,", or a number then e / e- / e+. */
export function isPartialNumber(text: string): boolean {
  const t = text.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!t) return true;
  if (["-", "+", ".", ",", "-.", "-,"].includes(t)) return true;
  const lower = t.toLowerCase();
  if (lower.endsWith("e") || lower.endsWith("e-") || lower.endsWith("e+")) {
    return parseNumber(lower.slice(0, lower.indexOf("e"))) !== null;
  }
  return false;
}

/** A field whose text is a legal prefix of a number: its error is real, but shown calmly. */
export function isPending(text: string): boolean {
  return parseNumber(text) === null && isPartialNumber(text);
}

/** Whole numbers with grouping, as `Int.formatted()` writes them ("10,000"). */
export function groupedInt(v: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v);
}

/** Step results are rounded to 1e-9 to drop float noise (DSFields `tidied`). */
export function tidied(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
