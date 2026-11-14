// The one way the interface talks to Rust (NetMon's IPC wrapper). Every command has a typed
// method on `api`; every rejection arrives as a CommandError with the Rust side's {kind, message,
// detail?} (src-tauri/src/errors.rs). Identical reads in flight share one promise, because
// React's StrictMode mounts every effect twice.
import { Channel, invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import type { AppInfo, ArchetypeRequest, BuiltArchetype, ExamplesLookup, StabilityReadout, ExportAllReport, GeneratedNetwork, GenerateRequest, ExampleDocument, KvValues, OpenedDocument, PersistenceWarning, SilentAnalysis, SettingSchemaKey, SettingsExportOutcome, SettingsImportOutcome, ActiveRunInfo, RunMessage, RunRecord, RunStartRequest, AiChatRequest, AiEvent, AiModelInfo, AiProvider } from "./types";
import type { SolverLookup, SweepStartRequest } from "./types";
import type { DependencyCatalog, DependencyResult, MethodDomain, PreparedReport, RuntimeAvailability } from "./types";
import type { ShellMessage, ShellStarted } from "./types";
import type { AboutInfo } from "./types";
import type { FailureReport } from "./types";
import type { QuietOutcome, QuietProbe, QuietRunRequest } from "./types";
import type { SensitivityAnalysis, SensitivityRequest } from "../sensitivity/model";
import type { CapacityPlan, CapacityRequest } from "../optimise/model";
import type { LinearRequest, UncertaintyAnalysis, UncertaintyProgress, UncertaintyRequest } from "../uncertainty/model";
import type { TransientAnalysis, TransientPrepare, TransientProgress, TransientRequest } from "../transient/model";
import type { Diagnostic } from "../canvas/validation/model";
import type { LiveResults } from "../live/model";
import type { AnimateChunk, AnimateStart } from "../animate/model";
import type { UpdateCheck, UpdateProgress, UpdateStatus } from "../updates/model";
import type { DataFile, FitReport, FitRequest } from "../fit/model";

/** False when the UI is opened in a plain browser (`npm run dev`) instead of the app. */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** What a command's `QnError` says: `kind` is one of src-tauri/src/errors.rs `ErrorKind`. */
export type ErrorKind = "invalid" | "notFound" | "unavailable" | "cancelled" | "failed";

/** A refusal or failure from a command, in one shape whatever failed. String(e) is the sentence. */
export class CommandError extends Error {
  kind: string;
  detail?: string;
  constructor(e: { kind: string; message: string; detail?: string }) {
    super(e.message);
    this.name = "CommandError";
    this.kind = e.kind;
    if (e.detail) this.detail = e.detail;
  }
  override toString() {
    return this.message;
  }
}

/** `e` as a CommandError when it's a QnError object or its JSON; anything else unchanged. */
export function commandError(e: unknown): unknown {
  if (e instanceof CommandError) return e;
  let v: unknown = e;
  // serde_json may put the keys in any order ({"detail":…,"kind":…}).
  if (typeof e === "string" && e.startsWith("{") && e.includes('"kind"')) {
    try {
      v = JSON.parse(e);
    } catch {
      return e;
    }
  }
  if (v && typeof v === "object" && !(v instanceof Error) && typeof (v as { kind?: unknown }).kind === "string" && typeof (v as { message?: unknown }).message === "string") {
    return new CommandError(v as { kind: string; message: string; detail?: string });
  }
  return e;
}

/**
 * Reads whose identical calls may share one promise while it's in flight: `app_info`, `get_…`,
 * and `…_get/_list/_status/_warnings`. Never a command that changes anything.
 */
const SHARED_READ = /^(app_info|get_[a-z_]+|[a-z_]+_(get|list|status|warnings))$/;
const inFlight = new Map<string, Promise<unknown>>();

/** Whether `cmd` is a read that identical calls in flight share. */
export const isSharedRead = (cmd: string) => SHARED_READ.test(cmd);

async function call<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } catch (e) {
    throw commandError(e);
  }
}

