// The round "?" a window carries in its footer (0.90.34 DSHelpButton / DSSheetFooter `helpTopic:`,
// ledger HELP-095): it always opens the Qnet Help window at the window's article, whatever
// Settings ▸ Help sends the Help menu's topics to (HELP-093).
import { getSetting } from "../../lib/kv";
import { openHelp } from "./state";
import { topic } from "./topics";
import { helpWords as w } from "./words";
import "./help.css";

/** A help button for a topic. Disabled when the build has no such article. */
export function HelpButton({ topic: id, className }: { topic: string; className?: string }) {
  const t = topic(id);
  const title = t ? w.buttonTip(t.windowTitle) : undefined;
  return (
    <button
      type="button"
      className={className ? `help-button ${className}` : "help-button"}
      data-help-button={id}
      aria-label={t ? w.buttonLabel(t.windowTitle) : "Help"}
      title={title}
      disabled={!t}
      onClick={() => openHelp(id)}
    >
      ?
    </button>
  );
}

/**
 * The article each Settings pane opens, by the pane's stored id (src/windows/settings/registry.ts).
 * 0.90.34's Settings had no Help links (HELP-099); PLAN P7 asks that every Settings section open
 * its article. Three panes have no article of their own and open the nearest one: Solver Engine
 * (the first method it switches), Output Format and Help (General Preferences).
 */
export const SETTINGS_HELP: Record<string, string> = {
  General: "general",
  "Solver Engine": "regenerativeSimulation",
  Simulation: "simulationInfinite",
  "SRBM MLMC": "exactSimulation",
  "Linear Program": "linearProgramInfinite",
  "Finite-Buffer LP": "finiteLP",
  "Finite Element": "finiteElement",
  "Spectral Method": "spectralInfinite",
  "Test Sets": "testSets",
  "Output Format": "general",
  "Interactive Shell Window": "interactiveShell",
  "Help menu": "general",
  "AI Assistant": "connectAnthropic",
};

const AI_PROVIDER_HELP: Record<string, string> = { anthropic: "connectAnthropic", openai: "connectOpenAI", lmstudio: "connectLMStudio", ollama: "connectOllama" };

/** The article for a Settings pane; AI Assistant opens the chosen provider's when it has one. */
export function settingsHelpTopic(pane: string): string {
  if (pane === "AI Assistant") {
    const provider = String(getSetting<unknown>("ai.provider", "")).toLowerCase().replace(/[^a-z]/g, "");
    return AI_PROVIDER_HELP[provider] ?? SETTINGS_HELP[pane];
  }
  return SETTINGS_HELP[pane] ?? "general";
}

/** The "?" in the Settings window's bottom bar, for the pane showing. */
export function SettingsHelpButton({ pane }: { pane: string }) {
  return <HelpButton topic={settingsHelpTopic(pane)} />;
}
