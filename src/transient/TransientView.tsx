// The Results pane's Transient view (new in 2.1, ROADMAP D4): for the tab's network, the mean
// number at each station over time from a chosen start — exact (the network's Markov chain, by
// uniformisation) and by the fluid model, each labelled — with each station's long-run average,
// the time it takes to settle, an optional surge of arrivals, a table of the same numbers and a
// one-sentence reading. Everything is computed in Rust (`transient_prepare`,
// `transient_analyze`); the exact tier runs off the main thread with progress and Stop.
//
// The view reaches its document only through its own elements, so it draws the same docked or in
// a detached window.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Activity, Share, TriangleAlert } from "lucide-react";
import { ChartFrame, seriesToken, SERIES_COUNT, v } from "../charts";
import { Icon } from "../components/Icon";
import { displayFixed } from "../editor/numbers";
import { api } from "../lib/api";
import { exportChart } from "../panes/results/charts/exportChart";
import { useCurrentFingerprint } from "../panes/results/fingerprint";
import { useWorkspace } from "../workspace/store";
import { peak, reading, relaxationReading, requestFor, suggestedSurge, transientTable, type TransientAnalysis, type TransientPrepare, type TransientRequest } from "./model";
import { nextTransientId, runTransient, setTransientSettings, stopTransient, useTransientError, useTransientResult, useTransientRun, useTransientSettings } from "./store";
import { FLUID_DASH, PSA_CEILING, PSA_DASH, TransientChart, type TransientSeries } from "./TransientChart";
import { about, pct, tiny, transientWords as w, type InitialKind } from "./words";
import "../panes/results/charts/charts.css";
import "../sweeps/sweeps.css";
import "./transient.css";

export interface TransientViewProps {
  tabId: string;
  /** `output.decimals`: how the values are shown. */
  decimals: number;
}

/** What the answer was computed for, without the document and the id: to tell whether the set-up has changed since. */
const shape = (r: TransientRequest) => JSON.stringify([r.horizon, r.initial, r.surge ?? null, r.settleFraction]);

/** The probability lost at the cut-off above which the view says so. */
const MASS_WARNING = 1e-4;
/** A bound on the error of a mean above this (customers) is said in a note, not only in the tier line. */
const MEAN_WARNING = 1e-3;

function LineKey({ dash }: { dash?: string }) {
  return (
    <svg className="transient-key" width={22} height={8} viewBox="0 0 22 8" aria-hidden="true">
      <line x1={1} x2={21} y1={4} y2={4} stroke={v("--text")} strokeWidth={2} strokeDasharray={dash} />
    </svg>
  );
}

