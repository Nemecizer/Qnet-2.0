// The overlay's legend chip (new in 2.1, ROADMAP B2), top-left of the canvas: the scale's swatch,
// "Mean number in system · Product Form · Exact", and — when the network has changed since the
// run — "Network changed since this run". The chip is a menu button: the metrics, Color Stations,
// back to the best run (after a pick in the Results pane) and Hide. It is where the overlay's
// commands are registered, so it is mounted with the canvas whether or not anything shows.
import { useRef, useState } from "react";
import { runCommand } from "../../lib/commands";
import { shortcutFor } from "../../lib/menu";
import { STATION_METRICS } from "../../results/insight";
import { setSelectedRun } from "../../results/selectedRun";
import { PopupMenu, type PopupItem } from "../../workspace/panes/PopupMenu";
import { useCanvasColors } from "../layers/useCanvasColors";
import { COLOR_COMMAND, metricCommand, SHOW_COMMAND, useOverlayCommands } from "./commands";
import { formatValue } from "./model";
import { LiveChip } from "../../live/LiveChip";
import { isLiveModel } from "../../live/model";
import { resultScale } from "./scale";
import type { ResultsOverlay } from "./useResultsOverlay";
import { overlayWords as w } from "./words";
import "./overlay.css";

const STOPS = [0, 0.2, 0.4, 0.6, 0.8, 0.85, 0.9, 0.95, 1];

export function ResultsLegend({ tabId, overlay }: { tabId: string; overlay: ResultsOverlay }) {
  useOverlayCommands();
  const colors = useCanvasColors();
  const button = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const { model, prefs } = overlay;
  if (!model || !prefs.show) return null;

  const scale = resultScale(colors.theme, colors.contrast);
  const gradient = `linear-gradient(to right, ${STOPS.map((t) => `${scale.color(t, model.fixedScale)} ${t * 100}%`).join(", ")})`;
  const empty = model.items.size === 0;
  const caption = empty ? w.noValues(model.metric, model.method) : model.caption;
  const top = model.fixedScale ? formatValue(1, "ratio", 2) : formatValue(model.max, model.unit, 2);
  const bottom = model.fixedScale ? formatValue(0, "ratio", 2) : formatValue(0, model.unit, 2);
  const hideKey = shortcutFor(SHOW_COMMAND);

  const items: PopupItem[] = [
    ...STATION_METRICS.map((m) => ({ label: m, help: w.metricHelp(m), checked: prefs.metric === m, disabled: !model.available.includes(m) && prefs.metric !== m, run: () => void runCommand(metricCommand(m)) })),
    "-",
    { label: w.colorStations, help: w.colorHelp, checked: prefs.color, run: () => void runCommand(COLOR_COMMAND) },
    ...(model.pinned ? [{ label: w.bestRun, help: w.bestRunHelp, run: () => setSelectedRun(tabId, null) }] : []),
    "-",
    { label: hideKey ? `${w.hide}  ${hideKey}` : w.hide, run: () => void runCommand(SHOW_COMMAND) },
  ];

  return (
    <div className="canvas-results-chrome">
      <button
        ref={button}
        type="button"
        className="canvas-results-legend canvas-appear"
        data-stale={model.stale || undefined}
        data-live={isLiveModel(model) ? model.live.tier : undefined}
        aria-label={w.legendLabel}
        aria-description={[caption, isLiveModel(model) ? model.live.chip : null, model.stale ? w.stale : null].filter(Boolean).join(". ")}
        aria-haspopup="menu"
        aria-expanded={!!menuAt}
        title={model.stale ? w.staleHelp : w.legendHelp}
        onClick={() => setMenuAt(button.current?.getBoundingClientRect() ?? new DOMRect())}
      >
        {prefs.color && !empty && (
          <span className="canvas-results-scale" aria-hidden="true">
            <span className="canvas-results-end">{bottom}</span>
            <span className="canvas-results-ramp" data-stale={model.stale || undefined} style={{ background: gradient }} />
            <span className="canvas-results-end">{top}</span>
          </span>
        )}
        <span className="canvas-results-text">
          <span className="canvas-results-caption">{caption}</span>
          {isLiveModel(model) && <LiveChip mark={model.live} />}
          {model.stale && <span className="canvas-results-stale">{w.stale}</span>}
        </span>
        <span className="canvas-results-caret" aria-hidden="true">⌄</span>
      </button>
      {menuAt && (
        <PopupMenu
          items={items}
          anchor={menuAt}
          label={w.legendMenu}
          onClose={(chosen) => {
            setMenuAt(null);
            button.current?.focus({ preventScroll: true });
            chosen?.();
          }}
        />
      )}
    </div>
  );
}
