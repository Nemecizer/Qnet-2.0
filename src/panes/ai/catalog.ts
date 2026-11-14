// The models Settings ▸ AI Assistant offers for the two cloud providers without a key or a
// refresh (new in 2.1, ledger AI-207…AI-209): a curated, dated list, newest and most useful
// first, merged with the live list when Refresh has fetched one. The live list wins (only the
// models the account can use are listed then, unknown ones included); the curated list gives
// them their short labels and marks the deprecated ones. Free text in the Model field still goes.
//
// Sources, read 2026-11-13: platform.claude.com/docs/en/about-claude/models/overview (and the
// deprecations page it links) for Anthropic; developers.openai.com/api/docs/models for OpenAI.
// Update CATALOG_DATE with the lists.
import type { AiProvider } from "../../lib/types";

export const CATALOG_DATE = "November 2026";

export interface CatalogModel {
  id: string;
  /** The picker's line: the model's name and, for a few, why to pick it. */
  label: string;
  /** current: the provider's present line-up; older: still served; deprecated: still served, retiring. */
  status: "current" | "older" | "deprecated";
  /** For a deprecated model: when it retires and what replaces it. */
  retires?: string;
  replacement?: string;
}

const ANTHROPIC: CatalogModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — recommended", status: "current" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2 — most capable", status: "current" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — faster, lower cost", status: "current" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 — fastest, lowest cost", status: "current" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", status: "older" },
  { id: "claude-fable-5", label: "Claude Fable 5", status: "older" },
  { id: "claude-opus-5", label: "Claude Opus 5", status: "older" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", status: "older" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", status: "older" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", status: "older" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", status: "older" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", status: "older" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", status: "older" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", status: "older" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", status: "deprecated", retires: "30 November 2026", replacement: "claude-sonnet-5-5" },
];

const OPENAI: CatalogModel[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra — most capable", status: "current" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol — near-Astra, lower cost", status: "current" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra — fast and efficient", status: "current" },
  { id: "gpt-6-luna", label: "GPT-6 Luna — most efficient", status: "current" },
];

export const CATALOG: Partial<Record<AiProvider, CatalogModel[]>> = { anthropic: ANTHROPIC, openai: OPENAI };

/** The default model of a cloud provider (settings_schema.rs `ai.model.<provider>`). */
export const CATALOG_DEFAULT: Partial<Record<AiProvider, string>> = { anthropic: "claude-opus-5-5", openai: "gpt-6-astra" };

/** Display names Refresh brought back this session (Anthropic's `display_name`); not stored. */
const liveNames = new Map<string, string>();
export function rememberNames(models: { id: string; displayName?: string }[]) {
  for (const m of models) if (m.displayName) liveNames.set(m.id, m.displayName);
}

export const catalogEntry = (provider: AiProvider, id: string) => CATALOG[provider]?.find((m) => m.id === id);

export interface PickerWords {
  current: string;
  older: string;
  account: string;
  deprecated: (label: string) => string;
}

export interface PickerSection {
  title?: string;
  items: { label: string; value: string }[];
}

/**
 * The Model menu's sections for a cloud provider: with a live list, one section of the account's
 * models in the catalog's order, then the unknown ones by id; without one, the built-in list.
 */
export function pickerSections(provider: AiProvider, discovered: string[], words: PickerWords): PickerSection[] {
  const catalog = CATALOG[provider] ?? [];
  const label = (id: string) => {
    const known = catalog.find((m) => m.id === id);
    const base = known?.label ?? liveNames.get(id) ?? id;
    const named = !known && liveNames.has(id) ? `${base} (${id})` : base;
    return known?.status === "deprecated" ? words.deprecated(named) : named;
  };
  if (discovered.length) {
    const rank = (id: string) => {
      const i = catalog.findIndex((m) => m.id === id);
      return i < 0 ? catalog.length : i;
    };
    const live = [...new Set(discovered)].sort((a, b) => rank(a) - rank(b) || (rank(a) === catalog.length ? a.localeCompare(b) : 0));
    return [{ title: words.account, items: live.map((id) => ({ label: label(id), value: id })) }];
  }
  const current = catalog.filter((m) => m.status === "current");
  const older = catalog.filter((m) => m.status !== "current");
  return [
    { title: words.current, items: current.map((m) => ({ label: label(m.id), value: m.id })) },
    ...(older.length ? [{ title: words.older, items: older.map((m) => ({ label: label(m.id), value: m.id })) }] : []),
  ];
}

/** Retired Claude ids: answered with an error by Anthropic's API. Replaced by the current model of their line. */
const RETIRED_EXACT = ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-opus-4-1-20250805", "claude-opus-4-1", "claude-opus-4-0", "claude-sonnet-4-0"];

/**
 * For a stored model that Anthropic has retired, or deprecated: the note's facts. Nothing is
 * changed for the person: the note only suggests (ledger AI-209).
 */
export function modelAdvice(provider: AiProvider, id: string): { kind: "retired" | "deprecated"; replacement: string; retires?: string } | null {
  if (provider !== "anthropic") return null;
  const model = id.trim();
  const entry = catalogEntry(provider, model);
  if (entry?.status === "deprecated") return { kind: "deprecated", replacement: entry.replacement ?? CATALOG_DEFAULT.anthropic!, retires: entry.retires };
  const retired = RETIRED_EXACT.includes(model) || /^claude-(instant|2|3)([.-]|$)/.test(model);
  if (!retired) return null;
  const replacement = /haiku/.test(model) ? "claude-haiku-5-5" : /sonnet/.test(model) ? "claude-sonnet-5-5" : "claude-opus-5-5";
  return { kind: "retired", replacement };
}
