// File ▸ Export's solver inputs (ledger EXP-108…115, MENU-024…028): 0.90.34's `exportNetwork`,
// `exportQNA`, `SRBMExportSheet.performExport` and `exportAllSolverInputs`. Rust's exporters
// write every byte (src-tauri/src/files.rs over core/src/export); this side picks the file.
import { api } from "../../lib/api";
import { report } from "../../lib/dialogs";
import { activeTab, addStatus, type Tab } from "../store";
import { reasonOf } from "./documents";
import { chooseFolder, chooseSaveTarget, exportFilters } from "./panels";
import { dirName, exportBaseName, inFolder, stem } from "./paths";
import { reportBlocked } from "./status";
import { BLOCKING_CONVENTIONS, fileWords as w, type BlockingConventionId } from "./words";

/** fBNAsim's `# Generated:` line: the time in the Mac's short date and medium time style. */
export function generatedNow(date = new Date()): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/** The document's folder, where every export panel starts (EXP-108). */
const folderOf = (tab: Tab) => (tab.path ? dirName(tab.path) : null);

/** A network to export: at least one node (0.90.34's `hasNetwork`). */
export function hasNetwork(tab: Tab = activeTab()): boolean {
  return tab.document.nodes.length > 0;
}

const SINGLE = {
  fbnasim: { ext: "txt", title: w.fbnasimPanelTitle, done: w.exportedNetwork, failed: w.exportFailed, writeFailed: w.exportWriteFailed },
  qna: { ext: "qna", title: w.qnaPanelTitle, done: w.exportedQna, failed: w.qnaExportFailed, writeFailed: w.qnaExportWriteFailed },
} as const;

/**
 * Export ▸ Finite Simulator Input (fBNAsim)… and QNA Input (.qna)… (EXP-109, EXP-110): the text
 * first (a refusal goes to the Status log, no panel), then the panel, then the write.
 */
export async function exportSingle(format: keyof typeof SINGLE): Promise<boolean> {
  const tab = activeTab();
  const spec = SINGLE[format];
  let text: string;
  try {
    text = await api.exportText(format, tab.document, { generated: generatedNow() });
  } catch (e) {
    reportBlocked(spec.failed(reasonOf(e).message), { tabId: tab.id });
    return false;
  }
  const path = await chooseSaveTarget(spec.title, inFolder(folderOf(tab), `${exportBaseName(tab)}.${spec.ext}`), exportFilters(spec.ext));
  if (!path) return false;
  try {
    const name = await api.exportSave(path, text);
    addStatus(spec.done(name), "success", tab.id);
    return true;
  } catch (e) {
    reportBlocked(spec.writeFailed(reasonOf(e).message), { tabId: tab.id });
    return false;
  }
}

/**
 * The SRBM export sheet's Export… (EXP-113): `SRBMExporter.export` to `<doc>.in`. Resolves true
 * when written (the sheet closes), false when cancelled or failed (the sheet stays).
 */
export async function exportSrbm(tab: Tab, convention: BlockingConventionId): Promise<boolean> {
  let text: string;
  try {
    text = await api.exportText("srbm", tab.document, { convention });
  } catch (e) {
    const r = reasonOf(e);
    addStatus(w.srbmExportFailed(r.message), "error", tab.id);
    await report({ title: w.srbmExportFailedTitle, message: r.message });
    return false;
  }
  // The sheet names the document after its file only: "Untitled" otherwise.
  const name = tab.path ? stem(tab.path) : w.untitled;
  const path = await chooseSaveTarget(w.srbmPanelTitle, inFolder(folderOf(tab), `${name}.in`), exportFilters("in"));
  if (!path) return false;
  try {
    await api.exportSave(path, text);
    addStatus(w.exportedSrbm(path), "success", tab.id);
    return true;
  } catch (e) {
    const r = reasonOf(e);
    addStatus(w.srbmExportWriteFailed(r.message), "error", tab.id);
    await report({ title: w.srbmExportFailedTitle, message: w.couldNotWrite(path.slice(path.lastIndexOf("/") + 1), r.message) });
    return false;
  }
}

/**
 * Export ▸ All Solver Inputs to Folder…, once the convention is known (EXP-114, EXP-115): the
 * folder panel, the seven files, the success line and, for files that weren't written, a warning.
 */
export async function exportAllTo(tab: Tab, convention: BlockingConventionId): Promise<boolean> {
  const folder = await chooseFolder(w.exportAllPanelTitle, folderOf(tab));
  if (!folder) return false;
  try {
    const r = await api.exportAllInputs(tab.document, convention, folder, generatedNow());
    addStatus(r.summary, "success", tab.id);
    if (r.warning) reportBlocked(r.warning, { detail: r.warningDetail ?? undefined, severity: "warning", tabId: tab.id });
    return true;
  } catch (e) {
    reportBlocked(w.exportFailed(reasonOf(e).message), { tabId: tab.id });
    return false;
  }
}

export const conventionTitle = (id: BlockingConventionId) => BLOCKING_CONVENTIONS.find((c) => c.id === id)!.title;
