// settings.json and state.json in the browser preview: kept in memory, with the same checks as
// src-tauri/src/kv.rs and settings_schema.rs, and the same `kv://changed` event.
//
// SETTINGS_DEFAULTS and SETTINGS_RULES mirror settings_schema.rs `KEYS` (0.90.34's
// `defaultsByKey`, `rangesByKey`, `allowedNumbersByKey`, `allowedStringsByKey`) key for key, in its
// order; `settings_schema::tests::the_preview_mock_mirrors_the_schema` reads this file and fails
// when they differ. Keep one key per line, each value written as JSON.
import { emit } from "@tauri-apps/api/event";
import type { KvValues } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";

/** The defaults of src-tauri/src/settings_schema.rs `KEYS`, in the same order. */
export const SETTINGS_DEFAULTS: KvValues = {
  "engine.regenerative": 0,
  "engine.qbd": 0,
  "engine.ctmc": 0,
  "sim.replications": 50,
  "sim.warmup": 1000000,
  "sim.time": 5000000,
  "sim.parallel": 0,
  "sim.blocking": 2,
  "sim.seedFixed": false,
  "sim.seed": 12345,
  "fem.solver": 0,
  "fem.meshSize": 10,
  "sm.degree": 8,
  "sm.legendre": false,
  "mlmc.epsilon": 0.01,
  "mlmc.gamma": 0.05,
  "mlmc.overrideT": false,
  "mlmc.T": 10,
  "mlmc.overrideL": false,
  "mlmc.L": 3,
  "mlmc.overrideN": false,
  "mlmc.N": 25000,
  "mlmc.backend": 0,
  "mlmc.threads": 0,
  "mlmc.seedFixed": false,
  "mlmc.seed": 12345,
  "mlmc.antithetic": false,
  "mlmc.adaptive": false,
  "mlmc.batchSize": 1000,
  "mlmc.minSamples": 5000,
  "mlmc.maxSamples": 200000,
  "mlmc.replications": 1,
  "lp.gridN": 0,
  "lp.basisM": 0,
  "lp.solver": 0,
  "lp.gridType": 0,
  "lp.smoothness": 0,
  "lp.basisNormalize": false,
  "lp.askBeforeRun": false,
  "lp.multiLevel": false,
  "flp.gridN": 0,
  "flp.basisM": 0,
  "flp.solver": 0,
  "flp.gridType": 0,
  "flp.basisNormalize": false,
  "flp.askBeforeRun": false,
  "testset.inf.stationsLo": 3,
  "testset.inf.stationsHi": 6,
  "testset.inf.classesLo": 1,
  "testset.inf.classesHi": 3,
  "testset.inf.rhoLo": 0.5,
  "testset.inf.rhoHi": 0.85,
  "testset.inf.numCases": 20,
  "testset.inf.topology": 0,
  "testset.fin.stationsLo": 2,
  "testset.fin.stationsHi": 4,
  "testset.fin.classesLo": 1,
  "testset.fin.classesHi": 2,
  "testset.fin.rhoLo": 0.5,
  "testset.fin.rhoHi": 0.85,
  "testset.fin.numCases": 10,
  "testset.fin.topology": 0,
  "testset.spc.stationsLo": 3,
  "testset.spc.stationsHi": 6,
  "testset.spc.classesLo": 1,
  "testset.spc.classesHi": 3,
  "testset.spc.rhoStart": 0.5,
  "testset.spc.rhoEnd": 0.95,
  "testset.spc.rhoStep": 0.05,
  "testset.spc.numCases": 10,
  "testset.spc.topology": 0,
  "tabs.restoreBehavior": 0,
  "runCompare.remember": false,
  "gcdg.enabled": false,
  "shell.fontSize": 12,
  "shell.fontName": "",
  "shell.classicTheme": false,
  "palette.paneVisible": true,
  "status.paneVisible": true,
  "results.paneVisible": false,
  "shell.paneVisible": true,
  "inspector.paneVisible": true,
  "results.autoShown": false,
  "panes.soloed": "",
  "panes.detached": "",
  "status.fontSize": 12,
  "output.decimals": 6,
  "help.outputDestination": 2,
  "ai.provider": "anthropic",
  "ai.systemPrompt": "You are an assistant embedded in BNET, a tool for Brownian Network analysis of queueing systems. Answer concisely.",
  "ai.maxTokens": 4096,
  "ai.temperature": 0.7,
  "ai.timeoutSec": 60,
  "ai.paneVisible": false,
  "ai.fontSize": 12,
  "ai.fontName": "",
  "ai.baseURL.anthropic": "https://api.anthropic.com",
  "ai.model.anthropic": "claude-opus-5-5",
  "ai.discovered.anthropic": "",
  "ai.baseURL.openai": "https://api.openai.com/v1",
  "ai.model.openai": "gpt-6-astra",
  "ai.discovered.openai": "",
  "ai.baseURL.ollama": "http://localhost:11434",
  "ai.model.ollama": "llama3.2",
  "ai.discovered.ollama": "",
  "ai.baseURL.lmstudio": "http://localhost:1234/v1",
  "ai.model.lmstudio": "local-model",
  "ai.discovered.lmstudio": "",
  "welcome.showAtLaunch": true,
  "updates.auto": true,
  "ai.fallback.anthropic": true,
};

