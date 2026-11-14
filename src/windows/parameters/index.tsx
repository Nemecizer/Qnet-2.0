// The parameter panels' host (mounted once in App.tsx): the Node Parameters and Link Parameters
// panels follow the active tab's `parameterEditorTarget` / `linkParameterEditorTarget` (0.90.34
// ContentView mirrored the targets into DSPanelWindow). Find Node is the canvas's
// (src/canvas/interaction/FindNodePanel.tsx). A tab that stops being active takes its panels away without their onClose
// (INS-175): nothing is written during that teardown.
import { useActiveEditor, useEditorView } from "../../editor";
import { LinkParametersPanel } from "./LinkParametersPanel";
import { NodeParametersPanel } from "./NodeParametersPanel";
import "../../panes/inspector/inspector.css";

export { NodeParametersPanel, NODE_PANEL_ID } from "./NodeParametersPanel";
export { LinkParametersPanel, LINK_PANEL_ID } from "./LinkParametersPanel";

export function ParametersHost() {
  const editor = useActiveEditor();
  const view = useEditorView(editor);
  return (
    <>
      {view.parameterEditorTarget ? <NodeParametersPanel key={`${editor.tabId}-node`} editor={editor} targetID={view.parameterEditorTarget} /> : null}
      {view.linkParameterEditorTarget ? <LinkParametersPanel key={`${editor.tabId}-link`} editor={editor} targetID={view.linkParameterEditorTarget} /> : null}
    </>
  );
}
