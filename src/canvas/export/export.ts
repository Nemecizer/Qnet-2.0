// File ▸ Export ▸ Diagram as PDF… / PNG…, Edit ▸ Copy as Image, File ▸ Print Diagram… and Page
// Setup… (0.90.34 CanvasImageExport.swift `exportPDF`, `exportPNG`, `save`, `copyToPasteboard`,
// `print`; ledger CAN-189…199, FILE-057…063). The interface draws the figure (figure.tsx); Rust
// renders and writes it (src-tauri/src/canvas_export.rs) and does the AppKit parts.
import { useSyncExternalStore } from "react";
import { api } from "../../lib/api";
import { holdModal } from "../../lib/overlays";
import { activeEditor, editorFor, type Editor } from "../../editor";
import { tabById } from "../../workspace/store";
import { chooseSaveTarget } from "../../workspace/files/panels";
import { baseName, stem } from "../../workspace/files/paths";
import { buildFigure } from "./figure";
import { loadExportOptions, type ExportFormat, type ExportOptions } from "./options";
import { exportWords as w } from "./words";

// ── The options panel's state: which format it is asking for, and for which tab ─────────────

export interface ExportPanelState {
  format: ExportFormat;
  tabId: string;
  classCount: number;
  /** Bumped on every request, so a second request rebuilds the panel (0.90.34 closed and re-presented it). */
  seq: number;
}

let panel: ExportPanelState | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

export function exportPanelState(): ExportPanelState | null {
  return panel;
}

export function useExportPanel(): ExportPanelState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => panel,
  );
}

export function closeExportPanel() {
  if (!panel) return;
  panel = null;
  publish();
}

/** The document's own name, or "Network Diagram" (0.90.34 `suggestedName`). */
export function suggestedName(tabId: string): string {
  const tab = tabById(tabId);
  return tab?.path ? stem(tab.path) : w.defaultName;
}

/** Export ▸ Diagram as PDF… / PNG…: the options panel first; an empty canvas only logs a warning. */
export function exportDiagram(format: ExportFormat) {
  const editor = activeEditor();
  if (!editor.nodes.length) {
    editor.status(w.nothingToExport, "warning");
    return;
  }
  panel = { format, tabId: editor.tabId, classCount: editor.numberOfCustomerClasses, seq: ++seq };
  publish();
}

const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  pdf: { name: w.pdfFilter, extensions: ["pdf"] },
  png: { name: w.pngFilter, extensions: ["png"] },
};

const reasonOf = (e: unknown): { kind?: string; message: string } => {
  if (e && typeof e === "object" && "message" in e) return { kind: (e as { kind?: string }).kind, message: String((e as { message: unknown }).message) };
  return { message: String(e) };
};

/**
 * The panel's Export…: the panel goes first (0.90.34 ordered it out before the app-modal Save
 * panel), then the Save panel "Export Diagram" with "<name>.<ext>", then the render and the write.
 * Resolves true when the file was written.
 */
export async function confirmExport(state: ExportPanelState, options: ExportOptions): Promise<boolean> {
  closeExportPanel();
  await Promise.resolve();
  if (!tabById(state.tabId)) return false;
  const editor = editorFor(state.tabId);
  const path = await chooseSaveTarget(w.savePanelTitle, `${suggestedName(state.tabId)}.${state.format}`, [FILTERS[state.format]]);
  if (!path) return false;
  const figure = buildFigure(editor, { options, opaqueFallback: state.format === "png" });
  if (!figure) {
    editor.status(w.renderFailed, "error");
    return false;
  }
  try {
    const name = await api.diagramExport(figure.svg, state.format, options.pixelScale, path);
    editor.status(w.exported(name));
    return true;
  } catch (e) {
    const r = reasonOf(e);
    editor.status(r.kind === "invalid" ? w.renderFailed : w.writeFailed(baseName(path), r.message), "error");
    return false;
  }
}

/**
 * Edit ▸ Copy as Image: a PDF (its ground may be transparent) and a TIFF (opaque) of the selected
 * nodes and the links between them, or of the whole diagram, with the remembered options.
 */
export async function copyAsImage(editor: Editor = activeEditor()): Promise<boolean> {
  if (!editor.nodes.length) {
    editor.status(w.nothingToCopy, "warning");
    return false;
  }
  const selection = editor.selectionUnion;
  const only = selection.size ? selection : null;
  const options = loadExportOptions();
  const pdf = buildFigure(editor, { options, only, opaqueFallback: false });
  const image = buildFigure(editor, { options, only, opaqueFallback: true });
  if (!pdf || !image) {
    editor.status(w.copyFailed, "error");
    return false;
  }
  try {
    await api.diagramCopy(pdf.svg, image.svg, options.pixelScale);
  } catch {
    editor.status(w.copyFailed, "error");
    return false;
  }
  editor.status(w.copied(only ? w.copiedSelection(only.size) : w.copiedWhole), "info");
  return true;
}

/**
 * File ▸ Print Diagram…: the PDF page, vector, scaled down (never up) to the paper of the shared
 * print info; a Canvas ground becomes Transparent on paper; the job title is the suggested name.
 * The Print panel is app-modal, so document commands wait while it is up.
 */
export async function printDiagram(editor: Editor = activeEditor()): Promise<boolean> {
  if (!editor.nodes.length) {
    editor.status(w.nothingToPrint, "warning");
    return false;
  }
  const options = loadExportOptions();
  if (options.background === "canvas") options.background = "transparent";
  const figure = buildFigure(editor, { options, opaqueFallback: false });
  if (!figure) {
    editor.status(w.printFailed, "error");
    return false;
  }
  const release = holdModal();
  try {
    await api.diagramPrint(figure.svg, suggestedName(editor.tabId));
    return true;
  } catch {
    editor.status(w.printFailed, "error");
    return false;
  } finally {
    release();
  }
}

/** File ▸ Page Setup…: AppKit's Page Setup panel, editing the shared print info Print reads. */
export async function pageSetup(): Promise<void> {
  const release = holdModal();
  try {
    await api.diagramPageSetup();
  } catch {
    // Nothing to report: the panel didn't open.
  } finally {
    release();
  }
}

/** For tests. */
export function resetExport() {
  panel = null;
  publish();
}

