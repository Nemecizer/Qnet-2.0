// The inspector's network section for a closed network (new in 2.1, ROADMAP D3): shown when
// nothing is selected. With a population it edits N; for a network drawn without a source and a
// sink but with no population yet, it offers to make it closed.
import { useEffect, useState } from "react";
import { CountField } from "../components/CountField";
import type { Editor } from "../editor";
import { Row } from "../panes/inspector/fields";
import { Section } from "../panes/inspector/NodeSections";
import { looksClosed, makeClosed } from "./commands";
import { closedWords as w, MAX_POPULATION, suggestedPopulation } from "./words";

export function PopulationSection({ editor }: { editor: Editor }) {
  const population = editor.closedPopulation;
  const [text, setText] = useState(population === undefined ? "" : String(population));
  // Undo, a fix or a sweep's "apply" changed it under the field.
  useEffect(() => setText(population === undefined ? "" : String(population)), [population]);
  if (!looksClosed(editor.nodes)) return null;
  if (population === undefined) {
    const n = suggestedPopulation(editor.nodes.filter((x) => x.kind === "station").length);
    return (
      <form className="insp-form is-pane" onSubmit={(e) => e.preventDefault()} aria-label={w.candidateSection}>
        <Section title={w.candidateSection}>
          <p className="insp-caption">{w.candidateCaption}</p>
          <button type="button" className="btn" title={w.makeClosedHelp} onClick={() => makeClosed(editor, n)}>
            {w.makeClosed(n)}
          </button>
        </Section>
      </form>
    );
  }
  const commit = (next: string) => {
    setText(next);
    // CountField hands back a committed, clamped whole number as plain digits; typing is free until then.
    if (/^\d+$/.test(next)) {
      const v = Number(next);
      if (v >= 1 && v <= MAX_POPULATION) editor.setClosedPopulation(v);
    }
  };
  return (
    <form className="insp-form is-pane" onSubmit={(e) => e.preventDefault()} aria-label={w.section}>
      <Section title={w.section}>
        <Row label={w.population} glossary={w.populationGlossary} help={w.populationHelp} labelFor="closed-population">
          <CountField id="closed-population" label={w.populationLabel} help={w.populationHelp} value={text} min={1} max={MAX_POPULATION} onChange={commit} decrementLabel={w.decrement} incrementLabel={w.increment} />
          <span className="muted"> {w.unit}</span>
        </Row>
        <p className="insp-caption">{w.caption}</p>
        <button type="button" className="btn" title={w.makeOpenHelp} onClick={() => editor.setClosedPopulation(null)}>
          {w.makeOpen}
        </button>
      </Section>
    </form>
  );
}
