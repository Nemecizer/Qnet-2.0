// Reading numbers out of what a person pastes or drops (new in 2.1, ROADMAP D2): a list separated
// by new lines, commas, tabs, semicolons or spaces, or a table (CSV, TSV) whose columns can be
// chosen from. Nothing here is arithmetic on the sample beyond taking the gaps between event
// times; the statistics are Rust's (src-tauri/src/fit.rs).
//
// The decimal comma. "1,5" is 1.5 in much of the world and two numbers in the rest. It is read as
// a decimal mark only when that is the one reading: there is no decimal point anywhere, every
// comma sits between digits, no cell has two, and something else (a semicolon or a tab) already
// separates the cells. When it merely could be (every line is "digits,digits"), the commas are
// read as separators and `ambiguous` is set, so the panel can ask.

export interface DataColumn {
  index: number;
  /** The first row's cell when it is a heading. */
  header: string | null;
  values: number[];
  /** Cells that are not numbers, as written (the heading aside). */
  skipped: string[];
}

export interface ParsedData {
  columns: DataColumn[];
  /** Whether commas were read as decimal marks. */
  decimalComma: boolean;
  /** The commas could be either; they were read as separators unless told otherwise. */
  ambiguous: boolean;
  /** Whether the text has a comma at all (the panel offers the switch only then). */
  hasComma: boolean;
  /** A table (rows of the same number of cells) rather than a plain list. */
  table: boolean;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A cell as a number, or null. Quotes and a leading BOM are dropped. */
export function cellNumber(cell: string, decimalComma: boolean): number | null {
  let t = cell.trim().replace(/^["']|["']$/g, "").trim();
  if (decimalComma) {
    if (t.includes(".")) return null;
    t = t.replace(",", ".");
  }
  // A typographic minus, as a spreadsheet may write it.
  t = t.replace(/^−/, "-");
  if (!NUMBER.test(t)) return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

function commaReading(text: string): { decimal: boolean; ambiguous: boolean } {
  if (!text.includes(",")) return { decimal: false, ambiguous: false };
  const digitFlanked = !/(^|[^\d]),|,([^\d]|$)/m.test(text);
  if (!digitFlanked || /\d\.\d|\.\d/.test(text)) return { decimal: false, ambiguous: false };
  const cells = text.split(/[;\t\n\r ]+/).filter((c) => c.length);
  const oneEach = cells.every((c) => (c.match(/,/g) ?? []).length <= 1);
  if (!oneEach) return { decimal: false, ambiguous: false };
  // Another separator is doing the separating: the comma can only be a decimal mark.
  if (/[;\t]/.test(text)) return { decimal: true, ambiguous: false };
  // Every cell is "digits,digits": decimal numbers, or pairs of whole numbers. It cannot be told.
  return { decimal: false, ambiguous: cells.length >= 2 && cells.every((c) => /^[+-]?\d+,\d+$/.test(c)) };
}

/**
 * The numbers in `text`. `decimalComma` forces the reading of commas (the panel's switch); null
 * decides from the text.
 */
export function parseData(text: string, decimalComma: boolean | null = null): ParsedData {
  const clean = text.replace(/^﻿/, "");
  const reading = commaReading(clean);
  const decimal = decimalComma ?? reading.decimal;
  const hasComma = clean.includes(",");
  const lines = clean.split(/\r\n|\n|\r/).filter((l) => l.trim().length);
  const splitter = decimal ? /[;\t]/ : /[;\t,]/;
  const rows = lines.map((l) => {
    const cells = splitter.test(l) ? l.split(splitter) : l.trim().split(/\s+/);
    return cells.map((c) => c.trim());
  });
  const widths = rows.map((r) => r.length);
  const width = Math.max(0, ...widths);
  const sameWidth = widths.filter((w) => w === width).length;
  const table = rows.length >= 2 && width >= 2 && sameWidth >= Math.ceil(rows.length * 0.8);
  const base = { decimalComma: decimal, ambiguous: decimalComma === null && reading.ambiguous, hasComma, table };
  if (!table) {
    const column: DataColumn = { index: 0, header: null, values: [], skipped: [] };
    for (const cell of lines.flatMap((l) => l.split(decimal ? /[;\s]+/ : /[;,\s]+/))) {
      if (!cell.length) continue;
      const x = cellNumber(cell, decimal);
      if (x === null) column.skipped.push(cell);
      else column.values.push(x);
    }
    return { ...base, columns: column.values.length || column.skipped.length ? [column] : [] };
  }
  const columns: DataColumn[] = [];
  for (let c = 0; c < width; c++) {
    const cells = rows.map((r) => r[c] ?? "");
    // A heading: a first cell that is not a number above a column that mostly is.
    const rest = cells.slice(1).filter((x) => x.length);
    const numeric = rest.filter((x) => cellNumber(x, decimal) !== null).length;
    const headed = cells[0].length > 0 && cellNumber(cells[0], decimal) === null && rest.length > 0 && numeric >= rest.length / 2;
    const column: DataColumn = { index: c, header: headed ? cells[0].replace(/^["']|["']$/g, "") : null, values: [], skipped: [] };
    for (const cell of headed ? cells.slice(1) : cells) {
      if (!cell.length) continue;
      const x = cellNumber(cell, decimal);
      if (x === null) column.skipped.push(cell);
      else column.values.push(x);
    }
    columns.push(column);
  }
  return { ...base, columns };
}

/** The column the panel opens on: the last one with the most numbers (times are usually to the right of a row number). */
export function defaultColumn(parsed: ParsedData): number {
  let best = 0;
  parsed.columns.forEach((c, i) => {
    if (c.values.length >= (parsed.columns[best]?.values.length ?? 0)) best = i;
  });
  return best;
}

export interface Prepared {
  /** What goes to the fit. */
  data: number[];
  negatives: number;
  zeros: number;
  /** Event times that were not in order, and were sorted before the gaps were taken. */
  sorted: boolean;
  droppedZeros: number;
}

/**
 * The sample itself: the column's numbers, or with `eventTimes` the gaps between them in time
 * order (n times give n − 1 gaps); zeros left out when asked.
 */
export function prepare(values: readonly number[], opts: { eventTimes: boolean; dropZeros: boolean }): Prepared {
  let data = [...values];
  let sorted = false;
  if (opts.eventTimes) {
    sorted = data.some((x, i) => i > 0 && x < data[i - 1]);
    if (sorted) data.sort((a, b) => a - b);
    data = data.slice(1).map((x, i) => x - data[i]);
  }
  const zeros = data.filter((x) => x === 0).length;
  const droppedZeros = opts.dropZeros ? zeros : 0;
  if (opts.dropZeros) data = data.filter((x) => x !== 0);
  return { data, negatives: data.filter((x) => x < 0).length, zeros, sorted, droppedZeros };
}