export function TransientView({ tabId, decimals }: TransientViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const doc = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId)?.document ?? null);
  const settings = useTransientSettings(tabId);
  const result = useTransientResult(tabId);
  const run = useTransientRun(tabId);
  const error = useTransientError(tabId);
  const fingerprint = useCurrentFingerprint(doc);
  const format = (x: number) => displayFixed(x, decimals);
  const set = (patch: Parameters<typeof setTransientSettings>[1]) => setTransientSettings(tabId, patch);

  // Which tiers apply to the network as it is, and the horizon to suggest.
  const [prepare, setPrepare] = useState<{ of: unknown; value: TransientPrepare | null; error: string | null } | null>(null);
  const nodes = doc?.nodes;
  const links = doc?.links;
  const infinite = doc?.infiniteBuffers;
  const hasNetwork = !!nodes?.length;
  useEffect(() => {
    if (!doc || !hasNetwork) {
      setPrepare(null);
      return;
    }
    let live = true;
    api.transientPrepare(doc).then(
      (value) => live && setPrepare({ of: nodes, value, error: null }),
      (e) => live && setPrepare({ of: nodes, value: null, error: typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e) }),
    );
    return () => {
      live = false;
    };
    // The document's parts, not its identity: a change of layout alone asks again, cheaply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links, infinite, hasNetwork]);

  const ready = prepare?.value ?? null;
  const applies = !!ready && (ready.exactReason === null || ready.fluidReason === null);
  const built = useMemo(() => (ready && applies && doc ? requestFor(settings, ready, doc, "") : null), [ready, applies, doc, settings]);
  const problem = built && "problem" in built ? built.problem : null;
  const compute = () => {
    if (!built || !("request" in built) || run) return;
    void runTransient(tabId, { ...built.request, id: nextTransientId() });
  };

  // The first time the view meets a network it can analyse, it computes: nobody should have to
  // press a button to see a first curve.
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || result || run || !built || !("request" in built)) return;
    auto.current = true;
    compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, result, run]);

  if (!doc || !hasNetwork) {
    return (
      <div ref={rootRef} className="results-charts transient-view" data-transient="none">
        <div className="results-charts-body">
          <div className="empty-state results-empty results-charts-empty">
            <Icon icon={Activity} size={20} aria-hidden />
            <h2>{w.emptyTitle}</h2>
            <p>{w.emptyMessage}</p>
          </div>
        </div>
      </div>
    );
  }

  if (prepare && !applies) {
    return (
      <div ref={rootRef} className="results-charts transient-view" data-transient="refused">
        <div className="results-charts-body">
          <div className="empty-state results-empty results-charts-empty">
            <Icon icon={Activity} size={20} aria-hidden />
            <h2>{w.neither}</h2>
            <p data-transient-reason>{prepare.error ?? ready?.fluidReason ?? ready?.exactReason}</p>
          </div>
        </div>
      </div>
    );
  }

  const analysis = result?.analysis ?? null;
  const request = result?.request ?? null;
  const stale = !!result && ((!!result.fingerprint && !!fingerprint && result.fingerprint !== fingerprint) || (!!built && "request" in built && shape(built.request) !== shape(result.request)));
  const stations = ready?.stations ?? [];
  const mode = settings.mode;
  const suggested = ready?.suggestedHorizon ?? null;
  const horizonNow = built && "request" in built ? built.request.horizon : suggested;

  return (
    <div ref={rootRef} className="results-charts transient-view" data-transient={analysis ? "answer" : "setup"} data-mode={mode}>
      <div className="results-charts-bar">
        {analysis && analysis.stations.length > 1 ? (
          <select className="results-picker" aria-label={w.stationLabel} title={w.stationHelp} value={settings.station ?? ""} onChange={(e) => set({ station: e.target.value || null })}>
            {analysis.stations.length <= SERIES_COUNT ? <option value="">{w.allStations}</option> : null}
            {analysis.stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="results-views" role="radiogroup" aria-label={w.modeLabel}>
          {(["chart", "table"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} title={w.modeHelp[m]} onClick={() => set({ mode: m })}>
              {w.modes[m]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {run ? (
          <button type="button" className="btn" data-transient-stop title={w.stopHelp} onClick={() => stopTransient(tabId)}>
            {w.stop}
          </button>
        ) : (
          <button type="button" className="btn primary" data-transient-run title={w.runHelp} disabled={!built || !("request" in built)} onClick={compute}>
            {analysis ? w.runAgain : w.run}
          </button>
        )}
        <button type="button" className="icon-btn" aria-label={w.exportChart} title={w.exportChartHelp} disabled={mode !== "chart" || !analysis} onClick={() => void exportChart(tabId, rootRef.current)}>
          <Icon icon={Share} size={14} aria-hidden />
        </button>
      </div>
      <div className="results-charts-body">
        <fieldset className="transient-setup" data-transient-setup>
          <legend>{w.setupTitle}</legend>
          <div className="transient-row">
            <label htmlFor={`${uid}-initial`}>{w.initialLabel}</label>
            <select id={`${uid}-initial`} className="qn-field" title={w.initialHelp} value={settings.initial} onChange={(e) => set({ initial: e.target.value as InitialKind })}>
              {(["empty", "steady", "given"] as const).map((k) => (
                <option key={k} value={k} disabled={k === "steady" && ready?.exactReason !== null}>
                  {w.initials[k]}
                </option>
              ))}
            </select>
            {settings.initial === "given"
              ? stations.map((s) => (
                  <label key={s.id}>
                    {s.name}
                    <input className="qn-field" inputMode="numeric" aria-label={w.numberAt(s.name)} title={w.numberAt(s.name)} value={settings.numbers[s.id] ?? "0"} onChange={(e) => set({ numbers: { ...settings.numbers, [s.id]: e.target.value } })} />
                  </label>
                ))
              : null}
            <label htmlFor={`${uid}-horizon`}>{w.horizonLabel}</label>
            <input id={`${uid}-horizon`} className="qn-field" inputMode="decimal" title={w.horizonHelp} placeholder={suggested !== null ? about(suggested) : ""} value={settings.horizon} onChange={(e) => set({ horizon: e.target.value })} />
            <span>
              {w.timeUnits}
              {suggested !== null && settings.horizon.trim() !== "" ? <span className="transient-hint"> ({w.suggested(about(suggested))})</span> : null}
            </span>
            <label htmlFor={`${uid}-band`}>{w.bandLabel}</label>
            <input id={`${uid}-band`} className="qn-field" inputMode="decimal" title={w.bandHelp} value={settings.band} onChange={(e) => set({ band: e.target.value })} />
            <span>{w.bandUnit}</span>
          </div>
          {ready?.profile ? (
            <p className="transient-scale" data-transient-profile>
              {w.profileNote(ready.profile.sources.join(", "), ready.profile.periodic, about(ready.profile.span))}
            </p>
          ) : null}
          <div className="transient-row" hidden={Boolean(ready?.profile)}>
            <label title={w.surgeHelp}>
              <input
                type="checkbox"
                checked={settings.surge}
                onChange={(e) => {
                  const fill = e.target.checked && settings.from.trim() === "" && settings.until.trim() === "" && horizonNow ? suggestedSurge(horizonNow) : {};
                  set({ surge: e.target.checked, ...fill });
                }}
              />
              {w.surgeLabel}
            </label>
            {settings.surge ? (
              <>
                <label htmlFor={`${uid}-factor`}>{w.surgeFactor}</label>
                <input id={`${uid}-factor`} className="qn-field" inputMode="decimal" title={w.surgeFactorHelp} value={settings.factor} onChange={(e) => set({ factor: e.target.value })} />
                <label htmlFor={`${uid}-from`}>{w.surgeFrom}</label>
                <input id={`${uid}-from`} className="qn-field" inputMode="decimal" value={settings.from} onChange={(e) => set({ from: e.target.value })} />
                <label htmlFor={`${uid}-until`}>{w.surgeUntil}</label>
                <input id={`${uid}-until`} className="qn-field" inputMode="decimal" value={settings.until} onChange={(e) => set({ until: e.target.value })} />
              </>
            ) : null}
          </div>
          {problem ? (
            <p className="transient-problem" role="alert" data-transient-problem>
              {problem}
            </p>
          ) : null}
        </fieldset>
        {!prepare ? <p className="transient-scale">{w.preparing}</p> : null}
        {run ? (
          <p className="transient-progress" role="status" data-transient-progress>
            <progress max={1} value={run.fraction} aria-label={w.running(Math.round(run.fraction * 100))} />
            {w.running(Math.round(run.fraction * 100))}
          </p>
        ) : null}
        {error ? (
          <p className="transient-problem" role="alert" data-transient-error>
            {error}
          </p>
        ) : null}
        {analysis && request ? <Answer tabId={tabId} analysis={analysis} request={request} stale={stale} mode={mode} station={settings.station} format={format} /> : null}
      </div>
    </div>
  );
}

interface AnswerProps {
  tabId: string;
  analysis: TransientAnalysis;
  request: TransientRequest;
  stale: boolean;
  mode: "chart" | "table";
  station: string | null;
  format: (x: number) => string;
}

function Answer({ analysis: a, request, stale, mode, station, format }: AnswerProps) {
  const band = pct(request.settleFraction);
  const all = a.stations.map((_, i) => i);
  const picked = station ? all.filter((i) => a.stations[i].id === station) : [];
  // Colours are never cycled: past eight stations one is shown at a time.
  const shown = picked.length ? picked : a.stations.length <= SERIES_COUNT ? all : [0];
  const sentence = reading(a, request, format);
  const scale = relaxationReading(a);
  const surge = request.surge ?? null;
  const subtitle = w.chartSubtitle(w.startText[request.initial.kind], surge ? w.surgeText(about(surge.factor), about(surge.from), about(surge.until)) : a.profileBreaks?.length ? w.profileText : null);
  // PSA (new in 2.1): shown beside the exact curve wherever the rates change in time.
  const psaTop = a.psa ? Math.max(0, ...shown.flatMap((i) => a.psa![i].filter((p): p is number => p !== null))) : 0;
  const ownTop = Math.max(0, ...shown.flatMap((i) => [...(a.exact ? a.exact.mean[i] : []), ...(a.fluid ? a.fluid.level[i] : []), a.stations[i].stationary ?? 0]));
  const psaGaps = a.psa ? shown.some((i) => a.psa![i].some((p) => p === null)) : false;
  const series: TransientSeries[] = shown.map((i) => ({
    key: a.stations[i].id,
    label: a.stations[i].name,
    color: seriesToken(i % SERIES_COUNT) ?? "--series-1",
    exact: a.exact ? a.exact.mean[i] : null,
    fluid: a.fluid ? a.fluid.level[i] : null,
    // With a repeating profile the drawn network's steady state is not where the mean goes: no such line.
    stationary: a.exact && !a.profilePeriodic ? a.stations[i].stationary : null,
    settling: a.exact ? a.exact.settling[i] : null,
    psa: a.psa ? a.psa[i] : null,
  }));
  const table = transientTable(a, shown, request, format);
  const e = a.exact;
  // The error of the means: the largest proven bound over the stations, or null when one has none.
  const meanBound = e ? (e.shortfall.some((b) => b === null) ? null : Math.max(0, ...(e.shortfall as number[]))) : null;
  const meanNote = !e ? null : meanBound === null ? w.meansUnbounded(tiny(e.missingMass)) : e.missingMass > MASS_WARNING || meanBound > MEAN_WARNING ? w.lostMassBounded(pct(e.missingMass), about(meanBound)) : null;
  const notes = [a.stopped ? w.stoppedNote : null, stale ? w.staleNote : null, meanNote].filter(Boolean);

  return (
    <>
      {notes.length ? (
        <p className="results-note" data-tone="warning" role="note">
          <Icon icon={TriangleAlert} size={12} aria-hidden />
          {notes.join(" ")}
        </p>
      ) : null}
      <p className="transient-reading" data-transient-reading>
        {sentence}
      </p>
      <ul className="transient-tiers" data-transient-tiers>
        {e ? (
          <li data-tier="exact" title={w.tierExactHelp(e.levels.join(", "), about(e.uniformisationRate), e.products, tiny(e.poissonBound), tiny(e.stationaryTail))}>
            <LineKey />
            <strong>{w.tierExact}</strong>
            <span data-transient-mean-bound={meanBound === null ? "none" : meanBound}>{w.tierExactDetail(e.states, tiny(Math.max(e.missingMass, e.poissonBound)), meanBound === null ? null : tiny(meanBound))}</span>
          </li>
        ) : a.exactReason ? (
          <li data-tier="exact-refused">
            <strong>{w.noExact}</strong>
            <span>{a.exactReason}</span>
          </li>
        ) : null}
        {a.fluid ? (
          <li data-tier="fluid" title={w.tierFluidHelp}>
            <LineKey dash={FLUID_DASH} />
            <strong>{w.tierFluid}</strong>
            <span>({w.tierFluidDetail})</span>
          </li>
        ) : null}
        {a.psa ? (
          <li data-tier="psa" title={w.tierPsaHelp}>
            <LineKey dash={PSA_DASH} />
            <strong>{w.tierPsa}</strong>
            <span>({w.tierPsaDetail(psaTop > ownTop * PSA_CEILING ? format(psaTop) : null, psaGaps)})</span>
          </li>
        ) : null}
        {a.fluid ? null : a.fluidReason ? (
          <li data-tier="fluid-refused">
            <strong>{w.noFluid}</strong>
            <span>{a.fluidReason}</span>
          </li>
        ) : null}
      </ul>
      {mode === "chart" ? (
        <ChartFrame className="results-chart-card">
          {({ width, fontScale }) => (
            <TransientChart width={width} fontScale={fontScale} times={a.times} series={series} surge={surge} breaks={a.profileBreaks} band={band} title={w.chartTitle} subtitle={subtitle} caption={w.caption(sentence, Boolean(a.psa), !a.profilePeriodic, Boolean(a.profileBreaks?.length))} table={table} formatY={format} formatX={about} />
          )}
        </ChartFrame>
      ) : (
        <div className="results-chart-card sweep-table-card">
          <table className="sweep-table transient-table" data-transient-table>
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
              {table.rows.map((row, k) => (
                <tr key={k}>
                  {row.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="results-chart-card sweep-table-card">
        <table className="sweep-table transient-table" data-transient-summary>
          <caption>{w.summaryTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{w.colStation}</th>
              <th scope="col">{w.colUtilisation}</th>
              <th scope="col" title={w.colStationaryHelp}>
                {w.colStationary}
              </th>
              <th scope="col" title={w.colRelaxationHelp}>
                {w.colRelaxation}
              </th>
              {e ? (
                <>
                  <th scope="col" title={w.colSettlingHelp}>
                    {w.colSettling(band)}
                  </th>
                  <th scope="col">{w.colPeak}</th>
                </>
              ) : null}
              {a.fluid ? <th scope="col">{w.colFluidPeak}</th> : null}
            </tr>
          </thead>
          <tbody>
            {a.stations.map((s, i) => {
              const top = e ? peak(a.times, e.mean[i]) : null;
              const fluidTop = a.fluid ? peak(a.times, a.fluid.level[i]) : null;
              return (
                <tr key={s.id} data-station={s.id}>
                  <th scope="row">{s.name}</th>
                  <td>{s.utilisation !== null ? pct(s.utilisation) : "—"}</td>
                  <td title={a.profilePeriodic ? w.profileNoLongRun : undefined}>{s.stationary !== null && !a.profilePeriodic ? format(s.stationary) : "—"}</td>
                  <td>{s.relaxation !== null ? about(s.relaxation) : "—"}</td>
                  {e ? (
                    <>
                      <td data-muted={e.settling[i] === null ? true : undefined} title={e.uncertified[i] ? w.notCertifiedHelp : undefined}>
                        {e.settling[i] !== null ? about(e.settling[i] as number) : a.profilePeriodic ? w.profileNeverSettles : e.uncertified[i] ? w.notCertified : w.notSettled}
                      </td>
                      <td>{top ? w.peakAt(format(top.value), about(top.time)) : "—"}</td>
                    </>
                  ) : null}
                  {a.fluid ? <td>{fluidTop ? w.peakAt(format(fluidTop.value), about(fluidTop.time)) : "—"}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {scale ? <p className="transient-scale">{scale}</p> : null}
    </>
  );
}
