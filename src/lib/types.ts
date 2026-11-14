// Shapes the Rust commands return, mirrored by hand (as in NetMon: no code generation). Each
// type names the Rust struct it mirrors; a change on one side changes the other in the same commit.

/** src-tauri/src/lib.rs `AppInfo`. */
export interface AppInfo {
  version: string;
  identifier: string;
  /** "release" or "dev" (src-tauri/src/identity.rs). */
  instance: "release" | "dev";
  buildTag: string;
  configDir: string;
  dataDir: string;
}

/** A settings or state file's contents: src-tauri/src/kv.rs. Keys are 0.90.34's names. */
export type KvValues = Record<string, unknown>;

/** src-tauri/src/documents.rs `OpenedDocument`. */
export interface OpenedDocument {
  path: string;
  /** The file name with its extension: the tab's title. */
  name: string;
  /** The document as 0.90.34 would write it; JSON.parse gives a BnetDocument (src/lib/bnet.ts). */
  text: string;
}

/** src-tauri/src/welcome.rs `Example`: a bundled example, and how it is drawn by core's one rule (`closed::drawn_as`). */
export interface ExampleDocument extends OpenedDocument {
  drawn: "open" | "closed" | "closedNoPopulation";
}

/** src-tauri/src/util.rs `PersistenceWarning`. */
export interface PersistenceWarning {
  file: string;
  path: string;
  backup: string;
  error: string;
  tsMs: number;
}

/** src-tauri/src/files.rs `ExamplesLookup`: the examples folder, if found, and every path tried. */
export interface ExamplesLookup {
  path: string | null;
  searched: string[];
  /** The first four paths tried, then ", and N more" (0.90.34 `searchTrail`). */
  trail: string;
  /** Where the panel opens when no folder was found: the home folder. */
  home?: string | null;
}

/** src-tauri/src/files.rs `ExportAllReport`. */
export interface ExportAllReport {
  written: string[];
  summary: string;
  warning?: string | null;
  warningDetail?: string | null;
}

/** src-tauri/src/files.rs `GenerateRequest`. */
export interface GenerateRequest {
  stations: number;
  classes: number;
  infiniteBuffers: boolean;
  targetRho: number;
  topology: "feedForward" | "jacksonFeedback" | "generalPMatrix" | "reentrantFeedback";
  /** Blank for a fresh seed; digits otherwise (text, so a 64-bit seed keeps every digit). */
  seed: string | null;
  title: string;
}

/** src-tauri/src/files.rs `GeneratedNetwork`. */
export interface GeneratedNetwork {
  text: string;
  lines: { text: string; severity?: "info" | "success" | "warning" | "error" }[];
}

/** A double from Rust that may be NaN or infinite (src-tauri/src/analysis.rs `Num`): `Number(x)` reads it. */
export type RustNumber = number | "NaN" | "Infinity" | "-Infinity";

/** src-tauri/src/analysis.rs `SilentAnalysis`: what the flag bar and the ρ badges show. */
export interface SilentAnalysis {
  outcome: "empty" | "analysed" | "failed";
  error: string | null;
  /** Node id → ρ (ledger ANA-015). */
  utilisation: Record<string, number>;
  warnings: string[];
  isAnalyticallyTractable: boolean;
  tractabilityIsExact: boolean;
  tractabilityTitle: string;
  tractabilityDetail: string;
  tractabilityMeans: RustNumber[];
  tractabilityMeansLabel: string;
  tractabilityExplanation: string;
  hasFeedback: boolean;
  feedbackDescription: string;
  feedbackQuality: "notReentrant" | "green" | "yellow" | "red";
  feedbackCriteria: { label: string; ok: boolean; detail: string }[];
  stationNames: string[];
  stationOrderIsAmbiguous: boolean;
  throughputs: number[] | null;
  nonExponentialStations: string[];
  /** A non-quiet run's Status lines, in order. */
  status: string[];
}

/** One key of src-tauri/src/settings_schema.rs (`settings_schema_get`). */
export interface SettingSchemaKey {
  name: string;
  kind: "bool" | "int" | "double" | "text";
  default: boolean | number | string;
  /** Inclusive bounds of a numeric key, or null. */
  range: [number, number] | null;
  allowedNumbers: number[];
  allowedStrings: string[];
}

/** src-tauri/src/settings_io.rs `ExportOutcome`. */
export interface SettingsExportOutcome {
  /** "Exported 108 settings to <file> (tagged Qnet <version>)." */
  message: string;
  count: number;
}

