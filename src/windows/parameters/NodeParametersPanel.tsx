// The Node Parameters panel, ⌘I (0.90.34 NodeParameterEditorSheet.swift in its DSPanelWindow,
// ledger 4.8): the node inspector's sections in a movable, document-modal panel with Previous /
// Next, Cancel (Escape) and Save (Return). Save commits the whole draft as one undo step. One
// unsaved-changes guard covers stepping, retargeting from the canvas, Cancel, a Routing row and the
// window's own close. The panel opens on `editor.view.parameterEditorTarget`; the draft and the
// prompt live here, above the window, so a refused close that had already taken the window away
// brings back the same form.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Icon } from "../../components/Icon";
import { classLabel, KIND_NAMES, type Editor } from "../../editor";
import { stationPicture } from "../../editor/pictures";
import { bringPanelForward, PanelWindow, rebandPanel } from "../../lib/panel";
import { useWorkspace } from "../../workspace/store";
import { formatSig, parseInteger } from "../../panes/inspector/distributions";
import { NodeParameterDraft } from "../../panes/inspector/drafts";
import { InlineMessage } from "../../panes/inspector/fields";
import { KIND_ICONS } from "../../panes/inspector/icons";
import { NodeSections, useDraft } from "../../panes/inspector/NodeSections";
import { inspectorWords as iw, panelWords as w } from "../../panes/inspector/words";
import { FeatureSections } from "../../extended/InspectorSections";
import { MissingTarget, PanelFooter, PanelHeader, settleDelay, UnsavedPrompt } from "./chrome";
import { nodePanelBand, nodePanelHeight } from "./sizes";

export const NODE_PANEL_ID = "node-parameters";

type Pending = { kind: "navigate"; id: string } | { kind: "close" };

