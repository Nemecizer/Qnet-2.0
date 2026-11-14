// The Settings window's panes and its search registry: 0.90.34's `SettingsView.Group`,
// `SettingsView.Tab` and `SettingsRegistry` (SettingsView.swift). Every searchable row is one
// entry, keyed by its anchor id, with the stored keys it edits (`keys`, the id itself when left
// out); Reset to Defaults, the sidebar's "differs" dot and the import report's "Pane ▸ Row" names
// are all read from here. `settings_schema::tests::every_stored_key_has_a_settings_row_or_a_reason`
// (Rust) reads this file: keep one entry per line, `{ id: "…", … keys: [ … ] }`.
import { Cpu, Dice5, FlaskConical, Grid3x3, Hash, Layers, RectangleHorizontal, Settings, Sparkles, SquareFunction, TrendingUp, Type, CircleHelp, type LucideIcon } from "lucide-react";
import { rows, settingsWords } from "./words";

export type GroupId = keyof typeof settingsWords.groups;

/** The stored pane ids (0.90.34 `Tab` raw values: persisted as `settings.selectedPane`). */
export type PaneId =
  | "General" | "Solver Engine" | "Simulation" | "SRBM MLMC" | "Linear Program" | "Finite-Buffer LP"
  | "Finite Element" | "Spectral Method" | "Test Sets" | "Output Format" | "Interactive Shell Window"
  | "Help menu" | "AI Assistant";

export interface PaneInfo {
  id: PaneId;
  title: string;
  group: GroupId;
  /** The sidebar row's tooltip. */
  summary: string;
  /** The lucide glyph for 0.90.34's `DS.Symbol` (its run sheet's glyph for a solver pane). */
  icon: LucideIcon;
}

/** The 13 panes in 0.90.34's order (ledger SET-004…016). */
export const PANES: PaneInfo[] = [
  { id: "General", title: "General", group: "general", summary: "Tab restore and Run Comparison behaviour", icon: Settings },
  { id: "Solver Engine", title: "Solver Engine", group: "solvers", summary: "C or Python for the three methods that ship both", icon: Cpu },
  { id: "Simulation", title: "Discrete-Event Simulation", group: "solvers", summary: "jackson_sim / fBNAsim run length, parallelism and blocking", icon: Dice5 },
  { id: "SRBM MLMC", title: "SRBM MLMC", group: "solvers", summary: "rbm_mlmc accuracy, overrides and reproducibility", icon: Layers },
  { id: "Linear Program", title: "Linear Program", group: "solvers", summary: "srbm_lp grid, basis and solver (orthant)", icon: TrendingUp },
  { id: "Finite-Buffer LP", title: "Finite-Buffer LP", group: "solvers", summary: "fBNAlp grid, basis and solver (rectangle)", icon: RectangleHorizontal },
  { id: "Finite Element", title: "Finite Element", group: "solvers", summary: "bna_fm quadrature and mesh", icon: Grid3x3 },
  { id: "Spectral Method", title: "Spectral Method", group: "solvers", summary: "Polynomial degree and basis", icon: SquareFunction },
  { id: "Test Sets", title: "Test Sets", group: "sweeps", summary: "Defaults for random test-set sweeps", icon: FlaskConical },
  { id: "Output Format", title: "Output Format", group: "interface", summary: "Decimal places in result tables", icon: Hash },
  { id: "Interactive Shell Window", title: "Panes", group: "interface", summary: "Fonts and colours for the Shell, Status and AI Assistant panes", icon: Type },
  { id: "Help menu", title: "Help", group: "interface", summary: "Where Help menu text is shown", icon: CircleHelp },
  { id: "AI Assistant", title: "AI Assistant", group: "assistant", summary: "Provider, model, API key and generation", icon: Sparkles },
];

export const GROUPS: GroupId[] = ["general", "solvers", "sweeps", "interface", "assistant"];

export function paneInfo(id: PaneId): PaneInfo {
  return PANES.find((p) => p.id === id)!;
}

/** A stored pane id, or General for one this build doesn't know (the removed "GCDG" pane). */
export function paneFromStored(raw: unknown): PaneId {
  return PANES.some((p) => p.id === raw) ? (raw as PaneId) : "General";
}

export interface SettingEntry {
  id: string;
  pane: PaneId;
  section: string;
  keywords: string[];
  /** The stored keys the row edits (the id when left out; none for a read-only row). */
  keys?: string[];
}

