// Everything the link inspector edits (0.90.34 LinkInspectorSections.swift `LinkParameterDraft`,
// ledger INS-108…122), shared by the Link Parameters panel (commits on Save) and the docked pane
// (commits on blur). The same load / dirty / commit contract as NodeDraft.
import type { BnetLink } from "../../../lib/bnet";
import { classLabel, type Editor } from "../../../editor";
import { fieldText, formatSig, isPartialNumber, parseNumber, READOUT_DIGITS } from "../distributions";
import { inspectorWords as w } from "../words";

/** The exit menu's "Same as entry": no class transition. */
export const SAME_AS_ENTRY = -1;

interface Snapshot {
  probability: string;
  entryClass: number;
  exit: number;
}

export class LinkParameterDraft {
  linkID: string | null = null;
  probabilityText = "1";
  selectedClass = 0;
  /** SAME_AS_ENTRY, or the exit class (the class count itself is a new derived class). */
  exitSelection = SAME_AS_ENTRY;
  fieldFocusCount = 0;
  version = 0;
  private baseline: Snapshot = { probability: "", entryClass: 0, exit: SAME_AS_ENTRY };
  private listeners = new Set<() => void>();

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  changed() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  update(f: (d: this) => void) {
    f(this);
    this.changed();
  }

  private get current(): Snapshot {
    return { probability: this.probabilityText, entryClass: this.selectedClass, exit: this.exitSelection };
  }

  load(editor: Editor, linkID: string) {
    this.linkID = linkID;
    this.fieldFocusCount = 0;
    const link = editor.link(linkID);
    if (link) {
      this.probabilityText = fieldText(link.routingProbability);
      this.selectedClass = link.customerClass ?? 0;
      this.exitSelection = link.toCustomerClass ?? SAME_AS_ENTRY;
      this.baseline = this.current;
    }
    this.changed();
  }

  revertToBaseline() {
    if (this.linkID === null) return;
    this.probabilityText = this.baseline.probability;
    this.selectedClass = this.baseline.entryClass;
    this.exitSelection = this.baseline.exit;
    this.changed();
  }

  /** The entry class menu. */
  get entryClass(): number {
    return this.selectedClass;
  }
  set entryClass(c: number) {
    this.selectedClass = c;
    this.changed();
  }

  /** The exit class menu: a class index (the class count is a new one), or "same". */
  get exitClass(): number | "same" {
    return this.exitSelection === SAME_AS_ENTRY ? "same" : this.exitSelection;
  }
  set exitClass(c: number | "same") {
    this.exitSelection = c === "same" ? SAME_AS_ENTRY : c;
    this.changed();
  }

  /** The probability field. */
  setProbability(text: string) {
    this.probabilityText = text;
    this.changed();
  }

  /** The links whose probabilities sum with this one: same origin, the entry class the menu shows (INS-111). */
  siblings(editor: Editor): BnetLink[] {
    const link = editor.link(this.linkID);
    if (!link) return [];
    const label = (l: BnetLink) => editor.displayLabel(l);
    return editor.links
      .filter((l) => l.id !== link.id && l.fromNodeID === link.fromNodeID && (l.customerClass ?? 0) === this.selectedClass)
      .sort((a, b) => (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0));
  }

  /** Balance to 1's state (INS-113): the remainder the siblings leave, and whether the button is enabled. */
  balanceState(editor: Editor): { siblingSum: number; total: number; remainder: number; enabled: boolean } {
    const siblingSum = this.siblings(editor).reduce((s, l) => s + l.routingProbability, 0);
    const total = siblingSum + (parseNumber(this.probabilityText) ?? 0);
    const remainder = 1 - siblingSum;
    return { siblingSum, total, remainder, enabled: remainder >= 0 && Math.abs(total - 1) > 1e-6 };
  }

  /** Balance to 1: this link's probability becomes what the siblings leave over. False when disabled. */
  balance(editor: Editor): boolean {
    const b = this.balanceState(editor);
    if (!b.enabled) return false;
    this.setProbability(fieldText(Math.min(Math.max(b.remainder, 0), 1)));
    return true;
  }

  /**
   * The draft differs from what was loaded or last committed. 0.90.34's pane decided "clean" by
   * comparing with the STORED link (`isDirty`), so after an outside change (an undo, a panel Save, a
   * click-cycled class) the untouched draft looked dirty, was never reloaded, and the next selection
   * change wrote its stale values back. 2.0 decides by the baseline, as the node draft does
   * (INS-012, Changed, D5).
   */
  get isEdited(): boolean {
    const a = this.current;
    const b = this.baseline;
    return a.probability !== b.probability || a.entryClass !== b.entryClass || a.exit !== b.exit;
  }

