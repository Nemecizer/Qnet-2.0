// View ▸ Results on Canvas (new in 2.1, ROADMAP B2; ids as src/lib/menuSpec.ts names them):
// Show/Hide (⌥⌘R), one check item per metric, and Color Stations. The legend chip on the canvas
// runs the same commands, so the menu, the palette and the chip cannot drift apart.
import { useEffect } from "react";
import { registerCommands, type Command } from "../../lib/commands";
import { STATION_METRICS, type StationMetric } from "../../results/insight";
import { overlayPrefs, setOverlayColor, setOverlayMetric, setOverlayShown } from "./state";
import { overlayWords as w } from "./words";

export const SHOW_COMMAND = "view:results-on-canvas";
export const COLOR_COMMAND = "view:results-color";
/** "Mean number in system" → "view:results-metric-mean-number-in-system". */
export const metricCommand = (m: StationMetric) => `view:results-metric-${m.toLowerCase().replace(/[^a-z]+/g, "-")}`;

export function overlayCommands(): Command[] {
  return [
    {
      id: SHOW_COMMAND,
      title: w.show,
      dynamicTitle: () => (overlayPrefs().show ? w.hide : w.show),
      group: "View",
      keywords: ["results", "overlay", "canvas", "values", "badges", "heat map"],
      subtitle: w.showHelp,
      run: () => setOverlayShown(!overlayPrefs().show),
    },
    ...STATION_METRICS.map(
      (m): Command => ({
        id: metricCommand(m),
        title: m,
        group: "View",
        keywords: ["results", "canvas", "metric", w.menuTitle],
        subtitle: w.metricHelp(m),
        checked: () => overlayPrefs().metric === m,
        run: () => setOverlayMetric(m),
      }),
    ),
    {
      id: COLOR_COMMAND,
      title: w.colorStations,
      group: "View",
      keywords: ["results", "canvas", "colour", "ring", "heat map"],
      subtitle: w.colorHelp,
      checked: () => overlayPrefs().color,
      run: () => setOverlayColor(!overlayPrefs().color),
    },
  ];
}

/** Registers the overlay's commands while the canvas is mounted. */
export function useOverlayCommands() {
  useEffect(() => registerCommands(overlayCommands()), []);
}
