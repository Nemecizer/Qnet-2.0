// A pane's header (DSSectionHeader: title, trailing controls, the 2-pt accent focus rule, ledger
// WS-013) and the one window control every header ends with (PaneSoloButton, WS-061, WS-085,
// WS-097): Maximize <pane> Pane / Restore Pane Layout while docked, Return <pane> to the Main Window
// while detached (Tools has none). Other areas' panes (Status, and P5–P7's) use both.
import type { ReactNode } from "react";
import { LogOut, Maximize2, Minimize2 } from "lucide-react";
import { Icon } from "../../components/Icon";
import { useSetting } from "../../lib/kv";
import { shortcutFor } from "../../lib/menu";
import type { PaneId } from "../focus";
import { useFocusedPane } from "./focusState";
import { DETACHED_KEY, isDetached, SOLO_KEY, soloedPane, setDetached, toggleSolo } from "./model";
import { PANE_NAME, paneWords } from "./words";

export function PaneHeader({ pane, title, subtitle, accessory, children }: { pane: PaneId; title?: string; subtitle?: string; accessory?: ReactNode; children?: ReactNode }) {
  const focused = useFocusedPane() === pane;
  return (
    <header className="pane-header" data-focused={focused || undefined}>
      <div className="pane-header-row">
        <h2 className="pane-header-title">{title ?? PANE_NAME[pane]}</h2>
        {accessory}
        <span className="spacer" />
        <div className="pane-header-trailing">
          {children}
          {pane === "tools" ? null : <PaneWindowButton pane={pane} />}
        </div>
      </div>
      {subtitle ? <div className="pane-header-subtitle" title={subtitle}>{subtitle}</div> : null}
    </header>
  );
}

/** What the header's window control does and says now (pure, for the tests). */
export function windowButtonState(pane: PaneId, detached: boolean, maximized: boolean, key: string) {
  const name = PANE_NAME[pane];
  if (detached) return { kind: "return" as const, label: paneWords.soloReturn(name), help: paneWords.soloReturnHelp(name) };
  if (maximized) return { kind: "restore" as const, label: paneWords.soloRestore, help: paneWords.soloRestoreHelp(key) };
  return { kind: "maximize" as const, label: paneWords.soloMaximize(name), help: paneWords.soloMaximizeHelp(name, key) };
}

export function PaneWindowButton({ pane }: { pane: PaneId }) {
  // Re-render when either key changes.
  useSetting(SOLO_KEY, "");
  useSetting(DETACHED_KEY, "");
  const detached = isDetached(pane);
  const s = windowButtonState(pane, detached, soloedPane() === pane, shortcutFor("view:maximize-pane") ?? "⌃⌘↩");
  const glyph = s.kind === "return" ? LogOut : s.kind === "restore" ? Minimize2 : Maximize2;
  return (
    <button
      type="button"
      className="icon-btn pane-window-btn"
      aria-label={s.label}
      title={s.help}
      data-window-control={s.kind}
      onClick={() => void (detached ? setDetached(pane, false) : toggleSolo(pane))}
    >
      <Icon icon={glyph} size={14} />
    </button>
  );
}
