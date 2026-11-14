// The docked Inspector pane (0.90.34 InspectorPaneView.swift, ledger 4.1): a selection-driven
// inspector in the right column, rendering the SAME sections the Node and Link Parameters panels do,
// over persistent drafts. Text fields commit when the last one lets go and on Return; pickers,
// steppers and picture choices commit 400 ms after the draft settles while no text field has the
// keyboard; a run of commits to one field is one ⌘Z (`performCoalescedParameterEdit`). Escape
// reverts the whole draft. Moving the selection off an invalid draft discards it, with a warning.
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Link as LinkGlyph, SquarePen } from "lucide-react";
import { Icon } from "../../components/Icon";
import { classLabel, KIND_NAMES, useActiveEditor, useEditorView, type Editor } from "../../editor";
import { useModalOpen } from "../../lib/overlays";
import { registerFocusTarget } from "../../workspace/focus";
import { PaneHeader } from "../../workspace/panes/PaneHeader";
import { useWorkspace } from "../../workspace/store";
import { commitIfIdle, commitNow, makePaneState, reloadIfIdle, revertDraft, syncSelection, targetLinkID, targetNodeID, type PaneState } from "./drafts";
import { KIND_ICONS } from "./icons";
import { LinkSections } from "./LinkSections";
import { NodeSections, useDraft } from "./NodeSections";
import { inspectorWords as w } from "./words";
import { looksClosed, PopulationSection } from "../../closed";
import { FeatureSections } from "../../extended/InspectorSections";
import "./inspector.css";

/** Pickers, steppers and picture choices commit this long after the draft settles. */
export const SETTLE_DELAY = 400;

const panes = new WeakMap<Editor, PaneState>();

/** The pane's persistent drafts for `editor` (one set per tab, as each tab had its own pane state). */
export function paneStateFor(editor: Editor): PaneState {
  let p = panes.get(editor);
  if (!p) {
    p = makePaneState();
    panes.set(editor, p);
  }
  return p;
}

const isTextField = (el: EventTarget | null): el is HTMLInputElement => el instanceof Element && el.tagName === "INPUT" && ((el as HTMLInputElement).type || "text") === "text";

