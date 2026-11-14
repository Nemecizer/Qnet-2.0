// Every word the Settings window shows, as 0.90.34 words it (SettingsView.swift,
// SettingsComponents.swift, DSFields.swift, DesignSystem.swift `DS.Glossary`, SolverEngine.swift,
// LLMBackend.swift, HelpOutputDestination.swift, AlgorithmHelp.swift). Row texts are keyed by the
// row's id (its 0.90.34 `settingsAnchor`), which is also its search-registry id (registry.ts).

/** A row's words: the label (also its search title), the caption under it, the tooltip, the unit
 * column, the glossary entry behind its "?", and a menu row's option titles and captions. */
export interface RowWords {
  label: string;
  caption?: string;
  help?: string;
  unit?: string;
  glossary?: keyof typeof glossary;
  /** Menu rows: the pop-up title of each option, in option order. */
  titles?: string[];
  /** Menu rows: the caption under the label for each option (it follows the selection). */
  details?: string[];
}

/** `DS.Glossary`: the text behind a row's "?" (DesignSystem.swift). */
export const glossary = {
  rho: "ρ — utilisation: fraction of time the station is busy (λ / (c·μ)). Must be below 1 for stability.",
  bas: "BAS — blocking after service: a finished job waits at its server until the downstream buffer has room.",
  replications: "Number of independent simulation runs averaged into the reported estimate. The 95 % half-width shrinks roughly as one over the square root of this.",
  warmup: "Simulated time discarded before statistics start, so the estimate is not biased by the empty initial state. Measured in the model's time unit, not wall-clock seconds.",
  simulationTime: "Simulated time over which statistics are collected in each replication, in the model's time unit. Wall-clock cost scales with this × replications ÷ cores.",
  epsilon: "ε — target root-mean-square error of the estimated stationary moments. Multilevel Monte Carlo keeps sampling until it expects to be this close, and the cost scales as 1/ε²: halving ε costs about four times the runtime.",
  stepFactor: "γ — ratio between the time-step sizes of two consecutive MLMC levels. Smaller γ means less discretisation bias per level but more work per path; 1/γ must be a whole number.",
  antithetic: "Antithetic variates — each sample is simulated together with its sign-flipped noise twin and the pair is averaged. The two are negatively correlated, so the variance roughly halves for about 1.5–2× the runtime, with no bias.",
  batchSize: "Samples drawn between successive standard-error checks in adaptive mode. Larger batches check less often and may overshoot the target; smaller ones add bookkeeping.",
  minSamples: "Adaptive sampling never stops before this many samples, however small the standard error looks — an early estimate can be optimistic.",
  maxSamples: "Hard cap on samples in adaptive mode, so a run whose standard error never reaches the target still terminates.",
  mlmcBackend: "Threading library rbm_mlmc uses to run paths in parallel. OpenMP is fastest when the binary was built with it; Apple GCD uses Accelerate; Serial runs on one thread, which is useful for reproducing a run exactly.",
  gridN: "grid_n — points per axis of the discretisation grid. The linear program has roughly grid_nᵈ variables for d stations, so the usable grid shrinks quickly as the network grows.",
  basisM: "basis_m — number of polynomial (monomial) basis functions used per boundary block. More terms fit the boundary density better but make the linear program larger and worse conditioned.",
  gridTypeOrthant: "How the grid_n points are spread along each axis. Exponential clusters them near the origin, where the stationary density has most of its mass; dyadic halves the spacing at each step; the randomised variant jitters the exponential grid to break ties in a degenerate LP.",
  lpBackend: "The linear-programming library that solves the relaxation. CPLEX is fastest on small networks (d ≤ 3), HiGHS scales better at d ≥ 4 and ships with the app, GLPK is the universal fallback. Auto picks the first one that is installed.",
  smoothness: "Weight on a penalty that discourages curvature in the fitted density. Zero disables the penalty; larger values give a smoother, less peaked fit and break a degenerate LP toward one solution.",
  gridTypeRectangle: "How the grid_n points are spread along each axis of the rectangle. Uniform spaces them evenly; Chebyshev nodes cluster toward the two buffer boundaries, where a finite-buffer density changes fastest.",
  quadrature: "Quadrature is the numerical integration rule used to build the finite-element matrices. Gauss–Legendre places a small number of exactly-weighted points per element and is the accurate choice at low dimension; CBC quasi-Monte Carlo uses a lattice rule whose cost grows far more slowly with the number of stations.",
  meshSize: "Number of finite elements along each axis of the hypercube. The mesh has nᵈ cells for d stations, and assembling it costs about n²ᵈ, so a mesh that is comfortable at two stations is impossible at five.",
  polynomialDegree: "Maximum total degree of the polynomials in the Galerkin trial space. Higher degree converges faster on a smooth density, but the linear system grows combinatorially with the number of stations.",
  topology: "Feed-forward networks route every job strictly downstream. Jackson + feedback adds random return arcs; General P-matrix draws an arbitrary routing matrix; Re-entrant sends a class back to a station it has already visited, the case QNA-style decompositions find hardest.",
  aiProvider: "Which chat-completion service the assistant talks to. Each provider keeps its own base URL, model name and API key, so switching back restores what was set for it.",
} as const;

// DualEngineMethod (SolverEngine.swift).
const engine = {
  regenerative: {
    summary: "Discrete-event simulation over regenerative cycles.",
    speedup: "252× measured (200,000 cycles on a two-node two-class network: 10.10 s → 0.04 s)",
  },
  qbd: {
    summary: "Matrix-geometric rate matrix by functional iteration.",
    speedup: "16× measured (48 interior phases: 38.9 s → 2.4 s)",
  },
  ctmc: {
    summary: "The adaptive truncated CTMC and the finite generic CTMC, which share a power-iteration kernel.",
    speedup: "21× to 78× measured (truncated CTMC, 12,341 states: 9.09 s → 0.43 s; finite CTMC, 60,929 states: 9.31 s → 0.12 s)",
  },
};
const engineRow = (m: keyof typeof engine): RowWords => ({
  label: "Engine",
  help: `${engine[m].summary} Both engines compute the same result; the C one is faster. ${engine[m].speedup}.`,
  titles: ["C", "Python"],
  details: [
    "The native binary. Same result as the Python engine, sooner.",
    "The reference implementation: readable, needs no compiler, and the engine to reach for when a result looks wrong.",
  ],
});

