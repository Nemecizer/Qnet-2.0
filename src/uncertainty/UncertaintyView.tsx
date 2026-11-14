// The Results pane's Uncertainty view (new in 2.1, ROADMAP D7): "my arrival rate is 0.8 give or
// take 10 %: how sure is the answer?". The rates' uncertainties are typed at the top (one default
// for all, a row per rate to say otherwise); below, for one measure: the chance of overload, a
// plain reading, the measure's distribution with its 95 % interval, and which input's uncertainty
// matters most.
//
// Three routes, always labelled. A Jackson network is answered by sampling its closed formula
// (Rust, `uncertainty_analyze`: every draw solved exactly; the sampling error is shown), with the
// linear approximation (delta method) beside it and a warning where the two part company. Any
// other open network gets the linear approximation alone, from the Sensitivity view's numerical
// derivatives over quiet runs (Experimental). A closed network is refused in a sentence. The view
// reaches its document only through its own elements, so it draws the same docked or detached.
import { useEffect, useMemo, useRef, useState } from "react";
import { Dices, Share, TriangleAlert } from "lucide-react";
import { BarChart, ChartFrame, TIER_STYLE, type BarRow, type BarSeries } from "../charts";
import { classicalOnly } from "../extended/shape";
import { Icon } from "../components/Icon";
import { displayFixed, formatSig } from "../editor/numbers";
import { api } from "../lib/api";
import { runCommand } from "../lib/commands";
import { exportChart } from "../panes/results/charts/exportChart";
import { useCurrentFingerprint } from "../panes/results/fingerprint";
import { measureOptions, pickMeasure, unitText, type MeasureChoice } from "../sensitivity/model";
import { numericPlan, runDifferences, type NumericPlan } from "../sensitivity/runner";
import { estimateIsStale, useSensitivityEstimate } from "../sensitivity/store";
import { SWEEP_COMMAND } from "../sweeps/commands";
import type { SweepParameter } from "../sweeps/model";
import { TierMark } from "../sweeps/SweepPanel";
import { aboutTime } from "../sweeps/words";
import { useWorkspace } from "../workspace/store";
import { HistogramChart } from "./HistogramChart";
import { BLANK_OVERRIDE, linearIsOff, planKey, planOf, rankedShares, recommendation, requestFor, shareLabel, uncertainParameters, type Estimate, type How, type InputRow, type LinearRequest, type Plan, type UncertaintyAnalysis, type UncertaintyProgress, type UncertaintySettings } from "./model";
import { setUncertaintyOverride, setUncertaintySettings, useUncertaintySettings } from "./store";
import { count, pctText, uncertaintyWords as w } from "./words";
import "../panes/results/charts/charts.css";
import "../sweeps/sweeps.css";
import "../sensitivity/sensitivity.css";
import "./uncertainty.css";

export interface UncertaintyViewProps {
  tabId: string;
  /** `output.decimals`: how the values are shown. */
  decimals: number;
}

/** How long the fields rest before the question is asked again. */
export const SETTLE_MS = 250;

const message = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));
const param = (x: number) => formatSig(x, 5);

