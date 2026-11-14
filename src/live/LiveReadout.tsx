// The status bar's live read-out for the selected station (new in 2.1, ROADMAP Phase D):
// "S1  ρ 80.0 %  L 4.000 customers  W 5.000 time units  · Live · exact". Shown while exactly one
// station is selected and Live Results has an answer for it; every number carries its unit and
// the read-out its tier. At the utilisation tier it shows ρ and says what to press for the rest.
import { useSetting } from "../lib/kv";
import { readoutFor } from "./model";
import { useLiveShown } from "./state";
import { useLive } from "./store";
import { liveWords as w } from "./words";
import "./live.css";

export function LiveReadout({ tabId, stationId }: { tabId: string; stationId: string | null }) {
  const on = useLiveShown();
  const results = useLive(tabId);
  const decimals = Number(useSetting<number>("output.decimals", 6));
  if (!on || !stationId) return null;
  const r = readoutFor(results, stationId, decimals);
  if (!r) return null;
  return (
    <>
      <span className="canvas-sb-div" aria-hidden="true" />
      <span className="canvas-sb-seg live-readout" data-live-readout={results?.tier} role="group" aria-label={w.readout.label(r.station)} title={r.help}>
        <span className="canvas-sb-strong">{r.station}</span>
        {r.parts.map((p) => (
          <span key={p.key} className="live-readout-part" title={p.help}>
            <span className="canvas-sb-quiet">{p.label}</span>
            <span className="live-readout-num">{p.number}</span>
            <span className="canvas-sb-quiet">{p.unit}</span>
          </span>
        ))}
        {r.note && <span className="live-readout-note">{r.note}</span>}
        <span className="live-readout-tier">{r.tier}</span>
        <span className="sr-only">{r.spoken}</span>
      </span>
    </>
  );
}