const topologyRow: RowWords = {
  label: "Topology",
  help: "Routing structure of the generated networks.",
  glossary: "topology",
  titles: ["Feed-forward", "Jackson + feedback", "General P-matrix", "Re-entrant"],
  details: [
    "Every job routes strictly downstream.",
    "Feed-forward plus random return arcs.",
    "An arbitrary routing matrix.",
    "A class revisits a station — the hardest case for decompositions.",
  ],
};
const casesRow = (help: string): RowWords => ({ label: "Number of cases", unit: "cases", help });
const classesRow = (help: string): RowWords => ({ label: "Classes", help });
const rhoRow: RowWords = { label: "Utilisation ρ", help: "Range of bottleneck utilisations targeted by the generated networks.", glossary: "rho" };

const lpRows = (p: "lp" | "flp", t: { autoGridHelp: string; gridHelp: string; autoBasisHelp: string; basisHelp: string }): Record<string, RowWords> => ({
  [`${p}.recommended`]: {
    label: "Recommended for the open network",
    help: "The dimension-dependent sizes each run uses while a value is set to Auto. Follows the front network as you edit it.",
  },
  [`${p}.autoGrid`]: { label: "Auto-scale grid_n by dimension", caption: "Off: the value below is used for every network.", help: t.autoGridHelp },
  [`${p}.gridN`]: { label: "Grid size (grid_n)", unit: "cells / axis", help: t.gridHelp, glossary: "gridN" },
  [`${p}.autoBasis`]: { label: "Auto-scale basis_m by dimension", caption: "Off: the value below is used for every network.", help: t.autoBasisHelp },
  [`${p}.basisM`]: { label: "Basis size (basis_m)", unit: "terms", help: t.basisHelp, glossary: "basisM" },
});

const normaliseRow: RowWords = {
  label: "Normalise monomial basis",
  caption: "Recommended for d ≥ 3.",
  help: "Rescales polynomial columns to unit magnitude, which reduces LP conditioning problems at higher degrees.",
};

const fontSizeRow = (help: string): RowWords => ({ label: "Text size", unit: "pt", help });

