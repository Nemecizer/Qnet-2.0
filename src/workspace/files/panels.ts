// The Open and Save panels (0.90.34's NSOpenPanel / NSSavePanel), through Tauri's dialog plugin.
// While one is up the workspace counts as modal (MENU-198), as the app-modal panel was.
//
// What the plugin can't set, and 2.0 therefore leaves out: the Save panel's prompt ("Export"),
// `allowsOtherFileTypes`, and an Open panel's message (Open Example's "could not be found" note,
// Export All's folder note), so those words go to the Status log instead (ledger Changed rows).
import { open, save, type DialogFilter } from "@tauri-apps/plugin-dialog";
import { holdModal } from "../../lib/overlays";
import { fileWords } from "./words";

export const BNET_FILTER: DialogFilter = { name: fileWords.networkFilter, extensions: ["bnet"] };

async function held<T>(run: () => Promise<T>): Promise<T> {
  const release = holdModal();
  try {
    return await run();
  } finally {
    release();
  }
}

const one = (r: unknown): string | null => (typeof r === "string" ? r : Array.isArray(r) && typeof r[0] === "string" ? r[0] : null);

/** One .bnet file (Open Network, Open Example): its path, or null when cancelled. */
export function chooseNetwork(title: string, folder?: string | null): Promise<string | null> {
  return held(async () => one(await open({ title, filters: [BNET_FILTER], multiple: false, directory: false, ...(folder ? { defaultPath: folder } : {}) })));
}

/** One folder, which may be created in the panel (Export All Solver Inputs). */
export function chooseFolder(title: string, folder?: string | null): Promise<string | null> {
  return held(async () => one(await open({ title, directory: true, multiple: false, canCreateDirectories: true, ...(folder ? { defaultPath: folder } : {}) })));
}

/** A Save panel offering `defaultPath` (a name, or a name in a folder) with `filters`. */
export function chooseSaveTarget(title: string, defaultPath: string, filters: DialogFilter[]): Promise<string | null> {
  return held(async () => one(await save({ title, defaultPath, filters, canCreateDirectories: true })));
}

/** 0.90.34 `configureExportPanel`'s types: the extension's own, and plain text. */
export function exportFilters(ext: string): DialogFilter[] {
  const own: DialogFilter = { name: `.${ext}`, extensions: [ext] };
  return ext === "txt" ? [{ name: fileWords.plainTextFilter, extensions: ["txt"] }] : [own, { name: fileWords.plainTextFilter, extensions: ["txt"] }];
}
