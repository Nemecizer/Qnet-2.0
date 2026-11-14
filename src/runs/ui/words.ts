// The run interface's words (0.90.34 QnetCommands.swift `runMenu`, `testMenu`, `runHelp`,
// `stopRunTitle`; RunParameterSpecs.swift; RunParameterSheet.swift; TestSetRunner.swift's two
// sheets; ContentView.swift `runSegment`; QnetGUIApp.swift `presentRunParameters`,
// `closeTabs(ids:)` and each `run…()` action's cancel line), as 0.90.34 wrote them. Menu titles
// are menuSpec's.

/** `TerminalModel.displayLabel(forRunLabel:)` (runner/src/supervisor/labels.rs `display_label`). */
const DISPLAY: Record<string, string> = {
  inf_cmp: "Run Comparison", cmp: "Run Comparison", inf_sim: "Monte Carlo", sim: "Monte Carlo", inf_sm: "Spectral", sm: "Spectral",
  qna: "QNA", rqna: "Robust QNA", sbd: "SBD", mlmc: "SRBM MLMC", lp: "Linear Program", flp: "Linear Program", fm: "Finite Element",
  mc: "Multi-class SRBM", testset: "Test Set", spc: "Spectral Convergence", primitives: "Network Primitives", analyze: "Analyze Network",
  // New in 2.1: Results ▸ Sensitivity's numerical route (src/sensitivity/runner.ts `SENSITIVITY_METHOD`;
  // src-tauri/src/quiet_runs.rs `SENSITIVITY_LABEL`), named for itself and not for the sweep it runs on.
  sensitivity: "Sensitivity",
  // New in 2.1 (runner/src/supervisor/labels.rs).
  closed_pf: "Closed Product Form",
  sim_inproc: "Replicated Simulation",
  priority_exact: "Exact Priority Queue",
  batch_exact: "Exact Batch-Arrival Queue",
};

/** Swift's `capitalized` on ASCII labels: a word starts at a letter that follows no letter. */
const capitalized = (s: string) => s.replace(/_/g, " ").replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

/** The name a run is shown under ("QNA", "Run Comparison", "Regenerative Mc"). */
export const displayLabel = (label: string) => DISPLAY[label] ?? capitalized(label);

