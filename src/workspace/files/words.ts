// The files area's words, 0.90.34's exactly where the ledger quotes them (the lead re-exports
// these from src/lib/vocabulary.ts). Sources: QnetGUIApp.swift (open, save, export, generate),
// QnetCommands.swift (the File menu's tooltips), SRBMExportSheet.swift, NetworkDialogs.swift
// (GenerateRandomNetworkSheet), RunParameterSpecs.swift (exportBlockingConvention), TabClosing.swift.

export const fileWords = {
  untitled: "Untitled",

  // Menu tooltips (menu tooltip → palette subtitle, MENU-203).
  newSubtitle: "Open an empty canvas in a new tab",
  openSubtitle: "Open a .bnet network file",
  openExampleSubtitle: "Open one of the bundled literature networks",
  saveSubtitle: "Save the network to its .bnet file",
  saveNoChanges: "No unsaved changes",
  saveNothing: "Draw or open a network first",
  saveAsSubtitle: "Write the network to a new .bnet file",
  exportFbnasimSubtitle: "Write the fBNAsim network description",
  exportSrbmSubtitle: "Write the drift, covariance and reflection data read by srbm_solver and bnet",
  exportQnaSubtitle: "Write the bna_qna / bna_rqna / bna_sbd input file",
  exportAllSubtitle: "Write every solver's input file into one folder (same files as Qnet --export-cmp); finite-buffer networks can pick the blocking convention",
  randomSubtitle: "Build a random network of a chosen size, topology and utilisation in a new tab",
  clearRecentEmpty: "No recent networks",

  // Panels (WS-109, WS-113, WS-118, EXP-108…114).
  openPanelTitle: "Open Network",
  examplePanelTitle: "Open Example",
  savePanelTitle: "Save Network As",
  networkFilter: "Qnet Network",
  plainTextFilter: "Plain Text",
  fbnasimPanelTitle: "Export Finite Simulator Input",
  qnaPanelTitle: "Export QNA Input",
  srbmPanelTitle: "Export SRBM Solver Input",
  exportAllPanelTitle: "Export All Solver Inputs",

  // Open (WS-110, WS-112, FILE-015, FILE-016).
  loadedCounts: (nodes: number, links: number) => `Loaded network with ${nodes} nodes and ${links} links.`,
  loaded: (name: string) => `Loaded ${name}.`,
  loadFailedTitle: "Load Failed",
  loadFailed: (reason: string) => `Load failed: ${reason}`,
  noExamples: (trail: string) => `No examples directory found — looked in: ${trail}.`,
  noExamplesPanel: "The bundled examples could not be found. Choose a .bnet file, or see the Status pane for the paths that were tried.",

  // Save (WS-119, WS-120, FILE-013).
  saved: (name: string) => `Saved network to ${name}.`,
  saveFailedTitle: "Save Failed",
  saveFailed: (reason: string) => `Save failed: ${reason}`,

  // Single-file exports (EXP-109, EXP-110, EXP-113).
  exportedNetwork: (name: string) => `Exported network to ${name}.`,
  exportFailed: (reason: string) => `Export failed: ${reason}`,
  exportWriteFailed: (reason: string) => `Export write failed: ${reason}`,
  exportedQna: (name: string) => `Exported QNA to ${name}.`,
  qnaExportFailed: (reason: string) => `QNA export failed: ${reason}`,
  qnaExportWriteFailed: (reason: string) => `QNA export write failed: ${reason}`,
  exportedSrbm: (path: string) => `Exported SRBM solver input to ${path}.`,
  srbmExportFailed: (reason: string) => `SRBM export failed: ${reason}`,
  srbmExportWriteFailed: (reason: string) => `SRBM export write failed: ${reason}`,
  srbmExportFailedTitle: "Export Failed",
  couldNotWrite: (name: string, reason: string) => `Could not write ${name}: ${reason}`,

  // The SRBM export sheet (EXP-111…113).
  srbmTitle: "Export SRBM Solver Input",
  srbmSubheading: "Writes the drift θ, covariance Γ, reflection matrix R and box dimensions read by srbm_solver and bnet.",
  covarianceLabel: "Covariance Γ",
  covarianceGlossary: "Γ — covariance matrix of the Brownian motion driving the SRBM: a d × d matrix (d stations) built from the arrival and service variability and the routing, written row by row after the drift θ. Not the throughput Γ of the solver output — the same letter, a different quantity.",
  glossaryHelp: (label: string) => `What is ${label}?`,
  documentSection: "Document",
  networkRow: "Network",
  stationsRow: "Stations",
  classesRow: "Customer classes",
  buffersRow: "Buffers",
  buffersInfinite: "Infinite (orthant)",
  buffersFinite: "Finite (hypercube)",
  blockingSection: "Blocking",
  blockingPicker: "Blocking convention",
  blockingHelpInfinite: "Blocking corrections apply to finite-buffer networks only",
  blockingHelpFinite: "How finite buffers block upstream stations in the exported SRBM",
  blockingInfiniteFooter: "Infinite-buffer networks never block; the manufacturing convention is used.",
  srbmEmpty: "The network is empty; add nodes before exporting.",
  srbmConfirm: "Export…",
  srbmCancelHelp: "Close without exporting (Esc)",
  srbmConfirmHelp: "Choose a destination and write the .in file (Return)",
  srbmBlockedHelp: "Add at least one node to export",

  // Export All (EXP-114, EXP-115; RunParameterSpecs.exportBlockingConvention).
  exportAllTitle: "Export All Solver Inputs",
  exportAllSubheading: "Writes every solver's input file into one folder — the same files Qnet --export-cmp produces.",
  exportAllSection: "Finite Buffers",
  exportAllFooter: "Only sm.in, fm.in and lp.in depend on this choice; the QNA and simulator inputs are unaffected.",
  exportAllFieldHelp: "How finite buffers block upstream stations in sm.in, fm.in and lp.in",
  basGlossaryLabel: "Blocking convention",
  basGlossary: "BAS — blocking after service: a finished job waits at its server until the downstream buffer has room.",
  exportAllConfirm: "Choose Folder…",
  exportAllConfirmHelp: "Pick the destination folder and write the files (Return)",
  exportAllCancelHelp: "Close without exporting (Esc)",
  exportAllPanelMessage: "Choose a folder for the solver input files (sm.in, fm.in, lp.in, sim.txt, qna.qna, cmp_sm.in, cmp_sim.sim).",

  // Generate Random Network (GEN-001…011).
  randomTitle: "Generate Random Network",
  randomSubheading: "Creates a random open network in a new tab: random routing per class, a random service law per (station, class) and arrival rates scaled to the target ρ.",
  structureSection: "Structure",
  stationsLabel: "Stations",
  stationsField: "Number of stations",
  stationsHelp: "Number of service stations d (1–20)",
  classesLabel: "Customer classes",
  classesField: "Number of customer classes",
  classesHelp: "Number of customer classes c (1–8)",
  buffersLabel: "Buffers",
  buffersHelp: "Infinite buffers give an SRBM on the orthant; finite buffers an SRBM on a hypercube",
  infinite: "Infinite",
  finite: "Finite",
  topologyLabel: "Topology",
  topologyHelp: "Routing structure of the generated network",
  topologies: {
    feedForward: "Feed-forward",
    jacksonFeedback: "Jackson feedback (light)",
    generalPMatrix: "General P-matrix (full feedback)",
    reentrantFeedback: "Re-entrant feedback (class-change)",
  },
  loadSection: "Load and reproducibility",
  rhoLabel: "Target ρ",
  rhoField: "Target utilisation rho",
  rhoHelp: "Average utilisation every station is scaled towards (0.10–0.99)",
  rhoGlossary: "ρ — utilisation: fraction of time the station is busy (λ / (c·μ)). Must be below 1 for stability.",
  seedLabel: "Seed",
  seedField: "Random seed",
  seedPlaceholder: "Random",
  seedHelp: "Leave blank for a fresh random network; enter an integer to reproduce one",
  seedFieldError: "Enter a non-negative whole number",
  loadFooter: "External arrival rates are scaled so every station sits near the target ρ; a fixed seed regenerates the same network.",
  stationsProblem: "Stations must be between 1 and 20.",
  classesProblem: "Customer classes must be between 1 and 8.",
  rhoProblem: "Target ρ must be a number between 0.10 and 0.99.",
  seedProblem: "Seed must be a non-negative integer, or blank for a random seed.",
  generate: "Generate",
  randomCancelHelp: "Close without generating a network (Esc)",
  randomConfirmHelp: "Create the random network in a new tab (Return)",
  randomBlockedHelp: "Fix the highlighted values to generate",
  randomTabTitle: (n: number) => `Random ${n}`,
  generateFailedTitle: "Generate Failed",

  // Sheet chrome (DSSheetFooter).
  cancel: "Cancel",
  cannotContinue: (problem: string) => `Cannot continue: ${problem}`,
  increment: (label: string) => `Increase ${label}`,
  decrement: (label: string) => `Decrease ${label}`,
} as const;

/** 0.90.34 `SRBMExportSheet.BlockingConvention`, in its order (ids as files.rs takes them). */
export const BLOCKING_CONVENTIONS = [
  { id: "manufacturing", title: "Manufacturing blocking (SRBM default)", detail: "The offered arrival rate α feeds every station; matches the spectral, finite-element and LP solvers." },
  { id: "loss", title: "Loss-network correction", detail: "Thins the arrival stream by the blocking probability, for comparison against a loss-network simulation (--loss-fix)." },
  { id: "bas", title: "BAS + external-loss correction", detail: "Adjusts drift for blocking-after-service with external loss (--bas-fix)." },
] as const;

export type BlockingConventionId = (typeof BLOCKING_CONVENTIONS)[number]["id"];
