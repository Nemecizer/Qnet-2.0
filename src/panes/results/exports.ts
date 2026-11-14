// The Results workspace's exports (0.90.34 `ResultsExport.save`, `copyCSV`; ledger RES-081…088,
// FILE-042…045): the text is Rust's (src-tauri/src/results_export.rs, from the store's records
// by id), the save panel the dialog plugin's, and a write error an alert as `NSAlert(error:)`.
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { report } from "../../lib/dialogs";
import { writeClipboard } from "../status/state";
import { resultsWords as w } from "./words";

export type ExportFormat = "csv" | "json";

/** Copy Selected Run as CSV: the same CSV text on the clipboard. */
export async function copyCsv(ids: string[], currentFingerprint: string | null, win?: Window): Promise<void> {
  if (!ids.length) return;
  const text = await api.resultsExportText(ids, "csv", currentFingerprint);
  await writeClipboard(text, win);
}

/** Save … as CSV/JSON…: asks where (qnet-result(s).csv/.json), then writes; a failure is an alert. */
export async function saveExport(ids: string[], format: ExportFormat, currentFingerprint: string | null, target?: Document): Promise<string | null> {
  if (!ids.length) return null;
  const path = await save({
    defaultPath: w.fileName(format, ids.length),
    filters: [format === "csv" ? { name: w.csvFilter, extensions: ["csv"] } : { name: w.jsonFilter, extensions: ["json"] }],
    canCreateDirectories: true,
  });
  if (!path) return null;
  try {
    return await api.resultsExportSave(path, ids, format, currentFingerprint);
  } catch (e) {
    const err = e as { message?: string; detail?: string };
    await report({ title: err?.message ?? String(e), details: err?.detail, target });
    return null;
  }
}
