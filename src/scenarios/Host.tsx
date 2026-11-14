// What scenarios put on screen besides the switcher (new in 2.1, ROADMAP E1): the name prompt
// (New, Rename, Duplicate) and the Compare Scenarios panel — a window of its own, not a Results
// view. Mounted once (`ScenarioHost`, by the toolbar's switcher's side or in App.tsx); until a
// host is mounted, the first request makes one in a root of its own.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Download, ImageDown, Layers, Play, Square } from "lucide-react";
import { BarChart, ChartFrame, shapePath, TIER_STYLE, v } from "../charts";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { useSetting } from "../lib/kv";
import { holdModal } from "../lib/overlays";
import { PanelWindow } from "../lib/panel";
import type { LiveResults } from "../live/model";
import { exportChart } from "../panes/results/charts/exportChart";
import { fingerprintNow } from "../panes/results/fingerprint";
import { asResult } from "../panes/results/model";
import { bestRun, currentRuns, type Tier } from "../results/insight";
import { useResults } from "../runs/state";
import { useSequence } from "../panes/results/agreement/runner";
import { useWorkspace } from "../workspace/store";
import { askScenarioName, closeCompare, closeScenarioName, confirmScenarioName, nameProblem, scenarioHosts, showScenario, useCompareTab, useScenarioNameRequest, type NameRequest } from "./commands";
import { CHART_MEASURES, compareChart, compareCsv, compareTable, diffText, rowLabel, tierLabel, unitLabel, valueText, type Cell, type MeasureKind, type Row, type Variant } from "./compare";
import { exportCompareCsv } from "./export";
import { activeId, scenarioDocument, scenariosOf } from "./model";
import { solveAllScenarios, stopSolveAll, useSolveAll } from "./solveAll";
import { scenarioWords as w } from "./words";
import "../workspace/files/files.css";
import "./scenarios.css";

// ── The name prompt ─────────────────────────────────────────────────────────────────────────────

function NamePrompt({ request }: { request: NameRequest }) {
  const id = useId();
  const [name, setName] = useState(request.initial);
  const [tried, setTried] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => holdModal(), []);
  useEffect(() => {
    const el = input.current;
    opener.current = el?.ownerDocument.activeElement ?? null;
    el?.focus({ preventScroll: true });
    el?.select();
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  const problem = nameProblem(request, name);
  const confirm = () => {
    setTried(true);
    confirmScenarioName(request, name);
  };
  const hint = w.nameHint[request.mode];
  return (
    <div className="sb-overlay" data-shell-overlay onPointerDown={(e) => e.target === e.currentTarget && closeScenarioName()}>
      <form
        className="sb-dialog modal scn-name"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-scenario-prompt={request.mode}
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeScenarioName();
          }
        }}
      >
        <Icon icon={Layers} className="sb-dialog-icon" size={32} strokeWidth={1.75} aria-hidden />
        <div className="sb-dialog-main">
          <h2 id={`${id}-title`} className="sb-dialog-title">
            {w.nameTitle[request.mode]}
          </h2>
          <label className="scn-name-row">
            <span>{w.nameLabel}</span>
            <input ref={input} className="qn-field" type="text" value={name} maxLength={80} aria-invalid={tried && problem !== null} aria-describedby={`${id}-note`} onChange={(e) => setName(e.target.value)} />
          </label>
          <div id={`${id}-note`} className="sb-dialog-body scn-name-note" role={tried && problem ? "alert" : undefined}>
            {tried && problem ? problem : hint}
          </div>
          <div className="sb-dialog-actions">
            <span className="spacer" />
            <button type="button" className="btn" onClick={closeScenarioName}>
              {w.cancel}
            </button>
            <button type="submit" className="btn primary">
              {request.mode === "rename" ? w.save : w.create}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ── Compare Scenarios ───────────────────────────────────────────────────────────────────────────

/** How long the network must rest before the table is read again (a drag asks nothing). */
export const COMPARE_DEBOUNCE_MS = 150;

/** Each variant with its best current run and its live answer; null until first read. */
export function useVariants(tabId: string): Variant[] | null {
  const doc = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId)?.document);
  const records = useResults(tabId);
  const [variants, setVariants] = useState<Variant[] | null>(null);
  const nodes = doc?.nodes;
  const links = doc?.links;
  const population = doc?.closedPopulation;
  const infinite = doc?.infiniteBuffers;
  const set = doc?.scenarios;
  useEffect(() => {
    if (!doc) return;
    let live = true;
    const timer = setTimeout(async () => {
      const rs = records.map(asResult);
      const out = await Promise.all(
        [null, ...scenariosOf(doc).map((s) => s.id)].map(async (id): Promise<Variant> => {
          const plain = scenarioDocument(doc, id);
          const [fp, answer] = await Promise.all([fingerprintNow(plain), api.liveResults(plain).then((r) => r as LiveResults, () => null)]);
          const s = id === null ? null : scenariosOf(doc).find((x) => x.id === id)!;
          return { id, name: s?.name ?? w.baseline, doc: plain, overrides: s ? s.overrides.length : null, run: fp === null ? null : bestRun(currentRuns(rs, fp)), live: answer };
        }),
      );
      if (live) setVariants(out);
    }, COMPARE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The document as far as the table goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, nodes, links, population, infinite, set, records]);
  return variants;
}

