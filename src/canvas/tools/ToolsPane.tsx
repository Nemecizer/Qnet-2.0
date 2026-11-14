// The Tools pane (0.90.34 ToolPaletteView.swift, ledger CAN-003…007, KEY-020, MENU-147): the
// "Tools" header, then the eight tools in three groups (selection · nodes in flow order · link)
// with rules between, each a button with its icon, its short label and a keycap with its letter,
// the long tooltip, the selected style on the active tool. Window ▸ Focus Tools (⌃⌘1) puts the
// keyboard on the selected tool's button; the arrow keys then move between the buttons and Space or
// Return picks one.
import { Fragment, useRef, type KeyboardEvent } from "react";
import { useActiveEditor, useEditorView, type EditorTool } from "../../editor";
import { Icon } from "../../components/Icon";
import { useFocusTarget } from "../../workspace/focus";
import { PaneHeader } from "../../workspace/panes/PaneHeader";
import { PALETTE_GROUPS, TOOL_ICON, toolKey } from "../interaction/tools";
import { interactionWords as w } from "../interaction/words";
import "./tools.css";

const ORDER = PALETTE_GROUPS.flat();

export function ToolsPane() {
  const editor = useActiveEditor();
  const view = useEditorView(editor);
  const root = useRef<HTMLElement>(null);
  const button = (t: EditorTool) => root.current?.querySelector<HTMLButtonElement>(`[data-tool="${t}"]`) ?? null;
  useFocusTarget("tools", { focus: () => button(editor.view.tool)?.focus() }, [editor]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
    if (dir === null) return;
    const at = ORDER.findIndex((t) => button(t) === document.activeElement);
    const next = dir === "first" ? 0 : dir === "last" ? ORDER.length - 1 : (at < 0 ? 0 : (at + dir + ORDER.length) % ORDER.length);
    e.preventDefault();
    button(ORDER[next])?.focus();
  };

  return (
    <section ref={root} className="pane pane-tools" data-pane="tools" tabIndex={-1} aria-label={w.toolsPane}>
      <PaneHeader pane="tools" title={w.toolsHeader} />
      <div className="tool-palette" role="toolbar" aria-orientation="vertical" aria-label={w.toolsHeader} onKeyDown={onKeyDown}>
        {PALETTE_GROUPS.map((group, gi) => (
          <Fragment key={gi}>
            {gi > 0 && <div className="tool-rule" role="separator" />}
            {group.map((t) => {
              const active = view.tool === t;
              return (
                <button
                  key={t}
                  type="button"
                  className="tool-btn"
                  data-tool={t}
                  data-selected={active || undefined}
                  aria-pressed={active}
                  aria-label={w.toolA11yLabel(w.paletteLabel[t])}
                  aria-description={w.toolA11yHint(toolKey(t))}
                  aria-keyshortcuts={toolKey(t)}
                  title={w.helpText[t]}
                  tabIndex={active ? 0 : -1}
                  data-focus-default={active || undefined}
                  onClick={() => editor.setTool(t)}
                >
                  <span className="tool-icon">
                    <Icon icon={TOOL_ICON[t]} size={14} />
                  </span>
                  <span className="tool-label">{w.paletteLabel[t]}</span>
                  <kbd className="tool-key" aria-hidden>
                    {toolKey(t)}
                  </kbd>
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
