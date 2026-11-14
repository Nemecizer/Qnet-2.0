// The Results pane's Sensitivity view (new in 2.1, ROADMAP D1): for one measure of the tab's
// network, which parameter moves it most (a ranked elasticity chart, or a table of every number),
// where the bottleneck is, a plain sentence per leading parameter, and "what would it take" — the
// single-parameter changes that move the measure by a chosen percentage, smallest first, each
// with Apply (one undo step) and Try as What-If Sweep.
//
// Two routes, always labelled. A Jackson network is answered by closed formula (Rust,
// `sensitivity_analyze`): exact, instant, and recomputed whenever the network, the measure or the
// target changes. Any other network is estimated on request by differences over quiet runs
// (./runner.ts) and kept until the network changes. The view reaches its document only through
// its own elements, so it draws the same docked or in a detached window.
import { useEffect, useMemo, useRef, useState } from "react";
import { Gauge, TriangleAlert } from "lucide-react";
import { ChartFrame } from "../charts";
import { Icon } from "../components/Icon";
import { displayFixed, formatSig } from "../editor/numbers";
import { api } from "../lib/api";
import { runCommand } from "../lib/commands";
import { useCurrentFingerprint } from "../panes/results/fingerprint";
import { agreementWords } from "../panes/results/agreement/words";
import { applySweepValue, openSweepPanel, SWEEP_COMMAND } from "../sweeps/commands";
import { tidy } from "../sweeps/model";
import { TierMark } from "../sweeps/SweepPanel";
import { aboutTime } from "../sweeps/words";
import { useWorkspace } from "../workspace/store";
import { ElasticityChart, type ElasticityBar } from "./ElasticityChart";
import { bottleneckSentence, fromAnalysis, measureOptions, METRIC, options, pickMeasure, ranked, reading, relativeChange, requestFor, STEP, steps, targetChangeOf, unitText, type MeasureChoice, type SensitivityAnalysis, type SensitivityResult, type SensitivityRow } from "./model";
import { FIND_EVALUATIONS } from "./model";
import { analysable, MAX_OPTIONS, numericPlan, runDifferences, runOptions, type NumericPlan } from "./runner";
import { estimateIsStale, setSensitivitySelection, useSensitivityEstimate, useSensitivitySelection } from "./store";
import { pctText, signed, sensitivityWords as w } from "./words";
import "../panes/results/charts/charts.css";
import "../sweeps/sweeps.css";
import "./sensitivity.css";
import { SaveAsScenarioButton, scenarioWords } from "../scenarios";

export interface SensitivityViewProps {
  tabId: string;
  /** `output.decimals`: how the values are shown. */
  decimals: number;
}

