// The Results workspace (0.90.34 ResultsWorkspace.swift `ResultsWorkspaceView`, dc066f0; ledger
// §11.5, §11.6, MENU-048, MENU-152, WS-072): the active tab's run records under a header with the
// count badge, Compare, Export and Delete Result; the filter bar with the layer and sort pickers;
// and, side by side in the pane's own split, the run history and the selected run's detail (summary,
// Quality Evidence, the measurement grid, the failure card, warnings, the solver transcript) or the
// comparison of the runs chosen in Compare. Docked or detached, it reaches its document only
// through its own elements.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, ChevronRight, CircleCheck, CircleEllipsis, CircleSlash, ClipboardList, Hash, Info, OctagonX, Search, Share, Trash2, TriangleAlert, X } from "lucide-react";
import { Icon } from "../../components/Icon";
import { activeEditor } from "../../editor";
import { displayFixed } from "../../editor/numbers";
import { api } from "../../lib/api";
import { destructive } from "../../lib/dialogs";
import { setStateValues, useSetting, useStateValue } from "../../lib/kv";
import { setSelectedRun } from "../../results/selectedRun";
import { reloadResults, useResults } from "../../runs/state";
import { useFocusTarget } from "../../workspace/focus";
import { PaneHeader } from "../../workspace/panes/PaneHeader";
import { useActiveTab } from "../../workspace/store";
import { writeClipboard } from "../status/state";
import { copyCsv, saveExport, type ExportFormat } from "./exports";
import { fingerprintNow, useCurrentFingerprint } from "./fingerprint";
import {
  abbreviatedShort,
  abbreviatedStandard,
  asResult,
  classLabel,
  comparisonRows,
  elapsedText,
  evidenceItems,
  evidenceLabel,
  failureGuidance,
  filterRuns,
  isStale,
  LAYER_FILTERS,
  layerSeverity,
  layerShortName,
  measurementHelp,
  parameterLine,
  previousComparableRun,
  RUN_SORTS,
  shortTime,
  sortMeasurements,
  statusSeverity,
  type LayerFilter,
  type MeasurementSort,
  type ResultRecord,
  type RunSort,
} from "./model";
import { ResultsMenu, type ResultsMenuItem } from "./ResultsMenu";
import { startAutoReveal } from "./reveal";
import { AgreementView } from "./agreement/AgreementView";
import { ChartsView } from "./charts/ChartsView";
import { chartableRun } from "./charts/data";
import { copyChart, exportChart } from "./charts/exportChart";
import { startAgreementCommands } from "./agreement/commands";
import { onResultsViewRequest, takeRequestedView, type ResultsView } from "./agreement/view";
import { resultsWords as w } from "./words";
import { onSweepViewRequest, startSweepCommands, SweepView, sweepWords, takeSweepViewRequest } from "../../sweeps";
import { onTransientViewRequest, startTransientCommands, takeTransientViewRequest, TransientView, transientWords } from "../../transient";
import { CapacityView, capacityWords, onCapacityViewRequest, startCapacityCommands, takeCapacityViewRequest } from "../../optimise";
import { onSensitivityViewRequest, SensitivityView, sensitivityWords, startSensitivityCommands, takeSensitivityViewRequest } from "../../sensitivity";
import { onUncertaintyViewRequest, startUncertaintyCommands, takeUncertaintyViewRequest, UncertaintyView, uncertaintyWords } from "../../uncertainty";
import "./results.css";

startAutoReveal();
startAgreementCommands();
startSweepCommands();
startSensitivityCommands();
startCapacityCommands();
startUncertaintyCommands();
startTransientCommands();

/** WS-072: the run history's minimum and ideal width, the detail's minimum (DS.Layout). */
export const HISTORY_MIN = 224;
export const HISTORY_IDEAL = 320;
export const DETAIL_MIN = 496;

const OUTPUT_DECIMALS_KEY = "output.decimals";
/** state.json: the view the pane was last switched to ("table", "agreement" or "charts"). */
export const RESULTS_VIEW_KEY = "results.view";