/** The window's text, row by row (keys are row ids). */
export const rows: Record<string, RowWords> = {
  // General
  "tabs.restoreBehavior": {
    label: "On quit",
    help: "What happens to open network tabs when Qnet quits and relaunches.",
    titles: ["Ask", "Always restore", "Never restore"],
    details: [
      "Qnet asks on the next launch whether to reopen the tabs that were open at quit.",
      "Tabs that were open at quit come back on the next launch without asking.",
      "Every launch starts with one empty tab.",
    ],
  },
  "welcome.showAtLaunch": {
    label: "Show Welcome at launch",
    caption: "The start screen with a first network, recent files and the examples.",
    help: "When on, a launch with no network open shows the Welcome view. It is always under Help ▸ Welcome to Qnet.",
  },
  "runCompare.remember": {
    label: "Remember blocking choice",
    caption: "Skip the blocking-regime dialog and use the default below.",
    help: "When on, Run ▸ Run Comparison no longer asks which finite-buffer blocking regime to simulate.",
  },
  "general.blockingSummary": { label: "Default blocking regime", caption: "Shared with Discrete-Event Simulation ▸ Blocking mode." },
  "updates.auto": {
    label: "Check for updates automatically",
    caption: "At most once a day, when Qnet starts. Nothing is installed without asking.",
    help: "When on, Qnet asks its update server once a day whether a newer version exists. Qnet ▸ Check for Updates… asks at any time.",
  },
  "general.resetAll": { label: "Reset all panes" },
  "general.exportImport": { label: "Configuration file", caption: "JSON of every stored setting. API keys stay in the Keychain and are never written." },

  // Solver Engine
  "engine.regenerative": engineRow("regenerative"),
  "engine.qbd": engineRow("qbd"),
  "engine.ctmc": engineRow("ctmc"),
  "engine.parity": { label: "How the engines are kept identical" },

  // Discrete-Event Simulation
  "sim.parallel": {
    label: "Parallelisation",
    help: "How replications are distributed across cores. Sequential is useful for debugging or reproducing a single-thread run.",
    titles: ["Apple GCD", "OpenMP", "Sequential"],
    details: [
      "Replications run on all cores through Grand Central Dispatch.",
      "Replications run on all cores through OpenMP (when the binary was built with it).",
      "One replication at a time on one thread — for debugging or reproducing a single-thread run.",
    ],
  },
  "sim.blocking": {
    label: "Blocking mode",
    help: "What a finite-buffer station does when the next buffer is full.",
    glossary: "bas",
    titles: ["Loss", "BAS", "BAS + external loss"],
    details: [
      "Arrivals to a full buffer are discarded.",
      "The server blocks after service; external arrivals are held.",
      "The server blocks after service; external arrivals to a full buffer are lost — matches the RBM model.",
    ],
  },
  "sim.replications": {
    label: "Replications",
    unit: "runs",
    help: "Independent simulation runs averaged for each estimate. More runs narrow the reported half-width at proportionally higher cost.",
    glossary: "replications",
  },
  "sim.warmup": {
    label: "Warm-up period",
    unit: "time units",
    help: "Simulated time discarded before statistics are collected (jackson_sim -w), so the initial empty-system transient does not bias the estimates.",
    glossary: "warmup",
  },
  "sim.time": {
    label: "Simulation time",
    unit: "time units",
    help: "Simulated time over which statistics are collected in each replication (jackson_sim -T).",
    glossary: "simulationTime",
  },
  "sim.seed": {
    label: "Fixed random seed",
    caption: "When off, Qnet generates a fresh seed for every run and records the seed with the result.",
    help: "Base seed for the simulation streams. Turn the switch on to replay the same streams.",
  },

  // SRBM MLMC
  "mlmc.epsilon": {
    label: "Target RMSE (ε)",
    caption: "Cost scales as 1/ε²: halving ε costs about 4× the runtime. Stepper halves / doubles.",
    help: "Target root-mean-square error of the stationary moments. Typical values 0.001–0.1.",
    glossary: "epsilon",
  },
  "mlmc.gamma": {
    label: "Step factor (γ)",
    help: "0.05 is the optimum analysed in the paper; smaller γ gives less bias per level but more cost per path. 1/γ must be an integer.",
    glossary: "stepFactor",
  },
  "mlmc.T": {
    label: "Path length T",
    caption: "Auto: max(log(d)²/2, 5 × relaxation time).",
    unit: "time units",
    help: "Length of each simulated path. Larger T removes initial-transient bias but costs linearly.",
  },
  "mlmc.L": {
    label: "Number of levels L",
    caption: "Auto: L = ⌈(log log d + 2 log(1/ε) + k) / log(1/γ)⌉.",
    unit: "levels",
    help: "More levels shrink discretisation bias exponentially, but cost grows as γ^(−L).",
  },
  "mlmc.N": {
    label: "Sample count N",
    caption: "Fixed-sample mode only. Auto: N = ⌈K(γ)⁻¹ γ^(−L) L⌉.",
    unit: "samples",
    help: "Total MLMC samples in fixed-sample mode. Adaptive mode uses its maximum-sample cap instead.",
  },
  "mlmc.antithetic": {
    label: "Antithetic variates",
    caption: "Each sample simulates a ±noise pair; roughly halves the variance for ~1.5–2× runtime, no bias.",
    help: "Recommended. Averages each path with its sign-flipped twin.",
    glossary: "antithetic",
  },
  "mlmc.replications": {
    label: "Replications (K)",
    caption: "K = 1 keeps the native within-run station intervals; K = 5–10 also identifies a joint network-average interval.",
    unit: "runs",
    help: "Run the whole algorithm K times with different seeds and report mean ± sample standard error.",
  },
  "mlmc.adaptive": {
    label: "Adaptive sampling",
    caption: "Stop once the sample standard-error target is met.",
    help: "Adaptive mode targets only the sample standard error, not discretisation or transient bias.",
  },
  "mlmc.batchSize": { label: "Batch size", unit: "samples", help: "Samples drawn between successive standard-error checks.", glossary: "batchSize" },
  "mlmc.minSamples": {
    label: "Minimum samples",
    unit: "samples",
    help: "Never stop before this many samples have been drawn; at least two are required to estimate variance.",
    glossary: "minSamples",
  },
  "mlmc.maxSamples": {
    label: "Maximum samples",
    unit: "samples",
    help: "Hard cap on samples when the target is never reached; at least two are required to estimate variance.",
    glossary: "maxSamples",
  },
  "mlmc.backend": {
    label: "Backend",
    help: "Threading library used by rbm_mlmc. Auto prefers OpenMP when the binary was built with it.",
    glossary: "mlmcBackend",
    titles: ["Auto", "OpenMP", "Apple GCD", "Serial"],
    details: [
      "OpenMP when rbm_mlmc was built with it, otherwise Apple GCD.",
      "OpenMP worker threads; fastest when the binary was built with libomp.",
      "Grand Central Dispatch with Accelerate; no OpenMP needed.",
      "One thread — reproduces a run exactly, at single-core speed.",
    ],
  },
  "mlmc.threads": { label: "Threads", unit: "cores", help: "Worker threads. Empty (stored as 0) uses one thread per logical core." },
  "mlmc.seed": {
    label: "Fixed random seed",
    caption: "When off, Qnet chooses a random base seed. Replication streams are hashed and recorded.",
    help: "Base seed for deterministic, widely separated replication streams. Fix it to reproduce every recorded stream exactly.",
  },

  // Linear Program
  ...lpRows("lp", {
    autoGridHelp: "When on, the grid size follows the dimension-dependent table from the paper's experiments.",
    gridHelp: "Points per axis of the discretisation grid. The LP has roughly nᵈ variables, so n must shrink as d grows.",
    autoBasisHelp: "When on, the polynomial basis size follows the dimension-dependent table.",
    basisHelp: "Number of monomial basis functions per boundary block.",
  }),
  "lp.gridType": {
    label: "Grid type",
    help: "Spacing of the grid points along each axis.",
    glossary: "gridTypeOrthant",
    titles: ["Exponential", "Dyadic", "Exponential (randomised)"],
    details: [
      "Default. Points cluster near the origin, where the density has most of its mass.",
      "Spacing halves at each step from the origin.",
      "The exponential grid, jittered to break ties in a degenerate LP.",
    ],
  },
  "lp.solver": {
    label: "LP backend",
    help: "CPLEX is fastest for d ≤ 3, HiGHS scales better at d ≥ 4, GLPK is the universal fallback.",
    glossary: "lpBackend",
    titles: ["Auto", "CPLEX", "GLPK", "HiGHS"],
    details: [
      "CPLEX if installed, then HiGHS, then GLPK.",
      "Fastest on d ≤ 3. Must be installed separately.",
      "The universal fallback; slowest on large programs. Must be installed separately.",
      "Scales best at d ≥ 4 and ships with the app.",
    ],
  },
  "lp.basisNormalize": normaliseRow,
  "lp.smoothness": {
    label: "Smoothness weight",
    caption: "0 = off. Try 1e-4 if a run reports a range of plausible solutions.",
    help: "Adds a total-variation penalty that breaks degenerate LPs toward a smooth solution.",
    glossary: "smoothness",
  },
  "lp.askBeforeRun": {
    label: "Ask for parameters before each run",
    caption: "A small dialog after Run ▸ Linear Program lets you adjust these values for that run only.",
    help: "Show a per-run parameter dialog.",
  },
  "lp.multiLevel": {
    label: "Multi-level refinement",
    caption: "Runs a fast coarse LP (grid_n ÷ 2) as a preview, then the full-resolution LP.",
    help: "Useful for d ≥ 3 where the full run is slow.",
  },
  "lp.hints": { label: "Performance Hints…", help: "Show the recommended grid / basis table and timing notes." },

  // Finite-Buffer LP
  ...lpRows("flp", {
    autoGridHelp: "When on, the grid size follows the finite-buffer table (smaller than the orthant LP because the rectangle has 2d boundary blocks).",
    gridHelp: "Points per axis of the discretisation grid on the rectangle.",
    autoBasisHelp: "When on, the polynomial basis size follows the finite-buffer table.",
    basisHelp: "Number of monomial basis functions per boundary block.",
  }),
  "flp.gridType": {
    label: "Grid type",
    help: "Uniform spacing, or Chebyshev nodes clustered toward the buffer boundaries.",
    glossary: "gridTypeRectangle",
    titles: ["Uniform", "Chebyshev"],
    details: [
      "Default. Points are evenly spaced across the rectangle.",
      "Points cluster toward the two buffer boundaries, where the density changes fastest.",
    ],
  },
  "flp.solver": {
    label: "LP backend",
    help: "LP solver passed to fBNAlp_solver --solver. HiGHS ships with the app; GLPK and CPLEX must be installed separately.",
    glossary: "lpBackend",
    titles: ["HiGHS", "GLPK", "CPLEX"],
    details: [
      "Default. Ships with the app, so it works everywhere.",
      "The universal fallback. Must be installed separately.",
      "Fastest when available. Must be installed separately.",
    ],
  },
  "flp.basisNormalize": normaliseRow,

  // Finite Element
  "fem.solver": {
    label: "Quadrature method",
    help: "Integration rule used to assemble the finite-element matrices (bna_fm_gauss or bna_fm_cbc).",
    glossary: "quadrature",
    titles: ["Gauss–Legendre", "CBC quasi-Monte Carlo"],
    details: [
      "Exactly-weighted points per element (bna_fm_gauss); the accurate choice at low dimension.",
      "Lattice rule (bna_fm_cbc); cost grows far more slowly with the number of stations.",
    ],
  },
  "fem.meshSize": {
    label: "Mesh size",
    caption: "Elements along each axis of the hypercube.",
    unit: "/ axis",
    help: "Finer meshes are more accurate, but cost grows as n²ᵈ.",
    glossary: "meshSize",
  },

  // Spectral Method
  "sm.degree": {
    label: "Polynomial degree",
    caption: "Maximum total degree of the Galerkin trial space.",
    help: "Higher degree converges faster on smooth densities but the linear system grows combinatorially with d.",
    glossary: "polynomialDegree",
  },
  "sm.legendre": {
    label: "Use Legendre basis",
    caption: "Orthogonal basis instead of raw monomials.",
    help: "Legendre polynomials keep the system well-conditioned at high degree.",
  },

  // Test Sets
  "testset.inf.stations": { label: "Stations", help: "Range of station counts (dimension d) drawn for each random case." },
  "testset.inf.classes": classesRow("Range of customer-class counts drawn for each random case."),
  "testset.inf.rho": rhoRow,
  "testset.inf.numCases": casesRow("Random networks generated and solved in one sweep."),
  "testset.inf.topology": topologyRow,
  "testset.fin.stations": { label: "Stations", help: "Range of station counts (dimension d). Finite solvers scale as n²ᵈ, so keep this small." },
  "testset.fin.classes": classesRow("Range of customer-class counts drawn for each random case."),
  "testset.fin.rho": rhoRow,
  "testset.fin.numCases": casesRow("Random networks generated and solved in one sweep."),
  "testset.fin.topology": topologyRow,
  "testset.spc.stations": { label: "Stations", help: "Range of station counts (dimension d) drawn for each generated network." },
  "testset.spc.classes": classesRow("Range of customer-class counts drawn for each generated network."),
  "testset.spc.rhoRange": { label: "ρ sweep start … end", help: "Each generated network is solved at every ρ from start to end.", glossary: "rho" },
  "testset.spc.rhoStep": { label: "ρ step", help: "Increment between successive ρ values in the sweep.", glossary: "rho" },
  "testset.spc.numCases": casesRow("Random networks generated; each is swept across the whole ρ grid."),
  "testset.spc.topology": topologyRow,

  // Output Format
  "output.decimals": {
    label: "Decimal places",
    unit: "digits",
    help: "Digits after the decimal point for every number the solvers print, in the Interactive Shell and in the Results pane.",
  },

  // Panes
  "shell.fontName": {
    label: "Font",
    caption: "Fixed-pitch families only — the Shell pane needs equal-width cells.",
    help: "Font family for the Shell pane. Also in the Shell pane header.",
  },
  "shell.fontSize": fontSizeRow("Point size of the Shell pane font. Also the A+ / A− buttons in the Shell pane header (⌘= / ⌘− while it has focus)."),
  "shell.classicTheme": {
    label: "Classic green-on-black",
    caption: "Off: the Shell pane follows the system text and background colours (light and dark).",
    help: "Use the classic green-on-black palette in the Shell pane instead of the semantic text and background colours.",
  },
  "status.fontSize": fontSizeRow("Point size of the Status pane log. Also the A+ / A− buttons in the Status pane header."),
  "ai.fontName": {
    label: "Code font",
    caption: "Fenced code and tool output; prose uses the system font. Fixed-pitch families only unless “Show all fonts” is on.",
    help: "Code font (fenced code and tool output; prose uses the system font). Also in the AI Assistant pane header.",
  },
  "ai.fontSize": fontSizeRow("Point size of the AI Assistant transcript — prose and code alike. Also the A+ / A− buttons in the AI Assistant pane header."),

  // Help
  "help.outputDestination": {
    label: "Send help output to",
    help: "Where the text of the Help menu items is shown.",
    titles: ["Status pane (plain text)", "Shell pane (plain text)", "Qnet Help window"],
    details: [
      "Help text is appended to the Status pane in the top-right of the main window, bracketed by divider lines.",
      "Help text is piped into the Shell pane and stays in the scrollback alongside command results.",
      "The topic opens in the searchable Qnet Help window (non-modal, alongside the main window). The main window stays interactive.",
    ],
  },

  // AI Assistant
  "ai.paneVisible": {
    label: "Show AI Assistant pane",
    caption: "When off, the Shell pane expands to fill the bottom of the window.",
    help: "Show or hide the AI Assistant pane in the main window. The same switch is under View ▸ Panes.",
  },
  "ai.provider": {
    label: "Provider",
    help: "Which chat-completion service the assistant talks to. Each provider keeps its own URL, model and key.",
    glossary: "aiProvider",
    titles: ["Anthropic (Claude API)", "OpenAI", "Ollama (local)", "LM Studio (local)"],
    details: [
      "Cloud service — needs an API key. Its URL, model and key are kept separately from the other providers'.",
      "Cloud service — needs an API key. Its URL, model and key are kept separately from the other providers'.",
      "Local server — no key needed. Its URL and model are kept separately from the other providers'.",
      "Local server — no key needed. Its URL and model are kept separately from the other providers'.",
    ],
  },
  "ai.baseURL": { label: "Base URL", help: "Endpoint of the chat-completion service for this provider" },
  "ai.model": { label: "Model", help: "Model identifier sent with every request" },
  "ai.apiKey": {
    label: "API key",
    caption: "Stored in the macOS Keychain, never in preferences.",
    help: "Secret key for this provider. Saved to the Keychain on Return, on focus loss or with Save Key",
  },
  "ai.systemPrompt": { label: "System prompt", caption: "Sent before every conversation.", help: "Instructions the assistant receives before every conversation." },
  "ai.maxTokens": { label: "Max tokens", unit: "tokens", help: "Upper bound on the length of each reply." },
  "ai.temperature": {
    label: "Temperature",
    caption: "Sent only to models that accept it: current Claude and GPT models choose their own and are sent none.",
    help: "Sampling randomness: 0 is deterministic, 1 is the provider default, above 1 is increasingly creative. Sent only to models that accept it (Ollama, LM Studio, Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 and older, GPT-4o and GPT-4.1); current Claude and GPT models are sent none.",
  },
  "ai.fallback.anthropic": {
    label: "If Claude declines, let another Claude model answer",
    caption: "Anthropic's own API only, for Claude Fable 5.2 and 5.1, Opus 5.5 and 5, and Sonnet 5.5.",
    help: "When the model declines a request (a safety classifier can stop a harmless question), Anthropic's server hands the same request to another Claude model, which answers in the same reply. Off: the pane says the request was declined.",
  },
  "ai.timeoutSec": { label: "Timeout", unit: "s", help: "How long to wait for a reply before giving up." },
  "ai.testConnection": { label: "Test Connection", help: "Send a one-word prompt to the configured endpoint and show the reply." },
};