/** `TerminalRunSummary.clock`: "m:ss" of the rounded seconds. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export const runWords = {
  // ── Run menu tooltips (QnetCommands.swift runMenu `.help`) ───────────────────────────────────
  help: {
    "run:comparison": "Run every method for the current buffer mode and tabulate the results side by side",
    "run:monte-carlo-infinite": "Discrete-event simulation of the unbounded-buffer queueing process (BNAsim · jackson_sim) — reference estimates include Monte Carlo uncertainty",
    "run:product-form": "Exact Jackson/open-BCMP stationary measures for class-preserving Poisson/exponential FCFS M/M/c networks; no state-space truncation",
    "run:closed-product-form": "Exact stationary measures of a closed network (a fixed population, no source and no sink) by Buzen's convolution algorithm, checked against Mean Value Analysis; computed inside Qnet",
    "run:replicated-simulation": "Steady-state simulation inside Qnet with confidence intervals: independent replications, warm-up deleted by MSER on 200 batch means, Student-t intervals. For a closed network (a second opinion beside the exact solution) and for an open network with infinite buffers",
    "run:priority-exact": "Exact mean values of one station with priority service fed by Poisson sources: Cobham's formula (non-preemptive), the preemptive-resume formula, and their multi-server forms for equal exponential rates; per class; computed inside Qnet",
    "run:batch-exact": "Exact mean values of one single-server station with batch Poisson arrivals (M^X/G/1): mean number, wait and sojourn of a customer; computed inside Qnet",
    "run:qbd": "Exact scalar matrix-geometric solution for the strict one-station M/M/1 subclass, including probabilistic feedback",
    "run:truncated-ctmc": "Sparse queue-process CTMC on successively larger total-population caps; truncation agreement is heuristic and any Foster bounds are labeled separately",
    "run:regenerative-infinite": "Sequential fixed-width queue simulation using complete empty-to-empty cycles as IID observations",
    "run:spectral-infinite": "Polynomial Galerkin solution of the SRBM in the orthant (BNAsm · bnet) — accurate in heavy traffic; cost grows quickly with the polynomial degree",
    "run:qna": "Whitt's parametric decomposition (BNAqna · bna_qna) — propagates two-moment traffic variability station by station; instant, approximate",
    "run:rqna": "Robust QNA, Whitt–You 2022 (BNArqna · bna_rqna) — replaces QNA's variability equations with a robust bound; instant, approximate",
    "run:sbd": "Sequential Bottleneck Decomposition (BNAsbd · bna_sbd) — splits the network into single-station subproblems and solves each one spectrally",
    "run:mlmc": "Multilevel Monte Carlo for the reflected Brownian motion (BNAmc · rbm_mlmc) — SRBM estimates with explicit finite-T and finite-L bias; no queue-simulation warm-up",
    "run:lp": "LP relaxation of the SRBM stationary distribution (BNAlp · srbm_lp, Saure–Glynn–Zeevi) — moment estimates whose cost grows with the constraint grid",
    "run:low-rank-bar": "Adaptive separable-exponential SRBM approximation with held-out BAR and moment-refinement diagnostics",
    "run:bar-bounds": "SRBM moment outer relaxation; exact special cases are certified and general floating SDP values remain explicitly uncertified",
    "run:monte-carlo-finite": "Discrete-event simulation of the finite-buffer queueing process (fBNAsim) — reference estimates include Monte Carlo uncertainty; the dialog picks the blocking regime",
    "run:regenerative-finite": "Sequential fixed-width simulation for finite loss-on-full Markovian networks using complete regeneration cycles",
    "run:generic-ctmc": "Exact finite-state Markov-chain solution for loss-on-full networks with Poisson arrivals and exponential FCFS service; stops before an unsafe state-space expansion",
    "run:decomposition": "Fast M/M/c/K fixed-point decomposition with explicit Loss or approximate BAS semantics and convergence diagnostics",
    "run:spectral-finite": "Polynomial Galerkin solution of the SRBM on the hypercube (fBNAsm · srbm_solver) — accurate at moderate degrees; memory grows quickly with degree and stations",
    "run:finite-element": "Hermite finite-element solution of the SRBM density on a hypercube (fBNAfm · bna_fm_gauss) — cost grows as n^2d in the mesh size n and the number of stations d",
    "run:finite-lp": "LP method for the SRBM on a rectangle (fBNAlp · fBNAlp_solver) — moment estimates for bounded buffers",
    "run:multiclass": "Class-aware workload diffusion with per-class traffic, compound service moments and routing covariance",
    "test:infinite": "Sweep random infinite-buffer networks and score every method against simulation",
    "test:finite": "Sweep random finite-buffer networks and score every method against simulation",
    "test:spectral-convergence": "Sweep ρ towards 1 and report how the spectral method's error shrinks",
  } as Record<string, string>,
  comparisonSuffix: " — ⌥⌘ + letter runs one method; Help ▸ Keyboard Shortcuts lists them",
  /** `runHelp`'s suffixes for a dimmed item. */
  noNetworkSuffix: " (open or draw a network first)",
  finiteSuffix: " (this network has finite buffers)",
  infiniteSuffix: " (this network has infinite buffers)",
  /** The same reasons as the palette states them. */
  noNetwork: "Open or draw a network first",
  hasFiniteBuffers: "This network has finite buffers",
  // New in 2.1: closed networks.
  isClosed: "This is a closed network (no source and no sink): use Exact Closed Product Form",
  /** Replicated Simulation on an open finite-buffer network. */
  replicatedNeedsInfinite: "This network has finite buffers: Replicated Simulation covers infinite buffers and closed networks",
  notClosed: "This needs a closed network: no source, no sink and a population",
  // New in 2.1: priorities, batch arrivals, rate profiles (src/extended/words.ts has the sentences).
  newFeatureSuffix: " (this network has priority service, batch arrivals or a rate profile, which this method does not model)",
  needsPrioritiesSuffix: " (no station of this network has priority service)",
  needsBatchesSuffix: " (no source of this network has batch arrivals)",
  closedSuffix: " (this is a closed network: use Exact Closed Product Form)",
  notClosedSuffix: " (this network has a source or a sink)",
  hasInfiniteBuffers: "This network has infinite buffers",
  multiClassTitle: "Run Multi-Class SRBM…",
  multiClassUnavailable: "Multi-Class SRBM — Unavailable",
  multiClassChecking: "Looking for mc_solver…",
  stopIdle: "Stop Run",
  stopTitle: (run: string) => `Stop ${run}`,
  nothingRunning: "Nothing is running",
  stopHelp: "Interrupt the running solver, as ⌃C would in the Shell",
  stopHelpBeforePid: "Interrupt the running solver as soon as it reports its process id (within a second)",
  testSetRunning: "A test set is running",

  // ── Before a sheet (presentRunParameters) ────────────────────────────────────────────────────
  sheetBusy: (title: string, run: string, tab: string) => `${title} cannot open while ${run} is running for “${tab}”. Stop or wait for that run first.`,
  sheetModal: (title: string) => `${title} needs the open dialog to be closed first.`,
  anotherTab: "another tab",

  // ── Closing a tab with a run (closeTabs(ids:)) ───────────────────────────────────────────────
  cannotClose: (title: string, run: string) => `“${title}” cannot be closed while ${run} is running. Stop or wait for the run first.`,

  // ── The sheet's chrome (RunParameterSheet.swift) ─────────────────────────────────────────────
  run: "Run",
  cancel: "Cancel",
  confirmHelp: "Start the run with these parameters (Return)",
  /** The spectral sheet opened on a lower degree than the stored one (new in 2.0, METH-052). */
  degreeChanged: (from: number, to: number, stations: number) =>
    `Degree changed from ${from} to ${to}: with ${stations} stations, ${to} is the largest degree whose matrix fits the 2 GB memory limit.`,
  cancelHelp: "Close without running (Esc)",
  blockedHelp: "Fix the highlighted values to run",
  setAsDefault: "Set as Default",
  savedAsDefault: "Saved as Default",
  setAsDefaultHelp: "Remember these values as the defaults for this dialog and Settings",
  setAsDefaultA11y: "Set as default",
  outOfRange: (field: string, lo: string, hi: string) => `${field} must be between ${lo} and ${hi}.`,
  helpButton: (topic: string) => `Open Qnet Help: ${topic}`,
  glossaryHelp: (term: string) => `What is ${term}?`,
  decrement: (field: string) => `Decrease ${field}`,
  increment: (field: string) => `Increase ${field}`,
  clampedTo: (v: string) => `Clamped to ${v}`,
  cannotContinue: (problem: string) => `Cannot continue: ${problem}`,
  couldNotSaveDefaults: (why: string) => `Couldn't save the defaults: ${why}`,

  // ── The status-bar run segment (ContentView.swift runSegment) ────────────────────────────────
  segmentProgress: (pct: number, time: string) => `${pct}% · ${time}`,
  segmentRunning: (run: string, tab: string, time: string) => `Running ${run} for ${tab}… ${time}`,
  segmentHelpProgress: (run: string, tab: string, pct: number, time: string, key: string) => `${run} for ${tab}: ${pct}% done after ${time} — Stop with ${key}`,
  segmentHelpRunning: (run: string, tab: string, time: string, key: string) => `${run} for ${tab} is running in the Shell (${time}) — Stop with ${key}`,
  segmentA11yProgress: (run: string, tab: string, pct: number, time: string) => `Running ${run} for ${tab}, ${pct} percent, ${time} elapsed`,
  segmentA11yRunning: (run: string, tab: string, time: string) => `Running ${run} for ${tab}, ${time} elapsed`,
  stopButton: "Stop Run",
  stopButtonHelp: (run: string, key: string) => `Stop ${run} (Run ▸ Stop ${run}, ${key}) — sends the same interrupt ⌃C would in the Shell`,
  stopButtonHelpBeforePid: (run: string, key: string) => `Stop ${run} (Run ▸ Stop ${run}, ${key}) — interrupts it as soon as it reports its process id`,
  lastRun: (text: string, tab: string) => `${text} · ${tab}`,
  lastRunHelp: (text: string) => `Last run: ${text}`,
  idle: "Idle",
  /** Spoken once when a run starts and once when it ends (docs/ACCESSIBILITY.md). */
  announceStarted: (run: string, tab: string) => `Running ${run} for ${tab}.`,
  announceEnded: (text: string, tab: string) => `Run finished: ${text}, ${tab}.`,
  idleHelp: "No solver run yet — use the Run menu",
  progressLabel: "Run progress",

  // ── Test menu sheets (TestSetRunner.swift) ───────────────────────────────────────────────────
  testSetTitle: (infinite: boolean) => `Run ${infinite ? "Infinite" : "Finite"} Test Set`,
  testSetSubtitle: (regime: string) => `Generates random ${regime}-buffer networks, runs every ${regime}-regime method on each and reports the per-method accuracy averaged over the sweep.`,
  spcTitle: "Run Infinite Spectral Convergence",
  spcSubtitle: "For each case, generates one random network and sweeps the target ρ from start to end in equal steps, reporting how the spectral method's error shrinks as ρ → 1.",
  networksSection: "Networks",
  sweepSection: "Sweep",
  stations: "Stations",
  stationsHelp: "Number of service stations d drawn for each network (1–32)",
  classes: "Customer classes",
  classesHelp: "Number of customer classes c drawn for each network (1–16)",
  targetRho: "Target ρ",
  targetRhoField: "Target utilisation",
  rhoGlossary: "ρ — utilisation: fraction of time the station is busy (λ / (c·μ)). Must be below 1 for stability.",
  topology: "Topology",
  topologyHelp: "Routing structure of every generated network",
  topologies: ["Feed-forward", "Jackson feedback (light)", "General P-matrix (full feedback)", "Re-entrant feedback (class-change)"],
  networksFooter: "Each case draws d, c and ρ uniformly from these ranges.",
  testCases: "Test cases",
  testCasesHelp: "Number of random networks in the sweep (1–1000)",
  spcCasesHelp: "Number of random networks, each swept over every ρ value (1–200)",
  fixedSeed: "Fixed random seed",
  fixedSeedHelp: "Use the same generated networks when these parameters are run again",
  spcFixedSeedHelp: "Reuse the same network shapes and simulation streams when this sweep is run again",
  seed: "Seed",
  seedHelp: "Base seed used to generate the complete test set",
  seedA11y: "Test-set seed",
  spcSeedHelp: "Base seed for the complete convergence sweep",
  spcSeedA11y: "Convergence-sweep seed",
  sweepSummary: (n: number, regime: string) => `${n} random ${regime}-buffer network${n === 1 ? "" : "s"}, each solved by every ${regime}-buffer method and scored against the simulator.`,
  rhoSweep: "ρ sweep",
  rhoSweepHelp: "Target utilisation ρ is swept from start to end; both strictly between 0 and 1",
  sweepStart: "Sweep start",
  sweepEnd: "Sweep end",
  step: "Step",
  stepHelp: "Increment between consecutive ρ values (0 < step ≤ end − start)",
  sweepStep: "Sweep step",
  stepError: "Step must be positive and at most end − start",
  solveSummary: (n: number, m: number) => {
    const solves = n * m;
    return `${n} case${n === 1 ? "" : "s"} × ${m} ρ value${m === 1 ? "" : "s"} = ${solves} spectral solve${solves === 1 ? "" : "s"}, each checked against simulation (QNA is the flat-line baseline).`;
  },
  solveSummaryInvalid: "Choose a valid ρ sweep to see the number of solves.",
  testConfirmHelp: "Generate the networks and start the sweep (Return)",
  spcConfirmHelp: "Generate the networks and start the convergence sweep (Return)",
  testBlockedHelp: "Fix the highlighted values to run the sweep",
  // TestSetParameterSheet.problem / SpectralConvergenceParameterSheet.problem, in row order.
  stationsRange: "Stations must be between 1 and 32.",
  stationsOrder: "Minimum stations must not exceed the maximum.",
  classesRange: "Customer classes must be between 1 and 16.",
  classesOrder: "Minimum classes must not exceed the maximum.",
  rhoRange: "ρ must lie strictly between 0 and 1.",
  rhoOrder: "Minimum ρ must not exceed the maximum.",
  casesRange: "Test cases must be between 1 and 1000.",
  spcSweepInvalid: "ρ sweep needs 0 < start < end < 1 and 0 < step ≤ end − start.",
  spcCasesRange: "Test cases must be between 1 and 200.",
  minimum: (field: string) => `Minimum ${field.toLowerCase()}`,
  maximum: (field: string) => `Maximum ${field.toLowerCase()}`,
  couldNotStart: (what: string, why: string) => `Couldn't start ${what}: ${why}`,
} as const;

