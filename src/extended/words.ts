// The words of the model features new in 2.1: priority service at a station, batch arrivals and
// a rate profile at a source (the inspector's sections, the canvas marks, the outline).
import type { ServiceDiscipline } from "../lib/bnet";
import type { Feature } from "./shape";

export const DISCIPLINE_NAMES: Record<ServiceDiscipline, string> = {
  fcfs: "First come, first served",
  priorityNonPreemptive: "Priority, non-preemptive",
  priorityPreemptiveResume: "Priority, preemptive-resume",
};

export type BatchKind = "single" | "constant" | "geometric" | "pmf";

export const extendedWords = {
  // The Node Parameters panel: its other fields wait for Save, these do not.
  appliesAtOnce: "The settings below are written as you change them, each as a step Edit ▸ Undo takes back. Save and Cancel apply to the fields above.",
  // ── Station: order of service ────────────────────────────────────────────────────────────────
  orderSection: "Service Order",
  discipline: "Discipline",
  disciplineHelp: "Which waiting customer a free server takes next",
  disciplineGlossary:
    "First come, first served: the customer that has waited longest, whatever its class. Priority, non-preemptive: the highest class waiting; a service that has started is never interrupted. Priority, preemptive-resume: a higher class interrupts a lower one at once, and the interrupted customer later carries on where it stopped.",
  orderLabel: "Priority order, highest first",
  orderCaption: "Within a class, first come, first served. Move a class with its buttons, or with Option and the up or down arrow key.",
  oneClass: "Only one class is served here, so the order of service changes nothing yet.",
  moveUp: (name: string) => `Move ${name} up`,
  moveDown: (name: string) => `Move ${name} down`,
  moved: (name: string, place: number, of: number) => `${name} is now ${place} of ${of}`,
  rank: (n: number) => `${n}.`,
  notServed: "not served here",
  fcfsCaption: "Classes are served in the order they arrive.",
  // ── Source: batches ──────────────────────────────────────────────────────────────────────────
  batchSection: "Batch Arrivals",
  batchKind: "Arrive",
  batchKindHelp: "How many customers arrive together at each arrival epoch",
  batchGlossary:
    "With batches, the inter-arrival law above times the batches, and each batch brings a random number of customers at the same instant. The load on the stations counts customers: batch rate × mean batch size.",
  batchKinds: { single: "One at a time", constant: "In batches of a fixed size", geometric: "In batches of geometric size", pmf: "In batches with given probabilities" } satisfies Record<BatchKind, string>,
  batchConstant: "Batch size",
  batchConstantHelp: "Customers in every batch (a whole number, 1 or more)",
  batchGeometric: "Mean batch size",
  batchGeometricHelp: "The mean of a geometric batch size on 1, 2, 3, …  (1 or more)",
  batchPmf: "Probabilities",
  batchPmfHelp: "The probabilities of sizes 1, 2, 3, …, separated by commas; they must sum to 1",
  batchPmfPlaceholder: "0.5, 0.3, 0.2",
  batchPmfNotNumbers: "Enter probabilities separated by commas, each 0 or more",
  batchPmfSum: (sum: string) => `These sum to ${sum}, not 1`,
  batchWhole: "Enter a whole number, 1 or more",
  batchMeanAtLeastOne: "Enter a number, 1 or more",
  batchReadout: (mean: string, rate: string | null) => (rate === null ? `Mean batch size ${mean} customers.` : `Mean batch size ${mean} customers: ${rate} customers per time unit arrive on average.`),
  customers: "customers",
  // ── Source: rate over time ───────────────────────────────────────────────────────────────────
  profileSection: "Rate Over Time",
  profileKind: "Arrival rate",
  profileKindHelp: "Whether the source's rate is the same at all times",
  profileGlossary:
    "A rate profile multiplies the source's own rate by a different factor on each stretch of time, starting at time 0. With it the arrivals are a non-homogeneous Poisson process and the network has no single steady state: Run ▸ Transient computes how the mean numbers move.",
  profileKinds: { constant: "Constant", varying: "Changes over time" },
  profileUntil: (n: number) => `Segment ${n}: until time`,
  profileMultiplier: (n: number) => `Segment ${n}: rate multiplier`,
  profileHeadUntil: "Until time",
  profileHeadMultiplier: "× rate",
  profileAdd: "Add Segment",
  profileRemove: (n: number) => `Remove segment ${n}`,
  profilePeriodic: "Repeat",
  profilePeriodicHelp: "Start the profile again when its last segment ends (a daily pattern). Otherwise the source's own rate is in force after the last segment.",
  enterNumbers: "Enter a number in every cell",
  profileNeedsPoisson: "A rate profile needs a Poisson source: set the inter-arrival law to Poisson.",
  profileNoLength: (n: number) => `Segment ${n} must end later than the one before it`,
  profileBadMultiplier: (n: number) => `Segment ${n} needs a multiplier that is 0 or more`,
  profileCaptionOnce: (end: string) => `After time ${end} the source's own rate applies.`,
  profileCaptionPeriodic: (period: string, mean: string) => `Repeats every ${period} time units; ${mean} × the source's rate on average.`,
  profileChartLabel: (segments: number, periodic: boolean) => `Step chart of the rate multiplier over time: ${segments} segment${segments === 1 ? "" : "s"}${periodic ? ", repeating" : ", then 1"}`,
  profileAxisTime: "time",
  // ── Marks on the canvas, the outline ─────────────────────────────────────────────────────────
  marks: {
    priorities: (preemptive: boolean) => (preemptive ? "Priority service, preemptive-resume" : "Priority service, non-preemptive"),
    batchArrivals: "Arrives in batches",
    timeVaryingRates: "Arrival rate changes over time",
  },
  /** The mark's letter on the canvas, beside its shape (a mark is never colour alone). */
  glyph: { priorities: "P", batchArrivals: "×n", timeVaryingRates: "λ(t)" } satisfies Record<Feature, string>,
  outline: {
    priorities: (preemptive: boolean, order: string) => `priority ${preemptive ? "preemptive-resume" : "non-preemptive"}${order ? `: ${order}` : ""}`,
    batchArrivals: (mean: string) => `batches, mean size ${mean}`,
    timeVaryingRates: (segments: number, periodic: boolean) => `rate profile, ${segments} segment${segments === 1 ? "" : "s"}${periodic ? ", repeating" : ""}`,
  },
  /** Whole sentences for the assistant's description of the network (`featureSentences`). */
  said: {
    priorities: (name: string, preemptive: boolean, order: string) =>
      `${name} serves by priority, ${preemptive ? "preemptive-resume (a higher class interrupts a lower one, which later resumes where it stopped)" : "non-preemptive (a service that has started is never interrupted)"}${order ? `; priority order, highest first: ${order}` : ""}. It is not a first-come-first-served station.`,
    batchArrivals: (name: string, law: string, mean: string) =>
      `${name} emits customers in batches: batch size ${law} (mean batch size ${mean}). Its interarrival law is of batches, so its customer rate is the batch rate times ${mean}.`,
    timeVaryingRates: (name: string, pieces: string, periodic: boolean, mean: string) =>
      `${name}'s arrival rate changes over time: its own rate ${pieces}${periodic ? ", then the pattern repeats" : ", and the last piece continues"} (long-run mean multiplier ${mean}). The network has no single steady state.`,
  },
  usesFeature: "This network has priority service, batch arrivals or a rate profile, which this method does not model. Use Replicated Simulation, the exact single-station method where it applies, or the Transient view for a rate profile",
  /** Solve on a network with a rate profile: no steady state to solve for. */
  solveTimeVarying: "This network's arrival rate changes over time, so it has no single steady state to solve for. The Transient view is open instead: Compute there shows how the mean numbers move, exactly, with the fluid model and with the stationary approximation.",
  /** Solve when no method can run on a network with priorities or batch arrivals (the Method Chooser's rows say why). */
  solveNoMethod: "No method can run on this network as it is. Run ▸ Choose a Method… says why for each one.",
  needsPriorities: "No station of this network has priority service",
  needsBatches: "No source of this network has batch arrivals",
};
