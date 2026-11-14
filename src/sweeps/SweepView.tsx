// The Results pane's Sweep view (new in 2.1, ROADMAP B4): the tab's saved what-if sweep as a line
// chart — x the parameter, y the measure, a line per method coloured by tier, an interval band
// for a simulation, a rule at the parameter's value now and a dashed one where the network becomes
// overloaded — or as a table of the same numbers. The measure and the station change without
// running anything again; Export Chart… and Export Data… save what is shown; "Apply" sets the
// parameter in the network to the value in hand, as one undo step.
//
// The value in hand is the chart's own read-out (the point under the pointer, or the one the
// arrow keys moved to): the view follows the chart's active mark and keeps the last one, so the
// button can still be reached after the pointer has left the plot. It reaches its document only
// through its own elements, so it draws the same docked or in a detached window.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartLine, FileSpreadsheet, Share, TriangleAlert } from "lucide-react";
import { ChartFrame, LineChart } from "../charts";
import { Icon } from "../components/Icon";
import { displayFixed } from "../editor/numbers";
import { runCommand } from "../lib/commands";
import { exportChart } from "../panes/results/charts/exportChart";
import { useCurrentFingerprint } from "../panes/results/fingerprint";
import { useWorkspace } from "../workspace/store";
import { methodNotes, metricOptions, pickMetric, pickStation, stationOptions, sweepChart, sweepCsv, sweepTable } from "./chart";
import { applySweepValue, exportSweepCsv, openSweepPanel, SWEEP_COMMAND } from "./commands";
import { parameterById, valueText } from "./model";
import { setSweepSelection, sweepIsStale, useSweepResult, useSweepSelection } from "./store";
import { sweepWords as w } from "./words";
import "../panes/results/charts/charts.css";
import "./sweeps.css";

export interface SweepViewProps {
  tabId: string;
  /** `output.decimals`: how the values are shown. */
  decimals: number;
}

