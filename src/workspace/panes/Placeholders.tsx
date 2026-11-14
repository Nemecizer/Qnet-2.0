// The bodies of the panes later phases fill (Tools and Inspector: P5; Results and Shell: P6; AI
// Assistant: P7): each a header and one empty-state line, marked with its pane id so focus, ⌘F and
// the window commands already route to it.
import type { PaneId } from "../focus";
import { PaneHeader } from "./PaneHeader";
import { PANE_NAME, paneWords } from "./words";

// Exported so it stays in use now that every pane has its body (tests may still render one).
export function Placeholder({ pane }: { pane: Exclude<PaneId, "canvas" | "status"> }) {
  return (
    <section className={`pane pane-${pane}`} data-pane={pane} tabIndex={-1} aria-label={PANE_NAME[pane]}>
      <PaneHeader pane={pane} />
      <div className="pane-empty" tabIndex={0} data-focus-default>
        <p className="muted">{paneWords.placeholder[pane]}</p>
      </div>
    </section>
  );
}

export { ToolsPane } from "../../canvas/tools/ToolsPane";
export { InspectorPane } from "../../panes/inspector";
export { ResultsPane } from "../../panes/results";
export { ShellPane } from "../../panes/shell";
export { AIPane } from "../../panes/ai";
