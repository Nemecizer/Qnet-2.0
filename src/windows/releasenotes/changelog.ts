// The release notes, newest first (0.90.34 Changelog.swift `Changelog.entries`; ledger ABOUT-013,
// ABOUT-014, ABOUT-017, ABOUT-018).
//
// The convention is 0.90.34's: the topmost entry has `timestamp: null`, which marks it as the
// entry of the build that is running — the window shows the app's own version and build time for
// it, whatever its `version` field says. To ship a release, give that entry its build stamp
// (MM.DD.YYYY.HHMM) and put a new `timestamp: null` entry above it.
//
// 0.90.34's two entries are carried over word for word in changelog-0.90.json (made from
// Changelog.swift by a script; its Swift string escapes resolved, nothing else changed). Its live
// entry was labelled "0.90.02" in the source and shown as the running build, 0.90.34 built
// 09.04.2026.1534; it is frozen here under what it showed.
import old from "./changelog-0.90.json";

export interface ChangelogEntry {
  version: string;
  /** MM.DD.YYYY.HHMM, or null for the running build's entry. */
  timestamp: string | null;
  /** Plain prose, one bullet each; no markup is read. */
  notes: string[];
}

/** What 0.90.34's About showed for its last build (`AppVersion`, ABOUT-008). */
export const LAST_0_90 = { version: "0.90.34", timestamp: "09.04.2026.1534" };

const carried: ChangelogEntry[] = (old as ChangelogEntry[]).map((e) => (e.timestamp === null ? { ...e, ...LAST_0_90 } : e));

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "2.1.2",
    timestamp: null,
    notes: [
      "Qnet 2.1.2 keeps itself up to date. It checks Qnet's public GitHub releases at launch, at most once a day, and from Qnet ▸ Check for Updates…; it installs only a download signed with the author's key, and never while a run is in progress. Settings ▸ General ▸ Updates turns the daily check off.",
      "Copies before 2.1.2 cannot update themselves: install 2.1.2 by hand once, and later versions arrive by themselves.",
    ],
  },
  {
    version: "2.1.1",
    timestamp: "11.13.2026.1543",
    notes: [
      "Qnet 2.1.1 makes the assistant work with the current Claude and OpenAI models. Settings list them without a key or a refresh: Claude Opus 5.5 (the new default), Claude Fable 5.2 and the rest of the current Claude models, and GPT-6 Astra (the new default), Sol, Terra and Luna. After Refresh, the account's own list is shown; a model you chose before is kept, and a retired one gets a note naming its replacement.",
      "Claude: requests no longer carry a temperature to the models that refuse one, which had stopped the assistant working with every recent Claude model. A reply Claude declines is explained in plain words, and a new setting, on by default, lets another Claude model answer instead.",
      "OpenAI: the assistant now uses OpenAI's Responses API, which carries tool calls for the GPT-6 models; nothing is stored on OpenAI's side between turns. Refresh lists text models only.",
      "Help has a new article on connecting to OpenAI, and the Anthropic article is rewritten.",
    ],
  },
  {
    version: "2.1.0",
    timestamp: "11.13.2026.1336",
    notes: [
      "Qnet 2.1 runs on macOS 14 and later and needs nothing installed: the solvers and their libraries are built for it, and Qnet carries its own Python and NumPy. A failed run now leaves a report and an explanation in plain words with a next step.",
      "See the answer. Solve (Command-Return) runs the best method for the network. The Results pane gains charts, an Agreement view that says how far independent methods agree and which is the reference, and What-If Sweeps. Results can be shown on the canvas, with the bottleneck marked, and they stay current when only the layout changes.",
      "The first five minutes. A Welcome view with the examples as a gallery, a Guided Tour that follows what you do, problems marked on the canvas with fixes that are single undo steps, and Help articles that open and run their own examples.",
      "Live results while drawing: utilisation as you edit, and exact queue lengths wherever a closed form exists.",
      "New analyses in the Results pane: Sensitivity with “what would it take”, Capacity planning, Uncertainty in the inputs, and Transient behaviour over time. Each number carries its kind of evidence: exact, simulation, approximation, diffusion model or bound. Where a network has no closed form these analyses use a numerical route marked Experimental.",
      "New kinds of model: closed networks with a fixed population, priorities at a station, batch arrivals, and arrival rates that vary through the day. A method that does not understand one of these refuses the network in a sentence; it never ignores the feature.",
      "New methods: Exact Closed Product Form, Exact Priority Queue, Exact Batch Queue, and Replicated Simulation, an in-process simulation with confidence intervals that gives closed networks a second opinion.",
      "Fit from Data in the inspector fits a distribution to pasted or imported observations. Scenarios keep named variants of one network in the file and compare them. Animate shows one random run on the canvas.",
      "The assistant can explain results. Every number in its reply is checked against the run or computation it cites, and a number it cannot source is marked unverified. It starts a run only when asked.",
      "Scripting: qnet-cli answers in JSON, and a Python package, qnet, builds, solves and sweeps networks from a script or notebook.",
      "Accessibility: a Canvas Outline gives keyboard and screen-reader access to the diagram, Tab now leaves the canvas at its ends instead of wrapping, and View ▸ Appearance sets theme, contrast, motion and text size.",
      "Fixed: a crash in the Monte Carlo solver on networks of five or more stations (they now get a clear message) and four other memory errors in three solvers; the inspector no longer lists a class a station does not serve; Finite LP refuses a problem too large for it before it starts.",
      "Automatic updates are built but switched off in this copy: it never checks.",
    ],
  },
  {
    version: "2.0.0",
    timestamp: "11.12.2026.1022",
    notes: [
      "Qnet 2.0 is Qnet 0.90.34 rebuilt, with the same functions: the same canvas and tools, inspectors and parameter panels, methods and their settings, solver input files, results workspace, Status log, Shell pane, AI assistant and Help. The solvers are 0.90.34's own code, unchanged; the model, the exporters, the analysis and the result parser were rewritten in Rust and are checked against 0.90.34's output for every bundled example, and the interface was rewritten for a Tauri shell in place of the Swift app. Three things work differently by design. Qnet now starts each solver itself and shows its output in the Shell pane, where 0.90.34 typed a generated script into your shell, so a run is no longer in the shell's own history. Settings and results are kept in JSON files under a new application identifier, so 0.90.34 and 2.0 can run side by side, and settings come across by Export… and Import… rather than automatically. Help articles are Markdown, and a Help topic sent to the Status pane or the Shell is printed as plain text made from them. Defects found in 0.90.34 during the rebuild are fixed rather than reproduced; each one is recorded as a changed row in the parity ledger (docs/PARITY.md).",
    ],
  },
  ...carried,
];

/** True when the topmost entry is the running build's (`topEntryMatchesAppVersion`). */
export const topEntryIsLive = (entries: ChangelogEntry[] = CHANGELOG) => entries[0]?.timestamp === null;
