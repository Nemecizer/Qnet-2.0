// Failure reports in plain words (new in 2.0, ROADMAP A4): what the Show Report… panel says when
// a run fails, chosen from the report's evidence (src-tauri/src/reports.rs), and the text Copy
// Report puts on the clipboard.
//
// Every rule is tied to something the runner or a solver really reports:
// - crash: the supervisor's step record says a signal ended the solver (`ExitKind::Signaled`,
//   runner/src/supervisor/process.rs), and Stop had not been pressed;
// - internal: the run's own thread ended ("… stopped on an internal error: …",
//   runner/src/supervisor/job.rs; "The run's thread ended unexpectedly.", src-tauri/src/runs.rs);
// - could not start: "<Label> could not start: <error>" (`Job::could_not_start`), exit status −1;
// - missing module: Python's own "ModuleNotFoundError: No module named '…'" / "ImportError: …";
// - unstable: an infinite-buffer network (every infinite-buffer method needs ρ < 1) whose own
//   utilisation, computed by Qnet, is 1 or more at some station, or a solver saying so ("station
//   'S1' is unstable: open offered load 1.2 >= 1", solvers/infinite/BNApf/open_bcmp.py);
// - memory: solvers/common/bnet_memcheck.h ("ERROR: requested allocation exceeds the memory
//   budget."), "<solver>: out of memory…", "Error: Failed to allocate …", "srbm: malloc failed
//   for N bytes", "allocation failure 1 in dmatrix()", Python's "MemoryError";
// - no convergence: "error: stationary iteration did not converge; increase …" (fBNAgc), "NOT
//   CONVERGED", "…_not_converged", "DIVERGED";
// - too large: mc_solver's size guard ("mc_solver: this network is too large for the multi-class
//   finite-element solver at this mesh.", solvers/infinite/BNAmd/src/mc_fem_gauss.c), with the
//   mesh that fits when it names one. The solver cannot know what else would work; the panel
//   passes the methods Run ▸ Choose a Method… recommends for the network (`Advised`);
// - unusable output: the solver exited 0 and the result parser filed the run as failed with a
//   reason (core/src/results/parser.rs, runner/src/store.rs);
// - anything else: the solver's last error line.
import type { FailureReport } from "../../lib/types";

export type Cause = "crash" | "internal" | "could-not-start" | "missing-module" | "unstable" | "too-large" | "memory" | "no-convergence" | "unusable-output" | "other";

/** A method Run ▸ Choose a Method… recommends or finds applicable for the network: its name there and its Run-menu command. */
export interface Advised {
  command: string;
  name: string;
}

export interface Explanation {
  cause: Cause;
  /** One sentence: what happened. */
  title: string;
  /** Why, in plain words. */
  body: string;
  /** What to try next, most useful first. */
  next: string[];
  /** A concrete other method to run, when there is one. */
  tryMethod: { command: string; name: string } | null;
  /** The solver's own last error line, when there is one. */
  detail: string | null;
}

/** The Run-menu command and plain name of each alternative (titles from src/lib/menuSpec.ts, without "Run"). */
const ALTERNATIVE = {
  qna: { command: "run:qna", name: "Whitt QNA" },
  monteCarloInfinite: { command: "run:monte-carlo-infinite", name: "Monte Carlo" },
  monteCarloFinite: { command: "run:monte-carlo-finite", name: "Monte Carlo" },
  decomposition: { command: "run:decomposition", name: "Finite-Buffer Decomposition" },
} as const;

/**
 * Another method for the same network: the quick approximation (infinite buffers) or the simulator
 * (finite buffers), or the next-nearest when that is the one that failed. A comparison already
 * runs every method, so it has none.
 */
export function alternativeFor(method: string, infinite: boolean): { command: string; name: string } | null {
  if (method === "inf_cmp" || method === "cmp") return null;
  if (infinite) return method === "qna" || method === "rqna" || method === "sbd" ? ALTERNATIVE.monteCarloInfinite : ALTERNATIVE.qna;
  return method === "sim" ? ALTERNATIVE.decomposition : ALTERNATIVE.monteCarloFinite;
}

const MEMORY = /out of memory|exceeds the memory budget|failed to (re)?allocate|allocation fail(ed|ure)|\b(m|c|re)alloc failed|MemoryError|bad_alloc|cannot allocate memory/i;
const TOO_LARGE = /too large for the multi-class finite-element solver/i;
const MESH_FITS = /A mesh of (\d+) or fewer elements per station fits/;
const STATIONS = /(\d+) stations with \d+ mesh elements per station/;
const NO_CONVERGENCE = /did not converge|not converged|not_converged|failed to converge|diverged/i;
const UNSTABLE = /\bis unstable\b|\bunstable (net|network|station)|offered load [^\n]*>= ?1/i;
const MISSING_MODULE = /ModuleNotFoundError: No module named ['"]([^'"\n]+)['"]|ImportError: ([^\n]+)/;
/** Lines that only announce a failure, never its cause. */
const HEADINGS = /^(⚠ .* failed \(exit -?\d+\):|.* failed \(exit -?\d+\) after .*|Solver exited with code -?\d+\.|Elapsed time: .*)$/;

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

