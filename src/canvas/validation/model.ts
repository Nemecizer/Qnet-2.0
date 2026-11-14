// What Rust's `network_diagnostics` answers (src-tauri/src/diagnostics.rs; new in 2.1, ROADMAP
// C4): the problems of a network as a typed list. Rust owns what is wrong and every number; the
// interface owns the sentences (./words.ts), the drawing and the edits that cure them (./fixes.ts).

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "emptyNetwork" | "noSource" | "noStation" | "noSink"
  | "sourceUnconnected" | "badArrivalRate" | "sourceCannotReachFirstStation"
  | "stationNeedsBuffer" | "stationManyBuffers" | "badServiceRate" | "noServers"
  | "bufferSizeZero" | "sinkUnused" | "noArrivals" | "noWayOut" | "noPathToSink"
  | "sourceMustFeedBuffer" | "linkOutOfSink" | "sinkFedByBuffer" | "linkNeverUsed"
  | "routingOverOne" | "routingSinkOverOne" | "closedLoop" | "unstable" | "overloaded" | "nearlyUnstable"
  | "infiniteVariance" | "noRandomness" | "modelRefused"
  // Closed networks (new in 2.1; src-tauri/src/diagnostics.rs `closed_problems`).
  | "closedCandidate" | "populationIgnored" | "closedPopulationRange" | "closedMultiClass" | "closedNotExponential"
  | "closedBufferTooSmall" | "closedRoutingLeaks" | "closedUnreachable" | "closedReducible"
  // Priorities, batch arrivals, rate profiles (new in 2.1; core/src/extended.rs `problems`): a
  // setting that cannot be modelled as written, and a profile whose peak overloads a station.
  | "featureSetting" | "featurePeakOverload"
  // A source whose links sum above 1 (review finding FIX-201; core/src/sim.rs `sources_over_one`).
  | "sourceOverOne";

export interface DiagnosticValues {
  name?: string;
  other?: string;
  rho?: number;
  arrivalRate?: number;
  serviceRate?: number;
  servers?: number;
  suggestedServers?: number;
  suggestedRate?: number;
  suggestedParameters?: string;
  classIndex?: number;
  sum?: number;
  /** A routing row over 1: what each of `linkIds` gets when the row is scaled (same order). Rust sends it only when the scaled network lets the class leave and is stable. */
  suggestedProbabilities?: number[];
  /** With `suggestedProbabilities`: what the station's own links into a sink keep. For `routingSinkOverOne`: what the row's other links leave under 1 (what leaves the network there). */
  exit?: number;
  size?: number;
  detail?: string;
  /** A closed network's population: the one set, or the one "Make this a closed network" would set. */
  population?: number;
}

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** A code this build doesn't know is shown with Rust's `detail`, or a general sentence. */
  code: DiagnosticCode | (string & {});
  /** The first is the node the badge sits on and a fix edits. */
  nodeIds: string[];
  linkIds: string[];
  values: DiagnosticValues;
}

const RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Stable within one answer: what it is and where. */
export const diagnosticId = (d: Diagnostic) => `${d.code}|${d.nodeIds.join(",")}|${d.linkIds.join(",")}`;

export const worst = (ds: readonly Diagnostic[]): DiagnosticSeverity => ds.reduce<DiagnosticSeverity>((w, d) => (RANK[d.severity] < RANK[w] ? d.severity : w), "info");

export interface ProblemCounts {
  errors: number;
  warnings: number;
  notes: number;
}

export function countProblems(ds: readonly Diagnostic[]): ProblemCounts {
  const c = { errors: 0, warnings: 0, notes: 0 };
  for (const d of ds) c[d.severity === "error" ? "errors" : d.severity === "warning" ? "warnings" : "notes"]++;
  return c;
}

/** Where a diagnostic is drawn: on its first node, else on its first link, else nowhere (the list only). */
export type ProblemTarget = { kind: "node"; id: string } | { kind: "link"; id: string } | null;

export function targetOf(d: Diagnostic): ProblemTarget {
  if (d.nodeIds.length) return { kind: "node", id: d.nodeIds[0] };
  if (d.linkIds.length) return { kind: "link", id: d.linkIds[0] };
  return null;
}

export const targetKey = (t: ProblemTarget) => (t ? `${t.kind}:${t.id}` : "");