export function NodeParametersPanel({ editor, targetID }: { editor: Editor; targetID: string }) {
  const model = useMemo(() => new NodeParameterDraft(), []);
  const [nodeID, setNodeID] = useState(targetID);
  const [pending, setPending] = useState<Pending | null>(null);
  const linkToOpen = useRef<string | null>(null);
  const isClosing = useRef(false);
  const nameInput = useRef<HTMLInputElement | null>(null);
  // The Name field takes the keyboard when the panel opens and after every step (INS-099, INS-104).
  const focusName = useRef(true);
  useDraft(model);
  useWorkspace((ws) => ws.tabs.find((t) => t.id === editor.tabId)?.document);
  // The band and the opening height are decided once, for the sibling order (INS-106, INS-107).
  const [opening] = useState(() => ({ band: nodePanelBand(editor, targetID), height: nodePanelHeight(editor, targetID) }));

  useEffect(() => {
    model.load(editor, nodeID);
    focusName.current = true;
    if (nameInput.current) {
      focusName.current = false;
      nameInput.current.focus();
    }
  }, [nodeID]);
  useEffect(() => () => model.cancelStabilityRefresh(), []);
  // The draft changes: the readout follows 250 ms later.
  useEffect(() => {
    let last = model.fieldVersion;
    return model.subscribe(() => {
      if (model.fieldVersion === last) return;
      last = model.fieldVersion;
      model.scheduleStabilityRefresh(editor);
    });
  }, [model]);

  // Retargeted from the canvas while open: forward, rebanded, through the guard (INS-093).
  useEffect(() => {
    if (targetID === nodeID) return;
    bringPanelForward(NODE_PANEL_ID);
    rebandPanel(NODE_PANEL_ID, nodePanelBand(editor, targetID));
    if (!editor.node(targetID)) return;
    if (!model.isDirty) switchNode(targetID);
    else setPending({ kind: "navigate", id: targetID });
  }, [targetID]);

  const node = editor.node(nodeID);
  const valid = model.isValid(editor);

  function switchNode(id: string) {
    // The editor's target follows the panel, so a later ⌘I or double-click on the first node retargets it.
    editor.setView({ selectedNodeID: id, selectedLinkID: null, selectedNodeIDs: new Set(), parameterEditorTarget: id });
    setNodeID(id);
    if (id === nodeID) {
      model.load(editor, id);
      nameInput.current?.focus();
    }
  }

  function close() {
    const link = linkToOpen.current;
    linkToOpen.current = null;
    isClosing.current = true;
    editor.closeParameterEditor();
    if (link) setTimeout(() => editor.openLinkParameterEditor(link), settleDelay());
  }

  function requestClose() {
    if (!model.isDirty) return close();
    setPending({ kind: "close" });
  }

  function perform() {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (p.kind === "navigate") switchNode(p.id);
    else close();
  }

  const neighbour = (offset: number) => editor.nodeAdjacentInInspectorOrder(nodeID, offset);
  function navigate(offset: number) {
    const target = neighbour(offset);
    if (!target) return; // INS-174: the buttons are disabled at the ends, so 0.90.34's beep is unreachable.
    if (!model.isDirty) switchNode(target.id);
    else setPending({ kind: "navigate", id: target.id });
  }

  function save() {
    if (model.commit(editor)) close();
  }

  const problem = node ? model.firstProblem(editor) : null;
  const pendingNote = node ? model.pendingNote(editor) : null;

  let body;
  if (!node) {
    body = (
      <MissingTarget
        message={w.nodeGone}
        onClose={() => {
          isClosing.current = true;
          editor.closeParameterEditor();
        }}
      />
    );
  } else {
    const kindName = KIND_NAMES[node.kind].toLowerCase();
    const order = editor.inspectorNavigationOrder(node.kind);
    const position = order.findIndex((n) => n.id === nodeID) + 1;
    const prev = neighbour(-1);
    const next = neighbour(1);
    const shownName = model.nameText.trim() ? model.nameText : node.name;
    const pic = node.kind === "station" ? stationPicture(model.stationPicture) : null;
    const Glyph = pic?.icon ?? KIND_ICONS[node.kind];
    const subtitle = (() => {
      switch (node.kind) {
        case "station": {
          const servers = parseInteger(model.serversText) ?? node.numberOfServers;
          const rho = model.stability?.utilisation ?? null;
          return w.stationSubtitle(servers, model.servedClasses.length, rho !== null ? formatSig(rho, 3) : null);
        }
        case "buffer":
          return model.infiniteBuffersDraft ? w.bufferInfinite : w.bufferSubtitle(parseInteger(model.bufferSizeText) ?? node.bufferSize);
        case "source":
          return w.sourceSubtitle(classLabel(editor.customerClassIndex(node.id)));
        case "sink":
          return w.sinkSubtitle;
      }
    })();
    const bulk = model.bulkUndo && model.bulkUndoIsLive ? model.bulkUndo : null;
    body = (
      <div
        className="panel-form"
        onKeyDown={(e) => {
          if (e.defaultPrevented) return;
          if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            navigate(e.key === "ArrowUp" ? -1 : 1);
          } else if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            requestClose();
          } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
            const t = e.target as HTMLElement;
            if (t.tagName === "BUTTON" || t.tagName === "SELECT" || t.getAttribute("role") === "option") return;
            e.preventDefault();
            if (valid) save();
          }
        }}
      >
        <PanelHeader glyph={<Icon icon={Glyph} size={20} />} title={shownName} subtitle={subtitle} a11y={w.headerA11y(node.name, KIND_NAMES[node.kind])}>
          {prev || next ? (
            <div className="panel-steps" role="group" aria-label={w.stepGroup(kindName)}>
              {position > 0 ? (
                <span title={w.positionHelp(kindName, position, order.length)} aria-label={w.positionA11y(kindName, position, order.length)}>
                  {w.position(position, order.length)}
                </span>
              ) : null}
              <button type="button" className="icon-btn" aria-label={w.previous(kindName)} title={prev ? w.stepHelp(prev.name, "⌥↑") : w.noPrevious(kindName)} disabled={!prev} onClick={() => navigate(-1)}>
                <Icon icon={ArrowUp} size={14} />
              </button>
              <button type="button" className="icon-btn" aria-label={w.next(kindName)} title={next ? w.stepHelp(next.name, "⌥↓") : w.noNext(kindName)} disabled={!next} onClick={() => navigate(1)}>
                <Icon icon={ArrowDown} size={14} />
              </button>
            </div>
          ) : null}
        </PanelHeader>
        <div className="panel-content">
          <form className="insp-form is-sheet" onSubmit={(e) => e.preventDefault()} aria-label={shownName}>
            <NodeSections
              editor={editor}
              model={model}
              node={node}
              host="sheet"
              nameRef={(el) => {
                nameInput.current = el;
                if (el && focusName.current) {
                  focusName.current = false;
                  el.focus();
                }
              }}
              onOpenLink={(id) => {
                linkToOpen.current = id;
                requestClose();
              }}
            />
            {/* New in 2.1, as in the docked Inspector: a station's order of service; a source's
                batches and rate over time. They write the document at once (not on Save). */}
            <FeatureSections editor={editor} node={node} host="sheet" />
          </form>
        </div>
        <PanelFooter
          problem={problem}
          leading={
            bulk ? (
              <span className="panel-bulk" role="group" aria-label={iw.bulkA11y(bulk.announcement)}>
                <span>{bulk.announcement}</span>
                <button type="button" className="btn btn-small" title={iw.bulkUndoHelp} onClick={() => model.revertBulk()}>
                  {iw.bulkUndo(bulk.actionName)}
                </button>
              </span>
            ) : (
              <InlineMessage message={pendingNote} severity="pending" />
            )
          }
          confirmTitle={w.save}
          canConfirm={valid}
          cancelHelp={model.isDirty ? w.cancelHelpDirty : w.cancelHelp}
          confirmHelp={w.saveHelp}
          blockedHelp={pendingNote ?? w.blockedHelp}
          onCancel={requestClose}
          onConfirm={save}
        />
        {pending ? (
          <UnsavedPrompt
            title={w.promptTitle(node.name, pending.kind === "close")}
            message={valid ? w.promptMessage("node") : w.promptInvalid("node", problem ?? pendingNote ?? w.incomplete)}
            canSave={valid}
            onSave={() => {
              if (model.commit(editor)) perform();
              else setPending(null);
            }}
            onDiscard={perform}
            onCancel={() => {
              setPending(null);
              linkToOpen.current = null;
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <PanelWindow
      id={NODE_PANEL_ID}
      title={w.nodeTitle}
      band={opening.band}
      idealHeight={opening.height}
      modality="document"
      escapeCloses={false}
      closeGuard={() => {
        if (isClosing.current || !model.isDirty) return true;
        setPending({ kind: "close" });
        return false;
      }}
      onClose={() => editor.closeParameterEditor()}
    >
      {body}
    </PanelWindow>
  );
}
