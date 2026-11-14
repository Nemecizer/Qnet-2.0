// The Node Parameters panel's size band and opening height (0.90.34 NodeParameterEditorSheet
// `size(for:in:)`, `idealHeight(for:in:)`; ledger INS-106, INS-107), decided for the whole sibling
// order so stepping never resizes the panel.
import type { Editor } from "../../editor";
import { heightForRows, PANEL_BANDS, type PanelBand } from "../../lib/panel";

export function nodePanelBand(editor: Editor, nodeID: string): PanelBand {
  const node = editor.node(nodeID);
  if (!node) return "wide";
  switch (node.kind) {
    case "sink":
      return "compact";
    case "buffer":
      return "regular";
    case "source":
      return "wide";
    case "station":
      return editor.inspectorNavigationOrder("station").some((s) => editor.classesServedAtStation(s.id).length > 0) ? "table" : "wide";
  }
}

export function nodePanelHeight(editor: Editor, nodeID: string): number {
  const band = nodePanelBand(editor, nodeID);
  const node = editor.node(nodeID);
  if (!node) return PANEL_BANDS[band].idealHeight;
  const order = editor.inspectorNavigationOrder(node.kind);
  const mostLinks = Math.max(0, ...order.map((n) => editor.linksAttached(n.id).length));
  const linkRows = Math.min(mostLinks, 4);
  if (node.kind !== "station") return linkRows === 0 ? PANEL_BANDS[band].idealHeight : heightForRows(band, linkRows);
  const largest = Math.max(0, ...order.map((n) => editor.classesServedAtStation(n.id).length));
  const classRows = largest === 0 ? 2 : Math.min(largest, 6);
  return heightForRows(band, classRows + linkRows);
}