/** 0.90.34's `SettingsRegistry.entries`, in its order. Titles are the rows' labels (words.ts). */
export const ENTRIES: SettingEntry[] = [
  { id: "tabs.restoreBehavior", pane: "General", section: "Tabs", keywords: ["restore", "tabs", "quit", "reopen", "session"] },
  { id: "welcome.showAtLaunch", pane: "General", section: "Launch", keywords: ["welcome", "start", "launch", "examples", "startup"] },
  { id: "runCompare.remember", pane: "General", section: "Run Comparison", keywords: ["comparison", "dialog", "popup", "skip", "prompt"] },
  { id: "general.blockingSummary", pane: "General", section: "Run Comparison", keywords: ["blocking", "loss", "bas", "regime", "finite"], keys: [] },
  { id: "updates.auto", pane: "General", section: "Updates", keywords: ["update", "updates", "version", "upgrade", "automatic", "check", "new", "release"] },
  { id: "general.resetAll", pane: "General", section: "All Settings", keywords: ["reset", "defaults", "everything", "all", "restore", "factory"], keys: [] },
  { id: "general.exportImport", pane: "General", section: "All Settings", keywords: ["export", "import", "json", "file", "configuration", "share", "paper", "backup", "transfer"], keys: [] },
  { id: "engine.regenerative", pane: "Solver Engine", section: "Regenerative Monte Carlo", keywords: ["engine", "c", "python", "native", "speed", "fast", "simulation", "regenerative", "monte carlo"] },
  { id: "engine.qbd", pane: "Solver Engine", section: "Exact Matrix-Analytic QBD", keywords: ["engine", "c", "python", "native", "speed", "fast", "qbd", "matrix", "analytic", "phase"] },
  { id: "engine.ctmc", pane: "Solver Engine", section: "Markovian CTMC", keywords: ["engine", "c", "python", "native", "speed", "fast", "ctmc", "truncated", "markov", "generic"] },
  { id: "engine.parity", pane: "Solver Engine", section: "Why There Are Two", keywords: ["parity", "identical", "reference", "verification", "same", "answer", "byte", "test"], keys: [] },
  { id: "sim.parallel", pane: "Simulation", section: "Execution", keywords: ["gcd", "openmp", "sequential", "threads", "parallel", "simulation"] },
  { id: "sim.blocking", pane: "Simulation", section: "Finite Buffers", keywords: ["loss", "bas", "external", "blocking", "buffer", "finite"] },
  { id: "sim.replications", pane: "Simulation", section: "Run Length", keywords: ["runs", "repeat", "confidence", "half-width", "simulation"] },
  { id: "sim.warmup", pane: "Simulation", section: "Run Length", keywords: ["warmup", "transient", "burn-in", "time", "simulation"] },
  { id: "sim.time", pane: "Simulation", section: "Run Length", keywords: ["horizon", "length", "duration", "time", "simulation"] },
  { id: "sim.seed", pane: "Simulation", section: "Reproducibility", keywords: ["seed", "random", "reproducible", "deterministic", "simulation"], keys: ["sim.seed", "sim.seedFixed"] },
  { id: "mlmc.epsilon", pane: "SRBM MLMC", section: "Accuracy", keywords: ["epsilon", "rmse", "error", "mlmc", "accuracy", "tolerance"] },
  { id: "mlmc.gamma", pane: "SRBM MLMC", section: "Accuracy", keywords: ["gamma", "step", "mlmc", "level"] },
  { id: "mlmc.T", pane: "SRBM MLMC", section: "Advanced Overrides", keywords: ["override", "path", "horizon", "transient", "mlmc"], keys: ["mlmc.T", "mlmc.overrideT"] },
  { id: "mlmc.L", pane: "SRBM MLMC", section: "Advanced Overrides", keywords: ["override", "levels", "mlmc", "bias"], keys: ["mlmc.L", "mlmc.overrideL"] },
  { id: "mlmc.N", pane: "SRBM MLMC", section: "Advanced Overrides", keywords: ["override", "samples", "mlmc", "variance"], keys: ["mlmc.N", "mlmc.overrideN"] },
  { id: "mlmc.antithetic", pane: "SRBM MLMC", section: "Variance Reduction", keywords: ["antithetic", "variance", "reduction", "mlmc"] },
  { id: "mlmc.replications", pane: "SRBM MLMC", section: "Variance Reduction", keywords: ["replications", "seeds", "standard error", "confidence", "mlmc"] },
  { id: "mlmc.adaptive", pane: "SRBM MLMC", section: "Adaptive Sampling", keywords: ["adaptive", "stop", "standard error", "mlmc"] },
  { id: "mlmc.batchSize", pane: "SRBM MLMC", section: "Adaptive Sampling", keywords: ["batch", "adaptive", "mlmc"] },
  { id: "mlmc.minSamples", pane: "SRBM MLMC", section: "Adaptive Sampling", keywords: ["minimum", "samples", "adaptive", "mlmc"] },
  { id: "mlmc.maxSamples", pane: "SRBM MLMC", section: "Adaptive Sampling", keywords: ["maximum", "cap", "samples", "adaptive", "mlmc"] },
  { id: "mlmc.backend", pane: "SRBM MLMC", section: "Parallelism", keywords: ["openmp", "gcd", "accelerate", "serial", "parallel", "mlmc"] },
  { id: "mlmc.threads", pane: "SRBM MLMC", section: "Parallelism", keywords: ["cores", "threads", "cpu", "parallel", "mlmc"] },
  { id: "mlmc.seed", pane: "SRBM MLMC", section: "Reproducibility", keywords: ["seed", "random", "reproducible", "deterministic", "mlmc"], keys: ["mlmc.seed", "mlmc.seedFixed"] },
  { id: "lp.recommended", pane: "Linear Program", section: "Discretisation", keywords: ["recommended", "dimension", "stations", "network", "lp"], keys: [] },
  { id: "lp.autoGrid", pane: "Linear Program", section: "Discretisation", keywords: ["auto-scale", "auto", "scale", "grid", "dimension", "lp"], keys: ["lp.gridN"] },
  { id: "lp.gridN", pane: "Linear Program", section: "Discretisation", keywords: ["grid", "cells", "resolution", "auto", "lp", "srbm_lp", "dimension", "recommended"] },
  { id: "lp.autoBasis", pane: "Linear Program", section: "Discretisation", keywords: ["auto-scale", "auto", "scale", "basis", "dimension", "lp"], keys: ["lp.basisM"] },
  { id: "lp.basisM", pane: "Linear Program", section: "Discretisation", keywords: ["basis", "polynomial", "degree", "auto", "lp", "dimension", "recommended"] },
  { id: "lp.gridType", pane: "Linear Program", section: "Discretisation", keywords: ["exponential", "dyadic", "random", "grid", "lp"] },
  { id: "lp.solver", pane: "Linear Program", section: "Solver", keywords: ["cplex", "glpk", "highs", "solver", "backend", "lp"] },
  { id: "lp.basisNormalize", pane: "Linear Program", section: "Numerical Stability", keywords: ["normalise", "normalize", "conditioning", "basis", "lp"] },
  { id: "lp.smoothness", pane: "Linear Program", section: "Numerical Stability", keywords: ["smoothness", "tv", "penalty", "degenerate", "lp"] },
  { id: "lp.askBeforeRun", pane: "Linear Program", section: "Run-time Behaviour", keywords: ["ask", "dialog", "prompt", "run", "lp"] },
  { id: "lp.multiLevel", pane: "Linear Program", section: "Run-time Behaviour", keywords: ["coarse", "fine", "preview", "refine", "lp"] },
  { id: "lp.hints", pane: "Linear Program", section: "Reference", keywords: ["hints", "performance", "table", "help", "lp"], keys: [] },
  { id: "flp.recommended", pane: "Finite-Buffer LP", section: "Discretisation", keywords: ["recommended", "dimension", "stations", "network", "finite", "lp"], keys: [] },
  { id: "flp.autoGrid", pane: "Finite-Buffer LP", section: "Discretisation", keywords: ["auto-scale", "auto", "scale", "grid", "dimension", "finite", "lp"], keys: ["flp.gridN"] },
  { id: "flp.gridN", pane: "Finite-Buffer LP", section: "Discretisation", keywords: ["grid", "cells", "resolution", "auto", "finite", "fbnalp", "rectangle", "dimension", "recommended"] },
  { id: "flp.autoBasis", pane: "Finite-Buffer LP", section: "Discretisation", keywords: ["auto-scale", "auto", "scale", "basis", "dimension", "finite", "lp"], keys: ["flp.basisM"] },
  { id: "flp.basisM", pane: "Finite-Buffer LP", section: "Discretisation", keywords: ["basis", "polynomial", "auto", "finite", "fbnalp", "dimension", "recommended"] },
  { id: "flp.gridType", pane: "Finite-Buffer LP", section: "Discretisation", keywords: ["uniform", "chebyshev", "grid", "finite", "lp"] },
  { id: "flp.solver", pane: "Finite-Buffer LP", section: "Solver", keywords: ["highs", "glpk", "cplex", "solver", "backend", "finite", "lp"] },
  { id: "flp.basisNormalize", pane: "Finite-Buffer LP", section: "Numerical Stability", keywords: ["normalise", "normalize", "conditioning", "basis", "finite", "lp"] },
  { id: "fem.solver", pane: "Finite Element", section: "Quadrature", keywords: ["gauss", "legendre", "cbc", "quasi", "monte carlo", "fem", "finite element"] },
  { id: "fem.meshSize", pane: "Finite Element", section: "Mesh", keywords: ["mesh", "elements", "per dimension", "axis", "resolution", "fem", "finite element", "cap"] },
  { id: "sm.degree", pane: "Spectral Method", section: "Basis", keywords: ["degree", "polynomial", "galerkin", "spectral", "bnet"] },
  { id: "sm.legendre", pane: "Spectral Method", section: "Basis", keywords: ["legendre", "monomial", "basis", "spectral", "conditioning"] },
  { id: "testset.inf.stations", pane: "Test Sets", section: "Infinite Test Set", keywords: ["stations", "dimension", "infinite", "test set", "sweep"], keys: ["testset.inf.stationsLo", "testset.inf.stationsHi"] },
  { id: "testset.inf.classes", pane: "Test Sets", section: "Infinite Test Set", keywords: ["classes", "customer", "infinite", "test set"], keys: ["testset.inf.classesLo", "testset.inf.classesHi"] },
  { id: "testset.inf.rho", pane: "Test Sets", section: "Infinite Test Set", keywords: ["rho", "utilisation", "utilization", "load", "infinite", "test set"], keys: ["testset.inf.rhoLo", "testset.inf.rhoHi"] },
  { id: "testset.inf.numCases", pane: "Test Sets", section: "Infinite Test Set", keywords: ["cases", "count", "infinite", "test set"] },
  { id: "testset.inf.topology", pane: "Test Sets", section: "Infinite Test Set", keywords: ["feed-forward", "jackson", "feedback", "p-matrix", "re-entrant", "topology", "infinite"] },
  { id: "testset.fin.stations", pane: "Test Sets", section: "Finite Test Set", keywords: ["stations", "dimension", "finite", "test set", "sweep"], keys: ["testset.fin.stationsLo", "testset.fin.stationsHi"] },
  { id: "testset.fin.classes", pane: "Test Sets", section: "Finite Test Set", keywords: ["classes", "customer", "finite", "test set"], keys: ["testset.fin.classesLo", "testset.fin.classesHi"] },
  { id: "testset.fin.rho", pane: "Test Sets", section: "Finite Test Set", keywords: ["rho", "utilisation", "utilization", "load", "finite", "test set"], keys: ["testset.fin.rhoLo", "testset.fin.rhoHi"] },
  { id: "testset.fin.numCases", pane: "Test Sets", section: "Finite Test Set", keywords: ["cases", "count", "finite", "test set"] },
  { id: "testset.fin.topology", pane: "Test Sets", section: "Finite Test Set", keywords: ["feed-forward", "jackson", "feedback", "p-matrix", "re-entrant", "topology", "finite"] },
  { id: "testset.spc.stations", pane: "Test Sets", section: "Spectral Convergence", keywords: ["stations", "dimension", "spectral", "convergence", "sweep"], keys: ["testset.spc.stationsLo", "testset.spc.stationsHi"] },
  { id: "testset.spc.classes", pane: "Test Sets", section: "Spectral Convergence", keywords: ["classes", "customer", "spectral", "convergence"], keys: ["testset.spc.classesLo", "testset.spc.classesHi"] },
  { id: "testset.spc.rhoRange", pane: "Test Sets", section: "Spectral Convergence", keywords: ["rho", "sweep", "start", "end", "spectral", "convergence"], keys: ["testset.spc.rhoStart", "testset.spc.rhoEnd"] },
  { id: "testset.spc.rhoStep", pane: "Test Sets", section: "Spectral Convergence", keywords: ["rho", "step", "increment", "spectral", "convergence"] },
  { id: "testset.spc.numCases", pane: "Test Sets", section: "Spectral Convergence", keywords: ["cases", "count", "spectral", "convergence"] },
  { id: "testset.spc.topology", pane: "Test Sets", section: "Spectral Convergence", keywords: ["feed-forward", "jackson", "feedback", "p-matrix", "re-entrant", "topology", "spectral"] },
  { id: "output.decimals", pane: "Output Format", section: "Numeric Display", keywords: ["decimals", "digits", "precision", "format", "table", "rho", "gamma", "sojourn"] },
  { id: "shell.fontName", pane: "Interactive Shell Window", section: "Shell", keywords: ["font", "family", "typeface", "terminal", "shell", "monospaced", "appearance"] },
  { id: "shell.fontSize", pane: "Interactive Shell Window", section: "Shell", keywords: ["font", "size", "points", "terminal", "shell", "zoom", "appearance"] },
  { id: "shell.classicTheme", pane: "Interactive Shell Window", section: "Shell", keywords: ["theme", "classic", "green", "black", "colours", "colors", "terminal", "shell", "dark", "appearance"] },
  { id: "status.fontSize", pane: "Interactive Shell Window", section: "Status", keywords: ["font", "size", "points", "status", "log", "zoom", "appearance"] },
  { id: "ai.fontName", pane: "Interactive Shell Window", section: "AI Assistant", keywords: ["font", "family", "typeface", "ai", "assistant", "transcript", "code", "monospaced", "appearance"] },
  { id: "ai.fontSize", pane: "Interactive Shell Window", section: "AI Assistant", keywords: ["font", "size", "points", "ai", "assistant", "transcript", "zoom", "appearance"] },
  { id: "help.outputDestination", pane: "Help menu", section: "Help Menu", keywords: ["help", "popup", "status", "shell", "window", "destination"] },
  { id: "ai.paneVisible", pane: "AI Assistant", section: "Pane", keywords: ["show", "hide", "pane", "ai", "assistant", "layout"], keys: [] },
  { id: "ai.provider", pane: "AI Assistant", section: "Backend", keywords: ["anthropic", "openai", "ollama", "lm studio", "provider", "claude", "gpt", "ai"], keys: [] },
  { id: "ai.baseURL", pane: "AI Assistant", section: "Backend", keywords: ["url", "endpoint", "server", "host", "api", "ai"], keys: ["ai.baseURL.anthropic", "ai.baseURL.openai", "ai.baseURL.ollama", "ai.baseURL.lmstudio"] },
  { id: "ai.model", pane: "AI Assistant", section: "Backend", keywords: ["model", "claude", "gpt", "llama", "ai", "discover", "refresh"], keys: ["ai.model.anthropic", "ai.discovered.anthropic", "ai.model.openai", "ai.discovered.openai", "ai.model.ollama", "ai.discovered.ollama", "ai.model.lmstudio", "ai.discovered.lmstudio"] },
  { id: "ai.apiKey", pane: "AI Assistant", section: "Backend", keywords: ["key", "secret", "token", "keychain", "credential", "ai"], keys: [] },
  { id: "ai.systemPrompt", pane: "AI Assistant", section: "Generation", keywords: ["prompt", "system", "instructions", "persona", "ai"] },
  { id: "ai.maxTokens", pane: "AI Assistant", section: "Generation", keywords: ["tokens", "length", "limit", "output", "ai"] },
  { id: "ai.temperature", pane: "AI Assistant", section: "Generation", keywords: ["temperature", "randomness", "creativity", "sampling", "ai"] },
  { id: "ai.fallback.anthropic", pane: "AI Assistant", section: "Generation", keywords: ["fallback", "refusal", "declines", "declined", "claude", "anthropic", "ai"] },
  { id: "ai.timeoutSec", pane: "AI Assistant", section: "Generation", keywords: ["timeout", "seconds", "network", "request", "ai"] },
  { id: "ai.testConnection", pane: "AI Assistant", section: "Connection", keywords: ["test", "connection", "ping", "verify", "ai"], keys: [] },
];

