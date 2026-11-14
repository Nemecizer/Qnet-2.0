// The Results pane's Charts view (new in 2.1, ROADMAP B1 and B5): one method's values station by
// station, or every current method's value and interval side by side, for a chosen quantity; with
// Export Chart… and Copy Chart. It reaches its document only through its own elements, so it
// draws the same docked or in a detached window.
import { useMemo, useRef, useState } from "react";
import { ChartColumn, Copy, Share, TriangleAlert } from "lucide-react";
import { BarChart, ChartFrame, DotInterval } from "../../../charts";
import { Icon } from "../../../components/Icon";
import { displayFixed } from "../../../editor/numbers";
import { runCommand, useCommands } from "../../../lib/commands";
import { agreement, bestRun, currentRuns } from "../../../results/insight";
import { isStale, shortTime, type ResultRecord } from "../model";
import { resultsWords } from "../words";
import { chartableRun, methodsChart, methodsMetrics, pickMetric, runChart, runMetrics } from "./data";
import { copyChart, exportChart } from "./exportChart";
import "./charts.css";

const w = resultsWords.charts;

export type ChartScope = "run" | "methods";

/** "2 %", "6.2 %": one decimal below ten, as the Agreement view writes a deviation. */
export const percent = (fraction: number) => {
  if (!Number.isFinite(fraction)) return "∞ %";
  const x = Math.abs(fraction) * 100;
  return `${x >= 100 || Number.isInteger(Number(x.toFixed(1))) ? x.toFixed(0) : x.toFixed(1)} %`;
};