type Severity = "info" | "success" | "warning" | "error";
const SEVERITY_ICON: Record<Severity, LucideIcon> = { info: Info, success: CircleCheck, warning: TriangleAlert, error: OctagonX };

function StatusChip({ label, severity, help }: { label: string; severity: Severity; help?: string }) {
  return (
    <span className="results-chip" data-severity={severity} title={help}>
      <Icon icon={SEVERITY_ICON[severity]} size={12} aria-hidden />
      {label}
    </span>
  );
}

function EmptyState({ icon, title, message }: { icon: LucideIcon; title: string; message: string }) {
  return (
    <div className="empty-state results-empty">
      <Icon icon={icon} size={20} aria-hidden />
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  );
}

/** `ResultsRunRow`'s status mark: a warning when stale, else the status's. */
function runMark(run: ResultRecord, stale: boolean): { icon: LucideIcon; tone: string; label: string } {
  if (stale) return { icon: TriangleAlert, tone: "warning", label: w.staleLabel };
  const label = w.status[run.status] ?? run.status;
  switch (run.status) {
    case "running": return { icon: CircleEllipsis, tone: "accent", label };
    case "completed": return { icon: CircleCheck, tone: "success", label };
    case "partial": return { icon: TriangleAlert, tone: "warning", label };
    case "failed": return { icon: OctagonX, tone: "error", label };
    default: return { icon: CircleSlash, tone: "muted", label };
  }
}