/** Tauri's invoke, with errors in the one shape above. Identical reads in flight share one promise. */
export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (options || !isSharedRead(cmd)) return call<T>(cmd, args, options);
  let key: string;
  try {
    key = `${cmd} ${JSON.stringify(args ?? null)}`;
  } catch {
    return call<T>(cmd, args, options);
  }
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const p = call<T>(cmd, args, options);
  inFlight.set(key, p);
  const forget = () => inFlight.delete(key);
  p.then(forget, forget);
  return p;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  /** Quits now, after the interface's own quit prompts (src-tauri/src/lib.rs). */
  appExit: () => invoke<void>("app_exit"),
  /** Closes the native window labelled `label`, an auxiliary window's (its page's own close doesn't). */
  auxClose: (label: string) => invoke<null>("aux_close", { label }),
  /** The .bnet files Finder asked Qnet to open since the last call (each handed over once). */
  openedFilesTake: () => invoke<string[]>("opened_files_take"),
  /** Files Qnet couldn't read this session and set aside. */
  persistenceWarnings: () => invoke<PersistenceWarning[]>("persistence_warnings"),
  /** Every setting under its 0.90.34 key, defaults filled in (src-tauri/src/settings_schema.rs). */
  settingsGet: () => invoke<KvValues>("settings_get"),
  /** Changes the given settings; `null` resets a key. One bad value refuses the whole patch. */
  settingsPatch: (patch: KvValues) => invoke<KvValues>("settings_patch", { patch }),
  /** Internal state (split sizes, Open Recent, migrations) as stored. */
  stateGet: () => invoke<KvValues>("state_get"),
  statePatch: (patch: KvValues) => invoke<KvValues>("state_patch", { patch }),
  /** Reads a .bnet file through 0.90.34's reader; refuses one that isn't a network. */
  documentRead: (path: string) => invoke<OpenedDocument>("document_read", { path }),
  /** Saves a document atomically, written exactly as 0.90.34 wrote it. */
  documentWrite: (path: string, document: unknown) => invoke<OpenedDocument>("document_write", { path, document }),
  /** Edit ▸ Undo, Cut, Copy… for the focused text field: sent down AppKit's responder chain (src-tauri/src/edit.rs). */
  nativeEdit: (action: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "delete") => invoke<null>("native_edit", { action }),
  /** The saved tab snapshot, 0.90.34's `tabs.persistedState` (src-tauri/src/session.rs), or null. */
  sessionGet: () => invoke<unknown>("session_get"),
  sessionSave: (snapshot: unknown) => invoke<void>("session_save", { snapshot }),
  sessionClear: () => invoke<void>("session_clear"),
  /** The main window's represented file and edited dot (ledger WS-004). */
  windowDocumentState: (path: string | null, edited: boolean) => invoke<void>("window_document_state", { path, edited }),
  /** Where File ▸ Open Example… starts (src-tauri/src/files.rs, ledger WS-114). */
  examplesLocate: () => invoke<ExamplesLookup>("examples_locate"),
  /** Every bundled example, read as `documentRead` reads one (src-tauri/src/welcome.rs; the Welcome gallery). */
  examplesList: () => invoke<ExampleDocument[]>("examples_list"),
  /** A solver input's text ("fbnasim", "qna", "srbm"), or the exporter's refusal. */
  exportText: (format: "fbnasim" | "qna" | "srbm", document: unknown, opts: { convention?: string; generated?: string } = {}) =>
    invoke<string>("export_text", { format, document, convention: opts.convention ?? null, generated: opts.generated ?? null }),
  /** Writes an export's text atomically; resolves to the file name. */
  exportSave: (path: string, text: string) => invoke<string>("export_save", { path, text }),
  /** File ▸ Export ▸ All Solver Inputs to Folder: the seven files, and 0.90.34's Status lines. */
  exportAllInputs: (document: unknown, convention: string, folder: string, generated: string) =>
    invoke<ExportAllReport>("export_all_inputs", { document, convention, folder, generated }),
  /** Network ▸ Generate Random Network: the network and its Status lines. */
  networkGenerate: (request: GenerateRequest) => invoke<GeneratedNetwork>("network_generate", { request }),
  /** The silent analysis of a document: flags, warnings, ρ badges and its Status lines (src-tauri/src/analysis.rs). */
  analysisRun: (document: unknown) => invoke<SilentAnalysis>("analysis_run", { document }),
  /** Live results while drawing: the closed-form steady state of a document, with its tier (src-tauri/src/live.rs). */
  liveResults: (document: unknown) => invoke<LiveResults>("live_results", { document }),
  /** View ▸ Animate: starts one random run of a document for the canvas animation, or refuses with the reason (src-tauri/src/animate.rs). */
  animateStart: (document: unknown, seed: number) => invoke<AnimateStart>("animate_start", { document, seed }),
  /** The run's next events, up to time `until` or `maxSteps` arrivals and completions. */
  animateNext: (session: number, maxSteps: number, until: number) => invoke<AnimateChunk>("animate_next", { session, maxSteps, until }),
  /** Runs on to `until` without events; answers with the state there. */
  animateSkip: (session: number, until: number) => invoke<AnimateChunk>("animate_skip", { session, until }),
  /** Ends a run. */
  animateStop: (session: number) => invoke<void>("animate_stop", { session }),
  /** The network's problems, each on its nodes and links, with the numbers a fix needs (src-tauri/src/diagnostics.rs). */
  networkDiagnostics: (document: unknown) => invoke<Diagnostic[]>("network_diagnostics", { document }),
  /** Save Status Log…: writes the text atomically; resolves to the path as the log shows it ("~/…"). */
  statusLogWrite: (path: string, text: string) => invoke<string>("status_log_write", { path, text }),
  /** Every setting's kind, default, range and allowed values (src-tauri/src/settings_schema.rs). */
  settingsSchemaGet: () => invoke<SettingSchemaKey[]>("settings_schema_get"),
  /** Settings ▸ General ▸ Export…: writes every setting to `path` (src-tauri/src/settings_io.rs). */
  settingsExport: (path: string) => invoke<SettingsExportOutcome>("settings_export", { path }),
  /** Settings ▸ General ▸ Import…: reads an export; `names` gives each key's "Pane ▸ Row" for the report. */
  settingsImport: (path: string, names: Record<string, string>) => invoke<SettingsImportOutcome>("settings_import", { path, names }),
  /** The station inspector's λ, c·μ and per-class λ under its draft (src-tauri/src/inspector.rs), or null. */
  inspectorStability: (stationId: string, nodes: unknown, links: unknown, infiniteBuffers: boolean) =>
    invoke<StabilityReadout | null>("inspector_stability", { stationId, nodes, links, infiniteBuffers }),
  /** Fit from Data… (src-tauri/src/fit.rs): the sample's summary, every family the model holds fitted to it, and how well each fits. */
  fitDistribution: (request: FitRequest) => invoke<FitReport>("fit_distribution", { request }),
  /** The text of a data file (CSV or plain text) chosen for Fit from Data…. */
  fitReadFile: (path: string) => invoke<DataFile>("fit_read_file", { path }),
  /** File ▸ Export ▸ Diagram as PDF/PNG: renders the figure's SVG and writes it; resolves to the file name (src-tauri/src/canvas_export.rs). */
  diagramExport: (svg: string, format: "pdf" | "png", scale: number, path: string) => invoke<string>("diagram_export", { svg, format, scale, path }),
  /** Edit ▸ Copy as Image: a PDF of `pdfSvg` and a TIFF of `imageSvg` at `scale` on the pasteboard. */
  diagramCopy: (pdfSvg: string, imageSvg: string, scale: number) => invoke<null>("diagram_copy", { pdfSvg, imageSvg, scale }),
  /** File ▸ Print Diagram…: the PDF page through the Print panel; resolves when it closes. */
  diagramPrint: (svg: string, jobTitle: string) => invoke<null>("diagram_print", { svg, jobTitle }),
  /** File ▸ Page Setup…: `NSApp.runPageLayout(nil)`; resolves when it closes. */
  diagramPageSetup: () => invoke<null>("diagram_page_setup"),
  /** The archetype gallery's network (src-tauri/src/archetypes.rs over core/src/generate/archetypes.rs). */
  networkArchetype: (request: ArchetypeRequest) => invoke<BuiltArchetype>("network_archetype", { request }),
  /** Run ▸ <method> for a tab (src-tauri/src/runs.rs): its Status lines, output, progress and end arrive on `onMessage`. */
  runStart: (request: RunStartRequest, onMessage: (m: RunMessage) => void) => {
    const channel = new Channel<RunMessage>();
    channel.onmessage = onMessage;
    return invoke<{ started: boolean }>("run_start", { request, channel });
  },
  /** Run ▸ Stop (⌘.): the stopped run's label, or null when nothing ran. */
  runStop: () => invoke<string | null>("run_stop"),
  /** The run in progress, or null. */
  runActive: () => invoke<ActiveRunInfo | null>("run_active"),
  /** A tab's Results records (all when `tabId` is null), oldest first. */
  resultsList: (tabId: string | null) => invoke<RunRecord[]>("results_list", { tabId }),
  resultsGet: (id: string) => invoke<RunRecord | null>("results_get", { id }),
  resultsDelete: (id: string) => invoke<null>("results_delete", { id }),
  /** Why the results file couldn't be used or written, or null. */
  resultsProblem: () => invoke<string | null>("results_problem"),
  /** The network's fingerprint, as a run of it would record it (src-tauri/src/results_export.rs): the Results workspace's staleness test. */
  resultsFingerprint: (document: unknown) => invoke<string>("results_fingerprint", { document }),
  /** The CSV or JSON export of these records, in this order (Copy Selected Run as CSV). */
  resultsExportText: (ids: string[], format: "csv" | "json", currentFingerprint: string | null) => invoke<string>("results_export_text", { ids, format, currentFingerprint }),
  /** Save … as CSV/JSON…: writes the export atomically; resolves to the file's name. */
  resultsExportSave: (path: string, ids: string[], format: "csv" | "json", currentFingerprint: string | null) =>
    invoke<string>("results_export_save", { path, ids, format, currentFingerprint }),
  /** Test ▸ Run Test Set / Spectral Convergence for a tab (src-tauri/src/testsets.rs): messages as `runStart`'s. */
  sweepStart: (request: SweepStartRequest, onMessage: (m: RunMessage) => void) => {
    const channel = new Channel<RunMessage>();
    channel.onmessage = onMessage;
    return invoke<{ started: boolean }>("sweep_start", { request, channel });
  },
  /** Whether a solver resolves, with the resolver's diagnostic (Run ▸ Multi-Class SRBM). */
  solverLookup: (name: string, subdirectory: string) => invoke<SolverLookup>("solver_lookup", { name, subdirectory }),
  /** Network ▸ Analyze Network / Show Network Primitives: the report and its Status lines (src-tauri/src/analysis_windows/report.rs). */
  analysisReport: (document: unknown, kind: "analyze" | "primitives") => invoke<PreparedReport>("analysis_report", { document, kind }),
  /** Shows a prepared report in the Shell through the run path (single flight, no record): messages as `runStart`'s. */
  analysisReportShow: (request: { tabId: string; title: string; kind: "analyze" | "primitives"; report: string }, onMessage: (m: RunMessage) => void) => {
    const channel = new Channel<RunMessage>();
    channel.onmessage = onMessage;
    return invoke<{ started: boolean }>("analysis_report_show", { request, channel });
  },
  /** Run ▸ Choose a Method…: is the network in each method's domain (src-tauri/src/analysis_windows/advice.rs). */
  methodDomain: (document: unknown) => invoke<MethodDomain>("method_domain", { document }),
  /** …and is each method's solver or Python runtime installed (INV-033: a separate question). */
  methodAvailability: () => invoke<RuntimeAvailability[]>("method_availability"),
  /** Help ▸ Check Dependencies…: this build's checklist (src-tauri/src/analysis_windows/deps.rs). */
  dependencyCatalog: () => invoke<DependencyCatalog>("dependency_catalog"),
  /** Checks one row of the checklist. */
  dependencyProbe: (id: string) => invoke<DependencyResult>("dependency_probe", { id }),
  /** The Shell pane's login shell (src-tauri/src/shell.rs): starts it, or hands the running one to `onMessage`. */
  shellStart: (cols: number, rows: number, onMessage: (m: ShellMessage) => void) => {
    const channel = new Channel<ShellMessage>();
    channel.onmessage = onMessage;
    return invoke<ShellStarted>("shell_start", { cols, rows, channel });
  },
  /** Keystrokes and pastes; `binary` when each character is one byte (xterm's onBinary). */
  shellInput: (data: string, binary = false) => invoke<null>("shell_input", { data, binary }),
  shellResize: (cols: number, rows: number) => invoke<null>("shell_resize", { cols, rows }),
  /** Restart Shell: ends the running shell. */
  shellStop: () => invoke<null>("shell_stop"),
  /** The saved transcript (base64), or null. */
  shellTranscriptLoad: () => invoke<string | null>("shell_transcript_load"),
  /** Saves the transcript (base64); false when there was nothing to write. */
  shellTranscriptSave: (data: string) => invoke<boolean>("shell_transcript_save", { data }),
  shellTranscriptClear: () => invoke<null>("shell_transcript_clear"),
  /** One assistant request (src-tauri/src/ai/): its stream arrives on `onEvent`; resolves to the request's id for `aiCancel`. */
  aiChat: (request: AiChatRequest, onEvent: (e: AiEvent) => void) => {
    const channel = new Channel<AiEvent>();
    channel.onmessage = onEvent;
    return invoke<string>("ai_chat", { request, channel });
  },
  aiCancel: (id: string) => invoke<null>("ai_cancel", { id }),
  /** The provider's API key, kept in the Keychain; `aiKeyStatus` says only whether one is stored. */
  aiKeySet: (provider: AiProvider, key: string) => invoke<null>("ai_key_set", { provider, key }),
  aiKeyStatus: (provider: AiProvider) => invoke<boolean>("ai_key_status", { provider }),
  aiKeyDelete: (provider: AiProvider) => invoke<null>("ai_key_delete", { provider }),
  /** The models the provider's server lists. */
  aiModels: (provider: AiProvider, baseURL: string) => invoke<AiModelInfo[]>("ai_models", { provider, baseURL }),
  /** Settings ▸ AI ▸ Test Connection: whether the server answers, in a sentence. */
  aiTest: (provider: AiProvider, baseURL: string, model: string) => invoke<{ ok: boolean; message: string }>("ai_test", { provider, baseURL, model }),
  /** Help ▸ a topic, sent to the Shell: printed through the run path under the topic's label (src-tauri/src/help.rs). */
  helpShow: (request: { tabId: string; title: string; label: string; text: string }, onMessage: (m: RunMessage) => void) => {
    const channel = new Channel<RunMessage>();
    channel.onmessage = onMessage;
    return invoke<{ started: boolean }>("help_show", { request, channel });
  },
  /** When this build was made, for About (src-tauri/src/help.rs). */
  aboutInfo: () => invoke<AboutInfo>("about_info"),
  /** A failed run's report (src-tauri/src/reports.rs), for the Show Report… panel. */
  reportGet: (id: string) => invoke<FailureReport>("report_get", { id }),
  /** Reveal in Finder: a report's folder, or with null the reports folder (Help ▸ Show Failure Reports…). Resolves to the folder ("~/…"). */
  reportsReveal: (id: string | null) => invoke<string>("reports_reveal", { id }),
  /** Results ▸ Sensitivity, the exact route (src-tauri/src/sensitivity.rs): derivatives, elasticities and "what would it take" of a Jackson network by closed formula; `available: false` with the reason for any other network. */
  sensitivityAnalyze: (request: SensitivityRequest) => invoke<SensitivityAnalysis>("sensitivity_analyze", { request }),
  /** Results ▸ Capacity, the exact route (src-tauri/src/optimise.rs): the cheapest servers (marginal allocation, certified by an exact search) or service rates (square-root rule) of a Jackson network that meet the targets; `available: false` with the reason for any other network. */
  capacityPlan: (request: CapacityRequest) => invoke<CapacityPlan>("capacity_plan", { request }),
  /** Results ▸ Uncertainty for a Jackson network (src-tauri/src/uncertainty.rs): the uncertain rates sampled and every draw solved exactly, with the linear approximation beside it; `available: false` with the reason for any other network. */
  uncertaintyAnalyze: (request: UncertaintyRequest, onProgress: (p: UncertaintyProgress) => void) => {
    const channel = new Channel<UncertaintyProgress>();
    channel.onmessage = onProgress;
    return invoke<UncertaintyAnalysis>("uncertainty_analyze", { request, channel });
  },
  /** Results ▸ Uncertainty for any other network: the linear approximation (delta method) from derivatives the interface supplies. */
  uncertaintyLinear: (request: LinearRequest) => invoke<UncertaintyAnalysis>("uncertainty_linear", { request }),
  /** Run ▸ Transient… (src-tauri/src/transient.rs): which tiers apply to a document, its stations and a horizon to suggest. */
  transientPrepare: (document: unknown) => invoke<TransientPrepare>("transient_prepare", { document }),
  /** The mean number at each station over time, exact and fluid; the exact tier's progress arrives on `onProgress`, and `transientStop(request.id)` stops it. */
  transientAnalyze: (request: TransientRequest, onProgress: (p: TransientProgress) => void) => {
    const channel = new Channel<TransientProgress>();
    channel.onmessage = onProgress;
    return invoke<TransientAnalysis>("transient_analyze", { request, channel });
  },
  transientStop: (id: string) => invoke<null>("transient_stop", { id }),
  /** Run ▸ What-If Sweep… (src-tauri/src/quiet_runs.rs): claims the one run slot for the sweep, or says why it can't. */
  quietBegin: (tabId: string, title: string, label?: string) => invoke<{ started: boolean; sentence: string | null; sweepId?: string | null }>("quiet_begin", label === undefined ? { tabId, title } : { tabId, title, label }),
  /** One point of a sweep: a method run for a document, answered as its record (never filed, nothing streamed) or why there is none. */
  quietRun: (request: QuietRunRequest) => invoke<QuietOutcome>("quiet_run", { request }),
  /** The sweep `sweepId` is over: frees the run slot. With null, whichever sweep holds it (a page that reloaded mid-sweep). */
  quietEnd: (sweepId: string | null = null) => invoke<null>("quiet_end", { sweepId }),
  /** Each station's utilisation for a document, without running anything. */
  quietProbe: (document: unknown) => invoke<QuietProbe>("quiet_probe", { document }),
  /** Whether this copy of Qnet was built to update itself (src-tauri/src/updates.rs); contacts nothing. */
  updateStatus: () => invoke<UpdateStatus>("update_status"),
  /** Asks the update server for a newer version; `disabled`, without a request, in a copy not built to. */
  updateCheck: () => invoke<UpdateCheck>("update_check"),
  /** Downloads, verifies and puts in place the version the last check found. */
  updateInstall: (version: string, onProgress: (p: UpdateProgress) => void) => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onProgress;
    return invoke<null>("update_install", { version, channel });
  },
  /** While armed, the next agreed quit starts the installed version instead of only quitting. */
  updateRelaunch: (armed: boolean) => invoke<null>("update_relaunch", { armed }),
};
