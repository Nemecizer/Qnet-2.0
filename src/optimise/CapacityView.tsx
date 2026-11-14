// The Results pane's Capacity view (new in 2.1, ROADMAP D5): the student states a problem — one
// or several targets, what a server (or a unit of service rate) costs at each station, which
// stations may change and within what limits — and the view answers with the cheapest plan: a
// table of now against proposed, each target's value now and under the plan, a line saying how
// the plan is known to be cheapest, one sentence to read aloud, the trade-off curve (cost against
// delay: steep, then flat — the teaching picture), Apply (one undo step) and Try as What-If Sweep.
//
// Two routes, always labelled. A Jackson network is answered by closed formula (Rust,
// `capacity_plan`): exact, instant, and recomputed whenever the network or the problem changes.
// Any other network is searched on request over quiet runs (./runner.ts), Experimental, and kept
// until the network or the problem changes. The view reaches its document only through its own
// elements, so it draws the same docked or in a detached window.
import { useEffect, useMemo, useRef, useState } from "react";
import { Scale, TriangleAlert } from "lucide-react";
import { ChartFrame, LineChart } from "../charts";
import { Icon } from "../components/Icon";
import { displayFixed } from "../editor/numbers";
import { api } from "../lib/api";
import { runCommand } from "../lib/commands";
import { agreementWords } from "../panes/results/agreement/words";
import { useCurrentFingerprint } from "../panes/results/fingerprint";
import { openSweepPanel, SWEEP_COMMAND } from "../sweeps/commands";
import { tidy } from "../sweeps/model";
import { TierMark } from "../sweeps/SweepPanel";
import { aboutTime } from "../sweeps/words";
import { useWorkspace } from "../workspace/store";
import { applyCapacityPlan, planParameter } from "./commands";
import { capacityChart, changes, constraintText, costText, DEFAULT_STATION, infeasibleSentence, isMet, param, problemKey, proofLine, readForm, reading, stationsOf, suggestedDelay, TARGET_KINDS, unitText, type CapacityForm, type CapacityPlan, type CapacityResult, type StationForm } from "./model";
import { runCapacitySearch, searchRoute, type SearchRoute } from "./runner";
import { planIsStale, setCapacityForm, useCapacityForm, useCapacityPlan } from "./store";
import { capacityWords as w, type TargetKind } from "./words";
import "../panes/results/charts/charts.css";
import "../sweeps/sweeps.css";
import "./capacity.css";
import { SaveAsScenarioButton, scenarioWords } from "../scenarios";

export interface CapacityViewProps {
  tabId: string;
  /** `output.decimals`: how the values are shown. */
  decimals: number;
}