function HeaderButton({ icon, label, help, onClick, disabled, danger, buttonRef, badge }: { icon: LucideIcon; label: string; help: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; danger?: boolean; buttonRef?: React.Ref<HTMLButtonElement>; badge?: number }) {
  return (
    <button ref={buttonRef} type="button" className="icon-btn results-header-btn" data-danger={danger || undefined} aria-label={label} title={help} disabled={disabled} onClick={onClick}>
      <Icon icon={icon} size={14} aria-hidden />
      {badge ? (
        <span className="results-menu-badge" aria-hidden>
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function ResultsPane() {
  const tab = useActiveTab();
  const tabId = tab.id;
  const records = useResults(tabId);
  const tabRecords = useMemo(() => records.map(asResult), [records]);
  const decimals = Number(useSetting<number>(OUTPUT_DECIMALS_KEY, 6));
  const fingerprint = useCurrentFingerprint(tab.document, records);

  // Kept across tab switches, as 0.90.34's were; none is saved.
  const [search, setSearch] = useState("");
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [runSort, setRunSort] = useState<RunSort>("newest");
  const [measurementSort, setMeasurementSort] = useState<MeasurementSort>("station");
  const [ascending, setAscending] = useState(true);
  // Cleared by a tab switch (RES-060).
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Set<string>>(new Set());
  const [showingComparison, setShowingComparison] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [menu, setMenu] = useState<{ kind: "compare" | "export"; anchor: HTMLElement } | null>(null);
  const [historyWidth, setHistoryWidth] = useState(HISTORY_IDEAL);
  // Which view the pane shows (2.1): the run table, or how far the methods agree. Run ▸ Solve asks for Agreement.
  // Charts (2.1) is a third view; the choice among the three is remembered (state.json, `results.view`), and
  // Charts is offered only once the tab has a completed run to draw, the table standing in until then.
  const [askedView, setView] = useState<ResultsView | "charts" | "sweep" | "sensitivity" | "capacity" | "uncertainty" | "transient" | null>(() => (takeCapacityViewRequest() ? "capacity" : takeUncertaintyViewRequest() ? "uncertainty" : takeTransientViewRequest() ? "transient" : takeSensitivityViewRequest() ? "sensitivity" : takeSweepViewRequest() ? "sweep" : takeRequestedView()));
  const rememberedView = useStateValue<string>(RESULTS_VIEW_KEY, "table");
  const chartsOffered = useMemo(() => tabRecords.some(chartableRun), [tabRecords]);
  const viewChoice = askedView ?? (rememberedView === "charts" || rememberedView === "agreement" || rememberedView === "sweep" || rememberedView === "sensitivity" || rememberedView === "capacity" || rememberedView === "uncertainty" || rememberedView === "transient" ? rememberedView : "table");
  const view = viewChoice === "charts" && !chartsOffered ? "table" : viewChoice;
  const chooseView = (v: ResultsView | "charts" | "sweep" | "sensitivity" | "capacity" | "uncertainty" | "transient") => {
    setView(v);
    void setStateValues({ [RESULTS_VIEW_KEY]: v }).catch(() => {});
  };
  useEffect(() => onResultsViewRequest(setView), []);
  // The switcher scrolls sideways in a narrow pane: keep the chosen view's button in sight.
  useEffect(() => {
    const on = rootRef.current?.querySelector<HTMLElement>('.results-views [aria-checked="true"]');
    on?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [askedView]);
  useEffect(() => onSweepViewRequest(() => setView("sweep")), []);
  useEffect(() => onSensitivityViewRequest(() => setView("sensitivity")), []);
  useEffect(() => onCapacityViewRequest(() => setView("capacity")), []);
  useEffect(() => onUncertaintyViewRequest(() => setView("uncertainty")), []);
  useEffect(() => onTransientViewRequest(() => setView("transient")), []);

  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const win = () => rootRef.current?.ownerDocument.defaultView ?? undefined;

  const lastTab = useRef(tabId);
  if (lastTab.current !== tabId) {
    lastTab.current = tabId;
    setSelectedRunId(null);
    setSelectedMeasurementId(null);
    setComparison(new Set());
    setShowingComparison(false);
    setShowRaw(false);
  }

  const visible = useMemo(() => filterRuns(tabRecords, search, layer, runSort), [tabRecords, search, layer, runSort]);
  const selected = visible.find((r) => r.id === (selectedRunId ?? visible[0]?.id)) ?? null;

  // The first visible run is selected when the selection is empty or filtered out (RES-060).
  const visibleKey = visible.map((r) => r.id).join(",");
  useEffect(() => {
    if (selectedRunId === null || !visible.some((r) => r.id === selectedRunId)) {
      setSelectedRunId(visible[0]?.id ?? null);
      setSelectedMeasurementId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, selectedRunId]);

  const selectRun = (id: string) => {
    // An explicit pick is what the canvas overlay shows (src/results/selectedRun.ts).
    setSelectedRun(tabId, id);
    if (id === selectedRunId) return;
    setSelectedRunId(id);
    setSelectedMeasurementId(null);
    setShowRaw(false);
  };

  const comparisonRuns = useMemo(
    () => tabRecords.filter((r) => comparison.has(r.id)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
    [tabRecords, comparison],
  );

  const focusFilter = useCallback(() => {
    filterRef.current?.focus();
    filterRef.current?.select();
  }, []);
  useFocusTarget("results", { findTitle: w.findTitle, find: focusFilter, focus: focusFilter }, [focusFilter]);

  /** RES-069: a measurement's station is selected on the canvas when it still exists. */
  const selectMeasurement = (id: string, stationId: string | undefined) => {
    setSelectedMeasurementId(id);
    if (id === selectedMeasurementId || !stationId) return;
    const editor = activeEditor();
    const node = editor.nodes.find((n) => String(n.id).toUpperCase() === stationId.toUpperCase());
    if (!node) return;
    editor.setView({ selectedLinkID: null, selectedNodeIDs: new Set(), selectedNodeID: node.id });
  };

  const deleteSelected = async () => {
    const run = selected;
    if (!run) return;
    const ok = await destructive({ title: w.deleteTitle, message: w.deleteMessage, confirmTitle: w.deleteConfirm, target: rootRef.current?.ownerDocument });
    if (!ok) return;
    await api.resultsDelete(run.id);
    await reloadResults(tabId);
    setSelectedRunId(null);
    setSelectedMeasurementId(null);
  };

  const exportIds = async (ids: string[], format: ExportFormat) => saveExport(ids, format, await fingerprintNow(tab.document), rootRef.current?.ownerDocument);

  const compareItems = (): ResultsMenuItem[] => [
    ...(visible.length
      ? visible.map(
          (run): ResultsMenuItem => ({
            kind: "toggle",
            label: `${run.method.shortName} · ${shortTime(run.startedAt)}`,
            checked: comparison.has(run.id),
            disabled: run.status === "running",
            run: () => {
              const next = new Set(comparison);
              if (next.has(run.id)) next.delete(run.id);
              else next.add(run.id);
              setComparison(next);
              if (next.size < 2) setShowingComparison(false);
            },
          }),
        )
      : [{ kind: "text", label: w.noVisibleRuns } as ResultsMenuItem]),
    "-",
    { kind: "toggle", label: w.showComparison, checked: showingComparison, disabled: comparison.size < 2, run: () => setShowingComparison(!showingComparison) },
    {
      label: w.clearComparison,
      disabled: comparison.size === 0,
      run: () => {
        setComparison(new Set());
        setShowingComparison(false);
      },
    },
  ];

  const exportItems = (): ResultsMenuItem[] => [
    { label: w.copyCsv, disabled: !selected, run: () => selected && void fingerprintNow(tab.document).then((fp) => copyCsv([selected.id], fp, win())) },
    { label: w.saveCsv, disabled: !selected, run: () => selected && void exportIds([selected.id], "csv") },
    { label: w.saveJson, disabled: !selected, run: () => selected && void exportIds([selected.id], "json") },
    "-",
    { label: w.saveVisibleCsv, disabled: !visible.length, run: () => void exportIds(visible.map((r) => r.id), "csv") },
    { label: w.saveVisibleJson, disabled: !visible.length, run: () => void exportIds(visible.map((r) => r.id), "json") },
    // The Charts view adds its own two (2.1).
    ...(view === "charts"
      ? ([
          "-",
          { label: w.charts.exportChart, disabled: !rootRef.current?.querySelector("svg[data-chart]"), run: () => void exportChart(tabId, rootRef.current) },
          { label: w.charts.copyChart, disabled: !rootRef.current?.querySelector("svg[data-chart]"), run: () => void copyChart(tabId, rootRef.current) },
        ] as ResultsMenuItem[])
      : []),
  ];

  // The inner split (WS-072): history ≥ 224, detail ≥ 496; not saved.
  const clampHistory = (x: number) => {
    const total = splitRef.current?.clientWidth ?? 0;
    const max = total > 0 ? Math.max(HISTORY_MIN, total - DETAIL_MIN - 1) : Infinity;
    return Math.round(Math.max(HISTORY_MIN, Math.min(max, x)));
  };
  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const start = e.clientX;
    const from = historyWidth;
    const move = (ev: PointerEvent) => setHistoryWidth(clampHistory(from + ev.clientX - start));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const history = visible.length ? (
    <div
      className="results-history-list"
      role="listbox"
      aria-label={w.historyLabel}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const i = visible.findIndex((r) => r.id === selected?.id);
        const j = Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        selectRun(visible[j].id);
      }}
    >
      {visible.map((run) => {
        const stale = isStale(run, fingerprint);
        const mark = runMark(run, stale);
        return (
          <div
            key={run.id}
            role="option"
            aria-selected={run.id === selected?.id}
            className="results-run"
            data-run={run.id}
            title={w.rowHelp(run.method.displayName, run.method.fidelity, stale)}
            onClick={() => selectRun(run.id)}
          >
            <div className="results-run-top">
              <span className="results-run-name">{run.method.shortName}</span>
              <span className="results-run-mark" data-tone={mark.tone} role="img" aria-label={mark.label}>
                <Icon icon={mark.icon} size={12} aria-hidden />
              </span>
            </div>
            <div className="results-run-meta">
              {layerShortName(run.method.layer)} · {abbreviatedShort(run.startedAt)}
            </div>
            <div className="results-run-count">{w.measurementCount(run.measurements.length)}</div>
          </div>
        );
      })}
    </div>
  ) : tabRecords.length ? (
    <EmptyState icon={Search} title={w.noMatchTitle} message={w.noMatchMessage} />
  ) : (
    <EmptyState icon={Hash} title={w.noResultsTitle} message={w.noResultsMessage} />
  );

  let detail: ReactNode;
  if (showingComparison && comparisonRuns.length >= 2) {
    detail = <ComparisonView runs={comparisonRuns} decimals={decimals} />;
  } else if (selected) {
    const stale = isStale(selected, fingerprint);
    const previous = previousComparableRun(tabRecords, selected);
    detail = (
      <div className="results-detail-run">
        <RunSummary run={selected} stale={stale} />
        <EvidencePanel run={selected} previous={previous} decimals={decimals} />
        <MeasurementTable
          run={selected}
          search={search}
          sort={measurementSort}
          ascending={ascending}
          decimals={decimals}
          selectedId={selectedMeasurementId}
          onSort={(by) => {
            if (by === measurementSort) setAscending(!ascending);
            else {
              setMeasurementSort(by);
              setAscending(true);
            }
          }}
          onSelect={selectMeasurement}
        />
        {selected.failureMessage != null ? <FailureCard message={selected.failureMessage} rawOutput={selected.rawOutput} partial={selected.status === "partial"} /> : null}
        {selected.warnings.length ? (
          <div className="results-warnings">
            <div className="results-label-strong">{w.warningsTitle}</div>
            <ul>
              {selected.warnings.map((x, i) => (
                <li key={i}>
                  <Icon icon={TriangleAlert} size={12} aria-hidden />
                  <span>{x}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {selected.rawOutput ? <Transcript text={selected.rawOutput} open={showRaw} onToggle={() => setShowRaw(!showRaw)} win={win} /> : null}
      </div>
    );
  } else {
    detail = <EmptyState icon={Hash} title={w.noRunTitle} message={w.noRunMessage} />;
  }

  return (
    <div ref={rootRef} className="pane results-pane" data-pane="results" role="region" tabIndex={-1} aria-label={w.title}>
      <PaneHeader
        pane="results"
        title={w.title}
        accessory={
          <span className="results-count" title={w.badgeHelp(tabRecords.length)}>
            {tabRecords.length}
          </span>
        }
      >
        <div className="results-views" role="radiogroup" aria-label={w.viewLabel}>
          {(["table", "agreement", "charts", "sweep", "sensitivity", "capacity", "uncertainty", "transient"] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} title={v === "capacity" ? capacityWords.viewHelp : v === "uncertainty" ? uncertaintyWords.viewHelp : v === "transient" ? transientWords.viewHelp : v === "sensitivity" ? sensitivityWords.viewHelp : v === "sweep" ? sweepWords.viewHelp : v === "charts" && !chartsOffered ? w.chartsNotYet : w.viewHelp[v]} disabled={v === "charts" && !chartsOffered} onClick={() => chooseView(v)}>
              {v === "capacity" ? capacityWords.view : v === "uncertainty" ? uncertaintyWords.view : v === "transient" ? transientWords.view : v === "sensitivity" ? sensitivityWords.view : v === "sweep" ? sweepWords.view : w.views[v]}
            </button>
          ))}
        </div>
        <HeaderButton
          icon={ClipboardList}
          label={w.compareLabel}
          help={w.compareHelp}
          badge={comparison.size || undefined}
          onClick={(e) => setMenu(menu?.kind === "compare" ? null : { kind: "compare", anchor: e.currentTarget })}
        />
        <HeaderButton
          icon={Share}
          label={w.exportLabel}
          help={w.exportHelp}
          disabled={!tabRecords.length}
          onClick={(e) => setMenu(menu?.kind === "export" ? null : { kind: "export", anchor: e.currentTarget })}
        />
        <HeaderButton icon={Trash2} label={w.deleteLabel} help={w.deleteHelp} danger disabled={!selected} onClick={() => void deleteSelected()} />
      </PaneHeader>

      {view === "agreement" ? <AgreementView tab={tab} records={tabRecords} fingerprint={fingerprint} decimals={decimals} /> : null}
      {view === "charts" ? <ChartsView tabId={tabId} records={tabRecords} fingerprint={fingerprint} decimals={decimals} selectedRunId={selected?.id} /> : null}
      {view === "sweep" ? <SweepView tabId={tabId} decimals={decimals} /> : null}
      {view === "sensitivity" ? <SensitivityView tabId={tabId} decimals={decimals} /> : null}
      {view === "capacity" ? <CapacityView tabId={tabId} decimals={decimals} /> : null}
      {view === "uncertainty" ? <UncertaintyView tabId={tabId} decimals={decimals} /> : null}
      {view === "transient" ? <TransientView tabId={tabId} decimals={decimals} /> : null}
      <div className="results-filter-bar" hidden={view !== "table"}>
        <label className="results-filter">
          <Icon icon={Search} size={12} aria-hidden />
          <input
            ref={filterRef}
            type="text"
            value={search}
            placeholder={w.filterPlaceholder}
            aria-label={w.filterLabel}
            spellCheck={false}
            autoCorrect="off"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <button type="button" className="results-filter-clear" aria-label={w.clearFilter} title={w.clearFilterHelp} onClick={() => setSearch("")}>
              <Icon icon={X} size={12} aria-hidden />
            </button>
          ) : null}
        </label>
        <select className="results-picker" aria-label={w.layerLabel} value={layer} onChange={(e) => setLayer(e.target.value as LayerFilter)}>
          {LAYER_FILTERS.map((l) => (
            <option key={l} value={l}>
              {w.layers[l]}
            </option>
          ))}
        </select>
        <select className="results-picker results-picker-sort" aria-label={w.sortLabel} value={runSort} onChange={(e) => setRunSort(e.target.value as RunSort)}>
          {RUN_SORTS.map((s) => (
            <option key={s} value={s}>
              {w.sorts[s]}
            </option>
          ))}
        </select>
      </div>

      <div ref={splitRef} className="results-split" hidden={view !== "table"}>
        <div className="results-history" style={{ flexBasis: historyWidth, minWidth: HISTORY_MIN }}>
          {history}
        </div>
        <div
          className="results-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={w.splitLabel}
          aria-valuemin={HISTORY_MIN}
          aria-valuenow={historyWidth}
          tabIndex={0}
          onPointerDown={onDividerDown}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            setHistoryWidth(clampHistory(historyWidth + (e.key === "ArrowRight" ? 10 : -10)));
          }}
        />
        <div className="results-detail" style={{ minWidth: DETAIL_MIN }}>
          {detail}
        </div>
      </div>

      {menu ? (
        <ResultsMenu
          anchor={menu.anchor}
          label={menu.kind === "compare" ? w.compareLabel : w.exportLabel}
          items={menu.kind === "compare" ? compareItems() : exportItems()}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

// ── The detail ────────────────────────────────────────────────────────────────────────────────

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="results-summary-item">
      <div className="results-caps">{label}</div>
      <div className="results-summary-value">{value}</div>
    </div>
  );
}

/** `ResultsRunSummary` (RES-061, RES-062). */
function RunSummary({ run, stale }: { run: ResultRecord; stale: boolean }) {
  const params = parameterLine(run.provenance.parameters);
  return (
    <div className="results-summary">
      <div className="results-summary-head">
        <div className="results-summary-title">
          <h3>{run.method.displayName}</h3>
          <div className="results-muted">{run.method.fidelity}</div>
        </div>
        <span className="spacer" />
        <StatusChip label={w.status[run.status] ?? run.status} severity={statusSeverity(run.status)} />
        {stale ? <StatusChip label={w.networkChanged} severity="warning" help={w.networkChangedHelp} /> : null}
      </div>
      <div className="results-summary-row">
        <SummaryItem label={w.summary.network} value={run.provenance.networkTitle} />
        <SummaryItem label={w.summary.capacity} value={run.provenance.bufferRegime} />
        <SummaryItem label={w.summary.started} value={abbreviatedStandard(run.startedAt)} />
        {typeof run.elapsedSeconds === "number" ? <SummaryItem label={w.summary.elapsed} value={elapsedText(run.elapsedSeconds)} /> : null}
        <SummaryItem label={w.summary.fingerprint} value={run.provenance.networkFingerprint.slice(0, 12)} />
      </div>
      {params ? (
        <div className="results-params" title={w.parametersHelp}>
          {params}
        </div>
      ) : null}
    </div>
  );
}

/** `ResultsEvidenceDashboard` (RES-063, RES-064). */
function EvidencePanel({ run, previous, decimals }: { run: ResultRecord; previous: ResultRecord | null; decimals: number }) {
  const items = evidenceItems(run, previous, decimals);
  if (!items) return null;
  return (
    <section className="results-evidence" aria-label={w.evidenceTitle}>
      <div className="results-label-strong">{w.evidenceTitle}</div>
      <div className="results-evidence-row">
        {items.map((it) => (
          <div key={it.label} className="results-evidence-item" title={it.help}>
            <div className="results-caps">{it.label}</div>
            <div className="results-mono">{it.value}</div>
          </div>
        ))}
      </div>
      <div className="results-muted">{w.evidenceFootnote}</div>
    </section>
  );
}

const COLUMNS: { by: MeasurementSort; title: string; numeric?: boolean }[] = [
  { by: "station", title: w.columns.station },
  { by: "customerClass", title: w.columns.customerClass },
  { by: "metric", title: w.columns.metric },
  { by: "estimate", title: w.columns.estimate, numeric: true },
  { by: "uncertainty", title: w.columns.uncertainty },
  { by: "unit", title: w.columns.unit },
];

/** The measurement grid (RES-065…070). */
function MeasurementTable(props: {
  run: ResultRecord;
  search: string;
  sort: MeasurementSort;
  ascending: boolean;
  decimals: number;
  selectedId: string | null;
  onSort: (by: MeasurementSort) => void;
  onSelect: (id: string, stationId: string | undefined) => void;
}) {
  const { run, search, sort, ascending, decimals, selectedId, onSort, onSelect } = props;
  if (!run.measurements.length) {
    return (
      <div className="results-measurements results-measurements-empty">
        {run.status === "running" ? (
          <>
            <span className="results-spinner" role="progressbar" aria-label={w.waiting} />
            <p>{w.waiting}</p>
          </>
        ) : (
          <p>{w.noMeasurements}</p>
        )}
      </div>
    );
  }
  const rows = sortMeasurements(run, search, sort, ascending);
  return (
    <div className="results-measurements">
      <table className="results-table" aria-label={w.measurementsLabel(run.method.displayName)}>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.by} data-numeric={c.numeric || undefined} aria-sort={sort === c.by ? (ascending ? "ascending" : "descending") : undefined}>
                <button type="button" aria-label={w.sortBy(c.title)} onClick={() => onSort(c.by)}>
                  {c.title}
                  {sort === c.by ? <span aria-hidden> {ascending ? "↑" : "↓"}</span> : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} data-measurement={m.id} aria-selected={m.id === selectedId} title={measurementHelp(m, decimals)} onClick={() => onSelect(m.id, m.stationID)}>
              <td>{m.stationName}</td>
              <td>{classLabel(m.customerClass)}</td>
              <td>{m.metric}</td>
              <td data-numeric>{displayFixed(m.estimate, decimals)}</td>
              <td className="results-mono">{evidenceLabel(m, decimals)}</td>
              <td>{m.unit || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `ResultsFailureCard` (RES-071). */
function FailureCard({ message, rawOutput, partial }: { message: string; rawOutput?: string; partial: boolean }) {
  const g = failureGuidance(message, rawOutput, partial);
  return (
    <section className="results-failure" data-partial={partial || undefined} aria-label={partial ? w.partialResult : w.runFailed}>
      <div className="results-failure-title">
        <Icon icon={partial ? TriangleAlert : OctagonX} size={14} aria-hidden />
        {partial ? w.partialResult : w.runFailed}
      </div>
      <p className="results-failure-diagnosis">{g.diagnosis}</p>
      <p className="results-muted">{w.nextStep(g.action)}</p>
    </section>
  );
}

/** The Solver Transcript disclosure (RES-073). */
function Transcript({ text, open, onToggle, win }: { text: string; open: boolean; onToggle: () => void; win: () => Window | undefined }) {
  return (
    <section className="results-transcript">
      <button type="button" className="results-disclosure" aria-expanded={open} onClick={onToggle}>
        <Icon icon={open ? ChevronDown : ChevronRight} size={12} aria-hidden />
        <span className="results-label-strong">{w.transcript}</span>
      </button>
      {open ? (
        <div className="results-transcript-body">
          <div className="results-transcript-caption">
            <span className="results-muted">{w.transcriptCaption}</span>
            <button type="button" className="results-link" onClick={() => void writeClipboard(text, win())}>
              {w.copyTranscript}
            </button>
          </div>
          <pre className="results-transcript-text" tabIndex={0}>
            {text}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

/** `ResultsComparisonView` (RES-077…080). */
function ComparisonView({ runs, decimals }: { runs: ResultRecord[]; decimals: number }) {
  const rows = comparisonRows(runs);
  const layers = new Set(runs.map((r) => r.method.layer));
  const fingerprints = new Set(runs.map((r) => r.provenance.networkFingerprint));
  const n = (v: number | null) => (v === null ? "—" : displayFixed(v, decimals));
  return (
    <div className="results-comparison">
      <div className="results-comparison-head">
        <div className="results-summary-head">
          <h3>{w.comparisonTitle}</h3>
          <span className="spacer" />
          <span className="results-count">{w.runsBadge(runs.length)}</span>
        </div>
        <div className="results-chips">
          {runs.map((r) => (
            <StatusChip key={r.id} label={r.method.shortName} severity={layerSeverity(r.method.layer)} help={`${r.method.fidelity} · ${abbreviatedShort(r.startedAt)}`} />
          ))}
        </div>
        {layers.size > 1 ? (
          <p className="results-note" data-tone="info">
            <Icon icon={Info} size={12} aria-hidden />
            {w.crossesLayers}
          </p>
        ) : null}
        {fingerprints.size > 1 ? (
          <p className="results-note" data-tone="warning">
            <Icon icon={TriangleAlert} size={12} aria-hidden />
            {w.differentSnapshots}
          </p>
        ) : null}
      </div>
      {rows.length ? (
        <div className="results-measurements">
          <table className="results-table" aria-label={w.comparisonLabel(runs.length)}>
            <thead>
              <tr>
                <th>{w.columns.station}</th>
                <th>{w.columns.customerClass}</th>
                <th>{w.columns.metric}</th>
                {runs.map((r) => (
                  <th key={r.id} data-numeric>
                    {r.method.shortName}
                  </th>
                ))}
                <th data-numeric>{w.range}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.stationName}</td>
                  <td>{row.classLabel}</td>
                  <td>{row.metric}</td>
                  {row.values.map((v, i) => (
                    <td key={runs[i].id} data-numeric>
                      {n(v)}
                    </td>
                  ))}
                  <td data-numeric>{n(row.range)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={Hash} title={w.noComparableTitle} message={w.noComparableMessage} />
      )}
    </div>
  );
}
