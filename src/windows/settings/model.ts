// What Reset to Defaults and the sidebar's "differs" dot compare: 0.90.34's
// `AppSettings.isStoredAtDefault` (a value equals its default, numbers by value) over
// `SettingsRegistry.resetKeys(for:)`.
import type { KvValues, SettingSchemaKey } from "../../lib/types";
import { PANES, resetKeys, resetWrites, type PaneId } from "./registry";

export type Schema = Map<string, SettingSchemaKey>;

/** `storageSignature` equality: numbers by value, everything else as is. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return a === b;
}

export function isAtDefault(key: string, values: KvValues, schema: Schema): boolean {
  const k = schema.get(key);
  if (!k) return true;
  return sameValue(key in values ? values[key] : k.default, k.default);
}

function provider(values: KvValues): string {
  return typeof values["ai.provider"] === "string" ? (values["ai.provider"] as string) : "anthropic";
}

/** Every key the pane's Reset would touch already holds its default. */
export function paneAtDefault(pane: PaneId, values: KvValues, schema: Schema): boolean {
  return resetKeys(pane, provider(values)).every((k) => isAtDefault(k, values, schema));
}

/** The panes that differ from their defaults, in sidebar order. */
export function dirtyPanes(values: KvValues, schema: Schema): PaneId[] {
  if (!schema.size) return [];
  return PANES.filter((p) => !paneAtDefault(p.id, values, schema)).map((p) => p.id);
}

/** The patch a pane's Reset applies: each of its keys back to its default (`null` removes). */
export function resetPatch(pane: PaneId, values: KvValues): KvValues {
  return Object.fromEntries(resetWrites(pane, provider(values)).map((k) => [k, null]));
}

/** The keys of the pane's Reset whose values a reset changes. */
export function changedByReset(pane: PaneId, values: KvValues, schema: Schema): string[] {
  return resetWrites(pane, provider(values)).filter((k) => !isAtDefault(k, values, schema));
}

/** Reset All Settings: every pane's reset (`resetAll`), which never touches pane visibility, the
 * maximized or detached panes, `results.autoShown`, the provider, the Keychain or `gcdg.enabled`. */
export function resetAllPatch(values: KvValues): KvValues {
  return Object.assign({}, ...PANES.map((p) => resetPatch(p.id, values)));
}
