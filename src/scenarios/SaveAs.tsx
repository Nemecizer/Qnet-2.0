// "Save as Scenario", the second button beside a view's Apply (Results ▸ Capacity, Sensitivity):
// the same change, kept as a new scenario instead of written over the values shown
// (./commands.ts `saveAsScenario`).
import { saveAsScenario } from "./commands";
import { scenarioWords as w } from "./words";

export function SaveAsScenarioButton({ tabId, name, what, disabled, apply }: { tabId: string; name: string; /** What is saved, for the spoken label. */ what?: string; disabled?: boolean; apply: () => boolean }) {
  return (
    <button type="button" className="btn" data-save-as-scenario title={w.saveAsHelp} aria-label={what ? `${w.saveAsScenario}: ${what}` : undefined} disabled={disabled} onClick={() => saveAsScenario(tabId, name, apply)}>
      {w.saveAsScenario}
    </button>
  );
}
