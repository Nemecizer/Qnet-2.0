// Export Chart… and Copy Chart (new in 2.1, ROADMAP B5), through the diagram export's own
// machinery: the chart's standalone SVG (src/charts/svgString.ts — light colours on white whatever
// the app shows) goes to `diagram_export` for a PDF or PNG (src-tauri/src/canvas_export.rs, which
// embeds the font as the diagram export does) or is written as it is for an SVG; Copy Chart puts
// a PDF and a TIFF on the pasteboard as the canvas's Copy as Image does. The PNG's pixel scale is
// the diagram export's remembered one.
import { chartSvgString } from "../../../charts";
import { loadExportOptions } from "../../../canvas/export/options";
import { editorFor } from "../../../editor";
import { api } from "../../../lib/api";
import { chooseSaveTarget } from "../../../workspace/files/panels";
import { baseName, stem } from "../../../workspace/files/paths";
import { tabById } from "../../../workspace/store";
import { resultsWords } from "../words";

const w = resultsWords.charts;

export type ChartFormat = "pdf" | "png" | "svg";

/** "<document> Chart", as the diagram export names a figure after its document. */
export function chartFileName(tabId: string): string {
  const tab = tabById(tabId);
  return w.fileName(tab?.path ? stem(tab.path) : null);
}

/** The format a chosen file name asks for (PDF when it has none of the three extensions). */
export function formatOf(path: string): ChartFormat {
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext === "png" || ext === "svg" ? ext : "pdf";
}

const reasonOf = (e: unknown): { kind?: string; message: string } => {
  if (e && typeof e === "object" && "message" in e) return { kind: (e as { kind?: string }).kind, message: String((e as { message: unknown }).message) };
  return { message: String(e) };
};

const say = (tabId: string, text: string, severity?: "info" | "warning" | "error") => {
  if (tabById(tabId)) editorFor(tabId).status(text, severity);
};

/** The chart shown under `root`, as the export draws it; null when none is showing. */
export function chartFigure(root: Element | null | undefined): string | null {
  try {
    return chartSvgString(root);
  } catch {
    return null;
  }
}

/** Export Chart…: asks where and as what (PDF, PNG or SVG by the name's extension), then writes. True when written. */
export async function exportChart(tabId: string, root: Element | null | undefined): Promise<boolean> {
  const svg = chartFigure(root);
  if (!svg) {
    say(tabId, w.renderFailed, "error");
    return false;
  }
  const path = await chooseSaveTarget(w.savePanelTitle, `${chartFileName(tabId)}.pdf`, [
    { name: w.pdfFilter, extensions: ["pdf"] },
    { name: w.pngFilter, extensions: ["png"] },
    { name: w.svgFilter, extensions: ["svg"] },
  ]);
  if (!path) return false;
  const format = formatOf(path);
  try {
    const name = format === "svg" ? await api.exportSave(path, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`) : await api.diagramExport(svg, format, loadExportOptions().pixelScale, path);
    say(tabId, w.exported(name));
    return true;
  } catch (e) {
    const r = reasonOf(e);
    say(tabId, r.kind === "invalid" ? w.renderFailed : w.writeFailed(baseName(path), r.message), "error");
    return false;
  }
}

/** Copy Chart: a PDF and a TIFF of the chart on the pasteboard. True when copied. */
export async function copyChart(tabId: string, root: Element | null | undefined): Promise<boolean> {
  const svg = chartFigure(root);
  if (!svg) {
    say(tabId, w.copyFailed, "error");
    return false;
  }
  try {
    await api.diagramCopy(svg, svg, loadExportOptions().pixelScale);
  } catch {
    say(tabId, w.copyFailed, "error");
    return false;
  }
  say(tabId, w.copied, "info");
  return true;
}