/** Stored keys with no Settings row, and why (0.90.34 `SettingsRegistry.unindexedKeys`). */
export const UNINDEXED_KEYS: Record<string, string> = {
  "gcdg.enabled": "vestigial; the tractability detector no longer reads it",
  "flp.askBeforeRun": "reserved; the finite-LP run path does not consult it yet",
  "palette.paneVisible": "View ▸ Panes, not a setting",
  "inspector.paneVisible": "View ▸ Panes, not a setting",
  "status.paneVisible": "View ▸ Panes, not a setting",
  "results.paneVisible": "View ▸ Panes, not a setting; the Results workspace is revealed by the first solver run and hidden again from the menu",
  "shell.paneVisible": "View ▸ Panes, not a setting",
  "ai.paneVisible": "View ▸ Panes, not a setting; edited by the Show AI Assistant pane row, whose entry lists no keys because Reset never shows or hides a pane",
  "panes.soloed": "View ▸ Panes ▸ Maximize Pane, not a setting — which pane currently has the whole window, restored on the next launch the way a hidden pane is",
  "panes.detached": "View ▸ Panes ▸ Separate Windows, not a setting — which panes are torn out into windows of their own, restored on the next launch the way a window frame is",
  "results.autoShown": "one-shot bookkeeping: whether the first solver run has already revealed the Results workspace. Not user-facing and never reset by a Settings pane",
  "ai.provider": "edited by the Provider row, whose entry lists no keys because Reset never changes the provider",
};

