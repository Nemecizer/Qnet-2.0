// The canvas pane (ledger CAN-164, CAN-165, WS-053): the tab bar above (it carries the canvas's
// 2-pt focus rule, WS-013), the canvas, and the canvas status bar below, which ends with the
// pane's window control (Maximize Canvas Pane / Restore Pane Layout). The canvas follows the
// active tab's editor (CAN-222): it is keyed on the tab, so a switch rebinds the gesture state,
// the camera and the subscriptions to the new tab. The pane is always mounted, so it is also where
// the canvas's commands (View zoom and snap, the Tools menu, Find Node, the tool letters) live.
import type { ReactNode } from "react";
import { TabBar } from "../workspace/tabs";
import { useActiveEditor } from "../editor";
import { useFocusedPane } from "../workspace/panes/focusState";
import { PaneWindowButton } from "../workspace/panes/PaneHeader";
import { CanvasView } from "./CanvasView";
import { useCanvasCommands } from "./commands";
import { useOutlineCommands } from "./outline";
import { FindNodeHost } from "./interaction/FindNodePanel";
import { CanvasStatusBar } from "./interaction/layers";
import { RunSegment } from "../runs/ui";

export function CanvasPane({ header }: { header?: ReactNode }) {
  const editor = useActiveEditor();
  const focused = useFocusedPane() === "canvas";
  useCanvasCommands();
  useOutlineCommands();
  return (
    <section className="canvas-pane" data-pane="canvas" aria-label="Canvas">
      <div className="canvas-tabbar" data-focused={focused || undefined}>
        <TabBar />
      </div>
      <CanvasView key={editor.tabId} editor={editor} />
      <div className="canvas-statusbar">
        <div className="canvas-statusbar-main">
          {header}
          <CanvasStatusBar editor={editor} run={<RunSegment />} />
        </div>
        <PaneWindowButton pane="canvas" />
      </div>
      <FindNodeHost />
    </section>
  );
}