/** Everything the run said, for the rules to read. */
function evidence(r: FailureReport): string {
  return [r.stderrTail, r.outputTail, ...r.statusLines.map((l) => l.text), r.reason ?? ""].join("\n");
}

/** The solver's last error line: from its stderr, else the run's error Status lines, else its output. */
export function lastErrorLine(r: FailureReport): string | null {
  const pick = (ls: string[]) => ls.filter((l) => !HEADINGS.test(l)).pop() ?? null;
  return (
    pick(lines(r.stderrTail)) ??
    pick(r.statusLines.filter((l) => l.severity === "error").map((l) => l.text.trim())) ??
    pick(lines(r.outputTail))
  );
}

/** True when the run stopped at mc_solver's size guard: the panel then asks the Method Chooser what does apply. */
export function tooLarge(r: FailureReport): boolean {
  return TOO_LARGE.test(evidence(r));
}

/** Stations whose utilisation is 1 or more, worst first. */
export function overloaded(r: FailureReport): { station: string; utilisation: number }[] {
  return r.utilisation.filter((u) => u.utilisation >= 1).sort((a, b) => b.utilisation - a.utilisation);
}

const rho = (x: number) => (Math.round(x * 100) / 100).toFixed(2);

/** How to make this method's problem smaller. */
function smaller(method: string): string {
  switch (method) {
    case "inf_sm":
    case "sm":
      return "Lower the polynomial degree in Run Spectral Method… (the memory needed grows very quickly with the degree and the number of stations).";
    case "fm":
      return "Use a smaller mesh size in Run Finite Element… (the memory needed grows very quickly with the mesh size and the number of stations).";
    case "lp":
      return "Use a smaller grid size for the Linear Program (Settings ▸ Linear Program).";
    case "truncated_ctmc":
    case "generic_ctmc":
    case "qbd":
      return "This network has too many states for an exact solution. Use smaller buffers or fewer stations.";
    case "inf_sim":
    case "sim":
    case "regenerative_mc":
    case "mlmc":
      return "Ask for fewer replications or a shorter simulation.";
    default:
      return "Make the problem smaller: fewer stations, or smaller buffers.";
  }
}

const listOf = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items.at(-1)}` : (items[0] ?? ""));

export const reportWords = {
  showReport: "Show Report…",
  showReportHelp: "Explain this failure and show what was run",
  /** The Status line written when a run failed without writing a failure line of its own (its output could not be used). */
  statusLine: (run: string) => `${run} ended without a usable result.`,
  panelTitle: "Failure Report",
  panelSubtitle: (run: string, network: string) => `${run} for “${network}”`,
  whatToTry: "What to try",
  whatWasRun: "What was run",
  lastOutput: "Last lines of output",
  noOutput: "The run printed nothing.",
  errorOutput: "Error output",
  solverSaid: "The solver's last message",
  method: "Method",
  network: "Network",
  ended: "Ended",
  settings: "Settings",
  command: "Command",
  solver: "Solver",
  runtime: "Runtime",
  system: "System",
  folder: "Report folder",
  reveal: "Reveal in Finder",
  revealHelp: "Show this report's folder in Finder: the solver input, the network, and the full error output",
  copy: "Copy Report",
  copied: "Copied",
  copyHelp: "Copy a summary to paste into an email or an issue. It names no folder of yours.",
  tryMethod: (name: string) => `Try ${name}`,
  tryHelp: (name: string) => `Run ${name} on this network instead`,
  close: "Close",
  loading: "Reading the report…",
  gone: "That failure report is no longer there. Qnet keeps the newest 20.",
  notWritten: "Qnet could not finish writing that failure report.",
  privacy: "Nothing is sent anywhere. The report stays on this Mac unless you send it.",
  menuTitle: "Show Failure Reports…",
  menuHelp: "Open the folder where Qnet keeps the reports of the last 20 failed runs",
  revealFailed: (why: string) => `Could not show the failure reports folder: ${why}`,
  buffers: (infinite: boolean) => (infinite ? "infinite buffers" : "finite buffers"),
  endedHow: (r: FailureReport) => {
    const t = `${r.durationSeconds.toFixed(1)} s`;
    switch (r.kind) {
      case "signal":
        return `stopped by ${r.signal ?? "a signal"} after ${t}`;
      case "could-not-start":
        return "could not start";
      case "unparsed":
        return `exit 0 after ${t}, with no usable result`;
      case "internal":
        return `internal error after ${t}`;
      default:
        return `exit ${r.exitCode} after ${t}`;
    }
  },
  tryAlternative: (name: string) => `Run ${name} instead: it does not use the part that failed.`,
  chooser: "Run ▸ Choose a Method… lists every method with whether it applies to this network, and why.",
  advised: (names: string[]) => `For this network Qnet's Method Chooser recommends ${listOf(names)}. ${names.length === 1 ? "It does" : "They do"} not build the mesh that was too large.`,
  coarserMesh: (n: number) => `Or run Multi-Class SRBM again with a coarser mesh: ${n} or fewer elements per station ("Mesh size per dimension" in Run Multi-Class SRBM…). A coarser mesh is less accurate and can still need a lot of memory and time.`,
  sendReport: "Send the report to the developer: Copy Report puts a summary on the clipboard, and Reveal in Finder shows the files.",
  checkDependencies: "Open Help ▸ Check Dependencies… to see which Python and which modules Qnet found.",
};

