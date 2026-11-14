// The tools the assistant explains with (new in 2.1, ROADMAP E4). Each is a thin wrapper over
// what the interface itself shows: the shared reading of runs (src/results/insight.ts), Live
// Results, the Problems, Sensitivity, Plan Capacity, Uncertainty, Transient, the Method Chooser
// and the bundled Help. Nothing is computed here: every number is the one a Qnet command or
// shared function answered with, handed on as a fact with a handle (./facts.ts).
//
// Where the logic lives decides who answers. The reading of runs and the Help text exist only in
// the interface, so these tools are fulfilled by the interface, as 0.90.34's nine are (../tools.ts);
// the ones that need arithmetic ask Rust through the same `api` methods the views use.
//
// Reading tools change nothing and start no solver. The four that act follow the rules the
// existing tools set (../tools.ts): `solve` and `check_with_another_method` are the Run menu's
// commands and, like `run_command`, refuse while the conversation's tab is not in front and need
// no confirmation; `apply_capacity_plan` edits the network, so it waits while a dialog is open or
// a node is dragged, as the editing tools do. Two things a person would be surprised by ask
// first: a sweep (many solver runs) and applying a plan (several stations changed at once).
import { api } from "../../../lib/api";
import type { BnetDocument } from "../../../lib/bnet";
import { ask } from "../../../lib/dialogs";
import { modalOpen } from "../../../lib/overlays";
import type { AiToolSpec } from "../../../lib/types";
import { sentence as problemSentence } from "../../../canvas/validation/words";
import { applyCapacityPlan } from "../../../optimise/commands";
import { changes, DEFAULT_FORM, readForm, type CapacityPlan } from "../../../optimise/model";
import type { TargetKind } from "../../../optimise/words";
import { agreement, bottlenecks, currentRuns, STATION_METRICS, stationValues, tierOf } from "../../../results/insight";
import { resultsFor, reloadResults } from "../../../runs/state";
import { liveRun } from "../../../runs/ui/live";
import { fromAnalysis, measureOptions, ranked, requestFor as sensitivityRequest, type MeasureChoice, type MeasureKind, type SensitivityResult } from "../../../sensitivity/model";
import { chosenParameters, runCount } from "../../../sensitivity/runner";
import { estimateIsStale, sensitivityEstimate } from "../../../sensitivity/store";
import { sensitivityWords } from "../../../sensitivity/words";
import { specItem } from "../../../lib/menuSpec";
import { specOf, summaryLine, type SweepForm } from "../../../sweeps/commands";
import { classesServed, discoverParameters, type SweepParameter } from "../../../sweeps/model";
import { defaultRange, methodsFor, runSweep, sweepRunning } from "../../../sweeps/runner";
import { showSweepView } from "../../../sweeps/store";
import { peak, requestFor as transientRequest, DEFAULT_SETTINGS as TRANSIENT_DEFAULTS } from "../../../transient/model";
import { nextTransientId } from "../../../transient/store";
import { DEFAULT_SETTINGS as UNCERTAINTY_DEFAULTS, planOf, rankedShares, requestFor as uncertaintyRequest, shareLabel, shareValue, uncertainParameters } from "../../../uncertainty/model";
import { TOPICS, topic, topicMatches, topicText } from "../../../windows/help/topics";
import { tabById } from "../../../workspace/store";
import { adviceFor } from "../../results/agreement/chooser";
import { checkWithAnother, solve } from "../../results/agreement/commands";
import { sequenceRunning } from "../../results/agreement/runner";
import { fingerprintNow } from "../../results/fingerprint";
import { asResult, type ResultRecord } from "../../results/model";
import { formattedLine } from "../../status/entries";
import { runCommandRefusal, ToolCancelled, ToolError, type ToolContext } from "../tools";
import { featureSentences } from "../../../extended/model";
import { networkKeyOf, num, Sheet, slug, type FactTarget } from "./facts";
import { EXPLAIN_TOOL_TEXT as T } from "./prompt";

type Input = Record<string, unknown>;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const number = (description: string, extra: Record<string, unknown> = {}) => ({ type: "number", description, ...extra });

export const MEASURES = ["network_delay", "network_number", "station_delay", "station_number", "station_queue", "station_utilisation"] as const;
const MEASURE_KIND: Record<(typeof MEASURES)[number], MeasureKind> = { network_delay: "networkSojourn", network_number: "networkNumber", station_delay: "stationSojourn", station_number: "stationNumber", station_queue: "stationQueue", station_utilisation: "stationUtilisation" };
const MEASURE_SLUG: Record<MeasureKind, string> = { networkSojourn: "delay", networkNumber: "number", stationSojourn: "delay", stationNumber: "number", stationQueue: "queue", stationUtilisation: "utilisation" };
export const TARGETS = ["network_delay", "network_number", "utilisation_percent", "station_wait"] as const;
const TARGET_KIND: Record<(typeof TARGETS)[number], TargetKind> = { network_delay: "networkSojourn", network_number: "networkNumber", utilisation_percent: "utilisation", station_wait: "stationWait" };
const METRIC_SLUG: Record<string, string> = { Utilization: "utilisation", "Server utilization": "utilisation", "Mean number in system": "number", "Mean sojourn time": "sojourn", "Mean queue length": "queue", Throughput: "throughput" };
const metricSlug = (metric: string) => METRIC_SLUG[metric] ?? slug(metric.toLowerCase());

const STATION = str("A station's name, to narrow the answer to it.");
const MEASURE = str("The measure asked about.", { enum: [...MEASURES] });
const MEASURE_STATION = str("The station's name; required for a station_… measure.");