/** What a key takes: settings_schema.rs `Key` (range `[0, "cores"]` is 0…the logical core count). */
export interface SettingRule {
  kind: "bool" | "int" | "double" | "text";
  range?: [number, number | "cores"];
  choices?: number[];
  strings?: string[];
}

/** The kinds, ranges and choices of src-tauri/src/settings_schema.rs `KEYS`, in the same order. */
export const SETTINGS_RULES: Record<string, SettingRule> = {
  "engine.regenerative": { "kind": "int", "choices": [0, 1] },
  "engine.qbd": { "kind": "int", "choices": [0, 1] },
  "engine.ctmc": { "kind": "int", "choices": [0, 1] },
  "sim.replications": { "kind": "int", "range": [1, 10000] },
  "sim.warmup": { "kind": "int", "range": [0, 1000000000] },
  "sim.time": { "kind": "int", "range": [1, 1000000000] },
  "sim.parallel": { "kind": "int", "choices": [0, 1, 2] },
  "sim.blocking": { "kind": "int", "choices": [0, 1, 2] },
  "sim.seedFixed": { "kind": "bool" },
  "sim.seed": { "kind": "int", "range": [0, 2147483647] },
  "fem.solver": { "kind": "int", "choices": [0, 1] },
  "fem.meshSize": { "kind": "int", "range": [2, 20] },
  "sm.degree": { "kind": "int", "range": [2, 30] },
  "sm.legendre": { "kind": "bool" },
  "mlmc.epsilon": { "kind": "double", "range": [0.0001, 1] },
  "mlmc.gamma": { "kind": "double", "choices": [0.01, 0.05, 0.1, 0.25, 0.5] },
  "mlmc.overrideT": { "kind": "bool" },
  "mlmc.T": { "kind": "double", "range": [0.01, 10000] },
  "mlmc.overrideL": { "kind": "bool" },
  "mlmc.L": { "kind": "int", "range": [1, 20] },
  "mlmc.overrideN": { "kind": "bool" },
  "mlmc.N": { "kind": "int", "range": [100, 100000000] },
  "mlmc.backend": { "kind": "int", "choices": [0, 1, 2, 3] },
  "mlmc.threads": { "kind": "int", "range": [0, "cores"] },
  "mlmc.seedFixed": { "kind": "bool" },
  "mlmc.seed": { "kind": "int", "range": [0, 2147483647] },
  "mlmc.antithetic": { "kind": "bool" },
  "mlmc.adaptive": { "kind": "bool" },
  "mlmc.batchSize": { "kind": "int", "range": [1, 10000000] },
  "mlmc.minSamples": { "kind": "int", "range": [2, 100000000] },
  "mlmc.maxSamples": { "kind": "int", "range": [2, 100000000] },
  "mlmc.replications": { "kind": "int", "range": [1, 1000] },
  "lp.gridN": { "kind": "int", "range": [0, 1000] },
  "lp.basisM": { "kind": "int", "range": [0, 64] },
  "lp.solver": { "kind": "int", "choices": [0, 1, 2, 3] },
  "lp.gridType": { "kind": "int", "choices": [0, 1, 2] },
  "lp.smoothness": { "kind": "double", "range": [0, 1] },
  "lp.basisNormalize": { "kind": "bool" },
  "lp.askBeforeRun": { "kind": "bool" },
  "lp.multiLevel": { "kind": "bool" },
  "flp.gridN": { "kind": "int", "range": [0, 1000] },
  "flp.basisM": { "kind": "int", "range": [0, 64] },
  "flp.solver": { "kind": "int", "choices": [0, 1, 2] },
  "flp.gridType": { "kind": "int", "choices": [0, 1] },
  "flp.basisNormalize": { "kind": "bool" },
  "flp.askBeforeRun": { "kind": "bool" },
  "testset.inf.stationsLo": { "kind": "int", "range": [1, 12] },
  "testset.inf.stationsHi": { "kind": "int", "range": [1, 12] },
  "testset.inf.classesLo": { "kind": "int", "range": [1, 8] },
  "testset.inf.classesHi": { "kind": "int", "range": [1, 8] },
  "testset.inf.rhoLo": { "kind": "double", "range": [0.01, 0.99] },
  "testset.inf.rhoHi": { "kind": "double", "range": [0.01, 0.99] },
  "testset.inf.numCases": { "kind": "int", "range": [1, 1000] },
  "testset.inf.topology": { "kind": "int", "choices": [0, 1, 2, 3] },
  "testset.fin.stationsLo": { "kind": "int", "range": [1, 12] },
  "testset.fin.stationsHi": { "kind": "int", "range": [1, 12] },
  "testset.fin.classesLo": { "kind": "int", "range": [1, 8] },
  "testset.fin.classesHi": { "kind": "int", "range": [1, 8] },
  "testset.fin.rhoLo": { "kind": "double", "range": [0.01, 0.99] },
  "testset.fin.rhoHi": { "kind": "double", "range": [0.01, 0.99] },
  "testset.fin.numCases": { "kind": "int", "range": [1, 1000] },
  "testset.fin.topology": { "kind": "int", "choices": [0, 1, 2, 3] },
  "testset.spc.stationsLo": { "kind": "int", "range": [1, 12] },
  "testset.spc.stationsHi": { "kind": "int", "range": [1, 12] },
  "testset.spc.classesLo": { "kind": "int", "range": [1, 8] },
  "testset.spc.classesHi": { "kind": "int", "range": [1, 8] },
  "testset.spc.rhoStart": { "kind": "double", "range": [0.01, 0.99] },
  "testset.spc.rhoEnd": { "kind": "double", "range": [0.01, 0.99] },
  "testset.spc.rhoStep": { "kind": "double", "range": [0.01, 0.5] },
  "testset.spc.numCases": { "kind": "int", "range": [1, 1000] },
  "testset.spc.topology": { "kind": "int", "choices": [0, 1, 2, 3] },
  "tabs.restoreBehavior": { "kind": "int", "choices": [0, 1, 2] },
  "runCompare.remember": { "kind": "bool" },
  "gcdg.enabled": { "kind": "bool" },
  "shell.fontSize": { "kind": "double", "range": [8, 28] },
  "shell.fontName": { "kind": "text" },
  "shell.classicTheme": { "kind": "bool" },
  "palette.paneVisible": { "kind": "bool" },
  "status.paneVisible": { "kind": "bool" },
  "results.paneVisible": { "kind": "bool" },
  "shell.paneVisible": { "kind": "bool" },
  "inspector.paneVisible": { "kind": "bool" },
  "results.autoShown": { "kind": "bool" },
  "panes.soloed": { "kind": "text", "strings": ["", "palette", "canvas", "status", "results", "shell", "ai", "inspector"] },
  "panes.detached": { "kind": "text" },
  "status.fontSize": { "kind": "double", "range": [8, 28] },
  "output.decimals": { "kind": "int", "range": [0, 6] },
  "help.outputDestination": { "kind": "int", "choices": [0, 1, 2] },
  "ai.provider": { "kind": "text", "strings": ["anthropic", "openai", "ollama", "lmstudio"] },
  "ai.systemPrompt": { "kind": "text" },
  "ai.maxTokens": { "kind": "int", "range": [1, 200000] },
  "ai.temperature": { "kind": "double", "range": [0, 2] },
  "ai.timeoutSec": { "kind": "double", "range": [1, 600] },
  "ai.paneVisible": { "kind": "bool" },
  "ai.fontSize": { "kind": "double", "range": [8, 28] },
  "ai.fontName": { "kind": "text" },
  "ai.baseURL.anthropic": { "kind": "text" },
  "ai.model.anthropic": { "kind": "text" },
  "ai.discovered.anthropic": { "kind": "text" },
  "ai.baseURL.openai": { "kind": "text" },
  "ai.model.openai": { "kind": "text" },
  "ai.discovered.openai": { "kind": "text" },
  "ai.baseURL.ollama": { "kind": "text" },
  "ai.model.ollama": { "kind": "text" },
  "ai.discovered.ollama": { "kind": "text" },
  "ai.baseURL.lmstudio": { "kind": "text" },
  "ai.model.lmstudio": { "kind": "text" },
  "ai.discovered.lmstudio": { "kind": "text" },
  "welcome.showAtLaunch": { "kind": "bool" },
  "updates.auto": { "kind": "bool" },
  "ai.fallback.anthropic": { "kind": "bool" },
};

