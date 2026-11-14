// The one place the export meets the drawing area's layers: the canvas's own `SceneLayers` in its
// `snapshot` form (no hover, selection, marquee, guides, link preview, ghost or accessibility
// elements), with the document's buffer regime, the analysis's ρ badges and the export's grid
// choice (0.90.34 `CanvasSnapshotView`: GridCanvas, LinkLayerCanvas, NetworkNodeView).
import type { Editor, EditorView } from "../../editor";
import { analysisOf } from "../../panes/status/analysis";
import type { CanvasScene } from "../geometry/scene";
import { SceneLayers } from "../layers";
import type { CanvasColors } from "../layers/colors";
import { shownResults } from "../overlay/useResultsOverlay";

export interface FigureLayersProps {
  editor: Editor;
  scene: CanvasScene;
  view: EditorView;
  colors: CanvasColors;
  showsGrid: boolean;
}

export function FigureLayers({ editor, scene, view, colors, showsGrid }: FigureLayersProps) {
  return (
    <SceneLayers
      scene={scene}
      view={view}
      colors={colors}
      snapshot
      grid={showsGrid}
      infiniteBuffers={editor.infiniteBuffers}
      utilisation={analysisOf(editor.tabId)?.utilisation ?? undefined}
      results={shownResults(editor.tabId)}
      linkDescription={(l) => editor.linkDescription(l)}
    />
  );
}
