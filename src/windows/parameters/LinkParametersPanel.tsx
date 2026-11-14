// The Link Parameters panel (0.90.34 LinkParameterEditorSheet.swift, ledger 4.10): the link
// inspector's sections in a movable, document-modal panel, wide band, never rebanded. Sibling rows
// switch it in place behind the same Save / Don't Save / Cancel guard as the node panel.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link as LinkGlyph } from "lucide-react";
import { Icon } from "../../components/Icon";
import { classLabel, type Editor } from "../../editor";
import { bringPanelForward, PanelWindow } from "../../lib/panel";
import { useWorkspace } from "../../workspace/store";
import { LinkParameterDraft } from "../../panes/inspector/drafts";
import { classColor, InlineMessage } from "../../panes/inspector/fields";
import { LinkSections } from "../../panes/inspector/LinkSections";
import { useDraft } from "../../panes/inspector/NodeSections";
import { panelWords as w } from "../../panes/inspector/words";
import { MissingTarget, PanelFooter, PanelHeader, UnsavedPrompt } from "./chrome";

export const LINK_PANEL_ID = "link-parameters";

type Pending = { kind: "navigate"; id: string } | { kind: "close" };

export function LinkParametersPanel({ editor, targetID }: { editor: Editor; targetID: string }) {
  const model = useMemo(() => new LinkParameterDraft(), []);
  const [linkID, setLinkID] = useState(targetID);
  const [pending, setPending] = useState<Pending | null>(null);
  const isClosing = useRef(false);
  const probInput = useRef<HTMLInputElement | null>(null);
  const focusProb = useRef(true);
  useDraft(model);
  useWorkspace((ws) => ws.tabs.find((t) => t.id === editor.tabId)?.document);

  useEffect(() => {
    model.load(editor, linkID);
    focusProb.current = true;
    if (probInput.current) {
      focusProb.current = false;
      probInput.current.focus();
    }
  }, [linkID]);

  useEffect(() => {
    if (targetID === linkID) return;
    bringPanelForward(LINK_PANEL_ID);
    requestNavigation(targetID);
  }, [targetID]);

  const link = editor.link(linkID);
  const valid = model.isValid(editor);
  const dirty = model.isDirty(editor);

  function switchLink(id: string) {
    editor.setView({ selectedLinkID: id, selectedNodeID: null, linkParameterEditorTarget: id });
    setLinkID(id);
  }
  function requestNavigation(id: string) {
    if (!editor.link(id)) return;
    if (!model.isDirty(editor)) switchLink(id);
    else setPending({ kind: "navigate", id });
  }
  function close() {
    isClosing.current = true;
    editor.closeLinkParameterEditor();
  }
  function requestClose() {
    if (!model.isDirty(editor)) return close();
    setPending({ kind: "close" });
  }
  function perform() {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (p.kind === "navigate") switchLink(p.id);
    else close();
  }
  function save() {
    if (model.commit(editor)) close();
  }

  let body;
  if (!link) {
    body = <MissingTarget message={w.linkGone} onClose={close} />;
  } else {
    const label = editor.displayLabel(link);
    const exit = model.effectiveExitClass;
    const subtitle = w.linkSubtitle(classLabel(model.selectedClass), exit !== model.selectedClass ? classLabel(exit) : null);
    const problem = model.firstProblem(editor);
    body = (
      <div
        className="panel-form"
        onKeyDown={(e) => {
          if (e.defaultPrevented) return;
          if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            requestClose();
          } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
            const t = e.target as HTMLElement;
            if (t.tagName === "BUTTON" || t.tagName === "SELECT") return;
            e.preventDefault();
            if (valid) save();
          }
        }}
      >
        <PanelHeader
          glyph={
            <span className="panel-link-glyph" style={{ ["--chip" as string]: classColor(model.selectedClass) }}>
              <Icon icon={LinkGlyph} size={20} />
            </span>
          }
          title={label}
          subtitle={subtitle}
          a11y={w.linkHeaderA11y(label, subtitle)}
        />
        <div className="panel-content">
          <form className="insp-form is-sheet" onSubmit={(e) => e.preventDefault()} aria-label={label}>
            <LinkSections
              editor={editor}
              model={model}
              link={link}
              host="sheet"
              probabilityRef={(el) => {
                probInput.current = el;
                if (el && focusProb.current) {
                  focusProb.current = false;
                  el.focus();
                }
              }}
              onOpenSibling={requestNavigation}
            />
          </form>
        </div>
        <PanelFooter
          problem={problem}
          leading={<InlineMessage message={model.pendingNote} severity="pending" />}
          confirmTitle={w.save}
          canConfirm={valid}
          cancelHelp={dirty ? w.cancelHelpDirty : w.cancelHelp}
          confirmHelp={w.saveHelp}
          blockedHelp={model.pendingNote ?? w.blockedHelp}
          onCancel={requestClose}
          onConfirm={save}
        />
        {pending ? (
          <UnsavedPrompt
            title={w.promptTitle(label, pending.kind === "close")}
            message={valid ? w.promptMessage("link") : w.promptInvalid("link", problem ?? model.pendingNote ?? w.incomplete)}
            canSave={valid}
            onSave={() => {
              if (model.commit(editor)) perform();
              else setPending(null);
            }}
            onDiscard={perform}
            onCancel={() => setPending(null)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <PanelWindow
      id={LINK_PANEL_ID}
      title={w.linkTitle}
      band="wide"
      modality="document"
      escapeCloses={false}
      closeGuard={() => {
        if (isClosing.current || !model.isDirty(editor)) return true;
        setPending({ kind: "close" });
        return false;
      }}
      onClose={() => editor.closeLinkParameterEditor()}
    >
      {body}
    </PanelWindow>
  );
}
