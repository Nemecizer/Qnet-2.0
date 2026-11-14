// Every word Results ▸ Capacity shows (new in 2.1, ROADMAP D5): the command, the problem the
// student states (targets, costs, what may change), the plan, its proof line, the trade-off
// chart and the reasons a target cannot be met.
import type { Tier } from "../results/insight";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export type TargetKind = "networkSojourn" | "networkNumber" | "utilisation" | "stationWait";
export type Decision = "servers" | "rates";

export const capacityWords = {
  menuTitle: "Plan Capacity…",
  commandHelp: "The cheapest numbers of servers, or service rates, that meet a target you set",
  keywords: ["capacity", "plan", "optimise", "optimize", "servers", "allocation", "cost", "target", "staffing", "how many servers", "square root"],
  noNetwork: "Add a network first",
  noStations: "This network has no station to plan yet",
  view: "Capacity",
  viewHelp: "The cheapest numbers of servers, or service rates, that meet a target",

  // ── The problem ──────────────────────────────────────────────────────────────────────────────
  decisionLabel: "What may change",
  decisions: { servers: "Servers", rates: "Service rates" } as Record<Decision, string>,
  decisionHelp: {
    servers: "Choose how many servers each station has",
    rates: "Choose how fast each single-server station works (the square-root rule)",
  } as Record<Decision, string>,
  targetsTitle: "Targets",
  targetsHelp: "Tick one or several. The plan meets all of them.",
  targets: {
    networkSojourn: "Mean delay through the network",
    networkNumber: "Mean number in the network",
    utilisation: "Utilisation of every station",
    stationWait: "Mean wait before service at",
  } as Record<TargetKind, string>,
  targetHelp: {
    networkSojourn: "The average time from arrival to departure",
    networkNumber: "The average number of customers in the network, waiting or in service",
    utilisation: "The fraction of time each server is busy",
    stationWait: "The average time a customer waits in this station's queue before service starts",
  } as Record<TargetKind, string>,
  atMost: "at most",
  targetValue: (label: string) => `${label}: at most`,
  stationOfWait: "Station whose wait is bounded",
  targetUnits: { networkSojourn: "time units", networkNumber: "customers", utilisation: "%", stationWait: "time units" } as Record<TargetKind, string>,
  hintNow: (value: string) => `now ${value}`,
  hintOverloaded: "overloaded now",
  hintFloor: (value: string) => `never below ${value}`,
  hintFloorHelp: "The service itself takes this long: the sum of the mean service times a customer meets on the way. More servers shorten the waiting, never the service.",
  stationsTitle: "Stations and costs",
  colStation: "Station",
  colFree: "May change",
  colCostServer: "Cost per server",
  colCostRate: "Cost per unit of service rate",
  colLower: "At least",
  colUpper: "At most",
  freeLabel: (s: string) => `${s} may change`,
  costLabel: (s: string) => `${s}: cost`,
  lowerLabel: (s: string) => `${s}: fewest servers`,
  upperLabel: (s: string) => `${s}: most servers`,
  noLimit: "no limit",
  problems: {
    noTarget: "Tick a target and type its value.",
    badTarget: (label: string) => `${label}: type a number above zero.`,
    badUtilisation: "Utilisation: type a percentage above 0 and at most 100.",
    badCost: (s: string) => `${s}: the cost must be a number above zero.`,
    badLimit: (s: string) => `${s}: the limits must be whole numbers of 1 or more, the fewest not above the most.`,
  },

  // ── The answer ───────────────────────────────────────────────────────────────────────────────
  working: "Working…",
  emptyTitle: "Nothing to plan yet",
  emptyMessage: "Capacity planning chooses the numbers of servers that meet a target at the least cost. Draw a network with a source and a station first.",
  brokenTitle: "The network can't be planned yet",
  seeProblems: "The Problems list says what to fix.",
  closedTitle: "Capacity planning is for open networks",
  tierFormula: "Exact — closed formulas (Jackson network)",
  tierFormulaHelp: "The network is an open Jackson network, so every number here comes from its exact formulas (Erlang C at each station). Nothing was run.",
  tierRuns: (tier: string, method: string) => `${tier} — greedy search over runs of ${method}`,
  tierRunsHelp: (method: string) => `No closed formula applies, so ${method} solved the network once for each allocation tried. The numbers are as good as ${method} is for this network.`,
  tiers: { exact: "Exact method", simulation: "Simulation", approximation: "Approximation", diffusion: "Diffusion model", bound: "Bound", mixed: "Mixed" } as Record<Tier, string>,
  experimental: "Experimental",
  experimentalHelp: "The search over solver runs is checked against the exact route on Jackson networks only. The allocation it finds is good; it is not proven to be the cheapest.",
  proof: {
    marginal: "Proven cheapest: each server was added where it cut congestion most (marginal allocation), which is optimal when servers cost the same.",
    search: (n: string) => `Proven cheapest: an exact search of ${n} candidate allocations found nothing cheaper.`,
    improved: (n: string) => `Proven cheapest: an exact search of ${n} candidate allocations found a cheaper plan than adding servers one at a time.`,
    closedForm: "Proven cheapest: Kleinrock's square-root rule gives the least-cost service rates in closed form.",
    none: (limit: string) => `Good, not proven best: servers cost different amounts and the exact search stopped at its limit of ${limit} candidates.`,
    runs: "Good, not proven best: a greedy search, one server at a time.",
  },
  proofHelp: {
    marginal: "The mean number at a station falls, and falls by less each time, as servers are added (it is convex). So giving each next server to the station where it helps most can never be beaten (Fox 1966; Dyer and Proll 1977).",
    search: "With unequal costs the greedy answer can be beaten by a mix of cheaper servers, so every allocation that costs no more than it was checked.",
    closedForm: "Each station first gets the rate it cannot do without (its arrival rate); the rest is shared in proportion to the square root of arrival rate over cost (Kleinrock, Queueing Systems vol. 2, section 5.7).",
    none: "The plan meets every target and no single server can be taken away, but a cheaper mix of servers may exist.",
  },
  planTitle: "Recommended plan",
  planCaption: (decision: Decision) => (decision === "servers" ? "Servers at each station: now and as proposed" : "Service rate at each station: now and as proposed"),
  colNow: "Now",
  colProposed: "Proposed",
  colChange: "Change",
  colCostNow: "Cost now",
  colCost: "Cost proposed",
  total: "Total",
  held: "held",
  heldHelp: "This station may not change",
  noChange: "—",
  overloaded: "overloaded",
  targetsMetTitle: "Targets",
  targetsCaption: "Each target: its value now and under the plan",
  colTarget: "Target",
  colLimit: "At most",
  colUnit: "Unit",
  colMet: "Met",
  met: "Yes",
  notMet: "No",
  constraintName: (kind: TargetKind, station: string | null) =>
    kind === "networkSojourn" ? "Mean delay through the network" : kind === "networkNumber" ? "Mean number in the network" : kind === "utilisation" ? "Highest utilisation" : `Mean wait at ${station ?? "the station"}`,
  units: { customers: "customers", time: "time units", ratio: "" } as Record<string, string>,
  apply: "Apply",
  applyHelp: "Change the network to the proposed plan (one step to undo)",
  applyUndoName: "Apply Capacity Plan",
  applied: (changes: string[]) => `Applied the capacity plan: ${list(changes)}.`,
  appliedServers: (s: string, n: number) => `${s} has ${plural(n, "server")}`,
  appliedRate: (s: string, rate: string) => `${s} serves at ${rate}`,
  applySame: "The network already matches the plan.",
  applyGone: "The network has changed since the plan was made. Nothing was applied.",
  nothingToApply: "The network already matches the plan",
  trySweep: "Try as What-If Sweep…",
  trySweepHelp: (s: string) => `Open a What-If Sweep of ${s} across the range of this plan`,
  staleNote: "The network has changed since this plan was made. Plan again to bring it up to date.",

  // One sentence a student can read aloud.
  reading: {
    same: (cost: string) => `The network already meets every target at the least cost (${cost}).`,
    add: (changes: string[], costNow: string, cost: string) => `${capital(list(changes))}: the cost rises from ${costNow} to ${cost}, the least that meets every target.`,
    save: (changes: string[], costNow: string, cost: string) => `${capital(list(changes))}: every target is still met and the cost falls from ${costNow} to ${cost}.`,
    move: (changes: string[], cost: string) => `${capital(list(changes))}: every target is met at the same cost (${cost}).`,
    more: (s: string, n: number) => `add ${plural(n, "server")} at ${s}`,
    fewer: (s: string, n: number) => `remove ${plural(n, "server")} at ${s}`,
    faster: (s: string, from: string, to: string) => `speed ${s} up from ${from} to ${to}`,
    slower: (s: string, from: string, to: string) => `slow ${s} down from ${from} to ${to}`,
    delay: (now: string | null, then: string, unit: string) => (now === null ? ` The mean delay becomes ${then} ${unit} (the network is overloaded now).` : ` The mean delay goes from ${now} to ${then} ${unit}.`),
  },

  // ── Why not ──────────────────────────────────────────────────────────────────────────────────
  infeasibleTitle: "No plan meets these targets",
  infeasible: {
    badTarget: "A target is not a number above zero.",
    badStation: (s: string) => `${s}: the cost must be above zero and the limits must not cross.`,
    fixedOverloaded: (s: string) => `${s} may not change, and it is overloaded as drawn: no plan gives the network a steady state. Let ${s} change.`,
    limitOverloaded: (s: string, n: string) => `${s} needs at least ${n} servers just to keep up with its arrivals, which is more than its limit allows. Raise the limit.`,
    stationLimit: (name: string, s: string, best: string) => `${name} cannot be met within the limit on ${s}: with the most servers allowed there it is still ${best}. Raise the limit, let ${s} change, or relax the target.`,
    serviceFloor: (name: string, floor: string) =>
      `${name} can never be ${floor} or less. That is the service itself: the sum of the mean service times a customer meets on the way. Servers remove waiting, not service — to go lower, make the service faster.`,
    floor: (name: string, floor: string) => `${name} cannot go below ${floor} while some stations are held or limited. Let more stations change, raise a limit, or relax the target.`,
    tooMany: "The targets would need more than 20,000 added servers. Relax a target.",
    ratesTarget: "Service rates are planned for a target on the whole network: the mean delay or the mean number. Untick the station targets, or plan servers instead.",
    severalServers: (s: string) => `${s} has several servers. The square-root rule plans single-server stations: hold ${s}, or plan servers instead.`,
    nothingFree: "No station may change. Let at least one change.",
    fixedTooFull: (value: string) => `The stations that may not change already account for ${value}, which is at or above the target. Let more stations change, or relax the target.`,
    unknown: "The targets cannot be met.",
  },

  // ── The chart ────────────────────────────────────────────────────────────────────────────────
  chartTitle: (measure: string) => `What each extra unit of cost buys: ${measure}`,
  chartSubtitleServers: "Marginal allocation: one more server at a time, each where it helps most",
  chartSubtitleRates: "The least cost at which each level can be reached (square-root rule)",
  chartSubtitleRuns: (method: string) => `Greedy search over runs of ${method}: one more server at a time`,
  chartX: "Total cost",
  chartY: { delay: "Mean delay through the network (time units)", number: "Mean number in the network (customers)" },
  chartMeasure: { delay: "mean delay", number: "mean number in the network" },
  seriesPath: "Plans",
  seriesTarget: "Target",
  seriesNow: "Now",
  ruleProposed: "Proposed",
  chartCaption: (measure: string, points: number, first: string, last: string, proposed: string | null, flattening: boolean) =>
    `${capital(measure)} against total cost for ${plural(points, "plan")}: from ${first} at the least cost to ${last} at the most.` +
    (proposed ? ` The proposed plan costs ${proposed}.` : "") +
    (flattening ? " The curve flattens: each further unit of cost buys less." : ""),
  pathNote: (s: string) => `one more server at ${s}`,

  // ── The route over solver runs ───────────────────────────────────────────────────────────────
  numericTitle: "No closed formula for this network",
  numericMessage: (method: string, tier: string, runs: number, time: string | null) =>
    `Qnet can search for a plan instead: it adds one server at a time where ${method} (${tier.toLowerCase()}) says it helps most, using at most ${plural(runs, "solver run")}${time ? `, ${time}` : ""}.`,
  numericAction: "Plan by Solver Runs",
  numericActionHelp: "Search for a plan by solving the network once per allocation tried",
  numericRatesOnly: "Service rates are planned by a closed formula that needs a Jackson network. For this network, plan servers.",
  again: "Plan Again",
  simulationOnlyTitle: "Only simulation applies to this network",
  simulationOnly: "A search compares allocations that differ by one server, and a simulation's noise is larger than that difference. Use a What-If Sweep of one station's servers instead: its chart shows the interval at every point.",
  simulationAction: "What-If Sweep…",
  noMethod: "No method that Solve would choose can be searched for this network.",
  started: (method: string, runs: number) => `Capacity: searching with ${method}, at most ${plural(runs, "run")}.`,
  progress: (done: number, total: number, time: string) => `Capacity: run ${done} of at most ${total} · ${time}`,
  finished: (time: string) => `Capacity plan finished (${time}).`,
  cancelled: (time: string) => `Capacity plan stopped (${time}).`,
  failed: (time: string) => `Capacity plan failed (${time}).`,
  couldNotStart: (why: string) => `The capacity plan was not started. ${why}`.trim(),
  baseFailed: (method: string, why: string) => `${method} could not solve the starting allocation, so there is nothing to search from. ${why}`.trim(),
  noMeasure: (method: string, what: string) => `${method} does not report what ${what.toLowerCase()} needs, so this target cannot be searched with it.`,
  ended: {
    met: "",
    outOfRuns: (runs: number) => `The search used its ${plural(runs, "run")} before every target was met. The plan below is the best it reached; relax a target or plan again from there after applying it.`,
    noProgress: "No single extra server brings the targets closer, so the search stopped. The plan below is the best it reached.",
    limits: "Every station is at its limit and a target is still missed. The plan below is the best the limits allow.",
    stopped: "The search was stopped. The plan below is the best it had reached.",
  },
  doneLine: (met: boolean, runs: number) => (met ? `Capacity: a plan that meets every target, found in ${plural(runs, "run")}.` : `Capacity: no plan met every target within ${plural(runs, "run")}.`),
};

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