export const EXPLAIN_SPECS: AiToolSpec[] = [
  { name: "get_results", description: T.get_results, inputSchema: object({ station: STATION }) },
  { name: "get_agreement", description: T.get_agreement, inputSchema: object({ station: STATION }) },
  { name: "get_live_results", description: T.get_live_results, inputSchema: object({}) },
  { name: "get_problems", description: T.get_problems, inputSchema: object({}) },
  { name: "get_parameters", description: T.get_parameters, inputSchema: object({}) },
  { name: "get_sensitivity", description: T.get_sensitivity, inputSchema: object({ measure: MEASURE, station: MEASURE_STATION, target_change_percent: number("Optional: also answer what each parameter would have to be to change the measure by this many percent (−10 cuts it by a tenth).", { minimum: -99, maximum: 1000 }) }, ["measure"]) },
  {
    name: "plan_capacity",
    description: T.plan_capacity,
    inputSchema: object({ target: str("What must be met.", { enum: [...TARGETS] }), value: number("The target: a time for network_delay and station_wait, customers for network_number, a percentage (1–100) for utilisation_percent.", { exclusiveMinimum: 0 }), station: str("The station's name, for station_wait."), decide: str("What may change: the number of servers (default) or the service rates.", { enum: ["servers", "rates"] }) }, ["target", "value"]),
  },
  { name: "get_uncertainty", description: T.get_uncertainty, inputSchema: object({ measure: MEASURE, station: MEASURE_STATION, percent: number("How uncertain every arrival and service rate is, in percent (default 10).", { exclusiveMinimum: 0, maximum: 300 }), reading: str("Whether the percentage is a standard deviation (default) or a range.", { enum: ["sd", "range"] }) }, ["measure"]) },
  {
    name: "get_transient",
    description: T.get_transient,
    inputSchema: object({ start: str("Where the network starts (default empty).", { enum: ["empty", "steady"] }), horizon: number("How long to follow it, in time units (default: Qnet's suggestion).", { exclusiveMinimum: 0 }), surge_factor: number("Optional: multiply every arrival rate by this between surge_from and surge_until.", { minimum: 0 }), surge_from: number("Start of the surge.", { minimum: 0 }), surge_until: number("End of the surge.", { exclusiveMinimum: 0 }) }),
  },
  { name: "list_methods", description: T.list_methods, inputSchema: object({}) },
  { name: "get_help", description: T.get_help, inputSchema: object({ topic: str("A topic id from list_methods or an earlier get_help, or a few words to search for ('QNA', 'sensitivity', 'closed networks')."), part: { type: "integer", minimum: 1, description: "Which part of a long article (default 1)." } }, ["topic"]) },
  { name: "solve", description: T.solve, inputSchema: object({}) },
  { name: "check_with_another_method", description: T.check_with_another_method, inputSchema: object({}) },
  {
    name: "run_sweep",
    description: T.run_sweep,
    inputSchema: object({ parameter: str("The parameter to vary: a name from get_parameters, without the 'net:' ('mu_S2', 'lambda_Src1', 'servers_S2')."), from: number("First value (default: Qnet's suggested range)."), to: number("Last value."), points: { type: "integer", minimum: 2, maximum: 12, description: "How many values (default 8, at most 12)." }, metric: str("What to read at each point (default Utilization).", { enum: [...STATION_METRICS] }), station: str("The station to read it at (default: the first station).") }, ["parameter"]),
  },
  { name: "apply_capacity_plan", description: T.apply_capacity_plan, inputSchema: object({}) },
];

/** The tools that only read: they change nothing and start no solver run. */
export const READ_TOOLS = new Set(["get_results", "get_agreement", "get_live_results", "get_problems", "get_parameters", "get_sensitivity", "plan_capacity", "get_uncertainty", "get_transient", "list_methods", "get_help"]);
/** The tools that run solvers or change the network. */
export const ACTION_TOOLS = new Set(["solve", "check_with_another_method", "run_sweep", "apply_capacity_plan"]);
/** Of those, the ones that edit the network (they wait while a dialog is open or a node is dragged). */
export const EXPLAIN_EDITING_TOOLS = new Set(["apply_capacity_plan"]);

// ── Asking first ────────────────────────────────────────────────────────────────────────────────