export function UncertaintyView({ tabId, decimals }: UncertaintyViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tab = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId) ?? null);
  const doc = tab?.document ?? null;
  const settings = useUncertaintySettings(tabId);
  const estimate = useSensitivityEstimate(tabId);
  const fingerprint = useCurrentFingerprint(doc);
  const format = (x: number) => displayFixed(x, decimals);

  // Closed or open by the one rule (src/closed/shape.ts mirrors core): a population on a network
  // that has a source and a sink does not make it closed.
  // A closed network, or one with priorities, batch arrivals or a rate profile (the two rules).
  const refusal = useMemo(() => classicalOnly(doc, w.subject), [doc]);
  const closed = refusal !== null;
  const parameters = useMemo(() => (doc ? uncertainParameters(doc) : []), [doc]);
  const measures = useMemo(() => (doc ? measureOptions(doc) : []), [doc]);
  const measure = useMemo(() => pickMeasure(measures, settings.measureKey), [measures, settings.measureKey]);
  const plan = useMemo(() => planOf(parameters, settings), [parameters, settings]);
  const key = measure ? planKey(measure, plan, settings.together) : null;
  const ready = !!doc && !!measure && parameters.length > 0 && !closed;

  // The sampled route: asked again, once the fields have rested, whenever the network or the question changes.
  const [answer, setAnswer] = useState<{ key: string; doc: unknown; analysis: UncertaintyAnalysis | null; error: string | null } | null>(null);
  const [progress, setProgress] = useState<UncertaintyProgress | null>(null);
  useEffect(() => {
    if (!ready || plan.blocked || !doc || !measure || !key) return;
    let live = true;
    const timer = setTimeout(() => {
      setProgress(null);
      api.uncertaintyAnalyze(requestFor(doc, measure, plan, settings.together), (p) => live && setProgress(p)).then(
        (analysis) => live && setAnswer({ key, doc, analysis, error: null }),
        (e) => live && setAnswer({ key, doc, analysis: null, error: message(e) }),
      );
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` stands for the measure, the uncertainties and how they are read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key, ready, plan.blocked]);
  const current = answer && answer.key === key && answer.doc === doc ? answer : null;
  const pending = ready && !plan.blocked && !current;
  // While a new answer is on its way the last one stays, dimmed, so the page does not jump.
  const shown = current ?? (pending && answer && !answer.error && answer.analysis?.available ? answer : null);
  const analysis = shown?.analysis ?? null;

  // No closed formula: the linear route, from the Sensitivity view's numerical estimate.
  const numeric = current?.analysis?.available === false && current.analysis.reason === "notJackson";
  const [numericPlanNow, setNumericPlan] = useState<NumericPlan | null>(null);
  useEffect(() => {
    if (!numeric || !tab) return;
    let live = true;
    void numericPlan(tab).then((p) => live && setNumericPlan(p));
    return () => {
      live = false;
    };
    // The plan follows the network.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numeric, doc]);
  const [busy, setBusy] = useState(false);
  const usable = numeric && estimate && measure && estimate.measureKey === measure.key && estimate.route === "difference" ? estimate : null;
  const linearRequest = useMemo<{ request: LinearRequest; missing: number } | null>(() => {
    if (!usable || plan.blocked) return null;
    const inputs: LinearRequest["inputs"] = [];
    let missing = 0;
    for (const { parameter: p, spread } of plan.inputs) {
      const row = usable.rows.find((r) => r.parameter.id === p.id);
      if (row && row.derivative !== null && Number.isFinite(row.derivative)) inputs.push({ id: p.id, kind: p.kind, current: p.current, derivative: row.derivative, spread });
      else missing++;
    }
    return inputs.length ? { request: { value: usable.value, inputs, arrivalsTogether: settings.together }, missing } : null;
  }, [usable, plan, settings.together]);
  const [linear, setLinear] = useState<{ request: LinearRequest; analysis: UncertaintyAnalysis | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!linearRequest) return;
    let live = true;
    const request = linearRequest.request;
    api.uncertaintyLinear(request).then(
      (a) => live && setLinear({ request, analysis: a, error: null }),
      (e) => live && setLinear({ request, analysis: null, error: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [linearRequest]);
  const linearNow = linearRequest && linear && linear.request === linearRequest.request ? linear : null;

  const empty = (title: string, text: string, action?: { label: string; help: string; run: () => void; disabled?: boolean }, extra?: string) => (
    <div className="empty-state results-empty results-charts-empty">
      <Icon icon={Dices} size={20} aria-hidden />
      <h2>{title}</h2>
      <p>{text}</p>
      {extra ? <p>{extra}</p> : null}
      {action ? (
        <button type="button" className="btn primary" title={action.help} disabled={action.disabled} onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
  const estimateNow = (method: NonNullable<NumericPlan["method"]>) => {
    setBusy(true);
    void runDifferences(tabId, measure?.key ?? null, method).finally(() => setBusy(false));
  };

  let route: "none" | "sampled" | "linear" = "none";
  let body: React.ReactNode = null;
  if (refusal) body = empty(w.closedTitle, refusal.reason === "closed" ? `${refusal.sentence} ${w.closedInstead}` : refusal.sentence);
  else if (!doc || !measure || !parameters.length) body = empty(w.emptyTitle, w.emptyMessage);
  else if (plan.blocked && !numeric) body = null;
  else if (!shown) body = <Waiting progress={progress} />;
  else if (shown.error) body = empty(w.brokenTitle, shown.error);
  else if (analysis?.available) {
    route = "sampled";
    body = <Report tabId={tabId} analysis={analysis} measure={measure} parameters={parameters} format={format} mode={settings.mode} tierOfLinear={null} />;
  } else if (analysis?.reason === "unstable") body = empty(w.unstableTitle, analysis.sentence ?? "", undefined, w.unstableHelp);
  else if (analysis?.reason === "network") body = empty(w.brokenTitle, analysis.sentence ?? "", undefined, w.seeProblems);
  else if (usable && linearNow?.analysis) {
    route = "linear";
    const stale = estimateIsStale(usable, fingerprint);
    const notes = [stale ? w.stale : null, linearRequest?.missing ? w.missingDerivatives(linearRequest.missing) : null, w.linearOnly].filter((x): x is string => !!x);
    body = <Report tabId={tabId} analysis={linearNow.analysis} measure={measure} parameters={parameters} format={format} mode={settings.mode} tierOfLinear={{ tier: usable.tier, method: usable.method?.name ?? "" }} notes={notes} />;
  } else if (usable && linearNow?.error) body = empty(w.brokenTitle, linearNow.error);
  else if (usable && plan.blocked) body = null;
  else if (!numericPlanNow) body = <Waiting progress={null} />;
  else if (!numericPlanNow.method) {
    body = numericPlanNow.simulationOnly ? empty(w.numericTitle, w.simulationOnly, { label: w.simulationAction, help: w.simulationAction, run: () => void runCommand(SWEEP_COMMAND) }) : empty(w.numericTitle, w.noMethod);
  } else {
    const method = numericPlanNow.method;
    body = empty(w.numericTitle, current?.analysis?.sentence ?? "", { label: w.numericAction, help: w.numericActionHelp, disabled: busy, run: () => estimateNow(method) }, w.numericMessage(method.name, w.tiers[method.tier], numericPlanNow.runs, numericPlanNow.seconds !== null ? aboutTime(numericPlanNow.seconds) : null));
  }

  return (
    <div ref={rootRef} className="results-charts sensitivity-view uncertainty-view" data-uncertainty={route} data-mode={settings.mode} aria-busy={pending || undefined}>
      <div className="results-charts-bar">
        {measures.length && !closed ? (
          <select className="results-picker" aria-label={w.measureLabel} title={w.measureHelp} value={measure?.key ?? ""} onChange={(e) => setUncertaintySettings(tabId, { measureKey: e.target.value })}>
            {measures.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        ) : null}
        {!closed ? (
          <div className="results-views" role="radiogroup" aria-label={w.modeLabel}>
            {(["chart", "table"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={settings.mode === m} title={w.modeHelp[m]} onClick={() => setUncertaintySettings(tabId, { mode: m })}>
                {w.modes[m]}
              </button>
            ))}
          </div>
        ) : null}
        <span className="spacer" />
        {pending && shown ? (
          <span className="uncertainty-progress" role="status">
            {progress ? w.progress(count(progress.done), count(progress.total)) : w.working}
          </span>
        ) : null}
        {route === "linear" && numericPlanNow?.method ? (
          <button type="button" className="btn" title={w.numericActionHelp} disabled={busy} onClick={() => estimateNow(numericPlanNow.method!)}>
            {w.again}
          </button>
        ) : null}
        <button type="button" className="icon-btn" aria-label={w.exportChart} title={w.exportChartHelp} disabled={route === "none" || settings.mode !== "chart"} onClick={() => void exportChart(tabId, rootRef.current)}>
          <Icon icon={Share} size={14} aria-hidden />
        </button>
      </div>
      <div className="results-charts-body" data-pending={pending && shown ? "true" : undefined}>
        {ready ? <Inputs tabId={tabId} settings={settings} parameters={parameters} plan={plan} rows={analysis?.available ? analysis.inputs : (linearNow?.analysis?.inputs ?? [])} /> : null}
        {body}
      </div>
    </div>
  );
}

function Waiting({ progress }: { progress: UncertaintyProgress | null }) {
  return (
    <p className="uncertainty-progress" role="status" data-uncertainty-waiting>
      {progress ? w.progress(count(progress.done), count(progress.total)) : w.working}
    </p>
  );
}

// ── The inputs ──────────────────────────────────────────────────────────────────────────────────

function Inputs({ tabId, settings, parameters, plan, rows }: { tabId: string; settings: UncertaintySettings; parameters: SweepParameter[]; plan: Plan; rows: InputRow[] }) {
  const arrivals = parameters.filter((p) => p.kind === "arrival").length;
  const defaultBad = Object.keys(plan.problems).some((id) => (settings.overrides[id]?.how ?? "default") === "default");
  const assumed = (id: string) => {
    const r = rows.find((x) => x.id === id);
    if (!r) return plan.inputs.some((i) => i.parameter.id === id) ? "" : w.assumed.fixed;
    return r.law === "lognormal" ? w.assumed.lognormal(param(r.mean), formatSig(r.sd, 3), param(r.low), param(r.high)) : r.law === "uniform" ? w.assumed.uniform(param(r.low), param(r.high)) : w.assumed.fixed;
  };
  return (
    <section className="sensitivity-section uncertainty-inputs" aria-label={w.inputsTitle} data-uncertainty-inputs>
      <h3>{w.inputsTitle}</h3>
      <div className="uncertainty-defaults">
        <label>
          <span>{w.allRates}</span>
          <input type="text" inputMode="decimal" aria-label={w.allRatesLabel} title={w.allRatesHelp} value={settings.percent} aria-invalid={defaultBad || undefined} onChange={(e) => setUncertaintySettings(tabId, { percent: e.target.value })} />
          <span aria-hidden>%</span>
        </label>
        <div className="results-views" role="radiogroup" aria-label={w.readingLabel}>
          {(["sd", "range"] as const).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={settings.reading === r} title={w.readingHelp[r]} onClick={() => setUncertaintySettings(tabId, { reading: r })}>
              {w.readings[r]}
            </button>
          ))}
        </div>
        {arrivals > 1 ? (
          <label className="uncertainty-check" title={w.togetherHelp}>
            <input type="checkbox" checked={settings.together} onChange={(e) => setUncertaintySettings(tabId, { together: e.target.checked })} />
            <span>{w.together}</span>
          </label>
        ) : null}
      </div>
      <p className="uncertainty-assumption" data-uncertainty-independence>
        {settings.together && arrivals > 1 ? w.independentTogether : w.independent}
      </p>
      <table className="sweep-table uncertainty-input-table">
        <thead>
          <tr>
            <th scope="col">{w.colInput}</th>
            <th scope="col">{w.colNow}</th>
            <th scope="col">{w.colHow}</th>
            <th scope="col">{w.colAssumed}</th>
          </tr>
        </thead>
        <tbody>
          {parameters.map((p) => {
            const o = settings.overrides[p.id] ?? BLANK_OVERRIDE;
            const name = p.label.replace(/ \(.*\)$/, "");
            const problem = plan.problems[p.id];
            return (
              <tr key={p.id} data-input={p.id}>
                <th scope="row">{name}</th>
                <td>
                  {param(p.current)}
                  {p.unit ? ` ${p.unit}` : ""}
                </td>
                <td className="uncertainty-how">
                  <select aria-label={w.howLabel(name)} value={o.how} onChange={(e) => setUncertaintyOverride(tabId, p.id, { how: e.target.value as How })}>
                    <option value="default">{w.how.default(`${settings.percent.trim() || "0"} %`)}</option>
                    <option value="percent">{w.how.percent}</option>
                    <option value="interval">{w.how.interval}</option>
                    <option value="exact">{w.how.exact}</option>
                  </select>
                  {o.how === "percent" ? (
                    <>
                      <span aria-hidden>±</span>
                      <input type="text" inputMode="decimal" aria-label={w.percentLabel(name)} value={o.percent} aria-invalid={!!problem || undefined} onChange={(e) => setUncertaintyOverride(tabId, p.id, { percent: e.target.value })} />
                      <span aria-hidden>%</span>
                    </>
                  ) : null}
                  {o.how === "interval" ? (
                    <>
                      <input type="text" inputMode="decimal" aria-label={w.lowLabel(name)} title={w.intervalHelp[settings.reading]} value={o.low} aria-invalid={!!problem || undefined} onChange={(e) => setUncertaintyOverride(tabId, p.id, { low: e.target.value })} />
                      <span>{w.intervalTo}</span>
                      <input type="text" inputMode="decimal" aria-label={w.highLabel(name)} title={w.intervalHelp[settings.reading]} value={o.high} aria-invalid={!!problem || undefined} onChange={(e) => setUncertaintyOverride(tabId, p.id, { high: e.target.value })} />
                    </>
                  ) : null}
                </td>
                <td className="uncertainty-assumed">{problem ?? assumed(p.id)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {plan.blocked ? (
        <p className="sensitivity-problem" role="alert" data-uncertainty-problem>
          {plan.blocked}
        </p>
      ) : null}
      <p className="sensitivity-footnote">{w.fitNote}</p>
    </section>
  );
}

// ── The answer ──────────────────────────────────────────────────────────────────────────────────

interface ReportProps {
  tabId: string;
  analysis: UncertaintyAnalysis;
  measure: MeasureChoice;
  parameters: SweepParameter[];
  format: (x: number) => string;
  mode: "chart" | "table";
  /** The linear-only route: the tier and name of the method that was differentiated. */
  tierOfLinear: { tier: NonNullable<NumericPlan["method"]>["tier"]; method: string } | null;
  notes?: string[];
}

function Report({ analysis: a, measure, parameters, format, mode, tierOfLinear, notes = [] }: ReportProps) {
  const unit = unitText(measure.unit);
  const s = a.sampling;
  const value = a.value ?? 0;
  /** Three significant digits, for sentences and the chart; the tables keep the app's decimals. */
  const short = (x: number) => formatSig(x, 3);
  const est = (e: Estimate | null) => (e ? `${format(e.value)} ± ${formatSig(e.se, 2)}` : "—");
  const share = (e: Estimate | null) => (e ? `${pctText(e.value * 100)} ± ${pctText(e.se * 100)}` : "—");
  const withUnit = (text: string) => (unit ? `${text} ${unit}` : text);
  const order = rankedShares(a.shares);
  const lead = recommendation(a, parameters, measure.noun);
  const off = linearIsOff(a);
  const limit = pctText(a.threshold * 100);
  const spread = (a.linear?.sd ?? 0) > 0 || (s?.sd ?? 0) > 0;

  const exact = TIER_STYLE.exact.color;
  const approx = TIER_STYLE.approximation.color;
  const sampledShares = order.some((r) => r.first);
  const series: BarSeries[] = [...(sampledShares ? [{ key: "sampled", label: w.seriesSampled, color: exact }] : []), { key: "linear", label: w.seriesLinear, color: approx, hatched: sampledShares }];
  const pct = (x: number) => Math.max(0, Math.min(100, x * 100));
  const bars: BarRow[] = order.map((r) => ({
    key: r.ids.join("+"),
    label: shareLabel(r, parameters),
    values: [...(sampledShares ? [r.first ? { value: pct(r.first.value), interval: r.first.se > 0 ? { low: pct(r.first.value - 2 * r.first.se), high: pct(r.first.value + 2 * r.first.se) } : null } : null] : []), { value: pct(r.linear) }],
  }));

  // The mean is not among them: where the laws allow overload there is none (`meanExists`).
  const stable = s && s.median && s.q025 && s.q975 && s.histogram ? { median: s.median, q025: s.q025, q975: s.q975, histogram: s.histogram } : null;
  const noMean = !!s && !s.meanExists;
  const momentRows = (
    <>
      <tr data-uncertainty-row="mean">
        <th scope="row">{w.rows.mean}</th>
        {s ? <td>{noMean ? w.noFiniteMean : est(s.mean)}</td> : null}
        <td>{format(value)}</td>
      </tr>
      <tr data-uncertainty-row="sd">
        <th scope="row">{w.rows.sd}</th>
        {s ? <td>{noMean ? w.noFiniteSd : s.sd !== null ? format(s.sd) : "—"}</td> : null}
        <td>{a.linear ? format(a.linear.sd) : "—"}</td>
      </tr>
    </>
  );
  const overloadPct = s ? pctText(s.pUnstable.value * 100) : "";

  return (
    <>
      {tierOfLinear ? (
        <p className="sensitivity-tier" title={w.tierLinearHelp(tierOfLinear.method)} data-uncertainty-tier="approximation">
          <TierMark tier="approximation" />
          <strong>{w.tierLinear(w.tiers[tierOfLinear.tier], tierOfLinear.method)}</strong>
          <span className="sensitivity-experimental" title={w.experimentalHelp}>
            {w.experimental}
          </span>
          <span className="sensitivity-value">{w.valueNow(measure.label, format(value), unit)}</span>
        </p>
      ) : s ? (
        <p className="sensitivity-tier" title={w.tierSampledHelp(count(s.samples), count(s.evaluations), s.seed)} data-uncertainty-tier="exact">
          <TierMark tier="exact" />
          <strong>{w.tierSampled(count(s.samples))}</strong>
          <span className="sensitivity-value">{w.valueNow(measure.label, format(value), unit)}</span>
        </p>
      ) : null}
      {s ? (
        <p className="uncertainty-overload" data-tone={s.unstable > 0 ? "warning" : "quiet"} title={w.overloadHelp} data-uncertainty-overload>
          {s.unstable > 0 ? <Icon icon={TriangleAlert} size={14} aria-hidden /> : null}
          <strong>{s.unstable === 0 ? w.noOverload(count(s.samples)) : s.unstable === s.samples ? w.allOverload : w.overload(overloadPct, pctText(s.pUnstable.se * 100))}</strong>
          {s.unstable > 0 && s.unstable < s.samples ? <span>{w.conditional}</span> : null}
        </p>
      ) : null}
      {stable ? (
        <p className="uncertainty-reading" data-uncertainty-reading>
          {spread ? w.reading(measure.noun, short(stable.q025.value), short(stable.q975.value), short(stable.median.value), short(value), unit) : w.noSpread}
        </p>
      ) : a.linear && !s ? (
        <p className="uncertainty-reading" data-uncertainty-reading>
          {spread ? w.readingLinear(measure.noun, short(a.linear.low), short(a.linear.high), short(value), unit) : w.noSpread}
          {spread && a.linear.low < 0 ? ` ${w.negativeLow}` : ""}
        </p>
      ) : null}
      {lead && spread ? (
        <p className="uncertainty-reading uncertainty-lead" title={w.recommendHelp} data-uncertainty-recommendation>
          {lead}
        </p>
      ) : null}
      {s && stable && noMean ? (
        <p className="results-note" data-tone="warning" role="note" data-uncertainty-linear="off" data-uncertainty-no-mean>
          <Icon icon={TriangleAlert} size={12} aria-hidden />
          {w.noFiniteMeanNote}
          {spread && a.disagreement !== null ? ` ${a.disagreement > a.threshold ? w.intervalDisagrees(pctText(a.disagreement * 100), limit) : w.intervalAgrees(limit)}` : ""}
        </p>
      ) : s && stable && spread ? (
        <p className="results-note" data-tone={off ? "warning" : undefined} role="note" data-uncertainty-linear={off ? "off" : "agrees"}>
          {off ? <Icon icon={TriangleAlert} size={12} aria-hidden /> : null}
          {off ? (a.disagreement !== null ? w.disagree(pctText(a.disagreement * 100), limit) : w.heavyTail) : w.agree(limit)}
          {off && s.unstable > 0 && a.disagreement !== null ? ` ${w.heavyTail}` : ""}
        </p>
      ) : null}
      {notes.length ? (
        <p className="results-note" data-tone="warning" role="note" data-uncertainty-notes>
          <Icon icon={TriangleAlert} size={12} aria-hidden />
          {notes.join(" ")}
        </p>
      ) : null}
      {mode === "chart" ? (
        <>
          {stable && a.linear && spread ? (
            <ChartFrame className="results-chart-card">
              {({ width, fontScale }) => (
                <HistogramChart
                  width={width}
                  fontScale={fontScale}
                  title={w.histTitle(measure.label)}
                  subtitle={w.histSubtitle(count(s!.samples - s!.unstable))}
                  caption={w.histCaption(
                    measure.noun,
                    short(stable.q025.value),
                    short(stable.q975.value),
                    short(stable.median.value),
                    short(value),
                    unit,
                    [stable.histogram.above > 0 ? w.histAbove(pctText((100 * stable.histogram.above) / Math.max(1, s!.samples - s!.unstable)), short(stable.histogram.high)) : null, stable.q975.value > stable.histogram.high ? w.histBeyond(short(stable.q975.value)) : null].filter(Boolean).join(" ") || null,
                  )}
                  axisLabel={w.histAxis(measure.label, unit)}
                  unit={unit}
                  format={short}
                  histogram={stable.histogram}
                  nominal={value}
                  median={stable.median.value}
                  q025={stable.q025.value}
                  q975={stable.q975.value}
                  linear={a.linear}
                />
              )}
            </ChartFrame>
          ) : null}
          {bars.length && spread ? (
            <ChartFrame className="results-chart-card">
              {({ width, fontScale }) => (
                <BarChart
                  width={width}
                  fontScale={fontScale}
                  rows={bars}
                  series={series}
                  title={w.sharesTitle(measure.label)}
                  subtitle={w.sharesSubtitle}
                  axisLabel={w.sharesAxis}
                  unit="%"
                  rowTitle={w.sharesRow}
                  format={(x) => String(Number(x.toFixed(1)))}
                  caption={sampledShares ? w.sharesCaption(lead) : w.sharesCaptionLinear(lead)}
                />
              )}
            </ChartFrame>
          ) : null}
        </>
      ) : (
        <>
          <div className="results-chart-card sweep-table-card">
            <table className="sweep-table uncertainty-table" data-uncertainty-table>
              <caption>{w.tableCaption(measure.label)}</caption>
              <thead>
                <tr>
                  <th scope="col">{w.colQuantity}</th>
                  {s ? <th scope="col">{withUnit(w.colSampled)}</th> : null}
                  <th scope="col">{withUnit(w.colLinear)}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{w.rows.nominal}</th>
                  {s ? <td>{format(value)}</td> : null}
                  <td>{format(value)}</td>
                </tr>
                {noMean ? null : momentRows}
                <tr>
                  <th scope="row">{w.rows.median}</th>
                  {s ? <td>{est(s.median)}</td> : null}
                  <td>{format(value)}</td>
                </tr>
                <tr>
                  <th scope="row">{w.rows.q025}</th>
                  {s ? <td>{est(s.q025)}</td> : null}
                  <td>{a.linear ? format(a.linear.low) : "—"}</td>
                </tr>
                <tr>
                  <th scope="row">{w.rows.q975}</th>
                  {s ? <td>{est(s.q975)}</td> : null}
                  <td>{a.linear ? format(a.linear.high) : "—"}</td>
                </tr>
                <tr>
                  <th scope="row">{w.rows.overload}</th>
                  {s ? <td>{`${overloadPct} ± ${pctText(s.pUnstable.se * 100)}`}</td> : null}
                  <td>{w.notSeen}</td>
                </tr>
                {noMean ? momentRows : null}
              </tbody>
            </table>
          </div>
          <div className="results-chart-card sweep-table-card">
            <table className="sweep-table uncertainty-table" data-uncertainty-shares>
              <caption>{w.sharesTableCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{w.sharesRow}</th>
                  {sampledShares ? (
                    <>
                      <th scope="col" title={w.firstHelp}>
                        {w.colFirst}
                      </th>
                      <th scope="col" title={w.totalHelp}>
                        {w.colTotal}
                      </th>
                    </>
                  ) : null}
                  <th scope="col" title={w.linearShareHelp}>
                    {w.colLinearShare}
                  </th>
                  <th scope="col">{w.colDerivative(unit)}</th>
                </tr>
              </thead>
              <tbody>
                {order.map((r) => (
                  <tr key={r.ids.join("+")}>
                    <th scope="row">{shareLabel(r, parameters)}</th>
                    {sampledShares ? (
                      <>
                        <td>{share(r.first)}</td>
                        <td>{share(r.total)}</td>
                      </>
                    ) : null}
                    <td>{pctText(r.linear * 100)}</td>
                    <td>{r.ids.map((id) => formatSig(a.inputs.find((i) => i.id === id)?.derivative ?? NaN, 4)).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s && s.shareRows > 0 ? <p className="sensitivity-footnote">{w.sharesNote(count(s.shareRows))}</p> : null}
          </div>
        </>
      )}
    </>
  );
}
