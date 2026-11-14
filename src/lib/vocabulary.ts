// The words the interface uses, in one place, so every surface says the same thing (NetMon's
// rule). Each area keeps its own words beside its code and they are re-exported here; the menu
// bar's labels are src/lib/menuSpec.ts.

export const APP_NAME = "Qnet";

export const words = {
  previewNote: "Browser preview: the backend is simulated.",
  /** A value field clamped what was typed into its range (DSNumericField `showClampNotice`). */
  clampedTo: (v: string) => `Clamped to ${v}`,
  /** A notice for files Qnet set aside because it couldn't read them. */
  setAside: (file: string, backup: string) => `Qnet couldn't read ${file}, so it started from defaults. The original is kept at ${backup}.`,
} as const;

/** "2.1.0 (dev, a1b2c3d)": the version as About and the status bar show it. */
export function versionLabel(version: string, instance: string, buildTag: string): string {
  return `${version} (${[instance === "dev" ? "dev" : null, buildTag].filter(Boolean).join(", ")})`;
}

export { tabWords } from "../workspace/tabs/words";
export { fileWords } from "../workspace/files/words";
export { paneWords } from "../workspace/panes/words";
export { statusWords } from "../panes/status/words";
export { settingsWords } from "../windows/settings/words";
export { editorWords } from "../editor/words";
export { canvasWords } from "../canvas/words";
export { inspectorWords, panelWords, glossary } from "../panes/inspector/words";
export { exportWords } from "../canvas/export/words";
export { networkWords } from "../network/words";
export { archetypeWords } from "../windows/archetypes/words";
export { resultsWords } from "../panes/results/words";
export { agreementWords } from "../panes/results/agreement/words";
export { analysisWords } from "../analysis/words";
export { methodChooserWords } from "../windows/methodchooser/words";
export { networkModelWords } from "../windows/networkmodel/words";
export { runWords } from "../runs/ui/words";
export { shellWords } from "../panes/shell/words";
export { aiWords } from "../panes/ai/words";
export { helpWords } from "../windows/help/words";
export { aboutWords } from "../windows/about/words";
export { releaseNotesWords } from "../windows/releasenotes/words";
export { shellWords as componentWords } from "../components/words";
export { outlineWords } from "../canvas/outline/words";
