// What every chart shares (new in 2.1, ROADMAP B1): the <svg> with its title, the read-out that
// follows the pointer or the arrow keys from mark to mark, and the text alternative — a caption
// sentence and a table of the same numbers that a screen reader reads in place of the drawing.
//
// Keyboard: the chart is one tab stop. → and ← move between the marks of a row, ↓ and ↑ between
// rows (keeping the column where there is one), Home and End go to the first and last mark,
// Escape puts the read-out away. The mark in hand is also spoken (a polite live region).
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { CHART_FONT, SIZE, textWidth, v } from "./theme";
import "./charts.css";

export interface Mark {
  key: string;
  /** Position among the marks: ↑↓ change the row, ←→ the column. */
  row: number;
  col: number;
  /** Where the read-out points. */
  x: number;
  y: number;
  /** The pointer's target, larger than the mark. */
  hit: { x: number; y: number; width: number; height: number };
  /** The read-out's lines; the first names the mark. */
  lines: string[];
}

export interface TableAlternative {
  caption: string;
  head: string[];
  rows: string[][];
}

/** The mark an arrow key leads to from `from` (an index into `marks`), or the same one at an edge. */
export function nextMark(marks: readonly Mark[], from: number | null, key: string): number | null {
  if (!marks.length) return null;
  if (key === "Home") return 0;
  if (key === "End") return marks.length - 1;
  if (from === null || !marks[from]) return key === "ArrowLeft" || key === "ArrowUp" ? marks.length - 1 : 0;
  const here = marks[from];
  const index = (m: Mark) => marks.indexOf(m);
  if (key === "ArrowRight" || key === "ArrowLeft") {
    const d = key === "ArrowRight" ? 1 : -1;
    const row = marks.filter((m) => m.row === here.row).sort((a, b) => a.col - b.col);
    const beside = row[row.indexOf(here) + d];
    if (beside) return index(beside);
    // Past the row's end: on into the neighbouring row.
    const rows = [...new Set(marks.map((m) => m.row))].sort((a, b) => a - b);
    const nextRow = rows[rows.indexOf(here.row) + d];
    if (nextRow === undefined) return from;
    const other = marks.filter((m) => m.row === nextRow).sort((a, b) => a.col - b.col);
    return index(d > 0 ? other[0] : other[other.length - 1]);
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    const d = key === "ArrowDown" ? 1 : -1;
    const rows = [...new Set(marks.map((m) => m.row))].sort((a, b) => a - b);
    const nextRow = rows[rows.indexOf(here.row) + d];
    if (nextRow === undefined) return from;
    const other = marks.filter((m) => m.row === nextRow);
    return index(other.reduce((best, m) => (Math.abs(m.col - here.col) < Math.abs(best.col - here.col) ? m : best)));
  }
  return from;
}

/** The height the title block takes at the top of a chart. */
export function headerHeight(subtitle: string | undefined, s: number): number {
  return Math.round((SIZE.title * 1.35 + (subtitle ? SIZE.label * 1.45 : 0) + 8) * s);
}

function ReadOut({ mark, width, height, s }: { mark: Mark; width: number; height: number; s: number }) {
  const size = SIZE.label * s;
  const line = Math.round(size * 1.4);
  const pad = 7 * s;
  const w = Math.min(width - 4, Math.max(...mark.lines.map((l, i) => textWidth(l, size, i === 0 ? 600 : 400))) * 1.06 + pad * 2);
  const h = mark.lines.length * line + pad * 2 - 3;
  let x = mark.x + 12;
  if (x + w > width - 2) x = mark.x - 12 - w;
  x = Math.max(2, Math.min(width - w - 2, x));
  let y = mark.y - h - 8;
  if (y < 2) y = Math.min(height - h - 2, mark.y + 12);
  return (
    <g data-export="skip" data-readout pointerEvents="none">
      <rect x={x} y={y} width={w} height={h} rx={5} fill={v("--surface")} stroke={v("--border")} strokeWidth={1} />
      {mark.lines.map((l, i) => (
        <text key={i} x={x + pad} y={y + pad + line * i + size * 0.82} fontSize={size} fontWeight={i === 0 ? 600 : 400} fill={v(i === 0 ? "--text" : "--text-2")}>
          {l}
        </text>
      ))}
    </g>
  );
}

export interface ChartShellProps {
  width: number;
  height: number;
  title: string;
  subtitle?: string;
  /** The sentence under the chart that says what it shows. */
  caption: string;
  table: TableAlternative;
  marks: Mark[];
  /** The app's text scale (1 by default). */
  fontScale?: number;
  /** A name for tests and styling ("bar", "dot-interval", "line"). */
  kind: string;
  children: ReactNode;
}

export function ChartShell({ width, height, title, subtitle, caption, table, marks, fontScale = 1, kind, children }: ChartShellProps) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const s = fontScale;
  const mark = active !== null ? marks[active] ?? null : null;

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "Escape") {
      if (active !== null) {
        e.stopPropagation();
        setActive(null);
      }
      return;
    }
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(nextMark(marks, active, e.key));
  };

  return (
    <figure className="chart" data-chart-kind={kind}>
      <svg
        data-chart={kind}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        fontFamily={CHART_FONT}
        role="img"
        aria-label={subtitle ? `${title}. ${subtitle}` : title}
        aria-describedby={`${id}-caption ${id}-table`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <text x={0} y={SIZE.title * s} fontSize={SIZE.title * s} fontWeight={600} fill={v("--text")} data-chart-title>
          {title}
        </text>
        {subtitle ? (
          <text x={0} y={(SIZE.title * 1.35 + SIZE.label) * s} fontSize={SIZE.label * s} fill={v("--text-2")} data-chart-subtitle>
            {subtitle}
          </text>
        ) : null}
        {children}
        <g data-export="skip">
          {mark ? <rect x={mark.hit.x} y={mark.hit.y} width={mark.hit.width} height={mark.hit.height} rx={3} fill={v("--text")} fillOpacity={0.07} stroke={v("--focus-ring")} strokeWidth={1.5} data-active-mark={mark.key} pointerEvents="none" /> : null}
          {marks.map((m, i) => (
            <rect key={m.key} x={m.hit.x} y={m.hit.y} width={m.hit.width} height={m.hit.height} fill="transparent" data-mark={m.key} onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)} />
          ))}
        </g>
        {mark ? <ReadOut mark={mark} width={width} height={height} s={s} /> : null}
      </svg>
      <figcaption id={`${id}-caption`} className="chart-caption">
        {caption}
      </figcaption>
      <div className="sr-only" role="status" aria-live="polite" data-chart-live>
        {mark ? mark.lines.join(". ") : ""}
      </div>
      <table id={`${id}-table`} className="sr-only" data-chart-table>
        <caption>{table.caption}</caption>
        <thead>
          <tr>
            {table.head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
