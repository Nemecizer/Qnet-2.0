// The diagram export's menu commands (0.90.34 QnetCommands.swift: File ▸ Export ▸ Diagram as
// PDF… / PNG…, File ▸ Page Setup… / Print Diagram…, Edit ▸ Copy as Image; ledger MENU-022, 023,
// 030, 031, 037). Each is dimmed with no network or while a sheet or modal panel is up
// (`.disabled(!hasNetwork || sheetPresented)`); Page Setup only under a sheet.
import { useCommands, type Command } from "../../lib/commands";
import { MODAL_REASON, modalOpen } from "../../lib/overlays";
import { activeEditor } from "../../editor";
import { copyAsImage, exportDiagram, pageSetup, printDiagram } from "./export";
import { exportWords as w } from "./words";

function withNetwork(): true | string {
  if (modalOpen()) return MODAL_REASON;
  return activeEditor().nodes.length ? true : w.noNetwork;
}

export function exportCommands(): Command[] {
  return [
    { id: "file:export-pdf", title: "Diagram as PDF…", group: "File", subtitle: w.pdfHelp, keywords: ["export", "figure", "image", "vector"], when: withNetwork, run: () => exportDiagram("pdf") },
    { id: "file:export-png", title: "Diagram as PNG…", group: "File", subtitle: w.pngHelp, keywords: ["export", "figure", "image", "raster"], when: withNetwork, run: () => exportDiagram("png") },
    { id: "edit:copy-as-image", title: "Copy as Image", group: "Edit", subtitle: w.copyHelp, keywords: ["clipboard", "pdf", "tiff", "figure"], when: withNetwork, run: () => copyAsImage() },
    { id: "file:page-setup", title: "Page Setup…", group: "File", subtitle: w.pageSetupHelp, keywords: ["paper", "print"], when: () => (modalOpen() ? MODAL_REASON : true), run: () => pageSetup() },
    { id: "file:print", title: "Print Diagram…", group: "File", subtitle: w.printHelp, keywords: ["print", "paper"], when: withNetwork, run: () => printDiagram() },
  ];
}

export function useExportCommands() {
  useCommands(exportCommands(), []);
}