/** The preview's logical core count (`mlmc.threads`' upper bound). */
export function previewCores(): number {
  return Math.max(1, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1);
}

/** settings_schema.rs `sig4`: four significant digits, en-US grouping. */
export function sig4(v: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? "—" : "∞";
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  const decimals = Math.max(0, 3 - e);
  const rounded = e > 3 ? Math.round(v / 10 ** (e - 3)) * 10 ** (e - 3) : v;
  let s = rounded.toFixed(decimals);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  const [whole, frac] = s.split(".");
  const neg = whole.startsWith("-");
  const digits = neg ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

function rangeOf(rule: SettingRule): [number, number] | null {
  if (!rule.range) return null;
  const [lo, hi] = rule.range;
  return [lo, hi === "cores" ? previewCores() : hi];
}

/** settings_schema.rs `rejection`: 0.90.34's import reason, or null. */
export function rejection(key: string, value: unknown): string | null {
  const rule = SETTINGS_RULES[key];
  if (!rule) return "not a Qnet setting";
  if (rule.kind === "bool") return typeof value === "boolean" ? null : "expected true or false";
  if (rule.kind === "text") {
    if (typeof value !== "string") return "expected text";
    if (rule.strings && !rule.strings.includes(value)) return `not one of ${rule.strings.join(", ")}`;
    return null;
  }
  if (typeof value !== "number") return rule.kind === "int" ? "expected a whole number" : "expected a number";
  if (!Number.isFinite(value)) return "expected a finite number";
  if (rule.kind === "int" && Math.round(value) !== value) return "expected a whole number";
  if (rule.choices) return rule.choices.some((c) => Math.abs(c - value) <= 1e-9) ? null : `not one of ${rule.choices.map(sig4).join(", ")}`;
  const r = rangeOf(rule);
  if (r && (value < r[0] || value > r[1])) return `outside ${sig4(r[0])}…${sig4(r[1])}`;
  return null;
}

/** settings_schema.rs `validate`: the sentence a refused patch shows, or null. */
export function check(key: string, value: unknown): string | null {
  const why = rejection(key, value);
  if (!why) return null;
  if (why === "not a Qnet setting") return `There's no setting called “${key}”.`;
  if (why.startsWith("expected ")) return `The setting “${key}” takes ${why.slice("expected ".length)}.`;
  if (why.startsWith("outside ")) {
    const r = rangeOf(SETTINGS_RULES[key])!;
    return `The setting “${key}” takes a value from ${sig4(r[0])} to ${sig4(r[1])}.`;
  }
  return typeof value === "string" ? `The setting “${key}” doesn't take “${value}”.` : `The setting “${key}” doesn't take ${JSON.stringify(value)}.`;
}

/** The preview's settings store, for the other mock files (settings.ts: export and import). */
export const previewSettings: { get: () => KvValues; patch: (patch: KvValues) => KvValues } = {
  get: () => ({ ...SETTINGS_DEFAULTS }),
  patch: () => ({ ...SETTINGS_DEFAULTS }),
};

export function kvHandlers(opts: { settings?: KvValues; state?: KvValues } = {}): MockHandlers {
  let settings: KvValues = { ...(opts.settings ?? {}) };
  let state: KvValues = { ...(opts.state ?? {}) };
  const full = () => ({ ...SETTINGS_DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([k]) => k in SETTINGS_DEFAULTS)) });
  const patchInto = (into: KvValues, patch: KvValues) => {
    const next = { ...into };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    return next;
  };
  const settingsPatch = (patch: KvValues) => {
    for (const [k, v] of Object.entries(patch)) {
      const why = v === null ? null : check(k, v);
      if (why) throw { kind: "invalid", message: why };
    }
    settings = patchInto(settings, patch);
    void emit("kv://changed", { store: "settings", patch });
    return full();
  };
  previewSettings.get = full;
  previewSettings.patch = settingsPatch;
  return {
    settings_get: () => full(),
    settings_patch: ({ patch }: { patch: KvValues }) => settingsPatch(patch),
    state_get: () => state,
    state_patch: ({ patch }: { patch: KvValues }) => {
      state = patchInto(state, patch);
      void emit("kv://changed", { store: "state", patch });
      return state;
    },
  };
}
