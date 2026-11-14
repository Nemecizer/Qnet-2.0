// The words of live results (new in 2.1, ROADMAP Phase D): what the canvas and the status bar say
// about the numbers computed while the network is drawn. "No steady state" is the validation
// area's wording for ρ ≥ 1 with infinite buffers (src/canvas/validation/words.ts "unstable"), kept
// the same here. With finite buffers ρ ≥ 1 is that area's "overloaded" (blocked or lost, never
// "no steady state"), and here the finite-buffer sentence says the same.
import type { LiveReason, LiveTier } from "./model";

const list = (names: string) => names;

export const liveWords = {
  menuTitle: "Live Results",
  menuHelp: "Show each station's steady state on the canvas as you draw, before any run",
  keywords: ["live", "instant", "spreadsheet", "jackson", "utilisation", "utilization", "bottleneck", "as you type"],
  notKey: "Live Results is available when the main window is active.",

  /** The synthetic method's names: what a tooltip and the layer's label call the source. */
  method: "Live",
  methodLong: "Live results (closed form)",

  /** The legend's chip. */
  chip: {
    exact: "Live · exact",
    utilisation: "Live · utilisation only",
    none: "Live",
  } satisfies Record<LiveTier, string>,
  chipOffered: "Live · offered load only",
  chipUnstable: "Live · no steady state",
  chipSpoken: (chip: string) => `${chip}. Computed from the network as drawn, not from a run.`,

  /** One sentence a student understands, per reason. */
  reason: (reason: LiveReason | null, detail: string): string => {
    switch (reason) {
      case "unstable":
        return `Work arrives at ${list(detail) || "a station"} as fast as it can be served, or faster (ρ ≥ 1), so no steady state exists and there are no queue lengths to show.`;
      case "finiteBuffers":
        return "Buffers are finite, so work can be blocked or lost and no formula gives the queue lengths. ρ here is the offered load, before blocking. With finite buffers there is a steady state even at ρ ≥ 1: blocking or loss absorbs the excess. Press Solve for queue lengths.";
      case "notExponential":
        return `${list(detail) || "A source or station"} is not exponential, so no formula gives the queue lengths. Utilisation is still exact. Press Solve for queue lengths.`;
      case "sharedStation":
        return `More than one class is served at ${list(detail) || "a station"}, so no formula Qnet computes live gives the queue lengths. Utilisation is still exact. Press Solve for queue lengths.`;
      case "noTraffic":
        return `Nothing reaches ${list(detail) || "a station"}. Connect it or remove it to see queue lengths live. Utilisation is still exact.`;
      case "notCertified":
        return "Qnet could not confirm a closed form for this network. Utilisation is still exact. Press Solve for queue lengths.";
      case "noModel":
        return detail || "The network is not complete yet.";
      // A closed network (no source, no sink): core's own sentence says what is missing.
      case "closedNoPopulation":
        return "This network has no source and no sink. Set a population (the number of customers circulating) to solve it as a closed network, or add a source and a sink.";
      case "closed":
        return detail || "This closed network has no product-form solution as drawn.";
      // Priorities, batch arrivals or a rate profile (new in 2.1): core's own sentence says what applies.
      case "extended":
        return `${detail || "This network has priority service, batch arrivals or a rate profile, and no formula Qnet computes live covers it."} Utilisation counts customers at their long-run rate. Press Solve for what applies.`;
      default:
        return "Exact: this is an open Jackson network, so every station is an M/M/c queue at the arrival rate the traffic equations give.";
    }
  },
  exactHelp: "Exact: an open Jackson network (Poisson arrivals, exponential service, infinite buffers). Each station is an M/M/c queue at the arrival rate the traffic equations give. Press Solve to record a run.",
  /** The exact tier of a single station with a feature new in 2.1 (core/src/priority.rs, batch.rs). */
  formulaHelp: {
    priority: "Exact: one station with priority service fed by Poisson sources. The numbers are for all classes together, by Cobham's formula (non-preemptive) or the preemptive-resume formula; Solve's run gives each class its own.",
    batch: "Exact: one single-server station with batch Poisson arrivals (M^X/G/1). Utilisation counts customers: batch rate × mean batch size × mean service time. Press Solve to record a run.",
  },
  closedExactHelp: (n: number, reference: string) =>
    `Exact: a closed network of ${n} customer${n === 1 ? "" : "s"} with exponential service (a Gordon–Newell network), solved by Mean Value Analysis or Buzen's convolution algorithm. Throughput is counted in visits; ${reference} is the reference station, and every pass through it counts, a customer sent straight back to it included. The cycle time N/X is the mean time between a customer's successive visits to ${reference}, not the response time of a job. Press Solve to record a run.`,
  pressSolve: "Press Solve for queue lengths",

  /** The status bar's read-out for the selected station. */
  readout: {
    label: (station: string) => `Live results for ${station}`,
    rho: "ρ",
    l: "L",
    w: "W",
    lUnit: "customers",
    wUnit: "time units",
    rhoHelp: "ρ: utilisation, the fraction of time each server is busy",
    rhoOfferedHelp: "ρ: offered load, arrival rate over service capacity (before blocking or loss)",
    lHelp: "L: mean number of customers at the station, waiting and in service",
    wHelp: "W: mean time a customer spends at the station per visit",
    spoken: (station: string, parts: string[], tier: string) => `${station}: ${parts.join(", ")}. ${tier}.`,
    network: (n: string, t: string, x: string) => `Network: N = ${n} customers, T = ${t} time units, throughput ${x} per time unit`,
    closedNetwork: (n: number, cycle: string, x: string, reference: string) => `Closed network: N = ${n} customer${n === 1 ? "" : "s"}. Throughput at ${reference} (visits per time unit): ${x}. Cycle time between visits to ${reference}: ${cycle} time units`,
  },
  tierName: {
    exact: "exact",
    utilisation: "utilisation only",
    none: "not available",
  } satisfies Record<LiveTier, string>,
} as const;