/** src-tauri/src/settings_io.rs `ImportOutcome`. */
export interface SettingsImportOutcome {
  applied: string[];
  unchanged: string[];
  rejected: { key: string; reason: string; name: string }[];
  /** "Imported <file>: N settings changed, M already matched…" */
  message: string;
  status: "success" | "info" | "failure";
}

/** src-tauri/src/inspector.rs `Readout`: a station's load under the inspector's draft (INS-031…036). */
export interface StabilityReadout {
  /** λ into the station, every class. */
  arrivalRate: number;
  /** c·μ. */
  capacity: number;
  servers: number;
  /** [class index, λ] for each class with a finite λ > 0 at the station. */
  arrivalRatePerClass: [number, number][];
}

/** src-tauri/src/archetypes.rs `ArchetypeRequest`: the gallery's knobs (0.90.34 `ArchetypeParameters`). */
export interface ArchetypeRequest {
  kind: "mmcStation" | "tandemLine" | "forkStyleSplit" | "openJacksonFeedback" | "reentrantTwoStation";
  stations: number;
  servers: number;
  targetRho: number;
  feedbackProbability: number;
  infiniteBuffers: boolean;
  bufferCapacity: number;
  arrivalRate: number;
}

/** src-tauri/src/archetypes.rs `BuiltArchetype`: the network as .bnet text, its summary line, and the empty-canvas origin. */
export interface BuiltArchetype {
  text: string;
  summary: string;
  origin: [number, number];
}

// ── Runs (src-tauri/src/runs.rs) ───────────────────────────────────────────────────────────────

export type RunSeverity = "info" | "success" | "warning" | "error";

/** What a run sends the page. `output` is base64 of the Shell pane's bytes. */
export type RunMessage =
  | { kind: "status"; text: string; severity: RunSeverity }
  | { kind: "output"; data: string }
  | { kind: "progress"; fraction: number | null; elapsedSeconds: number; text: string }
  | {
      kind: "finished";
      summary: string;
      statusBar: string;
      exitCode: number;
      userStopped: boolean;
      succeeded: boolean;
      recordId: string | null;
      filed: "completed" | "partial" | "failed" | "deleted" | null;
      filedReason: string | null;
    }
  // A failure report was written (src-tauri/src/reports.rs): sent just before `finished`.
  | RunReportMessage;

export interface RunStartRequest {
  tabId: string;
  title: string;
  document: unknown;
  /** 0.90.34's run label ("qna", "inf_cmp"). */
  method: string;
  settings: KvValues;
  /** What a parameter sheet changed for this run, by the settings keys. */
  overrides?: KvValues;
  sourcePath?: string | null;
}

export interface ActiveRunInfo {
  id: string;
  label: string;
  displayLabel: string;
  tabId: string;
  tabTitle: string;
  elapsedSeconds: number;
  fraction: number | null;
  stopRequested: boolean;
  text: string;
}

/** A Results record as results-v1.json holds it (0.90.34's `RunRecord`; core/src/results/model.rs). */
export interface RunRecord {
  id: string;
  method: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  elapsedSeconds?: number;
  measurements: unknown[];
  provenance: { tabID: string; networkTitle: string; [k: string]: unknown };
  [k: string]: unknown;
}

// ── Run UI (P6, src/runs/ui; src-tauri/src/testsets.rs) ─────────────────────────────────────────

/** Test ▸ Run Test Set / Spectral Convergence parameters (runner `TestSetParameters`, `SpectralConvergenceParameters`). */
export interface SweepParams {
  stationsLower: number;
  stationsUpper: number;
  classesLower: number;
  classesUpper: number;
  /** Test sets: the ρ range. */
  rhoLower?: number;
  rhoUpper?: number;
  /** Spectral convergence: the ρ sweep. */
  rhoStart?: number;
  rhoEnd?: number;
  rhoStep?: number;
  numTestCases: number;
  /** 0 feed-forward, 1 Jackson feedback, 2 general P-matrix, 3 re-entrant. */
  topology: number;
  /** A fixed base seed, or null for a fresh one. */
  seed: number | null;
}

/** A sweep the Test menu asks for; owned by the tab that was active (its record is filed there). */
export interface SweepStartRequest {
  tabId: string;
  title: string;
  document: unknown;
  /** "infinite" / "finite" test set, or "spc" (spectral convergence). */
  kind: "infinite" | "finite" | "spc";
  settings: KvValues;
  params: SweepParams;
  sourcePath?: string | null;
}

/** Whether a solver resolves (the Multi-Class SRBM item), with the resolver's diagnostic. */
export interface SolverLookup {
  available: boolean;
  diagnostic: string;
}