export function SweepView({ tabId, decimals }: SweepViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const result = useSweepResult(tabId);
  const selection = useSweepSelection(tabId);
  const doc = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId)?.document ?? null);
  const fingerprint = useCurrentFingerprint(doc);
  const format = (x: number) => displayFixed(x, decimals);
  /** The x value in hand: the chart's last active point, or a table row's. */
  const [chosen, setChosen] = useState<number | null>(null);

  const metric = useMemo(() => (result ? pickMetric(result, selection.metricKey) : null), [result, selection.metricKey]);
  const station = useMemo(() => (result ? pickStation(result, metric, selection.stationKey) : null), [result, metric, selection.stationKey]);
  const parameterNow = useMemo(() => (result && doc ? parameterById(doc, result.parameter.id) : null), [result, doc]);
  const chart = useMemo(
    () => (result && metric && station ? sweepChart(result, metric, station, format, parameterNow?.current ?? null) : null),
    // `format` follows `decimals`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, metric, station, decimals, parameterNow?.current],
  );
  const table = useMemo(
    () => (result && metric && station ? sweepTable(result, metric, station, format) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, metric, station, decimals],
  );

  // A new sweep has no value in hand.
  useEffect(() => setChosen(null), [result?.id]);

  // Follow the chart's read-out: its active mark names the series and the point.
  useEffect(() => {
    const root = rootRef.current;
    const Observer = root?.ownerDocument.defaultView?.MutationObserver;
    if (!root || !Observer || !chart) return;
    const read = () => {
      const key = root.querySelector("[data-active-mark]")?.getAttribute("data-active-mark");
      if (!key) return;
      const cut = key.lastIndexOf("/");
      const series = chart.series.find((sr) => sr.key === key.slice(0, cut));
      const drawn = series?.points.filter((p) => !p.gap && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
      const point = drawn?.[Number(key.slice(cut + 1))];
      if (point) setChosen(point.x);
    };
    const observer = new Observer(read);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-active-mark"] });
    return () => observer.disconnect();
  }, [chart]);

  if (!result) {
    return (
      <div ref={rootRef} className="results-charts sweep-view" data-sweep="none">
        <div className="results-charts-body">
          <div className="empty-state results-empty results-charts-empty">
            <Icon icon={ChartLine} size={20} aria-hidden />
            <h2>{w.emptyTitle}</h2>
            <p>{w.emptyMessage}</p>
            <button type="button" className="btn primary" title={w.commandHelp} onClick={() => void runCommand(SWEEP_COMMAND)}>
              {w.emptyAction}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const metrics = metricOptions(result);
  const stations = stationOptions(result, metric);
  const mode = selection.mode;
  // As every result: a change of layout alone leaves the sweep current.
  const stale = sweepIsStale(result, fingerprint);
  const notes = methodNotes(result);
  const name = result.parameter.axis;
  const apply = (x: number) => applySweepValue(tabId, result.parameter, x);
  const again = () => openSweepPanel({ tabId, from: result });
  const csv = () => exportSweepCsv(tabId, metric && station ? sweepCsv(result, { metric, station }) : sweepCsv(result));

  return (
    <div ref={rootRef} className="results-charts sweep-view" data-sweep={result.id} data-mode={mode}>
      <div className="results-charts-bar">
        {metrics.length ? (
          <select className="results-picker" aria-label={w.measureLabel} title={w.measureHelp} value={metric?.key ?? ""} onChange={(e) => setSweepSelection(tabId, { metricKey: e.target.value })}>
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {w.axisWithUnit(m.metric, m.unit)}
              </option>
            ))}
          </select>
        ) : null}
        {stations.length ? (
          <select className="results-picker" aria-label={w.stationLabel} title={w.stationHelp} value={station?.key ?? ""} onChange={(e) => setSweepSelection(tabId, { stationKey: e.target.value })}>
            {stations.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        ) : null}
        <div className="results-views" role="radiogroup" aria-label={w.modeLabel}>
          {(["chart", "table"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} title={w.modeHelp[m]} onClick={() => setSweepSelection(tabId, { mode: m })}>
              {w.modes[m]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {mode === "chart" ? (
          <button
            type="button"
            className="btn sweep-apply"
            data-sweep-apply
            disabled={chosen === null || !chart}
            title={chosen === null ? w.applyIdleHelp : w.applyHelp(name, valueText(chosen))}
            onClick={() => chosen !== null && apply(chosen)}
          >
            {chosen === null ? w.applyIdle : w.apply(name, valueText(chosen))}
          </button>
        ) : null}
        <button type="button" className="btn" title={w.againHelp} onClick={again}>
          {w.again}
        </button>
        <button type="button" className="icon-btn" aria-label={w.exportData} title={w.exportDataHelp} onClick={() => void csv()}>
          <Icon icon={FileSpreadsheet} size={14} aria-hidden />
        </button>
        <button type="button" className="icon-btn" aria-label={w.exportChart} title={w.exportChartHelp} disabled={mode !== "chart" || !chart} onClick={() => void exportChart(tabId, rootRef.current)}>
          <Icon icon={Share} size={14} aria-hidden />
        </button>
      </div>
      <div className="results-charts-body">
        {stale || result.stopped ? (
          <p className="results-note" data-tone="warning" role="note">
            <Icon icon={TriangleAlert} size={12} aria-hidden />
            {[result.stopped ? w.stoppedNote : null, stale ? w.staleNote : null].filter(Boolean).join(" ")}
          </p>
        ) : null}
        {mode === "chart" ? (
          chart ? (
            <ChartFrame className="results-chart-card">{({ width, fontScale }) => <LineChart {...chart} width={width} fontScale={fontScale} />}</ChartFrame>
          ) : (
            <div className="empty-state results-empty results-charts-empty">
              <Icon icon={ChartLine} size={20} aria-hidden />
              <h2>{w.noValuesTitle}</h2>
              <p>{w.noValuesMessage}</p>
            </div>
          )
        ) : null}
        {table && (mode === "table" || !chart) ? (
          <div className="results-chart-card sweep-table-card">
            <table className="sweep-table" data-sweep-table>
              <caption>{table.caption}</caption>
              <thead>
                <tr>
                  {table.head.map((h, i) => (
                    <th key={i} scope="col">
                      {h}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">{w.applyRow}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.x} data-current={parameterNow && Math.abs(parameterNow.current - row.x) <= 1e-9 * Math.max(1, Math.abs(row.x)) ? true : undefined}>
                    <th scope="row">{row.label}</th>
                    {row.cells.map((c, j) => (
                      <td key={j} data-gap={c.reason ? true : undefined} title={c.sentence ?? undefined}>
                        {c.reason ? <span className="sweep-gap">{c.reason}</span> : c.text}
                      </td>
                    ))}
                    <td className="sweep-table-apply">
                      <button type="button" className="btn" title={w.applyHelp(name, row.label)} aria-label={w.apply(name, row.label)} disabled={row.cells.every((c) => c.reason === w.gapReasons.unstable)} onClick={() => apply(row.x)}>
                        {w.applyRow}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {notes.length ? (
          <ul className="sweep-notes" aria-label={w.methodNotes}>
            {notes.map((n) => (
              <li key={n.method}>
                <strong>{n.method}</strong> — {w.methodNotes.toLowerCase()}: {n.sentence}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
