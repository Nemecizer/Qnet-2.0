// The link inspector's sections — Routing (probability, the sibling table, Balance to 1) and
// Customer class (entry and exit) — rendered alike by the Link Parameters panel and the docked pane
// (0.90.34 LinkInspectorSections.swift, ledger INS-108…123). `onOpenSibling` is what a sibling row does.
import { OverrideMark } from "../../scenarios/OverrideMark";
import { ChevronRight } from "lucide-react";
import type { BnetLink } from "../../lib/bnet";
import { classLabel, type Editor } from "../../editor";
import { Icon } from "../../components/Icon";
import { formatSig, parseNumber, READOUT_DIGITS } from "./distributions";
import { SAME_AS_ENTRY, type LinkParameterDraft } from "./drafts";
import { ClassChip, ExitClassTag, GlossaryButton, InlineMessage, MenuPicker, NumericField, Row } from "./fields";
import { Section, useDraft, type InspectorHost } from "./NodeSections";
import { glossary as g, inspectorWords as w } from "./words";

const f5 = (v: number) => formatSig(v, READOUT_DIGITS);
const unbalanced = (t: number) => Math.abs(t - 1) > 1e-6;

export interface LinkSectionsProps {
  editor: Editor;
  model: LinkParameterDraft;
  link: BnetLink;
  host: InspectorHost;
  probabilityRef?: (el: HTMLInputElement | null) => void;
  onOpenSibling?: (linkID: string) => void;
  onSubmit?: () => void;
}

export function LinkSections(props: LinkSectionsProps) {
  useDraft(props.model);
  return (
    <>
      <RoutingSection {...props} />
      <ClassSection {...props} />
    </>
  );
}

function SiblingRow({ label, value, exitClass, onOpen }: { label: string; value: number; exitClass: number | null; onOpen?: () => void }) {
  const body = (
    <>
      <span className="insp-route-name">{label}</span>
      {exitClass !== null ? <ExitClassTag exitClass={exitClass} /> : null}
      <span className="spacer" />
      <span className="insp-route-p">{f5(value)}</span>
      <span className={onOpen ? "insp-chevron" : "insp-chevron is-hidden"} aria-hidden="true">
        <Icon icon={ChevronRight} size={12} />
      </span>
    </>
  );
  const spoken = w.siblingA11y(label, f5(value));
  if (onOpen)
    return (
      <button type="button" className="insp-route-row" title={w.siblingHelp(label)} aria-label={spoken} aria-description={w.siblingHint} onClick={onOpen}>
        {body}
      </button>
    );
  return (
    <div className="insp-route-row" aria-label={spoken} role="group">
      {body}
    </div>
  );
}

