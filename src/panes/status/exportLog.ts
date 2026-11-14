// Save Status Log… — the one implementation behind the pane's Export menu (the visible entries)
// and File ▸ Export ▸ Status Log… (the whole log): 0.90.34 StatusLogExport.swift, ledger
// LOG-022…024, FILE-046…048. The dialog plugin's save panel asks where; Rust writes the file.
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../../lib/api";
import { tabById, type StatusEntry, type Tab } from "../../workspace/store";
import { statusLogFileText } from "./entries";
import { logStatus } from "./state";
import { statusWords as w } from "./words";

/** `<network>-status.txt` from the file name without its last extension, or `Untitled-status.txt` (`defaultFileName`). */
export function defaultStatusFileName(tab: Pick<Tab, "path">): string {
  if (!tab.path) return "Untitled-status.txt";
  const file = tab.path.split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  return `${base || "Untitled"}-status.txt`;
}

/** Where the panel starts: the document's folder with the suggested name, or the name alone. */
export function defaultStatusPath(tab: Pick<Tab, "path">): string {
  const name = defaultStatusFileName(tab);
  if (!tab.path) return name;
  const dir = tab.path.slice(0, tab.path.lastIndexOf("/"));
  return dir ? `${dir}/${name}` : name;
}

/** Asks where and writes `entries` (default: the tab's whole log); reports the outcome in the log. */
export async function saveStatusLog(tabId: string, entries?: StatusEntry[]): Promise<void> {
  const tab = tabById(tabId);
  if (!tab) return;
  const items = entries ?? tab.log;
  if (!items.length) {
    logStatus(tabId, w.nothingToSave, "warning");
    return;
  }
  const path = await save({
    title: w.savePanelTitle,
    defaultPath: defaultStatusPath(tab),
    filters: [{ name: w.plainText, extensions: ["txt"] }],
    canCreateDirectories: true,
  });
  if (!path) return;
  try {
    const shown = await api.statusLogWrite(path, statusLogFileText(items));
    logStatus(tabId, w.saved(items.length, shown), "success");
  } catch (e) {
    logStatus(tabId, w.couldNotSave(e instanceof Error ? e.message : String(e)), "error");
  }
}
