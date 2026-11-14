// The words of the diagram export (0.90.34 CanvasImageExport.swift, CanvasExportOptionsSheet.swift
// and the File/Edit menu `.help` texts in QnetCommands.swift), kept as 0.90.34 wrote them.
export const exportWords = {
  // The options panel (CanvasExportFormat, CanvasExportOptionsSheet).
  pdfTitle: "Export Diagram as PDF",
  pngTitle: "Export Diagram as PNG",
  pdfSubtitle: "Vector output — resolution-independent at any size, for a paper figure or a slide.",
  pngSubtitle: "Raster output on an opaque ground, for an email, a wiki or a chat.",
  figure: "Figure",
  scale: "Scale",
  scaleHelp: "Pixels per point. 2× matches a Retina screen; 4× for print-quality raster.",
  scaleLabel: (s: number) => `${s}×`,
  background: "Background",
  backgrounds: { canvas: "Canvas", white: "White", transparent: "Transparent" },
  backgroundHelpPdf: "The ground behind the diagram. Transparent lets the figure sit on the page's own colour.",
  backgroundHelpPng: "The ground behind the diagram. A PNG is always opaque.",
  includeGrid: "Include grid",
  includeGridHelp: "Draw the canvas dot grid behind the network",
  includeLegend: "Include class legend",
  includeLegendHelp: "Compose the customer-class colour key into the bottom-left of the figure",
  includeLegendOneClass: "This network has one customer class, so there is no colour key to include",
  footerLight: "Every export is drawn in the light appearance, so a figure made at midnight matches one made at noon.",
  footerClasses: (n: number) => `This network has ${n} customer classes; a figure without its colour key is hard to read in print.`,
  cancel: "Cancel",
  confirm: "Export…",
  cancelHelp: "Close without exporting (Esc)",
  confirmHelp: "Choose a destination and write the file (Return)",

  // The Save panel and the Status lines (CanvasImageExport `save`, `suggestedName`).
  savePanelTitle: "Export Diagram",
  defaultName: "Network Diagram",
  pdfFilter: "PDF",
  pngFilter: "PNG image",
  exported: (file: string) => `Exported diagram to ${file}.`,
  renderFailed: "!! Could not render the diagram for export.",
  writeFailed: (file: string, reason: string) => `!! Could not write ${file}: ${reason}`,
  nothingToExport: "Nothing to export: the canvas is empty.",
  nothingToCopy: "Nothing to copy: the canvas is empty.",
  nothingToPrint: "Nothing to print: the canvas is empty.",
  copied: (what: string) => `Copied ${what} to the clipboard as PDF and TIFF.`,
  copiedWhole: "the diagram",
  copiedSelection: (n: number) => `${n} selected node${n === 1 ? "" : "s"} and the links between them`,
  copyFailed: "!! Could not render the diagram for the clipboard.",
  printFailed: "!! Could not render the diagram for printing.",

  // Menu items (titles from menuSpec; these are their `.help` texts, the palette's subtitles).
  pdfHelp: "Render the canvas as a vector PDF — background, grid and class legend are asked for first",
  pngHelp: "Render the canvas as a PNG — scale, background, grid and class legend are asked for first",
  copyHelp: "Copy the selected nodes and the links between them — or the whole diagram when nothing is selected — to the clipboard as PDF and TIFF",
  pageSetupHelp: "Choose the paper size, orientation and scale that Print Diagram uses",
  printHelp: "Print the diagram as vector art, scaled down to the page when it does not fit",
  noNetwork: "Draw or open a network first",

  // The legend band (CustomerClass.label).
  classLabel: (i: number) => `Class ${i + 1}`,
} as const;