function RoutingSection({ editor, model, link, probabilityRef, onOpenSibling, onSubmit }: LinkSectionsProps) {
  const fromName = editor.node(link.fromNodeID)?.name ?? "?";
  const siblings = model.siblings(editor);
  const thisP = parseNumber(model.probabilityText);
  const { siblingSum, total, remainder, enabled } = model.balanceState(editor);
  const cls = classLabel(model.selectedClass);
  const target = f5(Math.max(remainder, 0));
  const balanceWhy = !unbalanced(total) ? w.balanceDone(fromName, cls) : remainder < 0 ? w.balanceOver : w.balanceDo(target, fromName, cls);
  let totalMessage: string | null = null;
  if (model.probabilityError === null && unbalanced(total)) {
    totalMessage = total > 1 ? w.linkOverOne(fromName, cls, f5(total)) : w.linkUnderOne(fromName, cls, f5(total), f5((1 - total) * 100), siblings.length === 0);
  }
  void siblingSum;
  const exit = model.effectiveExitClass;
  return (
    <Section title={w.routing} footer={w.linkRoutingFooter(siblings.length > 0)}>
      <NumericField
        label={w.probability}
        value={model.probabilityText}
        onChange={(t) => model.setProbability(t)}
        range={[0, 1]}
        step={0.05}
        error={model.probabilityError}
        help={w.probabilityHelp(cls, fromName)}
        glossary={g.routingProbability}
        placeholder="1"
        width="narrow"
        ariaLabel={w.probabilityA11y}
        inputRef={probabilityRef}
        onSubmit={onSubmit}
        dataField="probability"
      />
      <OverrideMark editor={editor} link={link.id} field="routingProbability" />
      <div className="insp-siblings">
        <div className="insp-siblings-title">{w.siblingsTitle(fromName, cls)}</div>
        <div className="insp-routes" role="group" aria-label={w.siblingsA11y(f5(total))}>
          {siblings.map((s) => (
            <SiblingRow key={s.id} label={editor.displayLabel(s)} value={s.routingProbability} exitClass={s.toCustomerClass !== undefined && s.toCustomerClass !== s.customerClass ? s.toCustomerClass : null} onOpen={onOpenSibling ? () => onOpenSibling(s.id) : undefined} />
          ))}
          <div className="insp-route-row is-current" aria-label={`${w.thisLink(editor.displayLabel(link))}, probability ${thisP !== null ? f5(thisP) : w.notANumber}`} role="group">
            <span className="insp-route-name">{w.thisLink(editor.displayLabel(link))}</span>
            {exit !== model.selectedClass ? <ExitClassTag exitClass={exit} /> : null}
            <span className="spacer" />
            <span className={`insp-route-p${thisP === null ? " is-unknown" : ""}`}>{thisP !== null ? f5(thisP) : "—"}</span>
            <span className="insp-chevron is-hidden" aria-hidden="true">
              <Icon icon={ChevronRight} size={12} />
            </span>
          </div>
          <div className="insp-route-total">
            <span className="insp-total-label">{w.totalRow}</span>
            <span className="spacer" />
            <button type="button" className="btn btn-small" disabled={!enabled} title={balanceWhy} aria-description={w.balanceHint(target)} onClick={() => model.balance(editor)}>
              {w.balance}
            </button>
            <span className={`insp-route-p${unbalanced(total) ? " is-warning" : ""}`}>{f5(total)}</span>
          </div>
        </div>
        <InlineMessage message={totalMessage} severity="warning" />
      </div>
    </Section>
  );
}

function ClassSection({ editor, model, link }: LinkSectionsProps) {
  const count = Math.max(editor.numberOfCustomerClasses, 1);
  const used = editor.entryClassesUsedByOtherLinks(link.id);
  const entryOptions = Array.from({ length: count }, (_, i) => ({ value: i, label: classLabel(i), disabled: used.has(i) }));
  const exitOptions = [
    { value: SAME_AS_ENTRY, label: w.sameAsEntryOf(classLabel(model.selectedClass)) },
    ...Array.from({ length: count }, (_, i) => ({ value: i, label: classLabel(i) })),
    { value: count, label: `${classLabel(count)} ${w.newClass}` },
  ];
  // A stored exit beyond the menu (a class that has since gone) still shows as itself.
  if (model.exitSelection > count) exitOptions.push({ value: model.exitSelection, label: `${classLabel(model.exitSelection)} ${w.newShort}` });
  const exit = model.effectiveExitClass;
  return (
    <Section
      title={w.customerClass}
      header={<GlossaryButton label={w.customerClass} text={g.customerClass} />}
      footer={exit !== model.selectedClass ? w.transitionFooter(classLabel(model.selectedClass), classLabel(exit)) : w.keepFooter}
    >
      <Row label={w.entryClass}>
        <span className="insp-class-pick">
          <ClassChip index={model.selectedClass} />
          <MenuPicker
            bare
            label={w.entryClass}
            ariaLabel={w.entryClassA11y(classLabel(model.selectedClass))}
            value={model.selectedClass}
            options={entryOptions}
            onChange={(c) => (model.entryClass = c)}
            help={w.entryClassHelp(editor.displayLabel(link))}
          />
        </span>
      </Row>
      {used.size ? <p className="insp-caption">{w.unavailable([...used].sort((a, b) => a - b).map(classLabel).join(", "))}</p> : null}
      <Row label={w.exitClass}>
        <span className="insp-class-pick">
          {model.exitSelection === SAME_AS_ENTRY ? null : <ClassChip index={model.exitSelection} />}
          <MenuPicker
            bare
            label={w.exitClass}
            ariaLabel={w.exitClassA11y(model.exitSelection === SAME_AS_ENTRY ? w.sameAsEntryLower : classLabel(model.exitSelection))}
            value={model.exitSelection}
            options={exitOptions}
            onChange={(c) => (model.exitClass = c === SAME_AS_ENTRY ? "same" : c)}
            help={w.exitClassHelp}
          />
        </span>
      </Row>
    </Section>
  );
}
