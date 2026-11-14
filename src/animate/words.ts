// The words of the canvas animation (new in 2.1, ROADMAP Phase E). It is always called what it
// is: one random run, an illustration. Results with confidence intervals come from Solve.
export const animateWords = {
  menuTitle: "Animate",
  menuHelp: "Watch one random run of the network on the canvas: customers arrive, queue, are served and move on",
  keywords: ["animate", "animation", "simulate", "simulation", "play", "watch", "customers", "tokens", "movie", "run"],
  notKey: "Animate is available when the main window is active.",

  /** The label the view always carries. */
  title: "Animation (one random run)",
  barLabel: "Animation controls",
  useSolve: "An illustration, not a result: for results with confidence intervals use Solve.",

  play: "Play",
  pause: "Pause",
  playHelp: "Play or pause (Space, when the canvas has the keyboard)",
  restart: "Restart",
  restartHelp: "Start this run again from time 0 with the same seed: the same customers, the same times",
  newRun: "New Run",
  newRunHelp: "Start again from time 0 with a new random seed: a different run of the same network",
  skip: "Skip Ahead",
  skipHelp: (span: string) => `Jump ${span} time units ahead without drawing what happens on the way. The averages keep counting.`,
  skipping: "Skipping…",
  speed: "Speed",
  speedOption: (x: number) => `${x}×`,
  speedHelp: (pace: string) => `Playback speed. At 1×, one second shows ${pace} time units.`,
  close: "Close Animation",
  closeHelp: "Leave animation mode and return to the drawing",

  clock: (t: string) => `t = ${t}`,
  clockUnit: "time units",
  clockSpoken: (t: string) => `Simulated time ${t} time units`,
  seed: (seed: number) => `seed ${seed}`,
  seedHelp: "The random seed of this run. Restart replays the same seed; New Run draws another.",
  starting: "Starting…",
  waiting: "Simulating…",

  /** The status bar's button. */
  button: "Animate",
  buttonOn: "Animating",
  buttonHelp: "Watch one random run of the network on the canvas (View ▸ Animate)",
  buttonHelpOn: "Leave animation mode",

  // The strip chart.
  chartTitle: (station: string) => `Number at ${station}`,
  chartNow: (n: number) => `${n} ${n === 1 ? "customer" : "customers"} now`,
  chartAverage: (avg: string, t: string) => `average ${avg} customers after t = ${t} time units`,
  chartNoAverage: "no average yet",
  chartExact: (l: string) => `exact long-run mean ${l} customers (dashed)`,
  chartNoExact: "no exact mean: no closed formula applies to this network",
  chartUnstableExact: "no long-run mean: no steady state exists",
  chartWindow: (span: string) => `last ${span} time units`,
  chartSpoken: (station: string, n: number, average: string | null, t: string, exact: string | null) =>
    `Number of customers at ${station} over the last stretch of the run: ${n} now` +
    (average ? `, time average ${average} customers after ${t} time units` : "") +
    (exact ? `. Exact long-run mean ${exact} customers.` : "."),
  chartPick: "Select a station to chart it.",
  biasOpen: "Early averages are biased by the empty start.",
  biasClosed: "Early averages are biased by the start, with every customer at the first station.",
  population: (n: number) => `${n} ${n === 1 ? "customer circulates" : "customers circulate"}`,
  inNetwork: (n: number) => `${n} in the network`,

  classLegend: (i: number) => `Class ${i + 1}`,
  legendLabel: "Customer classes",

  unstable: (names: string[]) =>
    `No steady state exists: work arrives at ${names.join(", ")} as fast as it can be served, or faster (ρ ≥ 1), so ${names.length === 1 ? "its queue keeps" : "their queues keep"} growing for as long as the run goes on.`,
  reduced: "Reduce Motion is on: customers are not drawn travelling. Counts and servers update in steps.",
  restarted: "The network changed, so the animation started again from time 0.",
  refusedTitle: "This network can't be animated",
  failedTitle: "The animation stopped",

  /** Spoken summary, updated every few seconds while playing. */
  spoken: (t: string, parts: string[]) => `Time ${t}. ${parts.join("; ")}.`,
  spokenStation: (name: string, n: number, busy: number, servers: number) => `${name}: ${n} ${n === 1 ? "customer" : "customers"}, ${busy} of ${servers} ${servers === 1 ? "server" : "servers"} busy`,
  canvasLabel: "Animation of the network: customers as coloured tokens",
} as const;
