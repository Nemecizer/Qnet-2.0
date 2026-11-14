// The strip chart in the animation's bar (new in 2.1, ROADMAP Phase E): the number at one station
// over the last stretch of the run, as the step function it is, with the exact long-run mean as
// a dashed line when one is known. Hand-built SVG, colours from tokens; the sentence beside it
// (AnimateBar) and its accessible name say the same in words.
export const CHART_WIDTH = 220;
export const CHART_HEIGHT = 52;
const PAD = { left: 18, right: 4, top: 5, bottom: 5 };

export interface StripGeometry {
  /** The step line's path, or "" with nothing to draw. */
  path: string;
  /** The top of the scale (customers). */
  max: number;
  /** y of the exact mean's line, or null. */
  exactY: number | null;
}

/**
 * The chart's geometry from a station's history (flat [time, number, time, number…], oldest
 * first), for the window ending at `now`.
 */
export function stripGeometry(history: readonly number[], now: number, window: number, exact: number | null): StripGeometry {
  const from = now - window;
  let max = Math.max(4, exact !== null && Number.isFinite(exact) ? Math.ceil(exact * 1.4) : 0);
  // The value in force at the window's start, then every change inside it (up to `now`: the
  // history may run a little ahead of nothing — it never does — but a restart can leave it behind).
  let start = 0;
  for (let i = 0; i + 1 < history.length; i += 2) {
    if (history[i] <= from) start = i;
    else break;
  }
  const pts: [number, number][] = [];
  for (let i = start; i + 1 < history.length; i += 2) {
    if (history[i] > now) break;
    pts.push([Math.max(history[i], from), history[i + 1]]);
    max = Math.max(max, history[i + 1]);
  }
  const w = CHART_WIDTH - PAD.left - PAD.right;
  const h = CHART_HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + (window > 0 ? ((t - from) / window) * w : 0);
  const y = (v: number) => PAD.top + h - (v / max) * h;
  const r = (v: number) => Math.round(v * 10) / 10;
  let path = "";
  pts.forEach(([t, v], i) => {
    if (i === 0) path = `M${r(x(t))} ${r(y(v))}`;
    else path += `H${r(x(t))}V${r(y(v))}`;
  });
  if (pts.length) path += `H${r(x(Math.max(now, pts[pts.length - 1][0])))}`;
  return { path, max, exactY: exact !== null && Number.isFinite(exact) ? r(y(exact)) : null };
}

export function StripChart({ history, now, window, exact, label }: { history: readonly number[]; now: number; window: number; exact: number | null; label: string }) {
  const g = stripGeometry(history, now, window, exact);
  const bottom = CHART_HEIGHT - PAD.bottom;
  return (
    <svg className="animate-chart" width={CHART_WIDTH} height={CHART_HEIGHT} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={label} data-animate-chart>
      <line className="animate-chart-axis" x1={PAD.left} y1={bottom} x2={CHART_WIDTH - PAD.right} y2={bottom} />
      <line className="animate-chart-axis" x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={bottom} />
      <text className="animate-chart-tick" x={PAD.left - 3} y={PAD.top + 3} textAnchor="end">
        {g.max}
      </text>
      <text className="animate-chart-tick" x={PAD.left - 3} y={bottom} textAnchor="end">
        0
      </text>
      {g.exactY !== null && <line className="animate-chart-exact" x1={PAD.left} y1={g.exactY} x2={CHART_WIDTH - PAD.right} y2={g.exactY} data-animate-exact-line />}
      {g.path && <path className="animate-chart-line" d={g.path} />}
    </svg>
  );
}