export interface Question {
  title: string;
  message: string;
  confirmTitle: string;
}
const askInDialog = (q: Question) => ask(q).then((a) => a.confirmed);
let confirmer: (q: Question) => Promise<boolean> = askInDialog;
/** For tests: answers the question instead of the dialog; null puts the dialog back. */
export function setConfirmer(f: ((q: Question) => Promise<boolean>) | null) {
  confirmer = f ?? askInDialog;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function documentOf(tabId: string): BnetDocument {
  const tab = tabById(tabId);
  if (!tab) throw ToolError.executionFailed("The conversation's tab has closed.");
  return tab.document;
}

const stationsOf = (doc: BnetDocument) => doc.nodes.filter((n) => n.kind === "station");

function stationNamed(doc: BnetDocument, name: unknown, required = false) {
  if (typeof name !== "string" || !name.trim()) {
    if (required) throw ToolError.invalidInput(`\`station\` is required. Stations: ${stationsOf(doc).map((s) => s.name).sort().join(", ") || "(none)"}.`);
    return null;
  }
  const s = stationsOf(doc).find((n) => n.name === name.trim());
  if (!s) throw ToolError.invalidInput(`No station named "${name}". Stations: ${stationsOf(doc).map((x) => x.name).sort().join(", ") || "(none)"}.`);
  return s;
}

const shortId = (id: string) => id.slice(0, 8).toLowerCase();
const station = (stationId: string | null): FactTarget => (stationId ? { kind: "station", stationId } : { kind: "none" });

/** A parameter's name in a handle: "mu_S2", "lambda_Src1", "servers_S2", "p_S1>S2". */
export function parameterSlug(doc: BnetDocument, p: SweepParameter): string {
  const name = (id: string | undefined) => slug(doc.nodes.find((n) => n.id === id)?.name ?? "x");
  switch (p.kind) {
    case "load":
      return "load";
    case "population":
      return "population";
    case "arrival":
      return `lambda_${name(p.nodeId)}`;
    case "service":
      // The class is named only where the station serves more than one.
      return `mu_${name(p.nodeId)}${typeof p.customerClass === "number" && classesServed(doc, p.nodeId ?? "").length > 1 ? `_c${p.customerClass + 1}` : ""}`;
    case "servers":
      return `servers_${name(p.nodeId)}`;
    case "buffer":
      return `buffer_${name(p.nodeId)}`;
    case "routing": {
      const link = doc.links.find((l) => l.id === p.linkId);
      return `p_${name(link?.fromNodeID)}>${name(link?.toNodeID)}${link && link.customerClass ? `_c${link.customerClass + 1}` : ""}`;
    }
  }
}
const parameterUnit = (p: SweepParameter) => (p.kind === "servers" ? "servers" : p.kind === "arrival" || p.kind === "service" ? "per time unit" : p.kind === "routing" ? "probability" : p.kind === "buffer" || p.kind === "population" ? "customers" : "");

async function runsNow(tabId: string): Promise<{ runs: ResultRecord[]; older: number; fingerprint: string | null }> {
  const doc = documentOf(tabId);
  const [fingerprint] = await Promise.all([fingerprintNow(doc), reloadResults(tabId).catch(() => {})]);
  const records = resultsFor(tabId).map(asResult);
  const runs = currentRuns(records, fingerprint);
  const finished = records.filter((r) => (r.status === "completed" || r.status === "partial") && tierOf(r) !== "mixed" && r.measurements.length);
  return { runs, older: Math.max(0, new Set(finished.map((r) => r.method.identifier)).size - runs.length), fingerprint };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** How often a waiting tool looks for Stop. Tests shorten it. */
export const EXPLAIN_WAIT = { intervalMs: 200 };

/** Waits for `p`, giving up when Stop is pressed (`onStop` tells the work to stop too, where it can). */
async function until<T>(p: Promise<T>, ctx: ToolContext, onStop?: () => void): Promise<T> {
  let settled = false;
  const done = p.finally(() => (settled = true));
  done.catch(() => {});
  while (!settled) {
    await Promise.race([done.catch(() => {}), sleep(EXPLAIN_WAIT.intervalMs)]);
    if (!settled && ctx.cancelled()) {
      onStop?.();
      throw new ToolCancelled();
    }
  }
  return done;
}

const NO_RESULTS = (older: number) =>
  `No results: no method has been run on the network as it is now.${older ? ` (${older} earlier result${older === 1 ? " is" : "s are"} of an older version of the network and no longer apply.)` : ""}\n` +
  "Do not state any result. Say that nothing has been solved yet and offer to run Solve (the `solve` tool) — ask before running it. `get_live_results` may have closed-form values meanwhile.";

// ── Reading tools ───────────────────────────────────────────────────────────────────────────────

async function getResults(input: Input, { tabId }: ToolContext): Promise<string> {
  const doc = documentOf(tabId);
  const only = stationNamed(doc, input.station);
  const { runs, older } = await runsNow(tabId);
  if (!runs.length) return NO_RESULTS(older);
  const sheet = new Sheet(tabId);
  sheet.say(`${runs.length} current result${runs.length === 1 ? "" : "s"} for this network, best evidence first. Tiers, best first: exact, simulation, approximation, diffusion, bound.${older ? ` ${older} older result${older === 1 ? "" : "s"} of an earlier version of the network are left out.` : ""}`);
  for (const run of runs) {
    const id = shortId(run.id);
    const tier = tierOf(run) + (run.status === "partial" ? " (the run ended early: partial)" : "");
    const source = `${run.method.displayName} (run ${id})`;
    sheet.say(`\nRun ${id} — ${run.method.displayName} — tier: ${tier}${run.warnings.length ? ` — ${run.warnings.length} warning(s)` : ""}`);
    const top = bottlenecks(run);
    if (top.length && !only) sheet.say(`Bottleneck (highest utilisation): ${top.map((s) => s.stationName).join(" and ")}${top.length > 1 ? " (a tie)" : ""}.`);
    for (const metric of STATION_METRICS) {
      for (const v of stationValues(run, metric)) {
        if (only && v.stationID !== only.id) continue;
        const unit = run.measurements.find((m) => m.stationID === v.stationID && (METRIC_SLUG[m.metric] ?? "") === metricSlug(metric))?.unit ?? "";
        sheet.fact({ handle: `run:${id}:${slug(v.stationName)}:${metricSlug(metric)}`, what: `${metric} at ${v.stationName}`, value: v.value, ...(v.interval ? { low: v.interval.low, high: v.interval.high } : {}), unit, tier: tierOf(run), source, target: { kind: "run", runId: run.id, stationId: v.stationID } });
      }
    }
    if (!only) {
      for (const m of run.measurements) {
        if (m.stationID || typeof m.customerClass === "number") continue;
        sheet.fact({ handle: `run:${id}:network:${metricSlug(m.metric)}`, what: `${m.metric} (${m.stationName || "whole network"})`, value: m.estimate, unit: m.unit, tier: tierOf(run), source, target: { kind: "run", runId: run.id, stationId: null } });
      }
    }
  }
  return sheet.text("Ask again with `station` for one station.");
}

async function getAgreement(input: Input, { tabId }: ToolContext): Promise<string> {
  const doc = documentOf(tabId);
  const only = stationNamed(doc, input.station);
  const { runs, older } = await runsNow(tabId);
  if (!runs.length) return NO_RESULTS(older);
  const a = agreement(runs);
  const sheet = new Sheet(tabId);
  sheet.say(`Verdict over ${a.compared} quantit${a.compared === 1 ? "y" : "ies"} that more than one method reports: ${a.verdict}.`);
  sheet.say(T.verdicts);
  sheet.say(`Methods read: ${a.methods.map((m) => `${m.shortName} (${m.tier})`).join(", ")}.`);
  if (a.compared === 0) sheet.say("Only one method has run, so nothing has been cross-checked. Say so; `check_with_another_method` would run a second one (ask first).");
  for (const q of a.quantities) {
    if (only && q.stationID !== only.id) continue;
    const scored = q.values.filter((v) => !v.isBound);
    if (scored.length < 2) continue;
    const where = `${slug(q.stationName || "network")}${q.classLabel === "All" ? "" : `.${q.classLabel}`}`;
    sheet.say(`\n${q.metric} at ${q.stationName || "the network"}${q.classLabel === "All" ? "" : `, class ${q.classLabel}`} — ${q.verdict}${q.referenceUncertain ? " (the reference simulation's interval is too wide to settle it)" : ""}${q.reference ? `; reference: ${q.reference.shortName}` : "; no exact or simulated reference"}`);
    for (const v of q.values) {
      const base = `agree:${where}:${metricSlug(q.metric)}:${slug(v.shortName)}`;
      const target: FactTarget = { kind: "agreement", stationId: q.stationID };
      sheet.fact({ handle: base, what: `${v.shortName}${v.isReference ? " (reference)" : v.isBound ? " (a bound, not an estimate)" : ""}${v.partial ? " (partial run)" : ""}`, value: v.estimate, ...(v.interval ? { low: v.interval.low, high: v.interval.high } : {}), unit: q.unit, tier: v.tier, source: `${v.shortName} (run ${shortId(v.runId)})`, target });
      if (v.deviation !== null && !v.isReference) sheet.fact({ handle: `${base}:dev`, what: `${v.shortName}'s difference from the reference, relative${v.withinInterval ? " (inside the reference's interval)" : ""}`, value: v.deviation, unit: "ratio", tier: v.tier, source: `Agreement of ${v.shortName} with ${q.reference?.shortName ?? "the reference"}`, target });
    }
  }
  return sheet.text("Ask again with `station` for one station.");
}

async function getLiveResults(_input: Input, { tabId }: ToolContext): Promise<string> {
  const doc = documentOf(tabId);
  if (!doc.nodes.length) return "The canvas is empty: there is nothing to compute.";
  const r = await api.liveResults(doc);
  const sheet = new Sheet(tabId);
  const source = "Live results (closed form, nothing was run)";
  if (r.tier === "none") return `Live results have nothing for this network${r.reasonDetail ? `: ${r.reasonDetail}` : "."} Do not state any number from them.`;
  sheet.say(r.tier === "exact" ? "Live results — tier: exact (closed formulas; no solver was run)." : `Live results — only the load at each station is known${r.reasonDetail ? `: ${r.reasonDetail}` : "."} No queue lengths or delays: do not state any.`);
  if (r.closed) sheet.say(`This is a closed network: a fixed population circulates. Network throughput is the rate of passes through ${doc.nodes.find((n) => n.id === r.closed!.referenceStation)?.name ?? r.closed.referenceStation}; the network delay is the mean cycle time.`);
  if (!r.utilisationExact) sheet.say("The ρ values below are offered loads, not long-run utilisations (the network is overloaded or loses customers): say 'offered load'.");
  const names = r.bottlenecks.map((id) => r.perStation.find((s) => s.stationId === id)?.stationName).filter(Boolean);
  if (names.length) sheet.say(`Bottleneck (highest ρ): ${names.join(" and ")}${names.length > 1 ? " (a tie)" : ""}.`);
  const tier = r.tier === "exact" ? "exact" : "exact load only";
  for (const s of r.perStation) {
    const at = slug(s.stationName);
    const target = station(s.stationId);
    const put = (key: string, what: string, value: number | null, unit: string) => {
      if (value !== null) sheet.fact({ handle: `live:${at}:${key}`, what: `${what} at ${s.stationName}`, value, unit, tier, source, target });
    };
    put("rho", r.utilisationExact ? "Utilisation ρ" : "Offered load ρ", s.utilisation, "ratio");
    put("throughput", "Throughput", s.throughput, "customers / time");
    if (r.tier !== "exact") continue;
    put("number", "Mean number in system", s.meanInSystem, "customers");
    put("queue", "Mean number waiting", s.meanWaiting, "customers");
    put("sojourn", "Mean time at the station", s.meanSojourn, "time");
    put("wait", "Mean wait before service", s.meanWait, "time");
  }
  if (r.network && r.tier === "exact") {
    const target: FactTarget = { kind: "none" };
    sheet.fact({ handle: "live:network:throughput", what: "Network throughput", value: r.network.throughput, unit: "customers / time", tier, source, target });
    sheet.fact({ handle: "live:network:number", what: r.closed ? "Population" : "Mean number in the network", value: r.network.meanNumber, unit: "customers", tier, source, target });
    sheet.fact({ handle: "live:network:delay", what: r.closed ? "Mean cycle time" : "Mean delay through the network", value: r.network.meanDelay, unit: "time", tier, source, target });
  }
  return sheet.text();
}

const SEVERITY_WORD = { error: "Error", warning: "Warning", info: "Note" } as const;
export const MAX_PROBLEMS = 20;

async function getProblems(_input: Input, { tabId }: ToolContext): Promise<string> {
  const doc = documentOf(tabId);
  const all = await api.networkDiagnostics(doc);
  if (!all.length) return "Qnet's checks find no problems with this network.";
  const sheet = new Sheet(tabId);
  const count = (s: string) => all.filter((d) => d.severity === s).length;
  sheet.say(`${count("error")} error(s), ${count("warning")} warning(s), ${count("info")} note(s). Errors stop a run; warnings make results doubtful; notes are for information. The sentences are Qnet's own.`);
  all.slice(0, MAX_PROBLEMS).forEach((d, i) => {
    const target: FactTarget = { kind: "problem", nodeId: d.nodeIds[0] ?? null, linkId: d.linkIds[0] ?? null };
    sheet.say(`\n${i + 1}. ${SEVERITY_WORD[d.severity]} (${d.code})${d.values.name ? ` at ${d.values.name}` : ""}: ${problemSentence(d)}`);
    for (const [key, value] of Object.entries(d.values)) {
      if (typeof value !== "number") continue;
      const unit = key === "rho" || key === "sum" || key === "exit" ? "ratio" : key === "servers" || key === "suggestedServers" ? "servers" : key === "arrivalRate" || key === "serviceRate" || key === "suggestedRate" ? "per time unit" : "";
      sheet.fact({ handle: `problem:${i + 1}:${key}`, what: `${key}${d.values.name ? ` at ${d.values.name}` : ""}`, value, unit, tier: "exact check", source: `Problems: ${d.code}`, target });
    }
  });
  if (all.length > MAX_PROBLEMS) sheet.say(`(${all.length - MAX_PROBLEMS} more problems are not listed.)`);
  return sheet.text();
}

async function getParameters(_input: Input, { tabId }: ToolContext): Promise<string> {
  const doc = documentOf(tabId);
  if (!doc.nodes.length) return "The canvas is empty.";
  const sheet = new Sheet(tabId);
  const info = await api.appInfo().catch(() => null);
  if (info) sheet.passage({ handle: "app:version", what: "Software", text: `Qnet ${info.version}`, source: "This copy of Qnet", target: { kind: "none" } });
  sheet.say(`The network's parameters as drawn (inputs, not results). Buffers: ${doc.infiniteBuffers ? "infinite" : "finite"}.${typeof doc.closedPopulation === "number" ? " A closed network." : ""}`);
  for (const p of discoverParameters(doc)) {
    if (p.kind === "load") continue;
    sheet.fact({ handle: `net:${parameterSlug(doc, p)}`, what: p.label, value: p.current, unit: parameterUnit(p), tier: "input", source: "The network as drawn", target: station(p.nodeId ?? null) });
  }
  for (const n of doc.nodes) if (n.kind === "station" || n.kind === "source") sheet.say(`${n.name}: ${n.kind === "station" ? "service" : "interarrival"} times ${n.distribution} (${n.distributionParameters}).`);
  // New in 2.1: priorities, batch sizes and rate profiles, in whole sentences, so the network
  // cannot be explained as a plain first-come-first-served one (review finding FIX-208d).
  const features = doc.nodes.flatMap(featureSentences);
  if (features.length) {
    sheet.say("This is not a plain network of first-come-first-served stations with single arrivals at a constant rate. Say so when you describe it:");
    for (const f of features) sheet.say(f);
  }
  return sheet.text();
}

function measureFrom(doc: BnetDocument, input: Input): MeasureChoice {
  const raw = input.measure;
  if (typeof raw !== "string" || !(MEASURES as readonly string[]).includes(raw)) throw ToolError.invalidInput(`\`measure\` must be one of: ${MEASURES.join(", ")}.`);
  const kind = MEASURE_KIND[raw as (typeof MEASURES)[number]];
  const options = measureOptions(doc);
  if (!options.length) throw ToolError.executionFailed("The network has no stations.");
  const stationId = kind.startsWith("station") ? stationNamed(doc, input.station, true)!.id : null;
  const found = options.find((m) => m.kind === kind && m.stationId === stationId);
  if (!found) throw ToolError.executionFailed("That measure is not available for this network.");
  return found;
}
const measureKey = (doc: BnetDocument, m: MeasureChoice) => (m.stationId ? `${slug(doc.nodes.find((n) => n.id === m.stationId)?.name ?? "x")}.` : "") + MEASURE_SLUG[m.kind];

/** The menu command that opens the Sensitivity view, and the button there that makes the numerical estimate, as the interface names them. */
const SENSITIVITY_COMMAND = "run:sensitivity"; // src/sensitivity/commands.ts
const SENSITIVITY_PATH = `Run ▸ ${specItem(SENSITIVITY_COMMAND)?.label ?? "Sensitivity…"}`;
const ESTIMATE_BUTTON = `“${sensitivityWords.numericAction}”`;

async function getSensitivity(input: Input, { tabId }: ToolContext): Promise<string> {
  const doc = documentOf(tabId);
  const measure = measureFrom(doc, input);
  const change = typeof input.target_change_percent === "number" && input.target_change_percent !== 0 ? input.target_change_percent / 100 : null;
  const { parameters } = chosenParameters(doc);
  const analysis = await api.sensitivityAnalyze(sensitivityRequest(doc, measure, parameters, change));
  let result: SensitivityResult | null = fromAnalysis(analysis, measure, parameters, change);
  if (!result) {
    // The numerical route's estimate, when the person has made one for this measure and network.
    const held = sensitivityEstimate(tabId);
    const fingerprint = await fingerprintNow(doc);
    if (held && held.measureKey === measure.key && !held.stopped && !estimateIsStale(held, fingerprint)) result = held;
    else {
      // Said outright, so the model can pass it on: this tool only reads an estimate the person
      // has made, which one is held (if any) and why it does not count, and the command that makes one.
      const why = !held
        ? "No numerical estimate has been made for this network."
        : held.stopped
          ? "The numerical estimate the person started was stopped before it finished."
          : held.measureKey !== measure.key
            ? "The person's numerical estimate is for a different measure."
            : "The person's numerical estimate is for the network as it was before it changed.";
      return (
        `No sensitivity results: ${analysis.sentence ?? "the exact formulas do not apply to this network."}\n` +
        `${why} get_sensitivity reports a numerical estimate only when the person has already made one for this measure and this network; it never starts one.\n` +
        `To make one the person chooses ${SENSITIVITY_PATH}, then ${ESTIMATE_BUTTON} in the Sensitivity view (about ${runCount(parameters)} solver runs; the assistant cannot start it). Tell the person this. Do not state any derivative or elasticity.`
      );
    }
  }
  const key = measureKey(doc, measure);
  const sheet = new Sheet(tabId);
  const tier = result.tier;
  const source = result.route === "formula" ? "Sensitivity, closed formula (Jackson network)" : `Sensitivity, numerical derivative of ${result.method?.name ?? "a method"}`;
  const target: FactTarget = { kind: "view", view: "sensitivity" };
  sheet.say(`Sensitivity of ${measure.noun} — tier: ${tier}${result.route === "formula" ? " (closed formulas; nothing was run)" : ` (central differences over runs of ${result.method?.name ?? "a method"})`}.`);
  if (result.route !== "formula") sheet.say(`This is the numerical estimate the person made with ${SENSITIVITY_PATH} ▸ ${ESTIMATE_BUTTON}; this tool read it and ran nothing. It holds for the network and the measure it was made for.`);
  sheet.say(T.elasticity);
  sheet.fact({ handle: `sens:${key}:value`, what: `${measure.label} now`, value: result.value, unit: measure.unit, tier, source, target });
  if (result.target !== null) sheet.fact({ handle: `sens:${key}:target`, what: `${measure.label} asked for`, value: result.target, unit: measure.unit, tier: "input", source, target });
  const top = result.bottlenecks.map((id) => result!.stations.find((s) => s.id === id)?.name).filter(Boolean);
  if (top.length) sheet.say(`Bottleneck (highest utilisation): ${top.join(" and ")}${top.length > 1 ? " (a tie)" : ""}.`);
  for (const s of result.stations) sheet.fact({ handle: `sens:${key}:rho_${slug(s.name)}`, what: `Utilisation at ${s.name}`, value: s.utilisation, unit: "ratio", tier, source, target: station(s.id) });
  sheet.say("\nParameters, the one that moves the measure most first:");
  const order = [...ranked(result.rows), ...result.rows.filter((r) => !ranked(result!.rows).includes(r))];
  for (const row of order) {
    const p = row.parameter;
    const base = `sens:${key}:${parameterSlug(doc, p)}`;
    const put = (suffix: string, what: string, value: number | null, unit: string, t: string = tier) => {
      if (value !== null) sheet.fact({ handle: base + suffix, what, value, unit, tier: t, source, target });
    };
    put("", `Elasticity with respect to ${p.label}`, row.elasticity, "");
    put(":derivative", `Derivative with respect to ${p.label}`, row.derivative, "");
    put(":current", `${p.label} now`, p.current, parameterUnit(p), "input");
    put(":one_more", `${measure.label} with one more (${p.label})`, row.oneMore, measure.unit);
    if (row.inversion?.kind === "achieved") put(":needed", `${p.label} needed to reach the target`, row.inversion.value, parameterUnit(p));
    else if (row.inversion) sheet.say(`${p.label} alone cannot reach the target (${row.inversion.why}).`);
    if (row.note) sheet.say(`Note on ${p.label}: ${row.note}`);
  }
  if (result.leftOut) sheet.say(`(${result.leftOut} parameters were not analysed.)`);
  return sheet.text();
}

/** The plan `plan_capacity` last made for a tab, for `apply_capacity_plan`. */
const lastPlans = new Map<string, { plan: CapacityPlan; networkKey: string | null }>();
export function forgetPlans(tabId?: string) {
  if (tabId === undefined) lastPlans.clear();
  else lastPlans.delete(tabId);
}

async function planCapacity(input: Input, { tabId }: ToolContext): Promise<string> {
  const doc = documentOf(tabId);
  const raw = input.target;
  if (typeof raw !== "string" || !(TARGETS as readonly string[]).includes(raw)) throw ToolError.invalidInput(`\`target\` must be one of: ${TARGETS.join(", ")}.`);
  if (typeof input.value !== "number" || !(input.value > 0)) throw ToolError.invalidInput("`value` must be a positive number.");
  const kind = TARGET_KIND[raw as (typeof TARGETS)[number]];
  const at = kind === "stationWait" ? stationNamed(doc, input.station, true) : null;
  const decision = input.decide === "rates" ? "rates" : "servers";
  const form = { ...DEFAULT_FORM, decision, waitStationId: at?.id ?? null, targets: { ...DEFAULT_FORM.targets, [kind]: { on: true, text: String(input.value) } } } as typeof DEFAULT_FORM;
  const read = readForm(doc, form);
  if (read.problem) throw ToolError.invalidInput(read.problem);
  const plan = await api.capacityPlan(read.request);
  lastPlans.delete(tabId);
  if (!plan.available) return `No capacity plan: ${plan.sentence ?? "the exact formulas do not apply to this network."} Do not propose numbers of servers or rates.`;
  const sheet = new Sheet(tabId);
  const source = "Plan Capacity (exact formulas)";
  const target: FactTarget = { kind: "view", view: "capacity" };
  const fact = (handle: string, what: string, value: number | null, unit: string, tier = "exact") => {
    if (value !== null) sheet.fact({ handle: `cap:${handle}`, what, value, unit, tier, source, target });
  };
  sheet.say(`Capacity plan — tier: exact (closed formulas for this network; nothing was run). Deciding: ${decision === "rates" ? "service rates" : "numbers of servers"}.`);
  for (const c of plan.constraints) {
    fact("target", "The target asked for", c.target, c.unit, "input");
    fact("target:now", "The same measure now", c.now, c.unit);
    fact("target:proposed", "The same measure under the plan", c.proposed, c.unit);
  }
  fact("delay_now", "Mean delay through the network now", plan.delayNow, "time");
  fact("number_now", "Mean number in the network now", plan.numberNow, "customers");
  if (plan.infeasible || plan.cost === null) {
    sheet.say(`The target cannot be met (${plan.infeasible?.why ?? "no feasible plan"}). Say so plainly; do not propose a plan.`);
    fact("delay_floor", "The lowest delay any plan could reach", plan.delayFloor, "time");
    return sheet.text();
  }
  fact("delay", "Mean delay through the network under the plan", plan.delay, "time");
  fact("number", "Mean number in the network under the plan", plan.number, "customers");
  fact("cost_now", "Cost now", plan.costNow, "");
  fact("cost", "Cost of the plan", plan.cost, "");
  sheet.say(`Whether it is the cheapest: proof = ${plan.proof ?? "none"}${plan.proof === "none" || plan.proof === null ? " — NOT proved cheapest; say so" : ""}. (get_help "capacity" explains the kinds of proof.)`);
  const moved = changes(plan);
  sheet.say(moved.length ? `Stations that change: ${moved.map((s) => s.name).join(", ")}.` : "Nothing needs to change: the target is met as drawn.");
  for (const s of plan.stations) {
    const k = slug(s.name);
    if (decision === "rates") {
      fact(`${k}:rate_now`, `Service rate at ${s.name} now`, s.rateNow, "per time unit", "input");
      fact(`${k}:rate`, `Service rate at ${s.name} under the plan`, s.rate, "per time unit");
    } else {
      fact(`${k}:servers_now`, `Servers at ${s.name} now`, s.serversNow, "servers", "input");
      fact(`${k}:servers`, `Servers at ${s.name} under the plan`, s.servers, "servers");
    }
    fact(`${k}:utilisation`, `Utilisation at ${s.name} under the plan`, s.utilisation, "ratio");
  }
  if (moved.length) {
    lastPlans.set(tabId, { plan, networkKey: networkKeyOf(tabId) });
    sheet.say("Nothing has been changed. `apply_capacity_plan` would change the network to this plan; it asks the person first.");
  }
  return sheet.text();
}

async function getUncertainty(input: Input, ctx: ToolContext): Promise<string> {
  const { tabId } = ctx;
  const doc = documentOf(tabId);
  const measure = measureFrom(doc, input);
  const percent = typeof input.percent === "number" ? input.percent : 10;
  const reading = input.reading === "range" ? "range" : "sd";
  const parameters = uncertainParameters(doc);
  const plan = planOf(parameters, { ...UNCERTAINTY_DEFAULTS, percent: String(percent), reading });
  if (plan.blocked) throw ToolError.invalidInput(plan.blocked);
  const a = await until(api.uncertaintyAnalyze(uncertaintyRequest(doc, measure, plan, false), () => {}), ctx);
  if (!a.available || a.value === null) return `No uncertainty analysis: ${a.sentence ?? "the exact formulas do not apply to this network."} Do not state any interval.`;
  const key = measureKey(doc, measure);
  const sheet = new Sheet(tabId);
  const target: FactTarget = { kind: "view", view: "uncertainty" };
  const unit = measure.unit;
  const sampled = "Monte Carlo over the uncertain rates, each case solved exactly";
  sheet.say(`Uncertainty of ${measure.noun} when every arrival and service rate is uncertain by ${num(percent)} % (${reading === "sd" ? "a standard deviation, lognormal" : "a range, uniform"}), independently.`);
  sheet.fact({ handle: `unc:${key}:percent`, what: "Uncertainty assumed in every rate, percent", value: percent, unit: "", tier: "input", source: "The question asked", target });
  sheet.fact({ handle: `unc:${key}:value`, what: `${measure.label} at the drawn values`, value: a.value, unit, tier: "exact", source: "Exact formulas", target });
  const s = a.sampling;
  if (s) {
    const put = (suffix: string, what: string, e: { value: number; se?: number } | number | null, u = unit) => {
      const value = typeof e === "number" ? e : (e?.value ?? null);
      if (value !== null) sheet.fact({ handle: `unc:${key}:${suffix}`, what, value, unit: u, tier: "simulation", source: sampled, target });
    };
    put("samples", "Cases sampled", s.samples, "");
    put("p_unstable", "Share of cases in which the network is overloaded", s.pUnstable, "ratio");
    if (!s.meanExists) sheet.say("Some cases overload a station the measure depends on, so its mean and standard deviation do not exist: do not state them. The median and the quantiles below are over all cases.");
    put("mean", "Mean over the cases", s.mean);
    put("sd", "Standard deviation over the cases", s.sd);
    put("median", "Median", s.median);
    put("q025", "2.5 % quantile (lower end of the middle 95 % of cases)", s.q025);
    put("q975", "97.5 % quantile (upper end of the middle 95 % of cases)", s.q975);
  }
  if (a.linear) {
    sheet.fact({ handle: `unc:${key}:linear_sd`, what: "Standard deviation by the linear approximation", value: a.linear.sd, unit, tier: "approximation", source: "First-order (delta method)", target });
    if (a.disagreement !== null && a.disagreement > a.threshold) sheet.say("The linear approximation is far from the sampled answer here: prefer the sampled numbers and say the response is not linear.");
  }
  sheet.say("\nShare of the measure's variance each rate explains, largest first:");
  for (const row of rankedShares(a.shares).slice(0, 8)) {
    const p = parameters.find((x) => x.id === row.ids[0]);
    const name = row.ids.length > 1 ? "arrivals" : p ? parameterSlug(doc, p) : slug(row.ids[0]);
    sheet.fact({ handle: `unc:${key}:share:${name}`, what: `Share explained by ${shareLabel(row, parameters)}`, value: shareValue(row), unit: "ratio", tier: row.first ? "simulation" : "approximation", source: row.first ? sampled : "First-order (delta method)", target });
  }
  return sheet.text();
}

async function getTransient(input: Input, ctx: ToolContext): Promise<string> {
  const { tabId } = ctx;
  const doc = documentOf(tabId);
  const prepare = await api.transientPrepare(doc);
  if (prepare.exactReason && prepare.fluidReason) return `No transient analysis: ${prepare.exactReason} ${prepare.fluidReason} Do not describe how the network evolves in numbers.`;
  const surge = typeof input.surge_factor === "number";
  const settings = { ...TRANSIENT_DEFAULTS, initial: input.start === "steady" ? ("steady" as const) : ("empty" as const), horizon: typeof input.horizon === "number" ? String(input.horizon) : "", surge, factor: String(input.surge_factor ?? ""), from: String(input.surge_from ?? ""), until: String(input.surge_until ?? "") };
  const id = nextTransientId();
  const made = transientRequest(settings, prepare, doc, id);
  if ("problem" in made) throw ToolError.invalidInput(made.problem);
  const a = await until(api.transientAnalyze(made.request, () => {}), ctx, () => void api.transientStop(id).catch(() => {}));
  if (a.stopped) throw new ToolCancelled();
  const sheet = new Sheet(tabId);
  const target: FactTarget = { kind: "view", view: "transient" };
  const curves = a.exact?.mean ?? a.fluid?.level ?? null;
  if (!curves) return `No transient analysis: ${a.exactReason ?? ""} ${a.fluidReason ?? ""}`.trim();
  const tier = a.exact ? "exact" : "approximation";
  const source = a.exact ? "Transient, exact (uniformisation on a truncated state space; values are lower bounds)" : "Transient, fluid approximation (no randomness)";
  sheet.say(`Mean number at each station over time, starting ${settings.initial === "steady" ? "in steady state" : "empty"}${surge ? ", with a surge in arrivals" : ""} — tier: ${a.exact ? "exact (computed lower bounds on the true means, with a proven shortfall)" : `fluid approximation only${a.exactReason ? ` (${a.exactReason})` : ""}`}.`);
  sheet.fact({ handle: "trans:horizon", what: "Time followed", value: made.request.horizon, unit: "time", tier: "input", source: "The question asked", target });
  if (made.request.surge) {
    sheet.fact({ handle: "trans:surge:factor", what: "Arrival rates multiplied by", value: made.request.surge.factor, unit: "", tier: "input", source: "The question asked", target });
    sheet.fact({ handle: "trans:surge:from", what: "Surge starts", value: made.request.surge.from, unit: "time", tier: "input", source: "The question asked", target });
    sheet.fact({ handle: "trans:surge:until", what: "Surge ends", value: made.request.surge.until, unit: "time", tier: "input", source: "The question asked", target });
  }
  a.stations.forEach((s, i) => {
    const k = slug(s.name);
    const curve = curves[i];
    if (!curve?.length) return;
    const put = (suffix: string, what: string, value: number | null | undefined, unit: string, t = tier, src = source) => {
      if (typeof value === "number") sheet.fact({ handle: `trans:${k}:${suffix}`, what: `${what} at ${s.name}`, value, unit, tier: t, source: src, target });
    };
    const top = peak(a.times, curve);
    put("start", "Mean number at the start", curve[0], "customers");
    put("peak", "Highest mean number", top.value, "customers");
    put("peak_time", "Time of the highest mean number", top.time, "time");
    put("end", "Mean number at the end of the time followed", curve[curve.length - 1], "customers");
    put("stationary", "Long-run mean number", s.stationary, "customers", "exact", "Steady state, exact");
    if (a.exact) {
      put("settling", "Time to settle near the long-run value", a.exact.settling[i], "time");
      if (a.exact.uncertified[i]) sheet.say(`A settling time for ${s.name} could not be certified: do not give one.`);
      put("shortfall", "Most the true mean can exceed the computed one", a.exact.shortfall[i], "customers", "bound");
    }
    put("relaxation", "Relaxation time", s.relaxation, "time", "exact", "Steady state, exact");
  });
  return sheet.text();
}

export const MAX_METHODS = 30;

async function listMethods(_input: Input, { tabId }: ToolContext): Promise<string> {
  const tab = tabById(tabId);
  if (!tab) throw ToolError.executionFailed("The conversation's tab has closed.");
  if (!tab.document.nodes.length) return "The canvas is empty: no method applies.";
  const advice = await adviceFor(tab);
  if (!advice) return "Qnet could not classify this network, so it cannot say which methods apply. `get_problems` may say why.";
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  const lines = [
    "Qnet's methods for this network, in the Method Chooser's order (recommended first). 'unavailable' means the method does not apply or its solver is not installed; the reason follows.",
    advice.domain.analytical ? `Analytical solution: ${advice.domain.analytical.title} — ${cut(advice.domain.analytical.detail, 200)}` : "No closed-form analytical solution is known for this network.",
  ];
  for (const r of advice.rows.slice(0, MAX_METHODS)) lines.push(`- ${r.name} — ${r.suitability} — kind: ${r.layer} — ${cut(r.summary, 220)} Assumes: ${cut(r.assumptions, 160)} Help topic: ${r.helpTopic}`);
  if (advice.rows.length > MAX_METHODS) lines.push(`(${advice.rows.length - MAX_METHODS} more are not listed.)`);
  lines.push("To explain a method, read its Help topic with get_help first.");
  return lines.join("\n");
}

/** A Help article is handed over in parts of this many characters. */
export const HELP_PART_CHARS = 5000;

function getHelp(input: Input, { tabId }: ToolContext): string {
  const asked = typeof input.topic === "string" ? input.topic.trim() : "";
  if (!asked) throw ToolError.invalidInput("`topic` is required.");
  const lower = asked.toLowerCase();
  const found = topic(asked) ?? TOPICS.find((t) => t.id.toLowerCase() === lower || t.title.toLowerCase() === lower) ?? TOPICS.find((t) => t.title.toLowerCase().includes(lower) || t.keywords.some((k) => k.toLowerCase().includes(lower))) ?? TOPICS.find((t) => topicMatches(t, asked));
  if (!found) return `Qnet's Help has no article matching "${asked}". Say you don't know rather than explain it from memory. Topics: ${TOPICS.map((t) => t.id).join(", ")}.`;
  const text = topicText(found.id);
  const parts = Math.max(1, Math.ceil(text.length / HELP_PART_CHARS));
  const part = Math.min(parts, Math.max(1, typeof input.part === "number" && Number.isInteger(input.part) ? input.part : 1));
  const sheet = new Sheet(tabId);
  const shown = text.slice((part - 1) * HELP_PART_CHARS, part * HELP_PART_CHARS);
  sheet.passage({ handle: `help:${found.id}`, what: `Qnet Help — ${found.windowTitle}${parts > 1 ? ` (part ${part} of ${parts})` : ""}`, text, source: `Qnet Help: ${found.title}`, target: { kind: "help", topic: found.id } }, shown);
  if (part < parts) sheet.say(`(More follows: get_help with part ${part + 1}.)`);
  sheet.say(`Explain from this text, and put [help:${found.id}] after what you take from it.`);
  // A passage is cut by parts, not by the sheet's own limit.
  return sheet.text().slice(0, HELP_PART_CHARS + 600);
}

// ── Action tools ────────────────────────────────────────────────────────────────────────────────

/** Why a run cannot start now, in the Run menu's own terms, or null. */
function runRefusal(tabId: string): string | null {
  const front = runCommandRefusal(tabId);
  if (front) return front;
  if (modalOpen()) return "Not run: a dialog or parameter panel is open in Qnet. Ask the user to close it, then try again.";
  if (!documentOf(tabId).nodes.length) return "Not run: the canvas is empty.";
  if (sequenceRunning() || liveRun() || sweepRunning()) return "Not run: another run is going. Wait for it to finish, or ask the user to stop it.";
  return null;
}

async function runAndRead(ctx: ToolContext, what: string, run: () => Promise<{ advice: { name: string } } | null>): Promise<string> {
  const refusal = runRefusal(ctx.tabId);
  if (refusal) return refusal;
  const log = () => tabById(ctx.tabId)?.log ?? [];
  const baseline = log().length;
  const picked = await until(run(), ctx);
  const said = log().slice(baseline).map(formattedLine).slice(-12).join("\n");
  if (!picked) return `${what} ran nothing.${said ? `\nStatus:\n${said}` : ""}`;
  const results = await getResults({}, ctx);
  return `${what}: ${picked.advice.name}.${said ? `\nStatus:\n${said}` : ""}\n\n${results}`;
}

const solveTool = (_input: Input, ctx: ToolContext) => runAndRead(ctx, "Solve chose", () => solve(ctx.tabId));
const checkTool = (_input: Input, ctx: ToolContext) => runAndRead(ctx, "Check with Another Method chose", () => checkWithAnother(ctx.tabId));

async function runSweepTool(input: Input, ctx: ToolContext): Promise<string> {
  const { tabId } = ctx;
  const refusal = runRefusal(tabId);
  if (refusal) return refusal;
  const tab = tabById(tabId)!;
  const doc = tab.document;
  const all = discoverParameters(doc);
  const wanted = typeof input.parameter === "string" ? input.parameter.replace(/^net:/, "") : "";
  const parameter = all.find((p) => parameterSlug(doc, p) === wanted) ?? null;
  if (!parameter) throw ToolError.invalidInput(`No parameter named "${wanted}". Parameters: ${all.map((p) => parameterSlug(doc, p)).join(", ") || "(none)"}.`);
  const at = stationNamed(doc, input.station) ?? stationsOf(doc)[0] ?? null;
  const metric = typeof input.metric === "string" && (STATION_METRICS as readonly string[]).includes(input.metric) ? input.metric : "Utilization";
  const offered = await methodsFor(tab);
  const preferred = offered.filter((m) => m.preferred && !m.slow);
  const methods = (preferred.length ? preferred : offered.filter((m) => !m.slow).slice(0, 1)).map((m) => m.label);
  if (!methods.length) return "Not run: no method quick enough to sweep applies to this network. The person can choose a simulation in Run ▸ What-If Sweep….";
  const range = typeof input.from === "number" && typeof input.to === "number" ? { from: input.from, to: input.to } : await defaultRange(doc, parameter);
  const points = typeof input.points === "number" && Number.isInteger(input.points) ? Math.min(12, Math.max(2, input.points)) : 8;
  const form: SweepForm = { parameterId: parameter.id, from: String(range.from), to: String(range.to), points: String(points), methods, metric, stationId: at?.id ?? null };
  const spec = specOf(form, parameter, offered);
  if (!spec) throw ToolError.invalidInput("That range cannot be swept: check `from`, `to` and `points` against the parameter's allowed values.");
  const names = offered.filter((m) => methods.includes(m.label)).map((m) => m.name).join(" and ");
  const yes = await until(confirmer({ title: "Run a what-if sweep?", message: `The assistant wants to vary ${parameter.label} from ${num(spec.from)} to ${num(spec.to)} and solve the network at each value with ${names}. ${summaryLine(form, parameter, offered)} The network itself is not changed.`, confirmTitle: "Run Sweep" }), ctx);
  if (!yes) return "Not run: the person declined the sweep. Do not ask again unless they bring it up.";
  const result = await until(runSweep(tabId, spec), ctx);
  if (!result) return "The sweep could not start, or nothing finished.";
  showSweepView();
  const sheet = new Sheet(tabId);
  const target: FactTarget = { kind: "view", view: "sweep" };
  sheet.say(`What-if sweep of ${parameter.label}: ${metric}${at ? ` at ${at.name}` : ""} at ${result.values.length} values${result.stopped ? " (stopped early)" : ""}. It is shown in Results ▸ Sweep.`);
  for (const limit of result.limits) sheet.fact({ handle: `sweep:limit_${limit.unstable}`, what: `The network is overloaded ${limit.unstable} this value of ${parameter.label}`, value: limit.x, unit: parameterUnit(parameter), tier: "exact check", source: "What-if sweep", target });
  result.methods.forEach((method, mi) => {
    sheet.say(`\n${method.name} — tier: ${method.tier}`);
    result.values.forEach((x, i) => {
      const cell = result.cells[mi]?.[i];
      if (!cell) return;
      if (!cell.ok) return void sheet.say(`At ${num(x)}: no value (${cell.reason}).`);
      const m = cell.m.find((v) => (METRIC_SLUG[v.k] ?? v.k) === metricSlug(metric) && v.s === (at?.id ?? null) && v.c === null);
      if (!m) return;
      sheet.fact({ handle: `sweep:${slug(method.label)}:${i + 1}:x`, what: `${parameter.label}, point ${i + 1}`, value: x, unit: parameterUnit(parameter), tier: "input", source: "What-if sweep", target });
      sheet.fact({ handle: `sweep:${slug(method.label)}:${i + 1}`, what: `${metric}${at ? ` at ${at.name}` : ""} when ${parameter.label} is ${num(x)}`, value: m.v, ...(m.lo !== undefined && m.hi !== undefined ? { low: m.lo, high: m.hi } : {}), unit: m.u, tier: method.tier, source: `What-if sweep, ${method.name}`, target });
    });
  });
  return sheet.text();
}

async function applyCapacityPlanTool(_input: Input, ctx: ToolContext): Promise<string> {
  const { tabId } = ctx;
  const held = lastPlans.get(tabId);
  if (!held) return "Nothing to apply: call plan_capacity first, and apply only a plan the person has seen.";
  if (held.networkKey !== networkKeyOf(tabId)) {
    lastPlans.delete(tabId);
    return "Not applied: the network has changed since the plan was made. Call plan_capacity again.";
  }
  const moved = changes(held.plan);
  const lines = moved.map((s) => (held.plan.decision === "rates" ? `${s.name}: service rate ${num(s.rateNow)} → ${num(s.rate)}` : `${s.name}: ${s.serversNow} → ${s.servers} servers`));
  const yes = await until(confirmer({ title: "Apply the capacity plan?", message: `The assistant wants to change the network:\n${lines.join("\n")}\nEdit ▸ Undo takes it back in one step. Results of the network as it is now will no longer apply.`, confirmTitle: "Apply Plan" }), ctx);
  if (!yes) return "Not applied: the person declined. The network is unchanged. Do not ask again unless they bring it up.";
  const changed = applyCapacityPlan(tabId, held.plan);
  lastPlans.delete(tabId);
  return changed ? `Applied: ${lines.join("; ")}. Earlier results are now of an older network: run Solve again before quoting any result.` : "Nothing changed: the network already matches the plan, or a station of the plan is gone.";
}

export const EXPLAIN_HANDLERS: Record<string, (input: Input, ctx: ToolContext) => string | Promise<string>> = {
  get_results: getResults,
  get_agreement: getAgreement,
  get_live_results: getLiveResults,
  get_problems: getProblems,
  get_parameters: getParameters,
  get_sensitivity: getSensitivity,
  plan_capacity: planCapacity,
  get_uncertainty: getUncertainty,
  get_transient: getTransient,
  list_methods: listMethods,
  get_help: getHelp,
  solve: solveTool,
  check_with_another_method: checkTool,
  run_sweep: runSweepTool,
  apply_capacity_plan: applyCapacityPlanTool,
};