function Notice({ title, message, action, help, onAction }: { title: string; message: string; action?: string; help?: string; onAction?: () => void }) {
  return (
    <div className="results-charts-notice" role="note">
      <div>
        <strong>{title}</strong> {message}
      </div>
      {action ? (
        <button type="button" className="btn" title={help} onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

function Empty({ title, message, action, help, onAction }: { title: string; message: string; action?: string; help?: string; onAction?: () => void }) {
  return (
    <div className="empty-state results-empty results-charts-empty">
      <Icon icon={ChartColumn} size={20} aria-hidden />
      <h2>{title}</h2>
      <p>{message}</p>
      {action ? (
        <button type="button" className="btn primary" title={help} onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

export interface ChartsViewProps {
  tabId: string;
  records: ResultRecord[];
  fingerprint: string | null;
  decimals: number;
  /** The run selected in the Table view: the one the chart opens on. */
  selectedRunId?: string | null;
}

export function ChartsView({ tabId, records, fingerprint, decimals, selectedRunId }: ChartsViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<ChartScope>("run");
  const [runId, setRunId] = useState<string | null>(null);
  const [metric, setMetric] = useState<string | null>(null);
  const format = (x: number) => displayFixed(x, decimals);

  // Newest first, as the run history lists them.
  const runs = useMemo(() => records.filter(chartableRun).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)), [records]);
  const current = useMemo(() => currentRuns(records, fingerprint), [records, fingerprint]);
  const read = useMemo(() => agreement(current), [current]);
  const left = runs.filter((r) => isStale(r, fingerprint)).length;

  const run = runs.find((r) => r.id === runId) ?? runs.find((r) => r.id === selectedRunId) ?? bestRun(current.filter(chartableRun)) ?? runs[0] ?? null;
  const metrics = scope === "run" ? (run ? runMetrics(run) : []) : methodsMetrics(read);
  const option = pickMetric(metrics, metric);
  const stale = !!run && isStale(run, fingerprint);

  let body: React.ReactNode;
  let showing = false;
  if (scope === "run") {
    const chart = run && option ? runChart(run, option, format, stale) : null;
    if (!run) body = <Empty title={w.noRunsTitle} message={w.noRunsMessage} action={w.runMethod} help={w.runMethodHelp} onAction={() => void runCommand("run:solve")} />;
    else if (!chart) body = <Empty title={w.noMeasurementsTitle} message={w.noMeasurementsMessage} />;
    else {
      showing = true;
      body = <ChartFrame className="results-chart-card">{({ width, fontScale }) => <BarChart {...chart} width={width} fontScale={fontScale} />}</ChartFrame>;
    }
  } else {
    const chart = option ? methodsChart(read, option, format, percent) : null;
    if (!current.length || !chart) {
      body = left ? (
        <Empty title={w.allStaleTitle} message={w.allStaleMessage(left)} action={w.runMethod} help={w.runMethodHelp} onAction={() => void runCommand("run:solve")} />
      ) : (
        <Empty title={w.noRunsTitle} message={w.noRunsMessage} action={w.runMethod} help={w.runMethodHelp} onAction={() => void runCommand("run:solve")} />
      );
    } else {
      showing = true;
      body = (
        <>
          {chart.series.length === 1 ? <Notice title={w.oneMethodTitle} message={w.oneMethodMessage} action={w.runAnother} help={w.runAnotherHelp} onAction={() => void runCommand("run:check-another")} /> : null}
          {left ? (
            <p className="results-note" data-tone="warning">
              <Icon icon={TriangleAlert} size={12} aria-hidden />
              {w.staleLeftOut(left)}
            </p>
          ) : null}
          <ChartFrame className="results-chart-card">{({ width, fontScale }) => <DotInterval {...chart} width={width} fontScale={fontScale} />}</ChartFrame>
        </>
      );
    }
  }

  // The palette's entries (and a menu item's, once the menu names these ids).
  useCommands(
    [
      { id: "results:export-chart", title: w.exportChart, group: "File", subtitle: w.exportChartHelp, keywords: ["figure", "pdf", "png", "svg", "plot", "graph"], when: () => (showing ? true : w.noChart), run: () => exportChart(tabId, rootRef.current) },
      { id: "results:copy-chart", title: w.copyChart, group: "Edit", subtitle: w.copyChartHelp, keywords: ["clipboard", "figure", "image", "plot", "graph"], when: () => (showing ? true : w.noChart), run: () => copyChart(tabId, rootRef.current) },
    ],
    [tabId, showing],
  );

  return (
    <div ref={rootRef} className="results-charts" data-scope={scope}>
      <div className="results-charts-bar">
        <div className="results-views" role="radiogroup" aria-label={w.scopeLabel}>
          {(["run", "methods"] as const).map((sc) => (
            <button key={sc} type="button" role="radio" aria-checked={scope === sc} title={w.scopeHelp[sc]} onClick={() => setScope(sc)}>
              {w.scopes[sc]}
            </button>
          ))}
        </div>
        {scope === "run" && runs.length ? (
          <select className="results-picker" aria-label={w.runLabel} value={run?.id ?? ""} onChange={(e) => setRunId(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {w.runOption(r.method.shortName, shortTime(r.startedAt), isStale(r, fingerprint))}
              </option>
            ))}
          </select>
        ) : null}
        {metrics.length ? (
          <select className="results-picker" aria-label={w.metricLabel} value={option?.key ?? ""} onChange={(e) => setMetric(e.target.value)}>
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {w.metricOption(m.metric, m.unit)}
              </option>
            ))}
          </select>
        ) : null}
        {scope === "run" && stale ? (
          <span className="results-chip" data-severity="warning" title={resultsWords.networkChangedHelp}>
            <Icon icon={TriangleAlert} size={12} aria-hidden />
            {w.staleChip}
          </span>
        ) : null}
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label={w.copyChart} title={w.copyChartHelp} disabled={!showing} onClick={() => void copyChart(tabId, rootRef.current)}>
          <Icon icon={Copy} size={14} aria-hidden />
        </button>
        <button type="button" className="icon-btn" aria-label={w.exportChart} title={w.exportChartHelp} disabled={!showing} onClick={() => void exportChart(tabId, rootRef.current)}>
          <Icon icon={Share} size={14} aria-hidden />
        </button>
      </div>
      <div className="results-charts-body">{body}</div>
    </div>
  );
}
