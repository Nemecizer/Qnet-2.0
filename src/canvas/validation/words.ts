// Every word the canvas's problems show (new in 2.1, ROADMAP C4): one sentence per diagnostic,
// written for a student who has not met the theory yet, and the labels of the fixes.
import { classLabel } from "../../editor/editor";
import type { Diagnostic, DiagnosticSeverity, ProblemCounts } from "./model";

const fixed2 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "?" : v.toFixed(2));
const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one-sentence explanation (two short ones where the consequence needs saying). */
export function sentence(d: Diagnostic): string {
  // A missing name reads "this node"; the sentence still starts with a capital.
  const text = sentenceOf(d);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sentenceOf(d: Diagnostic): string {
  const v = d.values;
  const name = v.name ?? "this node";
  const other = v.other ?? "the other node";
  const cls = v.classIndex === undefined ? "" : classLabel(v.classIndex);
  switch (d.code) {
    case "emptyNetwork":
      return "The canvas is empty. Add a source, a buffer, a station and a sink to build a network.";
    case "noSource":
      return "The network has no source, so no work ever arrives.";
    case "noStation":
      return "The network has no station, so nothing serves the work.";
    case "noSink":
      return "The network has no sink, so work has no way to leave.";
    case "sourceUnconnected":
      return `${name} is not connected to anything, so its arrivals go nowhere.`;
    case "badArrivalRate":
      return `${name}'s arrival rate is missing or not positive, so no work would ever arrive.`;
    case "sourceCannotReachFirstStation":
      return `${name} has no path to ${other}. Qnet needs the first source to lead to the first station.`;
    case "stationNeedsBuffer":
      return `${name} has no buffer in front of it. Every station takes its work from a buffer, where jobs wait.`;
    case "stationManyBuffers":
      return `${name} has more than one buffer feeding it. A station takes its work from exactly one buffer.`;
    case "badServiceRate":
      return `${name}'s service rate${cls ? ` for ${cls}` : ""} is missing or not positive, so it could never finish a job.`;
    case "noServers":
      return `${name} has no servers. A station needs at least one.`;
    case "bufferSizeZero":
      return `${name} has no waiting room (size ${v.size ?? 0}). A finite buffer needs room for at least one job.`;
    case "sinkUnused":
      return `Nothing leads to ${name}, so no work leaves through it.`;
    case "noArrivals":
      return `No work ever arrives at ${name}: no source has a path to it.`;
    case "noWayOut":
      return `Work that reaches ${name} has nowhere to go: nothing leads out of it.`;
    case "noPathToSink":
      return `Work that leaves ${name} can never reach a sink.`;
    case "sourceMustFeedBuffer":
      return `The link from ${name} goes straight to ${other}. A source must lead into a buffer.`;
    case "linkOutOfSink":
      return `The link from ${name} to ${other} leaves a sink. Work that reaches a sink has left the network, so this link is ignored.`;
    case "sinkFedByBuffer":
      return `The link from ${name} into ${other} is not allowed here. Work enters a sink from a station (or, with finite buffers, from a buffer that overflows).`;
    case "linkNeverUsed":
      return `The link from ${name} to ${other} has probability 0, so no work ever takes it.`;
    case "routingOverOne":
      return `The routing probabilities out of ${name}${cls ? ` for ${cls}` : ""} add up to ${fixed2(v.sum)}. They can add up to at most 1.`;
    case "routingSinkOverOne":
      // Which methods: core/src/export (the regenerative and finite Markov exporters count a sink
      // link in the row and refuse; the traffic equations never read its number).
      return `The routing probabilities out of ${name}${cls ? ` for ${cls}` : ""} add up to ${fixed2(v.sum)} with the link into a sink. Most methods ignore a sink link's number and let ${fixed2(v.exit)} leave here, but Regenerative Monte Carlo, Product Form, QBD, the CTMC methods and Finite-Buffer Decomposition refuse the network.`;
    case "sourceOverOne":
      // core/src/sim.rs refuses (`source_over_one_sentence`); core/src/traffic.rs adds the shares.
      return `The links out of ${name} add up to ${fixed2(v.sum)}, more than 1. The methods that solve the traffic equations then count ${name} at ${fixed2(v.sum)} times its rate, and Replicated Simulation and Animate refuse the network. Lower them so that they add up to 1 at most.`;
    case "closedLoop":
      return `${cls || "Work"} that reaches ${name} keeps coming back and never leaves the network. Lower a routing probability on the loop so some of it can leave.`;
    case "unstable":
      return `Work arrives at ${name} faster than it can be served (ρ = ${fixed2(v.rho)}). The queue would grow without limit, so no steady state exists: some methods will refuse to run, and a simulation will not settle.`;
    case "overloaded":
      return `Work arrives at ${name} as fast as it can be served, or faster (ρ = ${fixed2(v.rho)}). Its buffer will usually be full, so work is blocked or lost.`;
    case "nearlyUnstable":
      return `${name} is busy almost all the time (ρ = ${fixed2(v.rho)}). Queues will be long and a simulation will be slow; the diffusion methods are the most accurate here.`;
    case "infiniteVariance":
      return `${name}'s times vary without limit (infinite variance), so the approximation and diffusion methods cannot be used.`;
    case "noRandomness":
      return "Nothing in this network is random, so the diffusion methods have nothing to model.";
    // Closed networks (new in 2.1).
    case "closedCandidate":
      return "With no source and no sink, nothing arrives and nothing leaves. If that is what you mean, make this a closed network: a fixed number of customers that circulate for ever.";
    case "populationIgnored":
      return `This network has a population of ${v.population ?? "?"} set, but also a source or a sink, so it is solved as an open network and the population is not used.`;
    case "closedPopulationRange":
      return v.detail ?? "The population of a closed network must be between 1 and 10000.";
    case "closedMultiClass":
      return "Qnet solves closed networks with one customer class. Every link must carry Class 1, and none may change class.";
    case "closedNotExponential":
      return `${name}'s service time is not exponential. The exact closed-network solution needs exponential service at every station.`;
    case "closedBufferTooSmall":
      return `${name} has room for only ${v.size ?? "?"} of the ${v.population ?? "?"} customers, so customers would be blocked and the exact solution does not hold. Use infinite buffers, or make its buffer as large as the population.`;
    case "closedRoutingLeaks":
      return `The routing probabilities out of ${name} add up to ${fixed2(v.sum)}. In a closed network every customer that leaves a station goes to another, so they must add up to 1.`;
    case "closedUnreachable":
      return `Customers leave ${name} and never come back, so in the long run it stands empty. Route customers back to it, or remove it.`;
    case "closedReducible":
      return `The stations form separate groups that never exchange customers (one around ${name}, another around ${other}), so the long-run behaviour depends on where the customers start. Connect the groups.`;
    // Priorities, batch arrivals, rate profiles (new in 2.1): core writes the whole sentence.
    case "featureSetting":
      return v.detail ?? `${name} has a priority order, batch sizes or a rate profile that cannot be used as written.`;
    case "featurePeakOverload":
      return v.detail ?? `${name} is overloaded while the arrival rate is at its peak.`;
    default:
      return v.detail ?? `${name} has a problem Qnet cannot describe.`;
  }
}

export const validationWords = {
  sentence,
  severity: { error: "Error", warning: "Warning", info: "Note" } satisfies Record<DiagnosticSeverity, string>,
  /** The badge's spoken name: "Error at S1: …" and how many more. */
  badgeLabel: (severity: DiagnosticSeverity, first: string, more: number) => `${validationWords.severity[severity]}: ${first}${more > 0 ? ` (and ${plural(more, "more problem", "more problems")})` : ""}`,
  popoverLabel: (name: string) => `Problems with ${name}`,
  popoverLabelLink: "Problems with this link",
  layerLabel: "Problems on the canvas",
  close: "Close",

  // The status bar and the list.
  none: "No problems",
  count: (c: ProblemCounts) => {
    const parts: string[] = [];
    if (c.errors) parts.push(plural(c.errors, "error", "errors"));
    if (c.warnings) parts.push(plural(c.warnings, "warning", "warnings"));
    return parts.join(", ") || validationWords.none;
  },
  countChanged: (c: ProblemCounts) => `Problems: ${validationWords.count(c)}.`,
  countSpoken: (c: ProblemCounts) => `Problems: ${validationWords.count(c)}${c.notes ? `, ${plural(c.notes, "note", "notes")}` : ""}. Show the list`,
  countHelp: (next: string, previous: string) => `Problems with this network. Click for the list; ${next} and ${previous} step through them`,
  listTitle: "Problems",
  listEmpty: "Qnet found nothing wrong with this network.",
  listHidden: "Problems are hidden on the canvas.",
  showOnCanvas: "Show on Canvas",
  goTo: (text: string) => `Go to: ${text}`,

  // Commands.
  toggle: "Show Problems on Canvas",
  toggleHelp: "Mark stations, links and other nodes that have a problem, with an explanation and a fix",
  next: "Next Problem",
  previous: "Previous Problem",
  nextHelp: "Select the next node or link that has a problem and show what is wrong",
  showList: "Show Problems List",
  showListHelp: "List every problem Qnet found with this network",
  noneToVisit: "There are no problems to go to.",
  position: (i: number, n: number) => `Problem ${i} of ${n}.`,

  // Fixes.
  fix: {
    addServer: "Add a server",
    useServers: (n: number) => `Use ${n} servers`,
    raiseRate: (rate: number) => `Raise the service rate to ${rate}`,
    inspector: "Open in Inspector",
    connectToSink: "Connect to a sink",
    addSink: "Add a sink",
    addSource: "Add a source",
    addBuffer: "Add a buffer in front",
    connectTo: (name: string) => `Connect to ${name}`,
    resetRate: "Reset to the default rate",
    oneServer: "Use 1 server",
    sizeOne: "Set the size to 1",
    deleteSink: "Delete this sink",
    deleteLink: "Delete this link",
    insertBuffer: "Insert a buffer",
    // Closed networks (new in 2.1).
    makeClosed: (n: number) => `Make this a closed network with ${n} customer${n === 1 ? "" : "s"}`,
    removePopulation: "Remove the population",
    infiniteBuffers: "Use infinite buffers",
    resetPopulation: (n: number) => `Set the population to ${n}`,
    /** "Set the sink link to 0.4": the number every method then agrees on. */
    sinkShare: (to: readonly number[]) => `Set the sink link${to.length === 1 ? "" : "s"} to ${list(to.map(String))}`,
    /** Says the numbers the links get, and what the station's sink link keeps: "Scale them to 0.538 and 0.461". */
    scaleRouting: (to: readonly number[], exit: number | undefined) =>
      `Scale ${to.length === 1 ? "it" : "them"} to ${list(to.map(String))}${exit ? `, keeping ${exit} for the sink` : ""}`,
  },
  /** Undo names for the fixes made of several edits. */
  undo: { connectToSink: "Connect to Sink", addSink: "Add Sink", addBuffer: "Add Buffer", insertBuffer: "Insert Buffer", scaleRouting: "Scale Routing Probabilities", sinkShare: "Set Sink Probability", connect: "Connect Source" },

  /**
   * Added to the Status log when a run is refused while the network has errors. Not every error
   * stops every method (only some refuse an unstable station), so it says "may be why".
   */
  refusalPointer: (errors: number, key: string | undefined) =>
    `This network has ${plural(errors, "error", "errors")}, which may be why the run did not start. See Problems in the canvas status bar${key ? ` (${key} goes to the next one)` : ""}.`,
};
