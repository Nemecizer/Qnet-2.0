// Files: New, Open, Open Recent, Open Example, Save, Save As, the solver-input exports and
// Network ▸ Generate Random Network (ledger 5.9, File menu, 8.1, 8.7, 14.6–14.8). The tabs
// area's close guard and Quit call `saveTab`; the menu bar, palette and shortcuts run the
// commands below by the ids in src/lib/menuSpec.ts (runCommand checks each `when` first).
import { useEffect } from "react";
import { useCommands, type Command } from "../../lib/commands";
import { registerMenuProvider } from "../../lib/menu";
import { MODAL_REASON, modalOpen } from "../../lib/overlays";
import { activeTab, getWorkspace } from "../store";
import { canSave, canSaveAs, newNetwork, openExample, openNetwork, openPath, saveTab } from "./documents";
import { exportAllTo, exportSingle, hasNetwork } from "./exports";
import { clearRecents, recentItems, recentPaths } from "./recents";
import { openSheet, Sheets } from "./sheets";
import { fileWords as w } from "./words";

export { openPath, saveTab } from "./documents";
export { fileWords } from "./words";

/** Waits while a dialog, sheet or panel is up (MENU-198): a close guard's alert, the Save panel. */
const noModal = (): true | string => (modalOpen() ? MODAL_REASON : true);
const andNoModal = (f: () => true | string) => (): true | string => (modalOpen() ? MODAL_REASON : f());

/** Enabled with a network and no sheet up (0.90.34 `.disabled(!hasNetwork || sheetPresented)`). */
function exportable(): true | string {
  if (modalOpen()) return MODAL_REASON;
  return hasNetwork() ? true : w.saveNothing;
}

/** Export ▸ All Solver Inputs: finite networks pick the blocking convention first (EXP-114). */
function exportAll() {
  const tab = activeTab();
  if (tab.document.infiniteBuffers) return exportAllTo(tab, "manufacturing");
  openSheet("export-all");
}

export function fileCommands(): Command[] {
  return [
    { id: "file:new", title: "New Network", group: "File", subtitle: w.newSubtitle, when: noModal, run: () => newNetwork() },
    { id: "file:open", title: "Open…", group: "File", subtitle: w.openSubtitle, when: noModal, run: () => openNetwork() },
    {
      id: "file:clear-recent",
      title: "Clear Menu",
      group: "File",
      keywords: ["open recent", "recent"],
      when: () => (recentPaths().length ? true : w.clearRecentEmpty),
      run: () => clearRecents(),
    },
    { id: "file:open-example", title: "Open Example…", group: "File", subtitle: w.openExampleSubtitle, keywords: ["examples"], when: noModal, run: () => openExample() },
    {
      id: "file:save",
      title: "Save",
      group: "File",
      subtitle: w.saveSubtitle,
      when: andNoModal(() => canSave()),
      run: () => saveTab(getWorkspace().activeId),
    },
    {
      id: "file:save-as",
      title: "Save As…",
      group: "File",
      subtitle: w.saveAsSubtitle,
      when: andNoModal(() => canSaveAs()),
      run: () => saveTab(getWorkspace().activeId, { saveAs: true }),
    },
    { id: "file:export-fbnasim", title: "Finite Simulator Input (fBNAsim)…", group: "File", subtitle: w.exportFbnasimSubtitle, keywords: ["export"], when: exportable, run: () => exportSingle("fbnasim") },
    { id: "file:export-srbm", title: "SRBM Solver Input (.in)…", group: "File", subtitle: w.exportSrbmSubtitle, keywords: ["export"], when: exportable, run: () => openSheet("srbm") },
    { id: "file:export-qna", title: "QNA Input (.qna)…", group: "File", subtitle: w.exportQnaSubtitle, keywords: ["export"], when: exportable, run: () => exportSingle("qna") },
    { id: "file:export-all", title: "All Solver Inputs to Folder…", group: "File", subtitle: w.exportAllSubtitle, keywords: ["export", "export-cmp"], when: exportable, run: () => exportAll() },
    {
      id: "network:random",
      title: "Generate Random Network…",
      group: "Network",
      subtitle: w.randomSubtitle,
      when: () => (modalOpen() ? MODAL_REASON : true),
      run: () => openSheet("random"),
    },
  ];
}

/** The File menu's New, Open, Recent, Example, Save, Export and Network ▸ Generate commands. */
export function useFileCommands() {
  useCommands(fileCommands(), []);
  useEffect(() => registerMenuProvider("file:recent", () => recentItems((p) => openPath(p))), []);
}

/** Anything the files area keeps mounted (sheets: Generate Random Network, the SRBM export sheet). */
export function FilesHost() {
  return <Sheets />;
}