// ── Analysis windows (src-tauri/src/analysis_windows/) ─────────────────────────────────────────

/** Analyze Network / Show Network Primitives, prepared (src-tauri/src/analysis_windows/report.rs). */
export interface PreparedReport {
  /** "Analyze network aborted: <reason>" when the station model can't be computed. */
  failed: string | null;
  /** Status lines 0.90.34 wrote before showing the report (severity inferred from the words). */
  status: string[];
  /** The report, as the Shell shows it. */
  report: string;
  /** Primitives only: the analysis it publishes as the tab's flags. */
  analysis: SilentAnalysis | null;
}

/** The Method Chooser's network side (src-tauri/src/analysis_windows/advice.rs `MethodDomain`). */
export interface MethodDomain {
  infiniteBuffers: boolean;
  stationCount: number;
  classCount: number;
  warningCount: number;
  hasFeedback: boolean;
  analytical: { exact: boolean; title: string; detail: string; explanation: string } | null;
  sourcesArePoisson: boolean;
  servicesAreExponential: boolean;
  classTransitions: boolean;
  classIndependentService: boolean;
  heavyJackson: boolean;
  productFormRefusal: string | null;
  qbdRefusal: string | null;
  /** Why Replicated Simulation (new in 2.1, core/src/simstat.rs `plan`) cannot estimate the network, or null when it can. */
  replicatedSimulationRefusal: string | null;
  /** Present for a network drawn as a closed one (no source, no sink; new in 2.1): why core's closed solver refuses it, or null. */
  closed?: { population: number | null; refusal: string | null };
  /**
   * Present for a network that uses a model feature new in 2.1 (priorities, batch arrivals, a
   * rate profile; core/src/extended.rs `methods_domain`): what every classical method says of it,
   * and the exact single-station methods of the features in use.
   */
  extended?: { features: string[]; others: string; exact: { id: string; name: string; ready: string; refusal: string | null }[] };
}

export type RuntimeKey = "productForm" | "qbd" | "regenerative" | "truncatedCtmc" | "adaptiveBar" | "barBounds" | "multiclass" | "genericCtmc" | "decomposition";

/** Whether one method's solver or Python runtime is installed, and why not. */
export interface RuntimeAvailability {
  key: RuntimeKey;
  available: boolean;
  reason: string | null;
}

/** One row of the startup dependency checklist (src-tauri/src/analysis_windows/deps.rs). */
export interface DependencyRequirement {
  id: string;
  scope: "Runtime" | "Optional" | "Bundled" | "Developer";
  brewFormulae: string[];
  supplementalInstallCommands: string[];
}

export interface DependencyCatalog {
  /** A packaged app: the checklist does not open at launch. */
  packaged: boolean;
  items: DependencyRequirement[];
}

/** A probe's result. */
export type DependencyResult = { state: "available" | "missing" | "timedOut"; detail: string };

// --- The Shell pane (src-tauri/src/shell.rs, src/panes/shell/)

/** What the shell sends on its channel: PTY bytes (base64), or its exit. */
export type ShellMessage = { kind: "output"; data: string } | { kind: "exited"; code: number | null; generation: number };

/** `shell_start`'s answer. */
export interface ShellStarted {
  pid: number;
  shell: string;
  cwd: string;
  generation: number;
  /** An existing shell was handed to this channel (a reloaded page). */
  reattached: boolean;
}

// ── The AI assistant (src-tauri/src/ai/, P7): the contract between the pane and Rust ────────────
// Requests leave from Rust (the page's content policy allows no outside connections). The pane
// owns the conversation, the tools and the loop; Rust turns one request into a provider's wire
// format, streams the answer back as these events, and keeps the API keys in the Keychain.

export type AiProvider = "anthropic" | "openai" | "ollama" | "lmstudio";

export interface AiToolCall {
  id: string;
  name: string;
  /** The tool's arguments, as the model gave them (a JSON object). */
  input: Record<string, unknown>;
}

/**
 * A reply's own output items (OpenAI's Responses API, new in 2.1): stored on the assistant turn
 * and passed back unchanged when the same model is asked again. The pane never reads them.
 */
export interface AiReplay {
  provider: AiProvider;
  model: string;
  items: unknown[];
}

export type AiMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: AiToolCall[]; replay?: AiReplay }
  | { role: "tool"; results: { id: string; name: string; content: string; isError: boolean }[] };

export interface AiToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
}