export function SensitivityView({ tabId, decimals }: SensitivityViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tab = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId) ?? null);
  const doc = tab?.document ?? null;
  const selection = useSensitivitySelection(tabId);
  const estimate = useSensitivityEstimate(tabId);
  const fingerprint = useCurrentFingerprint(doc);
  const format = (x: number) => displayFixed(x, decimals);

  const parameters = useMemo(() => (doc ? analysable(doc) : []), [doc]);
  const measures = useMemo(() => (doc ? measureOptions(doc) : []), [doc]);
  const measure = useMemo(() => pickMeasure(measures, selection.measureKey), [measures, selection.measureKey]);
  const targetChange = targetChangeOf(selection.percent, selection.direction);

  // The exact route: asked again whenever the network, the measure or the target changes.
  const [answer, setAnswer] = useState<{ key: string; measureKey: string; targetChange: number | null; analysis: SensitivityAnalysis | null; error: string | null } | null>(null);
  const key = doc && measure ? `${measure.key}|${targetChange}` : null;
  useEffect(() => {
    if (!doc || !measure || !parameters.length) return;
    let live = true;
    const asked = { key: key!, measureKey: measure.key, targetChange };
    api.sensitivityAnalyze(requestFor(doc, measure, parameters, targetChange)).then(
      (analysis) => live && setAnswer({ ...asked, analysis, error: null }),
      (e) => live && setAnswer({ ...asked, analysis: null, error: e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e) }),
    );
    return () => {
      live = false;
    };
    // `key` stands for the measure and the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key, parameters]);
  // An answer belongs to the measure and target it was asked for: one for another measure is not
  // shown under this one's name, and its options are shown only while the field still asks for them.
  const current = answer && measure && answer.measureKey === measure.key ? answer : null;
  const analysis = current?.analysis ?? null;
  const exact = useMemo(() => (current?.analysis && measure ? fromAnalysis(current.analysis, measure, parameters, current.targetChange) : null), [current, measure, parameters]);

  // The numerical route's plan, asked only when no formula applies.
  const numeric = analysis !== null && !analysis.available && analysis.reason === "notJackson";
  const [plan, setPlan] = useState<NumericPlan | null>(null);
  useEffect(() => {
    if (!numeric || !tab) return;
    let live = true;
    void numericPlan(tab).then((p) => live && setPlan(p));
    return () => {
      live = false;
    };
    // The plan follows the network.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numeric, doc]);
  const [busy, setBusy] = useState(false);

  const empty = (title: string, message: string, action?: { label: string; help: string; run: () => void; disabled?: boolean }, extra?: string) => (
    <div className="empty-state results-empty results-charts-empty">
      <Icon icon={Gauge} size={20} aria-hidden />
      <h2>{title}</h2>
      <p>{message}</p>
      {extra ? <p>{extra}</p> : null}
      {action ? (
        <button type="button" className="btn primary" title={action.help} disabled={action.disabled} onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );

  let result: SensitivityResult | null = null;
  let body: React.ReactNode = null;
  if (!doc || !measure || !parameters.length) body = empty(w.emptyTitle, w.emptyMessage);
  else if (!current) body = empty(w.working, "");
  else if (current.error) body = empty(w.brokenTitle, current.error);
  else if (exact) result = exact;
  else if (analysis?.reason === "unstable") body = empty(w.unstableTitle, analysis.sentence ?? "", undefined, w.unstableHelp);
  else if (analysis?.reason === "closed" || analysis?.reason === "closedNoPopulation") body = empty(w.closedTitle, analysis.sentence ?? "");
  else if (analysis?.reason === "network") body = empty(w.brokenTitle, analysis.sentence ?? "", undefined, w.seeProblems);
  else if (estimate && estimate.measureKey === measure.key) result = estimate;
  else if (!plan) body = empty(w.working, "");
  else if (!plan.method) {
    body = plan.simulationOnly
      ? empty(w.simulationOnlyTitle, w.simulationOnly, { label: w.simulationAction, help: w.trySweepHelp(""), run: () => void runCommand(SWEEP_COMMAND) })
      : empty(w.numericTitle, w.noMethod);
  } else {
    const method = plan.method;
    body = empty(
      w.numericTitle,
      analysis?.sentence ?? "",
      {
        label: w.numericAction,
        help: w.numericActionHelp,
        disabled: busy,
        run: () => {
          setBusy(true);
          void runDifferences(tabId, measure.key, method).finally(() => setBusy(false));
        },
      },
      w.numericMessage(method.name, w.tiers[method.tier], plan.runs, plan.seconds !== null ? aboutTime(plan.seconds) : null),
    );
  }

  return (
    <div ref={rootRef} className="results-charts sensitivity-view" data-sensitivity={result ? result.route : "none"} data-mode={selection.mode}>
      <div className="results-charts-bar">
        {measures.length ? (
          <select className="results-picker" aria-label={w.measureLabel} title={w.measureHelp} value={measure?.key ?? ""} onChange={(e) => setSensitivitySelection(tabId, { measureKey: e.target.value })}>
            {measures.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        ) : null}
        <div className="results-views" role="radiogroup" aria-label={w.modeLabel}>
          {(["chart", "table"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={selection.mode === m} title={w.modeHelp[m]} onClick={() => setSensitivitySelection(tabId, { mode: m })}>
              {w.modes[m]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {result?.route === "difference" && plan?.method ? (
          <button
            type="button"
            className="btn"
            title={w.numericActionHelp}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void runDifferences(tabId, measure?.key ?? null, plan.method!).finally(() => setBusy(false));
            }}
          >
            {w.again}
          </button>
        ) : null}
      </div>
      <div className="results-charts-body">
        {result && measure ? (
          <Report
            tabId={tabId}
            result={result}
            measure={measure}
            format={format}
            mode={selection.mode}
            stale={result.route === "difference" && estimateIsStale(result, fingerprint)}
            targetChange={targetChange}
            busy={busy}
            findOptions={
              result.route === "difference" && plan?.method && targetChange !== null
                ? () => {
                    setBusy(true);
                    void runOptions(tabId, targetChange, plan.method!).finally(() => setBusy(false));
                  }
                : null
            }
          />
        ) : (
          body
        )}
      </div>
    </div>
  );
}

interface ReportProps {
  tabId: string;
  result: SensitivityResult;
  measure: MeasureChoice;
  format: (x: number) => string;
  mode: "chart" | "table";
  stale: boolean;
  targetChange: number | null;
  busy: boolean;
  /** The numerical route's search, when it can be run. */
  findOptions: (() => void) | null;
}

const param = (x: number) => formatSig(x, 5);

function Report({ tabId, result, measure, format, mode, stale, targetChange, busy, findOptions }: ReportProps) {
  const selection = useSensitivitySelection(tabId);
  const unit = unitText(measure.unit);
  const withUnit = (x: number) => `${format(x)}${unit ? ` ${unit}` : ""}`;
  const order = ranked(result.rows);
  const whole = steps(result.rows, result.value);
  const readings = [...order.slice(0, 3), ...whole.slice(0, 2)].map((r) => ({ id: r.parameter.id, text: reading(r, measure, result) })).filter((r): r is { id: string; text: string } => r.text !== null);
  const bars: ElasticityBar[] = order.map((r) => ({ key: r.parameter.id, label: r.parameter.label.replace(/ \(.*\)$/, ""), elasticity: r.elasticity!, lines: [reading(r, measure, result) ?? ""].filter(Boolean) }));
  const neck = bottleneckSentence(result);
  const tierLine = result.route === "formula" ? w.tierFormula : w.tierDifference(agreementWords.tierShort[result.tier], result.method?.name ?? "");
  const tierHelp = result.route === "formula" ? w.tierFormulaHelp : w.tierDifferenceHelp(result.method?.name ?? "", pctText(STEP * 100));
  const title = w.chartTitle(measure.label);
  const notes = [result.stopped ? w.stoppedNote : null, stale ? w.staleNote : null, result.leftOut ? w.leftOut(result.leftOut) : null].filter(Boolean);
  // The options shown are the ones worked out for the target in the field.
  const answered = result.target !== null && result.targetChange === targetChange;
  const { feasible, infeasible } = answered ? options(result.rows) : { feasible: [], infeasible: [] };

  const sweep = (row: SensitivityRow, to: number) => {
    const p = row.parameter;
    const [from, end] = to < p.current ? [to, p.current] : [p.current, to];
    openSweepPanel({ tabId, from: { parameter: p, from: tidy(from), to: tidy(end), values: new Array(12).fill(0), methods: [], metric: measure.kind === "networkSojourn" || measure.kind === "stationSojourn" ? "Mean sojourn time" : measure.stationId ? METRIC[measure.kind as keyof typeof METRIC] : "Mean number in system", stationId: measure.stationId } });
  };

  return (
    <>
      <p className="sensitivity-tier" title={tierHelp} data-sensitivity-tier={result.tier}>
        <TierMark tier={result.tier} />
        <strong>{tierLine}</strong>
        {result.route === "difference" ? (
          <span className="sensitivity-experimental" title={w.experimentalHelp}>
            {w.experimental}
          </span>
        ) : null}
        <span className="sensitivity-value" data-sensitivity-value>
          {w.valueNow(measure.label, format(result.value), unit)}
        </span>
      </p>
      {notes.length ? (
        <p className="results-note" data-tone="warning" role="note">
          <Icon icon={TriangleAlert} size={12} aria-hidden />
          {notes.join(" ")}
        </p>
      ) : null}
      {neck ? (
        <p className="sensitivity-bottleneck" data-sensitivity-bottleneck>
          {neck}
        </p>
      ) : null}
      {mode === "chart" && bars.length ? (
        <ChartFrame className="results-chart-card">{({ width, fontScale }) => <ElasticityChart width={width} fontScale={fontScale} bars={bars} tier={result.tier} title={title} caption={w.chartCaption(measure.noun, readings[0]?.text ?? null)} />}</ChartFrame>
      ) : (
        <div className="results-chart-card sweep-table-card">
          <table className="sweep-table sensitivity-table" data-sensitivity-table>
            <caption>{w.tableCaption(measure.label)}</caption>
            <thead>
              <tr>
                <th scope="col">{w.rowTitle}</th>
                <th scope="col">{w.colNow}</th>
                <th scope="col" title={w.derivativeHelp}>
                  {w.colDerivative(unit)}
                </th>
                <th scope="col" title={w.elasticityHelp}>
                  {w.colElasticity}
                </th>
                <th scope="col">{w.colOneMore}</th>
              </tr>
            </thead>
            <tbody>
              {[...order, ...whole, ...result.rows.filter((r) => !order.includes(r) && !whole.includes(r))].map((r) => (
                <tr key={r.parameter.id}>
                  <th scope="row">{r.parameter.label}</th>
                  <td>
                    {param(r.parameter.current)}
                    {r.parameter.unit ? ` ${r.parameter.unit}` : ""}
                  </td>
                  {r.note ? (
                    <td colSpan={3} data-note>
                      {r.note}
                    </td>
                  ) : (
                    <>
                      <td title={r.oneSided ? w.oneSided : undefined}>{r.derivative !== null ? `${signed(r.derivative, Math.max(2, Math.min(6, displayDigits(r.derivative))))}${r.oneSided ? " *" : ""}` : r.parameter.integer ? w.wholeNumber : "—"}</td>
                      <td>{r.elasticity !== null ? signed(r.elasticity) : "—"}</td>
                      <td>{r.oneMore !== null ? `${withUnit(r.oneMore)}${result.value ? ` (${signedPct((r.oneMore - result.value) / result.value)})` : ""}` : "—"}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {readings.length ? (
        <section className="sensitivity-section" aria-label={w.readingsTitle}>
          <h3>{w.readingsTitle}</h3>
          <ol className="sensitivity-readings" data-sensitivity-readings>
            {readings.map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
          </ol>
        </section>
      ) : null}
      <section className="sensitivity-section" aria-label={w.targetTitle} data-sensitivity-target>
        <h3>{w.targetTitle}</h3>
        <div className="sensitivity-target">
          <div className="results-views" role="radiogroup" aria-label={w.targetDirection}>
            {(["cut", "raise"] as const).map((d) => (
              <button key={d} type="button" role="radio" aria-checked={selection.direction === d} onClick={() => setSensitivitySelection(tabId, { direction: d })}>
                {w.directions[d]}
              </button>
            ))}
          </div>
          <span>{measure.noun}</span>
          <span>{w.targetBy}</span>
          <input type="text" inputMode="decimal" aria-label={w.targetPercent} title={w.targetPercentHelp} value={selection.percent} aria-invalid={targetChange === null} onChange={(e) => setSensitivitySelection(tabId, { percent: e.target.value })} />
          <span aria-hidden>%</span>
        </div>
        {targetChange === null ? (
          <p className="sensitivity-problem" role="alert">
            {w.targetBad}
          </p>
        ) : !answered ? (
          findOptions ? (
            <button type="button" className="btn" title={w.findOptionsHelp} disabled={busy || stale} onClick={findOptions}>
              {w.findOptions(Math.min(MAX_OPTIONS, order.filter((r) => r.parameter.kind !== "load").length) * FIND_EVALUATIONS)}
            </button>
          ) : null
        ) : (
          <>
            <p className="sensitivity-target-line">{w.targetSentence(selection.direction, measure.noun, pctText(Math.abs(targetChange) * 100), format(result.value), format(result.target!), unit)}</p>
            {feasible.length ? (
              <ul className="sensitivity-options" data-sensitivity-options>
                {feasible.map((r) => {
                  const a = r.inversion as Extract<SensitivityRow["inversion"], { kind: "achieved" }>;
                  const p = r.parameter;
                  const name = p.label.replace(/ \(.*\)$/, "");
                  const rel = relativeChange(r);
                  return (
                    <li key={p.id} data-feasible="true" data-option={p.id}>
                      <span className="sensitivity-option-what">{w.optionSet(name, param(p.current), param(a.value), p.unit)}</span>
                      <span className="sensitivity-option-change">{rel !== null ? w.optionChange(pctText(Math.abs(rel) * 100), rel > 0) : ""}</span>
                      <span className="sensitivity-option-gives">{w.optionReaches(format(a.measure), unit)}</span>
                      <span className="sensitivity-option-actions">
                        <button type="button" className="btn" title={w.applyHelp(name, param(a.value))} aria-label={`${w.apply}: ${w.optionSet(name, param(p.current), param(a.value), p.unit)}`} disabled={stale} onClick={() => applySweepValue(tabId, p, p.integer ? a.value : tidy(a.value), w.applyUndoName)}>
                          {w.apply}
                        </button>
                        <SaveAsScenarioButton tabId={tabId} name={scenarioWords.sensitivityName(name, param(a.value))} what={w.optionSet(name, param(p.current), param(a.value), p.unit)} disabled={stale} apply={() => applySweepValue(tabId, p, p.integer ? a.value : tidy(a.value), w.applyUndoName)} />
                        <button type="button" className="btn" title={w.trySweepHelp(name)} onClick={() => sweep(r, a.value)}>
                          {w.trySweep}
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="sensitivity-problem">{w.noOptions}</p>
            )}
            {infeasible.length ? (
              <>
                <p className="sensitivity-subhead">{w.infeasibleLabel}</p>
                <ul className="sensitivity-options" data-sensitivity-infeasible>
                  {infeasible.map((r) => (
                    <li key={r.parameter.id} data-feasible="false">
                      <span className="sensitivity-option-what">{r.parameter.label.replace(/ \(.*\)$/, "")}</span>
                      <span className="sensitivity-option-why">{whyText(r, withUnit)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="sensitivity-footnote">{result.route === "formula" ? w.verified : w.verifiedRuns(result.method?.name ?? "")}</p>
          </>
        )}
      </section>
    </>
  );
}

/** Decimals that show three significant digits of a derivative. */
const displayDigits = (x: number) => (x === 0 ? 2 : Math.max(0, 2 - Math.floor(Math.log10(Math.abs(x)))));
const signedPct = (fraction: number) => `${fraction < 0 ? "−" : "+"}${pctText(fraction * 100)}`;

function whyText(row: SensitivityRow, withUnit: (x: number) => string): string {
  const a = row.inversion;
  if (!a || a.kind !== "infeasible") return "";
  const i = w.infeasible;
  switch (a.why) {
    case "noEffect":
      return i.noEffect;
    case "rangeEnds":
      return a.limitValue !== null && a.limitMeasure !== null ? i.rangeEnds(param(a.limitValue), withUnit(a.limitMeasure)) : i.unknown;
    case "levels":
      return a.limitMeasure !== null ? i.levels(withUnit(a.limitMeasure)) : i.unknown;
    case "overload":
      return i.overload;
    case "notFound":
      return i.notFound(FIND_EVALUATIONS);
  }
}
