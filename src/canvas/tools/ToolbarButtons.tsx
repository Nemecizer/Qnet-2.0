// The workspace toolbar's canvas items (0.90.34 ContentView.swift `.toolbar(id: "qnet.main")`,
// ledger TB-002…004, WS-012): Straighten Network and Zoom to Fit, before the workspace controls.
// Snap to Grid was `showsByDefault: false` and 2.0's toolbar has no customisation (TB-001), so it
// isn't shown; View ▸ Snap to Grid, the zoom cluster and the canvas menu carry it.
import { Expand, MoveHorizontal } from "lucide-react";
import { Icon } from "../../components/Icon";
import { activeEditor } from "../../editor";
import { getCommand, runCommand, unavailableReason } from "../../lib/commands";
import { shortcutFor } from "../../lib/menu";
import { activeTab, useWorkspace } from "../../workspace/store";
import { interactionWords as w } from "../interaction/words";

/** Straighten: the Network menu's command when it can run, else the editor's own call, which says "Nothing to straighten." (the toolbar item was never disabled). */
export function straightenFromToolbar() {
  const c = getCommand("network:straighten");
  if (c && unavailableReason(c) === null) void runCommand("network:straighten");
  else activeEditor().straightenNetwork();
}

export function CanvasToolbarButtons() {
  const hasNodes = useWorkspace((ws) => activeTab(ws).document.nodes.length > 0);
  return (
    <>
      <button
        type="button"
        className="icon-btn toolbar-btn"
        aria-label={w.straighten}
        title={w.straightenHelp}
        data-toolbar-item="straighten"
        onMouseDown={(e) => e.preventDefault()}
        onClick={straightenFromToolbar}
      >
        <Icon icon={MoveHorizontal} size={16} />
      </button>
      <button
        type="button"
        className="icon-btn toolbar-btn"
        aria-label={w.zoomToFit}
        title={w.zoomToFitToolbarHelp(shortcutFor("view:zoom-to-fit") ?? "⇧⌘0")}
        data-toolbar-item="fit"
        disabled={!hasNodes}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => activeEditor().zoomToFit()}
      >
        <Icon icon={Expand} size={16} />
      </button>
    </>
  );
}
