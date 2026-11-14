// Edit ▸ Find Node… (⌘F with the canvas as the target): 0.90.34's document-modal "find-node" panel
// (QnetGUIApp.swift `syncFindNodePanel`, NetworkDialogs.swift `FindNodeSheet`, ledger MENU-044,
// MENU-045, CAN-168…170). A search field that filters live, a summary, up to six matches with
// their kind, and the sheet footer: Cancel (Escape) and Find (Return), which closes the panel and
// selects and frames the first match. Escape doesn't close the window itself; the footer does.
// The list follows the document, since the canvas under a panel stays live.
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useActiveEditor } from "../../editor";
import { PanelWindow } from "../../lib/panel";
import { useWorkspace } from "../../workspace/store";
import { KIND_NAMES } from "../../editor";
import { TOOL_ICON } from "./tools";
import { Icon } from "../../components/Icon";
import { interactionWords as w } from "./words";

let open = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function openFindNode() {
  if (open) return;
  open = true;
  notify();
}

export function closeFindNode() {
  if (!open) return;
  open = false;
  notify();
}

export const findNodeOpen = () => open;

function useFindNodeOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}

const trim = (q: string) => q.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");

const KIND_ICON = { station: TOOL_ICON.addStation, buffer: TOOL_ICON.addBuffer, source: TOOL_ICON.addSource, sink: TOOL_ICON.addSink } as const;

/** Mounted by the canvas pane; renders the panel while it is open. */
export function FindNodeHost() {
  const isOpen = useFindNodeOpen();
  if (!isOpen) return null;
  return (
    <PanelWindow id="find-node" title={w.findTitle} size={[420, 320]} modality="document" escapeCloses={false} onClose={closeFindNode}>
      <FindNodeBody onDone={closeFindNode} />
    </PanelWindow>
  );
}

export function FindNodeBody({ onDone }: { onDone: () => void }) {
  const editor = useActiveEditor();
  const nodes = useWorkspace((ws) => ws.tabs.find((t) => t.id === editor.tabId)?.document.nodes ?? []);
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const q = trim(query).toLowerCase();
  const matches = q ? nodes.filter((n) => n.name.toLowerCase().includes(q)) : [];
  const summary = !trim(query) ? w.findOnCanvas(nodes.length) : matches.length === 0 ? w.findNoMatch(trim(query)) : w.findMatches(matches.length);
  const submit = () => {
    if (!matches.length) return;
    onDone();
    editor.findAndRevealNode(query);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="find-node" onKeyDown={onKeyDown}>
      <header className="find-node-header">
        <h2>{w.findTitle}</h2>
        <p className="muted">{w.findSubtitle}</p>
      </header>
      <div className="find-node-body">
        <input
          ref={field}
          type="search"
          className="find-node-field"
          placeholder={w.findPlaceholder}
          title={w.findFieldHelp}
          aria-label={w.findFieldLabel}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="find-node-summary" aria-live="polite">{summary}</p>
        {matches.length > 0 && (
          <ul className="find-node-matches">
            {matches.slice(0, 6).map((n) => (
              <li key={n.id}>
                <Icon icon={KIND_ICON[n.kind]} size={12} />
                <span>{n.name}</span>
                <span className="muted">{KIND_NAMES[n.kind]}</span>
              </li>
            ))}
            {matches.length > 6 && <li className="muted">{w.findMore(matches.length - 6)}</li>}
          </ul>
        )}
      </div>
      <footer className="find-node-footer">
        <button type="button" className="btn" aria-keyshortcuts="Escape" title={w.findCancelHelp} onClick={onDone}>
          {w.findCancel}
        </button>
        <button type="button" className="btn primary" aria-keyshortcuts="Enter" title={matches.length ? w.findConfirmHelp : w.findBlockedHelp} disabled={!matches.length} onClick={submit}>
          {w.findConfirm}
        </button>
      </footer>
    </div>
  );
}