const w = reportWords;

/**
 * The explanation of a failed run, from its report. `advised` is what the Method Chooser
 * recommends for the network, best first, when the caller has asked it (the panel does for a
 * network that was too large); without it the explanation points at the chooser.
 */
export function explain(r: FailureReport, advised: readonly Advised[] = []): Explanation {
  const run = r.methodName;
  const text = evidence(r);
  const alt = alternativeFor(r.method, r.infiniteBuffers);
  const detail = lastErrorLine(r);
  const tryAlt = alt ? [w.tryAlternative(alt.name)] : [];

  if (r.kind === "signal" || r.kind === "internal") {
    return {
      cause: r.kind === "signal" ? "crash" : "internal",
      title: r.kind === "signal" ? `The solver stopped unexpectedly${r.signal ? ` (${r.signal})` : ""}.` : `${run} stopped on an internal error.`,
      body: "This is a fault in Qnet, not in your network. Nothing you entered is wrong, and your network has not been changed.",
      next: [...tryAlt, w.sendReport],
      tryMethod: alt,
      detail,
    };
  }

  if (r.kind === "could-not-start") {
    return {
      cause: "could-not-start",
      title: `${run} could not start.`,
      body: "Qnet could not start the solver or write its input file. This is a problem with this copy of Qnet or this Mac, not with your network.",
      next: [w.checkDependencies, ...tryAlt, w.sendReport],
      tryMethod: alt,
      detail,
    };
  }

  const missing = MISSING_MODULE.exec(text);
  if (missing) {
    const name = missing[1];
    return {
      cause: "missing-module",
      title: name ? `Python is missing the module “${name}”.` : "Python could not load a module this method needs.",
      body: `${run} is written in Python and needs ${name ? `the module “${name}”` : "a module"} that the Python Qnet used does not have. Your network is not the problem.`,
      next: [w.checkDependencies, ...tryAlt],
      tryMethod: alt,
      detail: missing[0],
    };
  }

  const over = overloaded(r);
  if (r.infiniteBuffers && (over.length > 0 || UNSTABLE.test(text))) {
    const worst = over[0];
    const which =
      over.length === 0
        ? "At least one station receives work faster than it can serve it"
        : over.length === 1
          ? `Station ${worst.station} has utilisation ${rho(worst.utilisation)}: work arrives faster than it can be served`
          : `Stations ${over.map((u) => `${u.station} (${rho(u.utilisation)})`).join(", ")} have utilisation of 1 or more: work arrives faster than it can be served`;
    return {
      cause: "unstable",
      title: "The network is unstable.",
      body: `${which}, so the queue there grows without limit and there is no steady state for ${run} to compute. With infinite buffers every method needs utilisation below 1 at every station.`,
      next: [
        worst
          ? `Check ${worst.station}'s service rate and number of servers against its arrival rate: utilisation (arrival rate ÷ total service rate) must be below 1.`
          : "Check each station's service rate against its arrival rate: utilisation (arrival rate ÷ total service rate) must be below 1. Network ▸ Analyze Network lists it per station.",
        "Or change Buffer Model to Finite, where a full station blocks or loses customers instead of growing.",
      ],
      tryMethod: null,
      detail,
    };
  }

  if (TOO_LARGE.test(text)) {
    const stations = STATIONS.exec(text)?.[1];
    const fits = MESH_FITS.exec(text)?.[1];
    // Not the method that failed, and at most three names: a sentence, not the chooser's table.
    const others = advised.filter((a) => a.command !== "run:multiclass").slice(0, 3);
    return {
      cause: "too-large",
      title: `This network is too large for ${run}.`,
      body: `${run} solves on a mesh over all the stations at once, and the mesh grows very quickly with their number${stations ? `: with ${stations} stations it` : "; this one"} needs more matrix entries than the solver can hold${fits ? " at the mesh it was given" : ", whatever the mesh"}. Your network is valid, and other methods solve it.`,
      next: [...(others.length ? [w.advised(others.map((a) => a.name))] : tryAlt), w.chooser, ...(fits ? [w.coarserMesh(Number(fits))] : [])],
      tryMethod: others[0] ?? alt,
      detail,
    };
  }

  if (MEMORY.test(text)) {
    return {
      cause: "memory",
      title: `${run} needs more memory than this Mac can give it.`,
      body: "The solver stopped before (or while) asking for more memory than is safe. Your network is valid; this method is too expensive for it at these settings.",
      next: [smaller(r.method), ...tryAlt],
      tryMethod: alt,
      detail,
    };
  }

  if (NO_CONVERGENCE.test(text)) {
    return {
      cause: "no-convergence",
      title: `${run} did not converge.`,
      body: "The solver's iteration did not settle on an answer, so it reported none rather than a wrong one. This happens more often when a station is close to full utilisation.",
      next: ["Check how close each station's utilisation is to 1 (Network ▸ Analyze Network); a slightly higher service rate often helps.", ...tryAlt],
      tryMethod: alt,
      detail,
    };
  }

  if (r.kind === "unparsed") {
    return {
      cause: "unusable-output",
      title: `${run} finished, but gave no usable result.`,
      body: r.reason ?? "The solver exited normally, but its output held no measurements Qnet could read.",
      next: [...tryAlt, w.sendReport],
      tryMethod: alt,
      detail,
    };
  }

  return {
    cause: "other",
    title: `${run} stopped with an error (exit ${r.exitCode}).`,
    body: detail ? `The solver's last message was: ${detail}` : "The solver gave no reason.",
    next: [...tryAlt, w.sendReport],
    tryMethod: alt,
    detail,
  };
}

