// Settings in the browser preview: the schema, and Export… / Import… (src-tauri/src/settings_io.rs)
// against an in-memory folder. The preview's Open and Save panels are the files area's
// (`plugin:dialog|open` / `save` in files.ts, a prompt for the path); a test installs its own.
import type { KvValues } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";
import { previewCores, previewSettings, rejection, SETTINGS_DEFAULTS, SETTINGS_RULES } from "./kv";

/** Files Export… wrote and Import… reads, path → text. Tests put a file here to import it. */
export const settingsFiles = new Map<string, string>();

const METADATA = ["qnet.settingsFormat", "qnet.exportedAt", "qnet.appVersion"];
const baseName = (p: string) => p.split("/").pop() ?? p;

/** settings_io.rs `export_text`, near enough for the preview (JSONSerialization's shape). */
export function previewExportText(values: KvValues, version: string, at: string): string {
  const all: KvValues = { ...values, "qnet.settingsFormat": 1, "qnet.exportedAt": at, "qnet.appVersion": version };
  const keys = Object.keys(all).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = keys.map((k) => `  ${JSON.stringify(k)} : ${JSON.stringify(all[k]).replace(/\//g, "\\/")}`);
  return `{\n${lines.join(",\n")}\n}`;
}

interface Refusal {
  key: string;
  reason: string;
  name: string;
}

/** settings_io.rs `plan_import` and `report_text`. */
function importText(text: string, names: Record<string, string>, fileName: string) {
  let dict: unknown;
  try {
    dict = JSON.parse(text);
  } catch {
    throw { kind: "invalid", message: "Could not import: The data couldn’t be read because it isn’t in the correct format." };
  }
  if (!dict || typeof dict !== "object" || Array.isArray(dict)) {
    throw { kind: "invalid", message: "Could not import: The file is not a Qnet settings export (expected a JSON object of setting keys)." };
  }
  const d = dict as KvValues;
  const format = d["qnet.settingsFormat"];
  if (typeof format === "number" && Math.trunc(format) > 1) {
    const writer = typeof d["qnet.appVersion"] === "string" ? ` by Qnet ${d["qnet.appVersion"]}` : "";
    throw { kind: "invalid", message: `Could not import: The file uses settings format ${Math.trunc(format)} (written${writer}); this build reads format 1 or older. Update Qnet to import it.` };
  }
  const current = previewSettings.get();
  const applied: string[] = [];
  const unchanged: string[] = [];
  const rejected: Refusal[] = [];
  const patch: KvValues = {};
  for (const key of Object.keys(d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (METADATA.includes(key)) continue;
    const why = rejection(key, d[key]);
    if (why) {
      rejected.push({ key, reason: why, name: names[key] ?? key });
      continue;
    }
    const stored = SETTINGS_RULES[key].kind === "int" ? Math.trunc(d[key] as number) : d[key];
    if (current[key] === stored) {
      unchanged.push(key);
      continue;
    }
    patch[key] = stored;
    applied.push(key);
  }
  if (applied.length) previewSettings.patch(patch);
  let message = `Imported ${fileName}: ${applied.length} ${applied.length === 1 ? "setting" : "settings"} changed`;
  if (unchanged.length) message += `, ${unchanged.length} already matched`;
  let status: "success" | "info" | "failure" = "success";
  if (!rejected.length) message += ".";
  else {
    message += rejected.length <= 4
      ? `; ${rejected.length} refused and left unchanged: ${rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}.`
      : `; ${rejected.length} refused and left unchanged.`;
    status = applied.length ? "info" : "failure";
  }
  return { applied, unchanged, rejected, message, status };
}

export function settingsHandlers(): MockHandlers {
  return {
    settings_schema_get: () =>
      Object.entries(SETTINGS_RULES).map(([name, r]) => ({
        name,
        kind: r.kind,
        default: SETTINGS_DEFAULTS[name],
        range: r.range ? [r.range[0], r.range[1] === "cores" ? previewCores() : r.range[1]] : null,
        allowedNumbers: r.choices ?? [],
        allowedStrings: r.strings ?? [],
      })),
    settings_export: ({ path }: { path: string }) => {
      const version = "2.1.2 (preview)";
      settingsFiles.set(path, previewExportText(previewSettings.get(), version, new Date().toISOString().replace(/\.\d+Z$/, "Z")));
      const count = Object.keys(SETTINGS_DEFAULTS).length;
      return { message: `Exported ${count} settings to ${baseName(path)} (tagged Qnet ${version}).`, count };
    },
    settings_import: ({ path, names }: { path: string; names?: Record<string, string> }) => {
      const text = settingsFiles.get(path);
      if (text === undefined) throw { kind: "failed", message: `Could not import: The file “${baseName(path)}” couldn’t be opened because there is no such file.` };
      return importText(text, names ?? {}, baseName(path));
    },
  };
}