/** DS.Glossary texts the run sheets show (DesignSystem.swift `DS.Glossary`). */
export const glossary = {
  replications: "Number of independent simulation runs averaged into the reported estimate. The 95 % half-width shrinks roughly as one over the square root of this.",
  warmup: "Simulated time discarded before statistics start, so the estimate is not biased by the empty initial state. Measured in the model's time unit, not wall-clock seconds.",
  bas: "BAS — blocking after service: a finished job waits at its server until the downstream buffer has room.",
  polynomialDegree: "Maximum total degree of the polynomials in the Galerkin trial space. Higher degree converges faster on a smooth density, but the linear system grows combinatorially with the number of stations.",
  meshSize: "Number of finite elements along each axis of the hypercube. The mesh has nᵈ cells for d stations, and assembling it costs about n²ᵈ, so a mesh that is comfortable at two stations is impossible at five.",
  gridN: "grid_n — points per axis of the discretisation grid. The linear program has roughly grid_nᵈ variables for d stations, so the usable grid shrinks quickly as the network grows.",
  basisM: "basis_m — number of polynomial (monomial) basis functions used per boundary block. More terms fit the boundary density better but make the linear program larger and worse conditioned.",
  smoothness: "Weight on a penalty that discourages curvature in the fitted density. Zero disables the penalty; larger values give a smoother, less peaked fit and break a degenerate LP toward one solution.",
} as const;
