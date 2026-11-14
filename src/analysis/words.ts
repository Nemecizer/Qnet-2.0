// The analysis area's words, 0.90.34's to the character: the Network menu's Analyze Network and
// Show Network Primitives (QnetCommands.swift `networkMenu`, QnetGUIApp.swift `analyzeNetwork`,
// `showNetworkPrimitives`), Run ▸ Choose a Method… and Network ▸ Network Model… as menu commands,
// and the startup dependency check (StartupDependencyChecker.swift, StartupDependencyCheckView.swift,
// QnetCommands.swift `helpMenu`). src/lib/vocabulary.ts re-exports them.

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const analysisWords = {
  // The menu commands (titles from src/lib/menuSpec.ts; tooltips as palette subtitles).
  analyzeTitle: "Analyze Network",
  analyzeHelp: "Check the network for stability, tractability and structural problems",
  primitivesTitle: "Show Network Primitives",
  primitivesHelp: "Print the SRBM primitives (drift, covariance, reflection) to the shell",
  modelTitle: "Network Model…",
  modelHelp: "Inspect a non-spatial node and route outline, or compare finite-buffer blocking rules",
  chooseTitle: "Choose a Method…",
  chooseHelp: "Compare applicability, assumptions, model layer, outputs and expected cost for this network",
  checkTitle: "Check Dependencies…",
  checkHelp: "Re-run the startup checklist: Python, optional modules, and the bundled solvers",

  // What the reports write after they are shown.
  displayedAnalysis: "Displayed network analysis.",
  displayedPrimitives: "Displayed network primitives.",

  // The startup check (StartupDependencyCheckView.swift).
  checkSheetTitle: "Qnet Startup Check",
  checkingName: (name: string) => `Checking ${name}…`,
  allReady: "Every checked dependency is ready.",
  needAttention: (n: number) => `${n} item${plural(n, "", "s")} need attention.`,
  preparingList: "Preparing the package checklist…",
  justChecked: (name: string) => `Just checked: ${name}`,
  complete: "Startup check complete",
  completeWithNotes: "Startup check complete with notes",
  greenMeans: "Green checkmarks identify packages and bundled components that are ready.",
  preparing: "Preparing checks…",
  waiting: "Waiting to be checked.",
  checkingNow: "Checking now…",
  missing: (detail: string) => `Missing — ${detail}`,
  timedOut: (detail: string) => `Check timed out — ${detail}`,
  recheck: "Recheck",
  recheckHelp: "Check every dependency again",
  continue: "Continue",
  continueHelp: "Close the startup check and use Qnet",
  continueBlocked: "Wait for the dependency checks to finish",
  footerChecking: "Checking packages…",
  footerPassed: (ok: number, all: number) => `${ok} of ${all} checks passed.`,
  footerNotes: (ok: number, attention: number) => `${ok} ready; ${attention} need attention. Optional items do not prevent Qnet from opening.`,
  installTitle: "Install missing packages",
  repairTitle: "Repair this Qnet app",
  repairExplanation:
    "This Qnet.app is incomplete or contains a component that cannot launch. Download Qnet again or rebuild the app: it carries everything it needs, so nothing installed on this Mac can repair it.",
  brewAndPython: "Open Terminal in Qnet's source folder and run the commands shown below. Optional rows only unlock the method named in that row. Relaunch Qnet afterwards.",
  brewOnly: "Open Terminal and run the Homebrew command shown below. Optional rows only unlock the method named in that row. Relaunch Qnet after installation.",
  pythonOnly: "Open Terminal in Qnet's source folder and run the commands shown below. Optional rows only unlock the method named in that row. Relaunch Qnet afterwards.",
  copy: "Copy",
  copied: "Copied",
  copyHelp: "Copy the install commands",
  cvxpyNote: "Commands that are not Homebrew formulas (Apple's tools, a Python package, Qnet's own build script) are shown on their own lines above.",
  bundledNote: "A packaged Qnet.app needs nothing installed: its Python, solvers and libraries are inside it.",
  rowLabel: (name: string, scope: string, status: string) => `${name}, ${scope}, ${status}`,

  /** Each row's name and summary, by id (StartupDependencyCatalog). */
  requirements: {
    "developer.xcode-tools": { name: "Xcode command-line tools", summary: "Apple's compiler, which builds Qnet's native solvers and their libraries from source." },
    "developer.cmake": { name: "CMake", summary: "Build tool that scripts/build-deps.sh needs to build the solvers' numerical libraries." },
    "runtime.python": { name: "Python 3", summary: "Runs the product-form, CTMC, QBD, decomposition, regenerative, adaptive SRBM, and BAR methods." },
    "optional.numpy": { name: "NumPy", summary: "Enables the exact dense tandem CTMC in finite-buffer comparisons." },
    "optional.cvxpy": { name: "CVXPY with an SDP solver", summary: "Adds numerical candidates for general BAR moment bounds; exact BAR cases work without it." },
    "developer.solver-libraries": { name: "Solver libraries", summary: "libomp, SuiteSparse, HiGHS, and cJSON, built from their pinned sources by scripts/build-deps.sh for the native solvers." },
    "bundled.rqna": { name: "RQNA solver", summary: "Bundled robust queueing-network analyzer used by Run Whitt–You RQNA." },
    "bundled.libomp": { name: "libomp", summary: "Bundled OpenMP runtime for the native simulation engines." },
    "bundled.suite-sparse": { name: "SuiteSparse", summary: "Bundled sparse numerical libraries for the spectral solver." },
    "bundled.highs": { name: "HiGHS", summary: "Bundled linear-programming backend for the orthant LP method." },
  } as Record<string, { name: string; summary: string }>,
  /** cJSON's row is a packaged app's only (a source tree builds it with the other solver libraries). */
  cjson: {
    name: "cJSON",
    developer: "Builds the experimental multiclass workload-diffusion solver.",
    packaged: "Bundled JSON reader for the experimental multiclass workload-diffusion solver.",
  },
} as const;
