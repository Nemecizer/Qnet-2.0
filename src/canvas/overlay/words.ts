// The words of the results overlay (new in 2.1, ROADMAP B2): what the canvas says about a run.
import type { Tier } from "../../results/insight";

const cls = (i: number) => `Class ${i + 1}`;

export const overlayWords = {
  menuTitle: "Results on Canvas",
  show: "Show Results on Canvas",
  hide: "Hide Results on Canvas",
  showHelp: "Show each station's result from the latest run beside it on the canvas",
  colorStations: "Color Stations",
  colorHelp: "Ring each station in a colour that follows the value shown",
  metricHelp: (metric: string) => `Show each station's ${metric.toLowerCase()} on the canvas`,
  bestRun: "Show the Best Current Run",
  bestRunHelp: "Go back to the best run of the network as it is now",

  layerLabel: (metric: string, method: string, tier: string) => `Results on canvas: ${metric}, ${method}, ${tier}`,
  legendLabel: "Results on canvas",
  legendHelp: "The result shown beside each station. Click to change the quantity or hide the results.",
  legendMenu: "Results on canvas options",
  stale: "Network changed since this run",
  staleHelp: "These values were computed for an earlier version of the network. Run a method again to update them.",
  bottleneck: "Bottleneck",
  bottleneckHelp: "Bottleneck: the highest utilisation in this run.",
  /** Stations that tie for the highest utilisation: none of them is "the" bottleneck. */
  equallyLoaded: "Equally loaded",
  equallyLoadedHelp: (others: readonly string[]) => `Equally loaded: the highest utilisation, shared with ${others.length <= 1 ? others.join("") : `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}`}. No single bottleneck.`,
  noValues: (metric: string, method: string) => `${method} reports no ${metric.toLowerCase()} per station`,
  noRunsNeeded: "Run a method to show results on the canvas.",
  className: cls,
  allClasses: "All classes",
  interval: (low: string, high: string) => `interval ${low} to ${high}`,
  /** Between the value and its unit: "9.350 ± 0.461 customers". */
  plusMinus: (half: string) => `± ${half}`,
  scaleLow: "low",
  scaleHigh: "high",

  tier: {
    exact: "Exact",
    simulation: "Simulation",
    approximation: "Approximation",
    diffusion: "Diffusion model",
    bound: "Bound",
    mixed: "Mixed methods",
  } satisfies Record<Tier, string>,

  /** What a unit reads as beside a number (the record's unit name → words a student reads). */
  unit: {
    customers: "customers",
    time: "time units",
    "customers / time": "per time unit",
    probability: "",
    work: "work",
  } as Record<string, string>,

  notKey: "Results on Canvas is available when the main window is active.",
} as const;
