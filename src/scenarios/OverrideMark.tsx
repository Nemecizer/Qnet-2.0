// The inspector's mark on a field the scenario shown overrides (new in 2.1, ROADMAP E1): a small
// dot, "Baseline: 1.25" and Reset to baseline. Draws nothing for a field at the baseline's value,
// and nothing at all while the baseline is shown.
import { classLabel, type Editor } from "../editor";
import { distributionDisplayName } from "../editor/distributions";
import type { ServiceConfig } from "../lib/bnet";
import { useWorkspace } from "../workspace/store";
import { resetToBaseline } from "./commands";
import { activeScenario, baselineValue, MISSING, type OverrideField, type OverrideTarget } from "./model";
import { scenarioWords as w } from "./words";
import "./scenarios.css";

const law = (c: ServiceConfig) => `${distributionDisplayName(c.distribution)} (${c.distributionParameters})`;

/** A baseline value in words: "2", "0.3", "Exponential (rate=1.25)", "Class 1: Exponential (rate=1.0)". */
export function baselineText(field: OverrideField, value: unknown): string {
  if (value === null || value === undefined) return w.noPopulation;
  if (field === "distribution") return law(value as ServiceConfig);
  if (field === "serviceDistributions") {
    const entries = Object.entries(value as Record<string, ServiceConfig>).sort((a, b) => Number(a[0]) - Number(b[0]));
    return entries.length ? entries.map(([cls, c]) => w.classValue(classLabel(Number(cls)), law(c))).join("; ") : w.noPopulation;
  }
  return String(value);
}

export function OverrideMark({ editor, node, link, field }: { editor: Editor; node?: string; link?: string; field: OverrideField }) {
  const doc = useWorkspace((ws) => ws.tabs.find((t) => t.id === editor.tabId)?.document);
  const target: OverrideTarget = node !== undefined ? { node, field } : link !== undefined ? { link, field } : { field };
  const value = baselineValue(doc, target);
  const scenario = activeScenario(doc);
  if (value === MISSING || !scenario) return null;
  const text = w.baselineIs(baselineText(field, value));
  return (
    <div className="scn-mark" data-scenario-override={field} role="group" aria-label={`${w.overridden}. ${text}`}>
      <span className="scn-mark-dot" aria-hidden="true" title={w.overridden} />
      <span className="scn-mark-text" title={text}>
        {text}
      </span>
      <button type="button" className="btn btn-small" title={w.resetHelp(scenario.name)} onClick={() => resetToBaseline(editor.tabId, target)}>
        {w.reset}
      </button>
    </div>
  );
}