/** The rest of the window's words. */
export const settingsWords = {
  windowTitle: "Settings",
  findTitle: "Search Settings…",
  groups: { general: "General", solvers: "Solvers", sweeps: "Sweeps", interface: "Interface", assistant: "Assistant" },
  differsDot: (pane: string) => `${pane} differs from its defaults`,
  differsHint: (summary: string) => `${summary}. Differs from defaults.`,
  search: {
    placeholder: "Search settings",
    shortcutHint: "⌘F",
    label: "Search settings",
    help: "Search every setting by name, section or keyword. Return or ⌘G steps forward through the matches, ⇧↩ or ⇧⌘G back",
    hint: "Filters the sidebar to panes with matching settings. Press Return or Command-G to step forward through the matches in pane order, Shift-Return or Shift-Command-G to step back.",
    status: (n: number, of: number) => `${n} of ${of}`,
    emptyTitle: (q: string) => (q.trim() ? `No Results for “${q.trim()}”` : "No Results"),
    emptyMessage: "Check the spelling or try a different search.",
    clear: "Clear search",
  },
  bar: {
    reset: "Reset to Defaults",
    resetAtDefaults: "Already at defaults",
    resetTip: (pane: string) => `Restore the defaults for the ${pane} pane only. Other panes are not affected.`,
    resetLabel: (pane: string) => `Reset ${pane} settings to defaults`,
    cancel: "Cancel",
    cancelTip: "Close Settings. Changes on this pane are applied as you make them, so closing does not discard anything; use Reset to Defaults to undo them.",
    cancelLabel: "Close Settings",
    save: "Save",
    saveTip: "Write the settings to disk now and confirm. Changes are already applied as you make them; this makes sure they are stored.",
    saveLabel: "Save settings",
    saved: "Saved",
    wasReset: "Reset to defaults",
  },
  field: {
    enterNumber: "Enter a number",
    enterWhole: "Enter a whole number",
    between: (lo: string, hi: string, unit?: string) => `Must be between ${lo} and ${hi}${unit ? ` ${unit}` : ""}`,
    order: "Minimum must not exceed maximum",
    orderStrict: "End must be greater than start",
    stepUp: "Increase",
    stepDown: "Decrease",
    glossary: (label: string) => `About ${label}`,
    override: (label: string) => `Override ${label}`,
    systemMono: "System Monospaced (default)",
    showAllFonts: "Show all fonts",
    showAllFontsTip: "Off: fixed-pitch families only. On: every installed family, including proportional ones.",
    fontSample: "Il1 O0 ρ=0.85 λ/μ",
    previewOf: (f: string) => `Preview of ${f || "System Monospaced"}`,
  },
  general: {
    tabsFooter: "Open tabs and their canvases are saved on quit; this decides whether they come back automatically at the next launch.",
    change: "Change…",
    changeTip: "Open the Discrete-Event Simulation pane, where the blocking mode is set.",
    changeLabel: "Change blocking mode in Discrete-Event Simulation",
    runCompareFooter: "Run Comparison simulates finite-buffer networks with this regime whenever the dialog is skipped. Change it in the Discrete-Event Simulation pane so there is a single place it is defined.",
    resetAll: "Reset All Settings…",
    resetAllTipNone: "Every pane is already at its defaults",
    resetAllTip: "Restore the defaults of every pane, after confirming. API keys in the Keychain are not touched.",
    resetAllLabel: "Reset all settings to defaults",
    allAtDefaults: "Every pane is at its defaults.",
    panesDiffer: (n: number, of: number) => `${n} of ${of} panes differ from their defaults (marked in the sidebar).`,
    export: "Export…",
    exportTip: "Write every setting and its current value to a JSON file — to attach to a run, or to carry to another Mac.",
    exportLabel: "Export settings to a file",
    import: "Import…",
    importTip: "Read a settings file written by Export. Each value is checked against its allowed range; anything refused is listed and left unchanged.",
    importLabel: "Import settings from a file",
    showDetails: "Show Details…",
    showDetailsTip: "List every value the import refused — the pane and row it belongs to, and why.",
    showDetailsLabel: "Show every refused import value",
    refusedTitle: "Refused values",
    refusedCount: (n: number) => `${n} left unchanged`,
    allFooter: "Reset here restores every pane at once; each pane's own Reset to Defaults touches only that pane. An exported file records the exact solver configuration a set of results was produced with.",
    confirmTitle: "Reset all settings to their defaults?",
    confirmMessage: (n: number) =>
      `${n} ${n === 1 ? "pane differs" : "panes differ"} from the defaults and will be changed. API keys in the Keychain, the selected AI provider and which panes are shown (View ▸ Panes) are not affected. To keep a copy of the current values first, use Export.`,
    confirmButton: "Reset All Settings",
    allReset: "Every pane is back at its defaults.",
    exportTitle: "Export Settings",
    importTitle: "Import Settings",
    exportName: (isoDate: string) => `Qnet settings ${isoDate}.json`,
    jsonFilter: "JSON",
  },
  engineFooters: {
    regenerative: `Run ▸ Regenerative Monte Carlo. Both engines draw the same random stream, so a run reports the same cycles and the same estimates whichever is selected. ${engine.regenerative.speedup}.`,
    qbd: `Run ▸ Exact Matrix-Analytic QBD. ${engine.qbd.speedup}; the gap widens as the fourth power of the phase count, so the choice matters most on the models that take longest.`,
    ctmc: `One choice for two solvers: Run ▸ Adaptive Truncated CTMC and Run ▸ Exact Sparse CTMC share a power-iteration kernel, so they share this setting. ${engine.ctmc.speedup}.`,
    parity: [
      "These are two implementations of one algorithm, not two methods. Each C engine was written to reproduce its Python counterpart's arithmetic operation by operation, and each ships a parity test that runs both on every packaged example and compares the output.",
      "What is verified: the report each method prints is byte-identical between engines, and so is every refusal message for an invalid document. Two known exceptions, both measured: confidence-interval bounds in the 17-digit machine records agree to about 1e-12 rather than exactly, because Python ships its own lgamma; and a simulation stopped by its wall-clock safeguard stops at a different cycle in each engine, because one of them is 250 times faster.",
      "If the selected engine is not installed — a source checkout that has not run build_all_algorithms.sh, say — the other one runs and the Status pane says so. A missing binary never turns into a method you cannot run.",
    ],
  },
  sim: {
    blockingFooter: "Applies to fBNAsim runs on finite-buffer networks. Run Comparison uses it as the default regime when “Remember blocking choice” is on in General.",
    runLengthFooter: "Warm-up and simulation time are simulated time in the model's units (jackson_sim -w / -T), not wall-clock seconds. Wall-clock cost scales with simulation time × replications ÷ cores.",
  },
  mlmc: {
    epsilonCaution: (eps: string, multiple: string) => `ε = ${eps} costs about ${multiple}× the default (ε = 0.01) — cost scales as 1/ε².`,
    gammaTitle: (g: number) => (g === 0.05 ? "0.05 (paper-optimal)" : g.toFixed(2)),
    gammaDetail: (levels: number) => `Ratio of consecutive MLMC time-step sizes: each level refines the step ${levels}×.`,
    overridesFooter: "Leave the overrides off for the paper's auto-tuning. Turn one on only to reproduce a specific configuration.",
    adaptiveFooter: "Run adaptively only when T and L are large enough that bias is below ε (the auto defaults usually are). The maximum is a required hard cost cap; estimates that reach it before the SE target are saved as Partial.",
    minOverMax: "Minimum samples must not exceed the maximum cap",
    batchOverMax: "Batch size must not exceed the maximum cap",
    threadsCaption: (cores: number) => `Leave empty for one thread per logical core (${cores} on this Mac). Ignored by the Serial backend.`,
    threadsPlaceholder: (cores: number) => `auto (${cores})`,
  },
  lp: {
    recommended: (grid: number, basis: number) => `grid_n ${grid}  ·  basis_m ${basis}`,
    recommendedLabel: (grid: number, basis: number) => `Recommended grid_n ${grid}, basis_m ${basis}`,
    forOpen: (d: number) => `For the open network (d = ${d}).`,
    noneOpen: (d: number) => `No network open — showing d = ${d}.`,
    tableFooter: "LP size is about nᵈ variables. Recommended (grid_n, basis_m): d ≤ 2 → (100, 6), d = 3 → (25, 5), d = 4 → (12, 4), d = 5 → (10, 3), d = 6 → (8, 3), d ≥ 7 → (6, 3).",
    solverFooter: "CPLEX is fastest on d ≤ 3; HiGHS scales better at d ≥ 4; GLPK is the universal fallback. Auto picks the first one that is installed.",
    flpTableFooter: "Recommended (grid_n, basis_m) for the rectangle LP: d = 1 → (64, 8), d = 2 → (20, 6), d = 3 → (12, 4), d = 4 → (8, 3), d ≥ 5 → (6, 3).",
    flpSolverFooter: "HiGHS is bundled and works everywhere; CPLEX is fastest when available; GLPK is the universal fallback.",
    flpStabilityFooter: "Used by Run ▸ Finite-Buffer LP and by finite test-set sweeps. Reference text: Help ▸ Finite-Buffer LP Algorithm.",
    hintsTitle: "Performance Hints",
  },
  fem: {
    meshCaution: (mesh: number, cap: number, d: number) => `Mesh ${mesh} exceeds the cap of ${cap} for the open network (d = ${d}); the run dialog will start from ${cap}. Cost grows as n²ᵈ.`,
    meshFooter: (c3: number, c4: number, c5: number, c6: number) =>
      `Cost grows as n²ᵈ, so the run dialog caps the mesh by dimension: d ≤ 3 → ${c3}, d = 4 → ${c4}, d = 5 → ${c5}, d ≥ 6 → ${c6}. The value here is the suggestion the dialog starts from.`,
  },
  spectral: {
    basisCaution: "Monomial basis is ill-conditioned above degree 10 — enable Legendre.",
    footer: "Legendre basis is recommended above degree 10; the monomial basis becomes ill-conditioned there. Used by bnet (orthant) and srbm_solver (rectangle).",
  },
  testSets: {
    infFooter: "Pre-populates Test ▸ Run Infinite Test Set. Values entered in that dialog override these for the one run.",
    finFooter: "Pre-populates Test ▸ Run Finite Test Set.",
    spcFooter: (summary: string) => `Pre-populates Test ▸ Run Infinite Spectral Convergence. ρ is a start / end / step grid rather than a min–max range. ${summary}`,
    sweepSummary: (cases: number, rhos: number) => {
      const total = cases * rhos;
      const n = (x: number) => x.toLocaleString("en-US");
      return `${n(cases)} ${cases === 1 ? "case" : "cases"} × ${n(rhos)} ρ ${rhos === 1 ? "value" : "values"} = ${n(total)} spectral ${total === 1 ? "solve" : "solves"}.`;
    },
    emptyGrid: "The ρ grid is empty — end must be greater than start.",
  },
  output: {
    example: (rendered: string) => `Example: ${rendered}`,
    footer: "Applies to every method's results in the Interactive Shell and to the Results pane. Display only: solver precision, the saved run output and CSV export all keep full precision. A value too small to show at this precision is printed in scientific notation rather than as a flat zero, and so is one large enough that a fixed rendering would be mostly floating-point noise. Whole numbers, percentages, version numbers, file paths and the advisory text of Analyze Network, Network Primitives and the Help pages keep their values; only the spelling of an exponent is regularised, so one line cannot show both 1e-9 and 6.02e23. Six is the ceiling because that is the precision the solvers themselves print.",
  },
  panes: {
    shellFooter: "Changes apply immediately. The font and text size are also in the Shell pane header; both places edit the same setting.",
    statusFooter: "Only the size is adjustable here. The Status log is fixed to the system monospaced face so its severity glyph, timestamp and message columns line up with the solver output pasted into it — a proportional family would break that grid. Text size is also in the Status pane header (A+ / A−).",
    aiFooter: "Text size governs prose and code together, so the transcript reads at one size. Both settings are also in the AI Assistant pane header (font menu, A+ / A−).",
  },
  help: {
    footer: "Applies to the Method Reference and Connect an AI Provider topics in the Help menu. Qnet Help (⌘?) — including the SRBM MLMC Guide — and Release Notes always open their own windows.",
  },
  ai: {
    paneFooter: "Window layout rather than a setting: it is also under View ▸ Panes, and Reset to Defaults leaves it as it is.",
    providerHint: {
      anthropic: "Messages API; /v1/messages is appended.",
      openai: "Responses API; /responses is appended.",
      ollama: "Start Ollama with `ollama serve`; /api/chat is appended.",
      lmstudio: "Start LM Studio's OpenAI-compatible server; /chat/completions is appended.",
    } as Record<string, string>,
    endpoints: "Recommended endpoints",
    endpointsTip: "Pick a recommended endpoint for this provider",
    resetTo: (v: string) => `Reset to default (${v})`,
    models: "Model list",
    modelsTip: "Pick a model for this provider",
    fromServer: "From Server",
    recommended: "Recommended",
    /** The cloud providers' built-in list (src/panes/ai/catalog.ts) and the live one that replaces it. */
    currentModels: (date: string) => `Current Models (${date})`,
    olderModels: "Older Models, Still Available",
    accountModels: "Available to Your Account",
    deprecatedModel: (label: string) => `${label} — deprecated`,
    retiredNote: (model: string, replacement: string) => `${model} has been retired by Anthropic and no longer answers. Its current replacement is ${replacement}: pick it from the Model list, or type another model.`,
    deprecatedNote: (model: string, retires: string, replacement: string) => `${model} is deprecated and retires on ${retires}. Its replacement is ${replacement}.`,
    refresh: "Refresh model list",
    refreshTip: "Ask the server for its list of available models",
    notRequired: "Not required",
    localKeyCaption: "Local servers need no key. Make sure the server is running at the Base URL above.",
    reveal: "Reveal the API key",
    saveKey: "Save Key",
    saveKeyTip: "Write the key to the macOS Keychain now. It is also saved automatically when the field loses focus.",
    /** 2.0 P4: the Keychain, the model listing and Test Connection arrive with the assistant (P7). */
    laterTip: "Arrives with the AI assistant in a later build of Qnet.",
    connectionFooter: "Uses the provider, URL, model and key above exactly as the assistant will.",
  },
  /** Section headers, as 0.90.34 titles them. */
  sections: {
    tabs: "Tabs", launch: "Launch", runComparison: "Run Comparison", updates: "Updates", allSettings: "All Settings",
    regenerative: "Regenerative Monte Carlo", qbd: "Exact Matrix-Analytic QBD", ctmc: "Markovian CTMC", whyTwo: "Why There Are Two",
    execution: "Execution", finiteBuffers: "Finite Buffers", runLength: "Run Length", reproducibility: "Reproducibility",
    accuracy: "Accuracy", overrides: "Advanced Overrides", variance: "Variance Reduction", adaptive: "Adaptive Sampling", parallelism: "Parallelism",
    discretisation: "Discretisation", solver: "Solver", stability: "Numerical Stability", runtime: "Run-time Behaviour", reference: "Reference",
    quadrature: "Quadrature", mesh: "Mesh", basis: "Basis",
    infinite: "Infinite Test Set", finite: "Finite Test Set", spectral: "Spectral Convergence",
    numeric: "Numeric Display", shell: "Shell", status: "Status", ai: "AI Assistant", helpMenu: "Help Menu",
    pane: "Pane", backend: "Backend", generation: "Generation", connection: "Connection",
  },
} as const;