function TierChip({ cell }: { cell: Cell }) {
  if (cell.tier === null) return null;
  const style = TIER_STYLE[cell.tier as Tier];
  const hollow = style.shape === "ring" || style.shape === "cross";
  const label = tierLabel(cell);
  return (
    <span className="scn-tier" data-tier={cell.tier} data-source={cell.source ?? undefined} title={cell.source === "live" ? w.liveHelp : w.runHelp(cell.method ?? "", w.tiers[cell.tier])}>
      <svg width={10} height={10} viewBox="-6 -6 12 12" aria-hidden="true">
        <path d={shapePath(style.shape, 0, 0, 4.5)} fill={hollow ? "none" : v(style.color)} stroke={v(style.color)} strokeWidth={hollow ? 1.8 : 0} />
      </svg>
      {label}
    </span>
  );
}

function ValueCell({ row, cell, first, decimals }: { row: Row; cell: Cell; first: boolean; decimals: number }) {
  if (cell.value === null)
    return (
      <td className="scn-cell is-empty" title={w.noValueHelp}>
        <span aria-label={w.noValueHelp}>{w.noValue}</span>
      </td>
    );
  const diff = first ? null : diffText(cell, row.unit, decimals);
  return (
    <td className="scn-cell" data-cell-tier={cell.tier ?? undefined}>
      <span className="scn-value">
        {valueText(cell.value, row.unit, decimals)}
        <span className="scn-unit"> {unitLabel(row.unit)}</span>
      </span>
      <TierChip cell={cell} />
      {diff !== null ? (
        <span className="scn-diff" title={w.diffHelp}>
          {diff}
        </span>
      ) : null}
    </td>
  );
}