export function CapacityView({ tabId, decimals }: CapacityViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tab = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId) ?? null);
  const doc = tab?.document ?? null;
  const form = useCapacityForm(tabId);
  const saved = useCapacityPlan(tabId);
  const fingerprint = useCurrentFingerprint(doc);
  const format = (x: number) => displayFixed(x, decimals);
  const stations = useMemo(() => (doc ? stationsOf(doc) : []), [doc]);
  const stated = useMemo(() => (doc && stations.length ? readForm(doc, form) : null), [doc, form, stations]);
  const key = stated ? problemKey(stated.request) : null;

  // The exact route: asked again whenever the network or the problem changes.
  const [answer, setAnswer] = useState<{ key: string; plan: CapacityPlan | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!stated || key === null) return;
    let live = true;
    api.capacityPlan(stated.request).then(
      (plan) => live && setAnswer({ key, plan, error: null }),
      (e) => live && setAnswer({ key, plan: null, error: e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e) }),
    );
    return () => {
      live = false;
    };
    // `key` stands for the problem; `doc` for the network.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key]);
  const plan = answer?.plan ?? null;

  // A first target for a form nobody has touched: a fifth off the delay now, or 80 % utilisation where the network is overloaded.
  useEffect(() => {
    if (form.touched || !plan?.available || TARGET_KINDS.some((k) => form.targets[k].on)) return;
    const targets = plan.delayNow !== null ? { ...form.targets, networkSojourn: { on: true, text: suggestedDelay(plan.delayNow, plan.delayFloor) } } : { ...form.targets, utilisation: { on: true, text: "80" } };
    setCapacityForm(tabId, { targets, touched: false });
  }, [form, plan, tabId]);

  // The route over solver runs, asked for only when no formula applies.
  const numeric = plan !== null && !plan.available && plan.reason === "notJackson";
  const [route, setRoute] = useState<SearchRoute | null>(null);
  useEffect(() => {
    if (!numeric || !tab) return;
    let live = true;
    void searchRoute(tab).then((r) => live && setRoute(r));
    return () => {
      live = false;
    };
    // The route follows the network.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numeric, doc]);
  const [busy, setBusy] = useState(false);
  const search = () => {
    if (!stated || !route?.method) return;
    setBusy(true);
    void runCapacitySearch(tabId, stated.request, route.method).finally(() => setBusy(false));
  };

  const empty = (title: string, message: string, action?: { label: string; help: string; run: () => void; disabled?: boolean }, extra?: string) => (
    <div className="empty-state results-empty results-charts-empty">
      <Icon icon={Scale} size={20} aria-hidden />
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

  let result: CapacityResult | null = null;
  let body: React.ReactNode = null;
  let showForm = true;
  if (!doc || !stated || key === null) {
    body = empty(w.emptyTitle, w.emptyMessage);
    showForm = false;
  } else if (!answer) body = empty(w.working, "");
  else if (answer.error) body = empty(w.brokenTitle, answer.error);
  else if (plan?.available) {
    if (answer.key === key && !stated.problem) result = { route: "formula", tier: "exact", method: null, plan, ended: "met", runs: 0, key };
  } else if (plan?.reason === "closed" || plan?.reason === "closedNoPopulation") {
    body = empty(w.closedTitle, plan.sentence ?? "");
    showForm = false;
  } else if (plan?.reason === "network" || plan?.reason === "noTraffic") {
    body = empty(w.brokenTitle, plan.sentence ?? "", undefined, w.seeProblems);
    showForm = false;
  } else if (form.decision === "rates") body = empty(w.numericTitle, plan?.sentence ?? "", undefined, w.numericRatesOnly);
  else if (stated.problem) body = null;
  else if (saved && saved.key === key) result = saved;
  else if (!route) body = empty(w.working, "");
  else if (!route.method) {
    body = route.simulationOnly ? empty(w.simulationOnlyTitle, w.simulationOnly, { label: w.simulationAction, help: w.trySweepHelp(""), run: () => void runCommand(SWEEP_COMMAND) }) : empty(w.numericTitle, w.noMethod);
  } else {
    body = empty(w.numericTitle, plan?.sentence ?? "", { label: w.numericAction, help: w.numericActionHelp, disabled: busy, run: search }, w.numericMessage(route.method.name, w.tiers[route.method.tier], route.runs, route.seconds !== null ? aboutTime(route.seconds) : null));
  }

  const patchTarget = (kind: TargetKind, patch: Partial<{ on: boolean; text: string }>) => setCapacityForm(tabId, { targets: { ...form.targets, [kind]: { ...form.targets[kind], ...patch } } });
  const patchStation = (id: string, patch: Partial<StationForm>) => setCapacityForm(tabId, { stations: { ...form.stations, [id]: { ...(form.stations[id] ?? DEFAULT_STATION), ...patch } } });
  const hint = (kind: TargetKind): { text: string; help?: string }[] => {
    if (!plan?.available) return [];
    const out: { text: string; help?: string }[] = [];
    const now = kind === "networkSojourn" ? plan.delayNow : kind === "networkNumber" ? plan.numberNow : kind === "utilisation" ? (plan.stations.every((s) => s.utilisationNow !== null) ? Math.max(...plan.stations.map((s) => s.utilisationNow!)) : null) : (plan.constraints.find((c) => c.kind === "stationWait")?.now ?? null);
    if (now !== null) out.push({ text: w.hintNow(constraintText({ kind }, now, format)) });
    else if (kind !== "stationWait" && plan.delayNow === null) out.push({ text: w.hintOverloaded });
    if (form.decision === "servers" && plan.delayFloor !== null && plan.totalArrivals !== null) {
      if (kind === "networkSojourn") out.push({ text: w.hintFloor(format(plan.delayFloor)), help: w.hintFloorHelp });
      if (kind === "networkNumber") out.push({ text: w.hintFloor(format(plan.delayFloor * plan.totalArrivals)), help: w.hintFloorHelp });
    }
    return out;
  };
  const rates = form.decision === "rates";

  return (
    <div ref={rootRef} className="results-charts capacity-view" data-capacity={result ? result.route : "none"} data-decision={form.decision}>
      <div className="results-charts-bar">
        <div className="results-views" role="radiogroup" aria-label={w.decisionLabel}>
          {(["servers", "rates"] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={form.decision === d} title={w.decisionHelp[d]} onClick={() => setCapacityForm(tabId, { decision: d })}>
              {w.decisions[d]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {result?.route === "runs" && route?.method ? (
          <button type="button" className="btn" title={w.numericActionHelp} disabled={busy} onClick={search}>
            {w.again}
          </button>
        ) : null}
      </div>
      <div className="results-charts-body">
        {showForm && doc ? (
          <>
            <section className="capacity-section" aria-label={w.targetsTitle} data-capacity-targets>
              <h3>
                {w.targetsTitle}
                <small>{w.targetsHelp}</small>
              </h3>
              <ul className="capacity-targets">
                {TARGET_KINDS.map((kind) => {
                  const t = form.targets[kind];
                  const name = w.targets[kind];
                  return (
                    <li key={kind} data-target={kind}>
                      <label title={w.targetHelp[kind]}>
                        <input type="checkbox" checked={t.on} onChange={(e) => patchTarget(kind, { on: e.target.checked })} />
                        {name}
                      </label>
                      {kind === "stationWait" ? (
                        <select aria-label={w.stationOfWait} value={stations.find((s) => s.id === form.waitStationId)?.id ?? stations[0]?.id ?? ""} onChange={(e) => setCapacityForm(tabId, { waitStationId: e.target.value })}>
                          {stations.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <span>{w.atMost}</span>
                      <input type="text" inputMode="decimal" aria-label={w.targetValue(name.replace(/ at$/, ""))} value={t.text} onChange={(e) => patchTarget(kind, { text: e.target.value, on: true })} />
                      <span>{w.targetUnits[kind]}</span>
                      {hint(kind).map((h) => (
                        <span key={h.text} className="capacity-hint" title={h.help} data-capacity-hint>
                          {h.text}
                        </span>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="capacity-section" aria-label={w.stationsTitle} data-capacity-stations>
              <h3>{w.stationsTitle}</h3>
              <table className="capacity-stations">
                <thead>
                  <tr>
                    <th scope="col">{w.colStation}</th>
                    <th scope="col">{w.colFree}</th>
                    <th scope="col">{rates ? w.colCostRate : w.colCostServer}</th>
                    {rates ? null : <th scope="col">{w.colLower}</th>}
                    {rates ? null : <th scope="col">{w.colUpper}</th>}
                  </tr>
                </thead>
                <tbody>
                  {stations.map((s) => {
                    const f = form.stations[s.id] ?? DEFAULT_STATION;
                    return (
                      <tr key={s.id} data-station={s.id}>
                        <th scope="row">{s.name}</th>
                        <td>
                          <input type="checkbox" aria-label={w.freeLabel(s.name)} checked={f.free} onChange={(e) => patchStation(s.id, { free: e.target.checked })} />
                        </td>
                        <td>
                          <input type="text" inputMode="decimal" aria-label={w.costLabel(s.name)} disabled={!f.free} value={rates ? f.rateCost : f.cost} onChange={(e) => patchStation(s.id, rates ? { rateCost: e.target.value } : { cost: e.target.value })} />
                        </td>
                        {rates ? null : (
                          <td>
                            <input type="text" inputMode="numeric" aria-label={w.lowerLabel(s.name)} disabled={!f.free} value={f.lower} onChange={(e) => patchStation(s.id, { lower: e.target.value })} />
                          </td>
                        )}
                        {rates ? null : (
                          <td>
                            <input type="text" inputMode="numeric" aria-label={w.upperLabel(s.name)} disabled={!f.free} placeholder={w.noLimit} value={f.upper} onChange={(e) => patchStation(s.id, { upper: e.target.value })} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
            {stated?.problem ? (
              <p className="capacity-problem" role="alert" data-capacity-problem>
                {stated.problem}
              </p>
            ) : null}
          </>
        ) : null}
        {result ? <Report tabId={tabId} result={result} format={format} stale={result.route === "runs" && planIsStale(result, fingerprint)} /> : body}
      </div>
    </div>
  );
}

interface ReportProps {
  tabId: string;
  result: CapacityResult;
  format: (x: number) => string;
  stale: boolean;
}

function Report({ tabId, result, format, stale }: ReportProps) {
  const doc = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId)?.document ?? null);
  const plan = result.plan;
  const rates = plan.decision === "rates";
  const tierLine = result.route === "formula" ? w.tierFormula : w.tierRuns(agreementWords.tierShort[result.tier], result.method?.name ?? "");
  const tierHelp = result.route === "formula" ? w.tierFormulaHelp : w.tierRunsHelp(result.method?.name ?? "");
  const chart = useMemo(() => capacityChart(result, format), [result, format]);
  const changed = changes(plan);
  const sentence = reading(plan, format);
  const proof = proofLine(result);
  const endedNote = result.ended === "met" ? null : result.ended === "outOfRuns" ? w.ended.outOfRuns(result.runs) : w.ended[result.ended];
  const notes = [stale ? w.staleNote : null, plan.infeasible ? null : endedNote].filter(Boolean);
  const amount = (s: CapacityPlan["stations"][number], now: boolean) => (rates ? param(now ? s.rateNow : s.rate) : String(now ? s.serversNow : s.servers));
  const change = (s: CapacityPlan["stations"][number]) => {
    const d = rates ? s.rate - s.rateNow : s.servers - s.serversNow;
    if (!changed.includes(s)) return w.noChange;
    return `${d > 0 ? "+" : "−"}${rates ? param(Math.abs(d)) : Math.abs(d)}`;
  };
  const sweep = () => {
    const s = changed[0] ?? plan.stations.find((x) => x.free);
    const p = s && doc ? planParameter(doc, plan, s.id) : null;
    if (!s || !p) return;
    // The range of the plan, never into overload: a rate stays above the arrival rate, a count above the load.
    const [lo, hi] = rates ? [Math.max(Math.min(s.rateNow, s.rate) * 0.9, s.load * s.rateNow * 1.02), Math.max(s.rateNow, s.rate) * 1.25] : [Math.max(Math.floor(s.load) + 1, Math.min(s.serversNow, s.servers) - 1), Math.max(s.serversNow, s.servers) + 2];
    openSweepPanel({ tabId, from: { parameter: p, from: tidy(lo), to: tidy(hi), values: new Array(rates ? 12 : hi - lo + 1).fill(0), methods: [], metric: "Mean sojourn time", stationId: s.id } });
  };
  const sweepStation = changed[0] ?? plan.stations.find((x) => x.free);

  return (
    <>
      <p className="capacity-tier" title={tierHelp} data-capacity-tier={result.tier}>
        <TierMark tier={result.tier} />
        <strong>{tierLine}</strong>
        {result.route === "runs" ? (
          <span className="capacity-experimental" title={w.experimentalHelp}>
            {w.experimental}
          </span>
        ) : null}
      </p>
      {notes.length ? (
        <p className="results-note" data-tone="warning" role="note">
          <Icon icon={TriangleAlert} size={12} aria-hidden />
          {notes.join(" ")}
        </p>
      ) : null}
      {plan.infeasible ? (
        <div className="capacity-infeasible" role="alert" data-capacity-infeasible={plan.infeasible.why}>
          <h3>
            <Icon icon={TriangleAlert} size={14} aria-hidden />
            {w.infeasibleTitle}
          </h3>
          <p>{infeasibleSentence(plan, format)}</p>
        </div>
      ) : (
        <>
          {sentence ? (
            <p className="capacity-reading" data-capacity-reading>
              {sentence}
            </p>
          ) : null}
          <p className="capacity-proof" title={proof.help} data-capacity-proof={plan.proof} data-proven={proof.proven}>
            {proof.text}
          </p>
          <div className="results-chart-card sweep-table-card">
            <table className="sweep-table capacity-table" data-capacity-plan>
              <caption>{w.planCaption(plan.decision)}</caption>
              <thead>
                <tr>
                  <th scope="col">{w.colStation}</th>
                  <th scope="col">{w.colNow}</th>
                  <th scope="col">{w.colProposed}</th>
                  <th scope="col">{w.colChange}</th>
                  <th scope="col">{w.colCostNow}</th>
                  <th scope="col">{w.colCost}</th>
                </tr>
              </thead>
              <tbody>
                {plan.stations.map((s) => (
                  <tr key={s.id} data-station={s.id}>
                    <th scope="row">
                      {s.name}
                      {s.free ? null : (
                        <span className="capacity-held" title={w.heldHelp}>
                          {w.held}
                        </span>
                      )}
                    </th>
                    <td>{amount(s, true)}</td>
                    <td>{amount(s, false)}</td>
                    <td data-change={!changed.includes(s) ? "none" : (rates ? s.rate > s.rateNow : s.servers > s.serversNow) ? "more" : "fewer"}>{change(s)}</td>
                    <td>{rates && !s.free ? w.noChange : costText(s.costNow)}</td>
                    <td>{rates && !s.free ? w.noChange : costText(s.cost)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{w.total}</th>
                  <td />
                  <td />
                  <td />
                  <td data-capacity-cost-now>{costText(plan.costNow)}</td>
                  <td data-capacity-cost>{plan.cost !== null ? costText(plan.cost) : w.noChange}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
      {plan.constraints.length ? (
        <div className="results-chart-card sweep-table-card">
          <table className="sweep-table capacity-table" data-capacity-constraints>
            <caption>{w.targetsCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{w.colTarget}</th>
                <th scope="col">{w.colLimit}</th>
                <th scope="col">{w.colNow}</th>
                <th scope="col">{w.colProposed}</th>
                <th scope="col">{w.colUnit}</th>
                <th scope="col">{w.colMet}</th>
              </tr>
            </thead>
            <tbody>
              {plan.constraints.map((c, k) => (
                <tr key={k} data-constraint={c.kind}>
                  <th scope="row">{w.constraintName(c.kind, plan.stations.find((s) => s.id === c.stationId)?.name ?? null)}</th>
                  <td>{constraintText(c, c.target, format)}</td>
                  <td>{c.now !== null ? constraintText(c, c.now, format) : plan.delayNow === null ? w.overloaded : w.noChange}</td>
                  <td>{c.proposed !== null ? constraintText(c, c.proposed, format) : w.noChange}</td>
                  <td>{unitText(c.unit)}</td>
                  <td data-met={c.proposed !== null ? isMet(c, c.proposed) : undefined}>{c.proposed === null ? w.noChange : isMet(c, c.proposed) ? w.met : w.notMet}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!plan.infeasible ? (
        <div className="capacity-actions">
          <button type="button" className="btn primary" title={changed.length ? w.applyHelp : w.nothingToApply} disabled={stale || !changed.length} onClick={() => applyCapacityPlan(tabId, plan)}>
            {w.apply}
          </button>
          <SaveAsScenarioButton tabId={tabId} name={scenarioWords.capacityName} disabled={stale || !changed.length} apply={() => applyCapacityPlan(tabId, plan)} />
          <button type="button" className="btn" title={w.trySweepHelp(sweepStation?.name ?? "")} disabled={!sweepStation} onClick={sweep}>
            {w.trySweep}
          </button>
        </div>
      ) : null}
      {chart && !plan.infeasible ? <ChartFrame className="results-chart-card">{({ width, fontScale }) => <LineChart {...chart} width={width} fontScale={fontScale} />}</ChartFrame> : null}
    </>
  );
}

export type { CapacityForm };