export interface AiChatRequest {
  provider: AiProvider;
  model: string;
  /** The provider's base URL (settings `ai.baseURL.<provider>`). */
  baseURL: string;
  system: string;
  messages: AiMessage[];
  tools: AiToolSpec[];
  maxTokens: number;
  /** Sent only to models known to accept it (src-tauri/src/ai/wire.rs `accepts_temperature`). */
  temperature: number;
  timeoutSec: number;
  /** `ai.fallback.anthropic`: if Claude declines, let another Claude model answer (2.1). */
  fallback: boolean;
}

/** One model a provider's server lists (`ai_models`). */
export interface AiModelInfo {
  id: string;
  /** Anthropic's `display_name`, when given. */
  displayName?: string;
}

/** One request's stream. `done` or `error` is always last. */
export type AiEvent =
  | { kind: "text"; delta: string }
  | { kind: "toolCall"; call: AiToolCall }
  /** The reply's output items, for the assistant turn's `replay`. */
  | { kind: "replay"; replay: AiReplay }
  /** The reply was declined (`done` with `refusal` follows). */
  | { kind: "refused"; category: string | null; explanation: string | null }
  | { kind: "done"; stopReason: "end" | "toolUse" | "maxTokens" | "cancelled" | "refusal" | "other" }
  | { kind: "error"; message: string };

// ── Help and About (src-tauri/src/help.rs) ──────────────────────────────────────────────────

/** `about_info`: what About shows besides AppInfo. */
export interface AboutInfo {
  /** When the executable was written (milliseconds since 1970), or null when it can't be read. */
  builtMs: number | null;
}

// ── Failure reports (src-tauri/src/reports.rs, new in 2.0) ────────────────────────────────────

/** A run's failure report was written: its id, and the Status line it belongs to (null when the run wrote none). */
export interface RunReportMessage {
  kind: "report";
  id: string;
  statusText: string | null;
}

/** How a run failed (`FailureKind`). */
export type FailureKind = "exit" | "signal" | "could-not-start" | "unparsed" | "internal";

export interface FailureReportCommand {
  /** The command line: bundle paths relative to the bundle, `$TMPDIR`, `~`. */
  command: string;
  cwd: string | null;
  /** "exit 1", "SIGSEGV", "could not start: …". */
  ended: string;
  exitCode: number | null;
  signal: string | null;
  durationSeconds: number;
}

/** `report.json` and the tails, as `report_get` returns them. */
export interface FailureReport {
  /** The folder's name: "<timestamp>-<method>". */
  id: string;
  createdAt: string;
  qnetVersion: string;
  buildTag: string;
  macosVersion: string;
  chip: string;
  /** The run label ("lp"). */
  method: string;
  /** The display label ("Linear Program"). */
  methodName: string;
  networkTitle: string;
  infiniteBuffers: boolean;
  kind: FailureKind;
  exitCode: number;
  signal: string | null;
  durationSeconds: number;
  reason: string | null;
  settings: Record<string, string>;
  sheet: Record<string, string>;
  seed: number | null;
  solverPath: string | null;
  runtime: string | null;
  commands: FailureReportCommand[];
  utilisation: { station: string; utilisation: number }[];
  statusLines: { severity: string; text: string }[];
  inputFiles: string[];
  inputsOmitted: string[];
  /** The last 200 lines of the run's output. */
  outputTail: string;
  /** The last 200 lines of the solvers' stderr. */
  stderrTail: string;
  /** The report's folder, with `~` for the home folder. */
  folder: string;
}

// ── Quiet runs (src-tauri/src/quiet_runs.rs; Run ▸ What-If Sweep…, src/sweeps/) ─────────────────

/** One quiet run: a Run-menu method for a document, answered as a record that is never filed. */
export interface QuietRunRequest {
  tabId: string;
  title: string;
  document: unknown;
  /** 0.90.34's run label ("qna", "inf_sim"). */
  method: string;
  settings: KvValues;
  overrides?: KvValues;
  /** The sweep this run is a point of (`quiet_begin`'s answer): once that sweep is over the run answers `stopped`. Absent for a quiet run on its own. */
  sweepId?: string | null;
}

/** How a quiet run ended: its record, or why there is none. */
export type QuietOutcome =
  | { kind: "record"; record: RunRecord; elapsedSeconds: number }
  | { kind: "unstable"; sentence: string; station: string; utilisation: number }
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; sentence: string }
  | { kind: "stopped" };

/** Each station's utilisation for a document (`quiet_probe`). */
export interface QuietProbe {
  infiniteBuffers: boolean;
  loads: { station: string; utilisation: number }[];
  /** False when an infinite-buffer network has a station at utilisation ≥ 1. */
  stable: boolean;
  error: string | null;
}
