// Node names and the numbers in them (0.90.34 NodeNaming.swift; core/src/naming.rs is the Rust twin
// the exporters use, and the two must agree).

/** The number in a node name: Swift's `Int(name.drop(while: { !$0.isNumber }))`, or null when there is none. */
export function numericSuffix(name: string): number | null {
  const m = /\p{N}/u.exec(name);
  if (!m) return null;
  const rest = name.slice(m.index);
  if (!/^[0-9]+$/.test(rest)) return null;
  return int64(rest);
}

/** The sort key every exporter uses: a name without a number sorts last. */
export function sortIndex(name: string): number {
  return numericSuffix(name) ?? Number.MAX_VALUE;
}

/** `items` sorted by `sortIndex` of their names, ties kept in document order (Swift's sort is stable, and so is this). */
export function inExportOrder<T>(items: readonly T[], name: (t: T) => string): T[] {
  return [...items].sort((a, b) => cmp(sortIndex(name(a)), sortIndex(name(b))));
}

/** True when the names don't give one order: a name without a number, or two with the same one. */
export function orderIsAmbiguous(names: readonly string[]): boolean {
  const seen = new Set<number>();
  for (const n of names) {
    const s = numericSuffix(n);
    if (s === null || seen.has(s)) return true;
    seen.add(s);
  }
  return false;
}

/**
 * Swift's `Int(String)`: ASCII digits after an optional sign, nothing else, and null when the value
 * doesn't fit a 64-bit Int. (Beyond 2^53 the value is approximate; only order matters to callers.)
 */
export function swiftInt(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) return null;
  const big = BigInt(s);
  if (big > 9223372036854775807n || big < -9223372036854775808n) return null;
  return Number(big);
}

function int64(digits: string): number | null {
  return swiftInt(digits);
}

let segmenter: Intl.Segmenter | null = null;

/** Swift's `String.dropFirst(k)`: drops k Characters (grapheme clusters), not code units. */
export function dropFirstCharacters(s: string, k: number): string {
  if (k <= 0) return s;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let i = 0;
  for (const seg of segmenter.segment(s)) {
    if (i === k) return s.slice(seg.index);
    i++;
  }
  return "";
}

/** The highest `Int(name.dropFirst(prefix.count))` among `names`, 0 when none parses (NetworkEditorModel.maxNameIndex). */
export function maxNameIndex(names: readonly string[], prefix: string): number {
  let best: number | null = null;
  const k = [...(segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })).segment(prefix)].length;
  for (const n of names) {
    const v = swiftInt(dropFirstCharacters(n, k));
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best ?? 0;
}

function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