/** AlgorithmHelp.linearProgramPerformanceHints, shown by Linear Program ▸ Performance Hints…. */
export const linearProgramPerformanceHints = `================================================================================
PERFORMANCE HINTS — Linear Program (Saure-Glynn-Zeevi 2008)
================================================================================

WHY SIZE MATTERS
----------------
The LP that srbm_lp builds has roughly nᵈ interior λ-variables, where
n = grid_n and d = number of stations.  At n = 100, that's:

   d = 2  →     10 000 cells  (OK,      ~0.5 s)
   d = 3  →  1 000 000 cells  (ENORMOUS, minutes to hours)
   d = 4  → 100 000 000 cells (INFEASIBLE at this n)

So n must shrink as d grows — commercial LP solvers can handle around
10 000 – 100 000 variables briskly, above that CPLEX / HiGHS start to
struggle with a dense Basic-Adjoint-Relationship matrix like ours.

RECOMMENDED DEFAULTS (used when grid_n = 0 and basis_m = 0)
----------------------------------------------------------
The defaults below are what Sections 4 & 6 of the paper use.  Set
\`grid_n\` and \`basis_m\` to 0 in Settings ▸ Linear Program to let the
GUI pick these automatically based on d:

   Dimension d    grid_n    basis_m    # cells    typical solve
   -----------    ------    -------    -------    -------------
          1–2       100         6      ≤10 000    < 1 s
            3        25         5      15 625     ~0.5 – 3 s
            4        12         4      20 736     ~5 – 15 s
            5        10         3     100 000     ~20 – 60 s
            6         8         3     262 144     minutes
          ≥7         6         3      ~47 000     minutes to hours

Doubling n multiplies LP size by 2^d.  Doubling m multiplies the
number of basis functions (BAR rows) by roughly (m+d choose d)/(m-1+d
choose d).  At d = 3 going from m = 5 → 6 takes you from 56 to 84
basis functions — about 50% more BAR rows.

TUNING GUIDELINES
-----------------
  • Tail stations under-converged?   Raise basis_m by 1 (accept the
                                     cost; the LP gets slower).
  • Solver reports "numerical"       Enable \`basis_normalize\` — scales
    trouble or "dual infeasible"?    monomial rows to unit magnitude
                                     and usually restores stability.
  • LP degenerate (u* = 0, many      Enable the smoothness term with
    vertices pick awful moments)?    a small weight (e.g. 1e-4) to
                                     break ties toward a smooth λ.
  • Running out of memory at d=4+?   Drop grid_n to 8 – 10 and
                                     basis_m to 3.  Switch solver to
                                     HiGHS (uses less memory than
                                     CPLEX barrier).

SOLVER CHOICE
-------------
  CPLEX is usually fastest on d ≤ 3 dense LPs (IBM's dual simplex is
  highly tuned for this structure).
  HiGHS is competitive at d ≥ 4 where the LP becomes sparse in a
  way CPLEX's presolve doesn't fully exploit; HiGHS also has a
  lower memory footprint.
  GLPK is the fallback; slowest but available everywhere.

MULTI-LEVEL NESTED GRIDS
------------------------
Enable "Multi-level refinement" in Settings ▸ Linear Program to run
the LP twice: first on a coarse grid (≈ n_target / 2) for a quick
preview, then on the full grid for the refined answer.  The coarse
run lets you sanity-check the problem setup in seconds before
committing to the full solve.  Cost ≈ 1.05× - 1.3× of the full
solve, but you see an intermediate result along the way.

WHEN TO STOP TUNING
-------------------
If you need d ≥ 5 or you want ε ≤ 0.01 on every station, the LP
approach hits a wall. Switch to SRBM MLMC, which scales
almost linearly with d and has explicit accuracy control.`;