function ComparePanel({ tabId }: { tabId: string }) {
  const tab = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId) ?? null);
  const decimals = Math.min(4, Number(useSetting<number>("output.decimals", 6)));
  const variants = useVariants(tabId);
  const solving = useSolveAll();
  useSequence();
  const [kind, setKind] = useState<MeasureKind>("networkDelay");
  const chartRoot = useRef<HTMLDivElement>(null);
  const uid = useId();
  const table = useMemo(() => (variants ? compareTable(variants) : null), [variants]);
  const chart = useMemo(() => (table ? compareChart(table, kind, decimals) : null), [table, kind, decimals]);
  useEffect(() => {
    if (!tab) closeCompare();
  }, [tab]);
  if (!tab) return null;
  const shown = activeId(tab.document);
  const none = scenariosOf(tab.document).length === 0;
  const groups = table ? [...new Set(table.rows.map((r) => r.group))] : [];

  return (
    <PanelWindow id="compare-scenarios" title={w.compareTitle} band="table" modality="modeless" onClose={closeCompare}>
      <div className="panel-form scn-compare" data-panel="compare-scenarios">
        <header className="scn-compare-head">
          <div>
            <h2>{w.compareTitle}</h2>
            <p className="muted">{w.compareIntro}</p>
          </div>
          <div className="scn-compare-actions">
            {solving ? (
              <>
                <span className="scn-progress" role="status" data-solve-all-progress>
                  {w.solving(solving.index, solving.total, solving.name)}
                </span>
                <button type="button" className="btn" disabled={solving.stopping} onClick={() => void stopSolveAll()}>
                  <Icon icon={Square} size={12} /> {w.stop}
                </button>
              </>
            ) : (
              <button type="button" className="btn primary" title={w.solveAllHelp} onClick={() => void solveAllScenarios(tabId)}>
                <Icon icon={Play} size={12} /> {w.solveAll}
              </button>
            )}
            <button type="button" className="icon-btn" aria-label={w.exportData} title={w.exportDataHelp} disabled={!table} onClick={() => table && void exportCompareCsv(tabId, compareCsv(table))}>
              <Icon icon={Download} size={16} />
            </button>
            <button type="button" className="icon-btn" aria-label={w.exportChart} title={w.exportChartHelp} disabled={!chart} onClick={() => void exportChart(tabId, chartRoot.current)}>
              <Icon icon={ImageDown} size={16} />
            </button>
          </div>
        </header>
        <div className="panel-content scn-compare-body">
          {none ? (
            <div className="scn-compare-hint" role="note">
              <strong>{w.compareEmpty}</strong> {w.compareEmptyHint}{" "}
              <button type="button" className="btn btn-small" onClick={() => askScenarioName("new", tabId)}>
                {w.newFromCurrent}
              </button>
            </div>
          ) : null}
          {!table ? (
            <p className="muted" role="status">
              {w.loading}
            </p>
          ) : (
            <>
              {table.mixedRows ? (
                <p className="scn-mixed-summary" role="status" data-mixed-rows={table.mixedRows}>
                  <Icon icon={AlertTriangle} size={14} /> {w.mixedSummary(table.mixedRows)}
                </p>
              ) : null}
              <div className="scn-table-wrap">
                <table className="scn-table" aria-label={w.tableLabel}>
                  <thead>
                    <tr>
                      <th scope="col">{w.measure}</th>
                      {table.variants.map((x) => {
                        const source = x.run ? w.sourceRun(x.run.method.shortName) : x.live?.tier === "exact" ? w.sourceLive : w.sourceNone;
                        const isShown = x.id === shown;
                        return (
                          <th key={x.id ?? "baseline"} scope="col" className={isShown ? "is-shown" : undefined} title={w.columnHelp(x.name, x.overrides, source)}>
                            <button type="button" className="scn-col-btn" title={x.id === null ? w.showBaselineHelp : w.showHelp(x.name)} aria-pressed={isShown} disabled={solving !== null} onClick={() => void showScenario(tabId, x.id)}>
                              {x.name}
                            </button>
                            <span className="scn-col-source">{isShown ? `${w.shownMark} · ${source}` : source}</span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  {groups.map((g) => (
                    <tbody key={g}>
                      <tr className="scn-group">
                        <th scope="rowgroup" colSpan={table.variants.length + 1}>
                          {g}
                        </th>
                      </tr>
                      {table.rows
                        .filter((r) => r.group === g)
                        .map((r) => {
                          const warning = r.mixed ? w.mixedRow(r.mixed.map((t) => w.tiers[t])) : null;
                          return (
                            <tr key={r.key} data-row={r.key} data-mixed={r.mixed ? "true" : undefined}>
                              <th scope="row" title={rowLabel(r)}>
                                {r.label}
                                {warning ? (
                                  <span className="scn-mixed" role="img" aria-label={`${w.mixedMark}. ${warning}`} title={warning}>
                                    <Icon icon={AlertTriangle} size={12} />
                                  </span>
                                ) : null}
                              </th>
                              {r.cells.map((c, i) => (
                                <ValueCell key={i} row={r} cell={c} first={i === 0} decimals={decimals} />
                              ))}
                            </tr>
                          );
                        })}
                    </tbody>
                  ))}
                </table>
              </div>
              <div className="scn-chart" ref={chartRoot}>
                <label className="scn-chart-pick" htmlFor={`${uid}-measure`}>
                  {w.chartMeasure}
                  <select id={`${uid}-measure`} className="qn-field" value={kind} onChange={(e) => setKind(e.target.value as MeasureKind)}>
                    {CHART_MEASURES.map((k) => (
                      <option key={k} value={k}>
                        {w.measures[k]}
                      </option>
                    ))}
                  </select>
                </label>
                {chart ? (
                  <ChartFrame className="results-chart-card">{({ width, fontScale }) => <BarChart {...chart} width={width} fontScale={fontScale} />}</ChartFrame>
                ) : (
                  <p className="muted" role="status">
                    {w.chartNothing}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </PanelWindow>
  );
}

// ── The host ────────────────────────────────────────────────────────────────────────────────────

/** Draws the prompt and the panel when one is asked for. */
export function ScenarioHost({ fallback = false }: { fallback?: boolean }) {
  useEffect(() => {
    if (fallback) return;
    scenarioHosts.mounted++;
    return () => {
      scenarioHosts.mounted--;
    };
  }, [fallback]);
  const name = useScenarioNameRequest();
  const compare = useCompareTab();
  if (fallback && scenarioHosts.mounted > 0) return null;
  return (
    <>
      {name ? <NamePrompt key={`${name.tabId}-${name.mode}`} request={name} /> : null}
      {compare ? <ComparePanel key={compare} tabId={compare} /> : null}
    </>
  );
}

scenarioHosts.fallback = () => {
  scenarioHosts.fallback = null;
  if (typeof document === "undefined") return;
  const el = document.createElement("div");
  document.body.appendChild(el);
  createRoot(el).render(<ScenarioHost fallback />);
};
