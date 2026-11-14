// The legend's live chip (new in 2.1, ROADMAP Phase D): "Live · exact", "Live · utilisation
// only", "Live · offered load only" or "Live · no steady state", with a pulse dot. A recorded
// run's legend reads "metric · method · tier" in plain text and has no chip, so the two cannot be
// mistaken for each other. The dot is still under Reduce Motion (live.css).
import type { LiveMark } from "./model";
import { liveWords as w } from "./words";
import "./live.css";

export function LiveChip({ mark }: { mark: LiveMark }) {
  return (
    <span className="live-chip" data-live-tier={mark.unstable ? "unstable" : mark.tier} title={mark.help} role="note" aria-label={w.chipSpoken(mark.chip)}>
      <span className="live-chip-dot" aria-hidden="true" />
      <span aria-hidden="true">{mark.chip}</span>
    </span>
  );
}