  /** INS-121: the classes differ, or the probability by more than 1e-12 (unparsable text compared as text). */
  isDirty(editor: Editor): boolean {
    const link = editor.link(this.linkID);
    if (!link) return false;
    const storedExit = link.toCustomerClass ?? SAME_AS_ENTRY;
    if (this.selectedClass !== (link.customerClass ?? 0) || this.exitSelection !== storedExit) return true;
    const p = parseNumber(this.probabilityText);
    if (p === null) return this.probabilityText !== fieldText(link.routingProbability);
    return Math.abs(p - link.routingProbability) > 1e-12;
  }

  get changedFieldKey(): string | null {
    const a = this.current;
    const b = this.baseline;
    const keys: string[] = [];
    if (a.probability !== b.probability) keys.push("probability");
    if (a.entryClass !== b.entryClass) keys.push("entryClass");
    if (a.exit !== b.exit) keys.push("exit");
    return keys.length === 1 ? keys[0] : null;
  }

  get effectiveExitClass(): number {
    return this.exitSelection === SAME_AS_ENTRY ? this.selectedClass : this.exitSelection;
  }

  get probabilityError(): string | null {
    const p = parseNumber(this.probabilityText);
    if (p === null) return w.probabilityNumber;
    if (p < 0 || p > 1) return w.probabilityRange;
    return null;
  }

  get probabilityIsPending(): boolean {
    return parseNumber(this.probabilityText) === null && isPartialNumber(this.probabilityText);
  }

  get pendingNote(): string | null {
    return this.probabilityIsPending ? w.stillTyping("Probability") : null;
  }

  firstProblem(editor: Editor): string | null {
    if (this.linkID === null) return null;
    if (!this.probabilityIsPending && this.probabilityError) return this.probabilityError;
    if (editor.entryClassesUsedByOtherLinks(this.linkID).has(this.selectedClass)) return w.classTaken(classLabel(this.selectedClass));
    return null;
  }

  isValid(editor: Editor): boolean {
    return this.firstProblem(editor) === null && this.pendingNote === null;
  }

  /** One undo step "Edit Link S1 → S2"; false when invalid (nothing written). */
  commit(editor: Editor, opts: boolean | { coalescing?: boolean } = false): boolean {
    const coalescing = typeof opts === "boolean" ? opts : !!opts.coalescing;
    const link = editor.link(this.linkID);
    const probability = parseNumber(this.probabilityText);
    if (!link || !this.isValid(editor) || probability === null) return false;
    const label = editor.displayLabel(link);
    if (!this.isDirty(editor)) {
      if (!coalescing) editor.status(w.noLinkChanges(label));
      return true;
    }
    const changes: string[] = [];
    if (Math.abs(probability - link.routingProbability) > 1e-12) changes.push(`probability ${formatSig(link.routingProbability, READOUT_DIGITS)} → ${formatSig(probability, READOUT_DIGITS)}`);
    if (this.selectedClass !== (link.customerClass ?? 0)) changes.push(`entry class → ${classLabel(this.selectedClass)}`);
    const newExit = this.exitSelection === SAME_AS_ENTRY ? null : this.exitSelection;
    if (newExit !== (link.toCustomerClass ?? null)) changes.push(newExit !== null ? `exit class → ${classLabel(newExit)}` : "exit class cleared");
    const summary = changes.length ? `Edited link ${label}: ${changes.join("; ")}.` : null;
    const id = link.id;
    const entry = this.selectedClass;
    const mutation = () => {
      editor.updateLinkProbability(id, probability);
      editor.updateLinkCustomerClass(id, entry);
      editor.updateLinkExitClass(id, newExit);
    };
    const name = w.linkUndoName(label);
    const key = this.changedFieldKey;
    let changed: boolean;
    if (coalescing && key !== null) changed = editor.performCoalescedParameterEdit(`${id}.${key}`, name, summary, mutation);
    else {
      editor.endParameterRun();
      changed = editor.performParameterEdit(name, summary, mutation);
    }
    if (!changed && !coalescing) editor.status(w.noLinkChanges(label));
    this.baseline = this.current;
    this.changed();
    return true;
  }
}
