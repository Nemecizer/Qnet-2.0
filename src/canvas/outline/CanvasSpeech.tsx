// What the canvas says (new in 2.1, ledger WF-603): when the selection changes while the canvas
// has the keyboard, the selected node or link is read out with its parameters, its result and its
// problems, through the app's one polite announcer. The canvas is an `application` whose nodes are
// drawn, not focused, so without this a Tab from node to node is silent. Renders nothing.
import { useEffect, useRef } from "react";
import type { Editor } from "../../editor";
import { useEditorView } from "../../editor";
import { announce } from "../../lib/announce";
import type { CanvasResults } from "../overlay/ResultsLayer";
import { diagnosticsOf } from "../validation/store";
import { selectionSpoken } from "./describe";

export function CanvasSpeech({ editor, results, utilisation, surface }: { editor: Editor; results: CanvasResults | null; utilisation?: Readonly<Record<string, number>>; surface: React.RefObject<HTMLDivElement | null> }) {
  const view = useEditorView(editor);
  const key = `${view.selectedLinkID ?? ""}|${view.selectedNodeID ?? ""}|${[...view.selectedNodeIDs].sort().join(",")}`;
  const last = useRef<string | null>(null);
  const latest = useRef({ results, utilisation });
  latest.current = { results, utilisation };
  useEffect(() => {
    const first = last.current === null;
    if (last.current === key) return;
    last.current = key;
    const el = surface.current;
    // Only for the keyboard on the canvas itself, and never for the selection a tab opens with.
    if (first || !el || el.ownerDocument.activeElement !== el || view.isDraggingNode) return;
    announce(selectionSpoken({ editor, results: latest.current.results, utilisation: latest.current.utilisation, diagnostics: diagnosticsOf(editor.tabId) }));
  }, [key, editor, surface, view.isDraggingNode]);
  return null;
}