export function entryKeys(e: SettingEntry): string[] {
  return e.keys ?? [e.id];
}

export function entryTitle(e: SettingEntry): string {
  return rows[e.id]?.label ?? e.id;
}

export function entry(id: string): SettingEntry | undefined {
  return ENTRIES.find((e) => e.id === id);
}

/** Lower case, without diacritics (`.caseInsensitive, .diacriticInsensitive`). */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** `SettingEntry.matches`: every whitespace-separated term occurs in the title, section, pane
 * title or keywords. */
export function entryMatches(e: SettingEntry, query: string): boolean {
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = fold([entryTitle(e), e.section, paneInfo(e.pane).title, ...e.keywords].join(" "));
  return terms.every((t) => hay.includes(fold(t)));
}

/** The entries a query finds, in registry order (grouped by pane). */
export function matches(query: string): SettingEntry[] {
  return query.trim() ? ENTRIES.filter((e) => entryMatches(e, query)) : [];
}

/** Every stored key edited on `pane`, in row order, without duplicates. */
export function keysFor(pane: PaneId): string[] {
  const out: string[] = [];
  for (const e of ENTRIES) if (e.pane === pane) for (const k of entryKeys(e)) if (!out.includes(k)) out.push(k);
  return out;
}

/** The keys whose values decide whether the pane is at its defaults (`resetKeys(for:)`): the AI
 * pane counts only the current provider's endpoint, model and discovered list and the four
 * generation keys. */