export function InspectorPane() {
  const editor = useActiveEditor();
  const view = useEditorView(editor);
  const pane = paneStateFor(editor);
  const doc = useWorkspace((ws) => ws.tabs.find((t) => t.id === editor.tabId)?.document);
  const modal = useModalOpen();
  useDraft(pane.node);
  useDraft(pane.link);
  const [, rerender] = useState(0);
  const root = useRef<HTMLElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const probabilityInput = useRef<HTMLInputElement | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCommit = () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
  };
  const now = () => {
    cancelCommit();
    commitNow(editor, pane);
  };

  const nodeTarget = targetNodeID(editor);
  const linkTarget = targetLinkID(editor);

  // Selection follows the canvas: commit what is pending for the old target, then load the new one.
  useEffect(() => {
    cancelCommit();
    syncSelection(editor, pane);
    rerender((n) => n + 1);
  }, [editor, nodeTarget, linkTarget]);

  // The document changed under the pane (undo, a context menu, a panel's Save, this pane's own commit).
  useEffect(() => {
    reloadIfIdle(editor, pane);
    rerender((n) => n + 1);
  }, [editor, doc?.nodes, doc?.links, doc?.infiniteBuffers, doc?.closedPopulation]);

  // Draft changes: the readout follows 250 ms later, the commit 400 ms later if no field is typing.
  useEffect(() => {
    let lastNode = pane.node.fieldVersion;
    let lastLink = pane.link.version;
    const schedule = () => {
      cancelCommit();
      commitTimer.current = setTimeout(() => {
        commitTimer.current = null;
        commitIfIdle(editor, pane);
      }, SETTLE_DELAY);
    };
    const offNode = pane.node.subscribe(() => {
      if (pane.node.fieldVersion === lastNode) return;
      lastNode = pane.node.fieldVersion;
      pane.node.scheduleStabilityRefresh(editor);
      schedule();
    });
    const offLink = pane.link.subscribe(() => {
      if (pane.link.version === lastLink) return;
      lastLink = pane.link.version;
      schedule();
    });
    return () => {
      offNode();
      offLink();
    };
  }, [editor, pane]);

  // Window ▸ Focus Inspector: the Name field for a node, Probability for a link (INS-002, MENU-151).
  useEffect(
    () =>
      registerFocusTarget("inspector", {
        focus: () => {
          if (pane.loadedNodeID !== null) nameInput.current?.focus();
          else if (pane.loadedLinkID !== null) probabilityInput.current?.focus();
          else root.current?.querySelector<HTMLElement>("[data-focus-default]")?.focus();
        },
      }),
    [pane],
  );

  // Toggled off (or the tab's pane state replaced): write a valid pending draft (INS-015).
  useEffect(
    () => () => {
      cancelCommit();
      commitNow(editor, pane);
      pane.node.cancelStabilityRefresh();
    },
    [editor, pane],
  );

  const node = pane.loadedNodeID !== null ? editor.node(pane.loadedNodeID) : undefined;
  const link = pane.loadedLinkID !== null ? editor.link(pane.loadedLinkID) : undefined;

  const onFocus = (e: FocusEvent) => {
    if (!isTextField(e.target)) return;
    if (node) pane.node.fieldFocusCount = 1;
    if (link) pane.link.fieldFocusCount = 1;
  };
  const onBlur = (e: FocusEvent) => {
    if (!isTextField(e.target)) return;
    // Focus moving from one field to the next is not "nothing focused".
    if (isTextField(e.relatedTarget) && root.current?.contains(e.relatedTarget)) return;
    const was = (node ? pane.node.fieldFocusCount : 0) + (link ? pane.link.fieldFocusCount : 0);
    pane.node.fieldFocusCount = 0;
    pane.link.fieldFocusCount = 0;
    if (was > 0) now();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((node && pane.node.isDirty) || (link && pane.link.isDirty(editor))) {
      e.preventDefault();
      e.stopPropagation();
      cancelCommit();
      revertDraft(editor, pane);
    }
  };

  const subtitle = node ? w.nodeSubtitle(node.name, KIND_NAMES[node.kind]) : link ? w.linkSubtitle(editor.displayLabel(link), classLabel(pane.link.selectedClass)) : undefined;
  const glyph = node ? (
    <span className={`insp-kind-glyph kind-${node.kind}`} title={KIND_NAMES[node.kind]}>
      <Icon icon={KIND_ICONS[node.kind]} size={12} />
    </span>
  ) : link ? (
    <span className="insp-kind-glyph" title={w.routingLink}>
      <Icon icon={LinkGlyph} size={12} />
    </span>
  ) : null;

  return (
    <section ref={root} className="pane pane-inspector" data-pane="inspector" tabIndex={-1} aria-label={w.title}>
      <PaneHeader pane="inspector" title={w.title} subtitle={subtitle} accessory={glyph}>
        <button
          type="button"
          className="icon-btn"
          aria-label={w.editInSheet}
          title={w.editInSheetHelp}
          disabled={!editor.canOpenParameterEditor || modal || view.parameterEditorTarget !== null || view.linkParameterEditorTarget !== null}
          onClick={() => {
            now();
            editor.openParameterEditorForSelection();
          }}
        >
          <Icon icon={SquarePen} size={14} />
        </button>
      </PaneHeader>
      <div className="insp-body" onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown}>
        {node ? (
          <form className="insp-form is-pane" onSubmit={(e) => e.preventDefault()} aria-label={subtitle}>
            <NodeSections
              editor={editor}
              model={pane.node}
              node={node}
              host="pane"
              nameRef={(el) => (nameInput.current = el)}
              onSubmit={now}
              onOpenLink={(id) => {
                now();
                editor.setView({ selectedLinkID: id, selectedNodeID: null, selectedNodeIDs: new Set() });
              }}
            />
            {/* New in 2.1: a station's order of service; a source's batches and rate over time. */}
            <FeatureSections editor={editor} node={node} />
          </form>
        ) : link ? (
          <form className="insp-form is-pane" onSubmit={(e) => e.preventDefault()} aria-label={subtitle}>
            <LinkSections
              editor={editor}
              model={pane.link}
              link={link}
              host="pane"
              probabilityRef={(el) => (probabilityInput.current = el)}
              onSubmit={now}
              onOpenSibling={(id) => {
                now();
                editor.setView({ selectedLinkID: id, selectedNodeID: null });
              }}
            />
          </form>
        ) : looksClosed(editor.nodes) ? (
          // Nothing selected in a closed network (or one drawn like it): its population (new in 2.1).
          <PopulationSection editor={editor} />
        ) : (
          <div className="pane-empty insp-empty" tabIndex={0} data-focus-default>
            <Icon icon={SquarePen} size={32} />
            <h3>{w.emptyTitle}</h3>
            <p className="muted">{w.emptyMessage}</p>
          </div>
        )}
      </div>
    </section>
  );
}
