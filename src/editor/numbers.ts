// 0.90.34's DS.Number, the formatting of every number the editor writes into the Status log, the
// inspectors and the canvas labels.

/** Precision of a read-only number the app derives and shows back (DS.Number.readoutDigits). */
export const READOUT_DIGITS = 5;

const sigFormats = new Map<number, Intl.NumberFormat>();

/**
 * `DS.Number.format(_:significantDigits:)`: up to `digits` significant digits in the user's
 * locale form, no trailing zeros, "—" for NaN and "∞" for either infinity. Foundation's number
 * format rounds half to even, as ICU does.
 */
export function formatSig(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "—" : "∞";
  let f = sigFormats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(undefined, {
      minimumSignificantDigits: 1,
      maximumSignificantDigits: digits,
      roundingMode: "halfEven",
    } as Intl.NumberFormatOptions);
    sigFormats.set(digits, f);
  }
  return f.format(value);
}

/**
 * `DS.Number.display(_:decimals:)`: exactly `decimals` fraction digits (`%.<d>f`), scientific
 * (`%.<max(1,d-1)>e`) for a non-zero magnitude below 10^-d or at or above 1e9, "—" for NaN,
 * "∞" / "-∞" for infinities, and never a "-0.000".
 */
export function displayFixed(value: number, decimals: number): string {
  if (Number.isNaN(value)) return "—";
  if (!Number.isFinite(value)) return value < 0 ? "-∞" : "∞";
  const d = Math.max(0, Math.min(9, decimals));
  const small = d > 0 && Math.abs(value) < Math.pow(10, -d);
  const large = Math.abs(value) >= 1e9;
  const text = value !== 0 && (small || large) ? cExp(value, Math.max(1, d - 1)) : cFixed(value, d);
  if (text.startsWith("-") && Number(text.slice(1)) === 0) return text.slice(1);
  return text;
}

/** C's `%.<d>f`: JavaScript's toFixed, except that an exact tie rounds to even as printf does. */
export function cFixed(value: number, d: number): string {
  const neg = value < 0 || Object.is(value, -0);
  const a = Math.abs(value);
  let out = a.toFixed(d);
  // toFixed picks the larger candidate on an exact tie; printf picks the even one.
  const wide = a.toFixed(Math.min(100, d + 40));
  const tail = wide.slice(wide.length - 40);
  if (/^50*$/.test(tail)) {
    const down = wide.slice(0, wide.length - 40);
    const lastDigit = Number(down.replace(".", "").slice(-1));
    if (lastDigit % 2 === 0) out = d === 0 ? down.replace(/\.$/, "") : down;
  }
  return (neg ? "-" : "") + out;
}

/** C's `%.<p>e`: mantissa with p fraction digits and an exponent of at least two digits. */
export function cExp(value: number, p: number): string {
  const s = value.toExponential(p);
  return s.replace(/e([+-])(\d)$/, "e$10$2");
}