/**
 * `text` with no home folder in it: "/Users/<name>" (and "/home/<name>") become "~". The whole
 * name goes, up to the next "/", space or quote, so no name is ever cut at another's prefix (the
 * boundary rule of `scrub` in src-tauri/src/reports.rs, which knows the one home folder).
 */
export function withoutHome(text: string): string {
  return text.replace(/\/(?:Users|home)\/[^/\s"'“”]+/g, "~");
}

const lastLines = (text: string, n: number) => lines(text).slice(-n).join("\n");

/** Copy Report: a summary for an email or an issue. No home-folder path. */
export function reportText(r: FailureReport, e: Explanation = explain(r)): string {
  const settings = Object.entries(r.settings).map(([k, v]) => `${k} = ${v}`).join("; ");
  const sheet = Object.entries(r.sheet).map(([k, v]) => `${k} = ${v}`).join("; ");
  const out: string[] = [
    `Qnet failure report: ${r.methodName} for “${r.networkTitle}”`,
    "",
    e.title,
    e.body,
    ...(e.next.length ? ["", `${w.whatToTry}:`, ...e.next.map((n) => `- ${n}`)] : []),
    "",
    `Qnet ${r.qnetVersion} (${r.buildTag}) · macOS ${r.macosVersion} · ${r.chip}`,
    `${w.method}: ${r.methodName} (${r.method}), ${w.buffers(r.infiniteBuffers)}`,
    `${w.ended}: ${w.endedHow(r)}`,
    ...(settings ? [`${w.settings}: ${settings}`] : []),
    ...(sheet ? [`Sheet: ${sheet}`] : []),
    ...(r.seed !== null ? [`Seed: ${r.seed}`] : []),
    ...r.commands.map((c) => `${w.command}: ${c.command} → ${c.ended}`),
    ...(r.solverPath ? [`${w.solver}: ${r.solverPath}`] : []),
    ...(r.runtime ? [`${w.runtime}: ${r.runtime}`] : []),
    ...(r.utilisation.length ? [`Utilisation: ${r.utilisation.map((u) => `${u.station} ${rho(u.utilisation)}`).join(", ")}`] : []),
    `Report: ${r.id} (${r.createdAt})`,
  ];
  const err = lastLines(r.stderrTail, 40);
  if (err) out.push("", `${w.errorOutput}:`, err);
  const tail = lastLines(r.outputTail, 40);
  if (tail) out.push("", `${w.lastOutput}:`, tail);
  return withoutHome(out.join("\n")) + "\n";
}