export function resetKeys(pane: PaneId, provider: string): string[] {
  if (pane !== "AI Assistant") return keysFor(pane);
  const p = ["anthropic", "openai", "ollama", "lmstudio"].includes(provider) ? provider : "anthropic";
  const keys = [`ai.baseURL.${p}`, `ai.model.${p}`, `ai.discovered.${p}`, "ai.systemPrompt", "ai.maxTokens", "ai.temperature", "ai.timeoutSec"];
  // 2.1: Anthropic's refusal fallback is that provider's own switch (ledger AI-205).
  return p === "anthropic" ? [...keys, "ai.fallback.anthropic"] : keys;
}

/** The keys a pane's Reset writes (the `reset*()` helpers): `resetFiniteLP` also resets the
 * row-less `flp.askBeforeRun` (ledger SET-034). */
export function resetWrites(pane: PaneId, provider: string): string[] {
  const keys = resetKeys(pane, provider);
  return pane === "Finite-Buffer LP" ? [...keys, "flp.askBeforeRun"] : keys;
}

const anchorByKey = (() => {
  const map = new Map<string, string>();
  for (const e of ENTRIES) for (const k of entryKeys(e)) if (!map.has(k)) map.set(k, e.id);
  for (const e of ENTRIES) if (entryKeys(e).includes(e.id)) map.set(e.id, e.id);
  return map;
})();

/** The row that shows a stored key (the one Reset flashes), if any. */
export function anchorForKey(key: string): string | undefined {
  return anchorByKey.get(key);
}

/** "SRBM MLMC ▸ Path length T" for a stored key, or the key when no row edits it. */
export function displayName(key: string): string {
  const id = anchorByKey.get(key);
  const e = id ? entry(id) : undefined;
  return e ? `${paneInfo(e.pane).title} ▸ ${entryTitle(e)}` : key;
}

/** `displayName` for every stored key a row edits (sent with an import, for its report). */
export function displayNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of anchorByKey.keys()) out[k] = displayName(k);
  return out;
}
