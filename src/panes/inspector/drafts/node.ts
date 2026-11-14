// Everything the node inspector edits, as ONE draft shared by the two hosts that show it (0.90.34
// NodeParameterDraft.swift, ledger 4.7): the Node Parameters panel (⌘I; commits on Save as one undo
// step) and the docked Inspector pane (follows the selection; commits each field on blur, a run of
// commits to one field folding into one undo step). Load, dirty, validation and commit live here
// once, so the panel and the pane cannot drift.
//
//   • `load(editor, id)` fills every field from the node and records the baseline; `isDirty` is
//     "current ≠ baseline".
//   • `refresh(editor)` re-reads the same node after the document changed under it (undo, the
//     pane's own commit): field text and baseline move, UI state (active class row, entry modes)
//     stays.
//   • `commit(editor, coalescing)` writes the draft as one undo step "Edit <name> Parameters" (or
//     folds into the field run in the pane) and re-baselines. Nothing is written while invalid.
import type { BnetNode } from "../../../lib/bnet";
import { classLabel, KIND_NAMES, type Editor } from "../../../editor";
import { stationPicture, type StationPicture } from "../../../editor/pictures";
import {
  asDistribution,
  card,
  commitMomentsToNative,
  compactSummary,
  defaultDraft,
  draftErrors,
  draftsEqual,
  effectiveParams,
  fieldName,
  displayMeanText,
  displayParam,
  displayScvText,
  makeDraft,
  MEAN_KEY,
  paramsString,
  parameterString,
  parseInteger,
  parseNumber,
  pendingFieldNames,
  changeDistribution,
  setMeanText,
  setParam,
  setScvText,
  SCV_KEY,
  settledErrors,
  syncMode,
  fieldText,
  isPending,
  type DistributionDraft,
  type EntryMode,
} from "../distributions";
import { stabilityOf, type Stability } from "./stability";
import { inspectorWords as w } from "../words";

/** The ranges the Servers and Buffer size fields state (INS-028, INS-038). */
export const SERVERS_RANGE: [number, number] = [1, 10_000];
export const BUFFER_RANGE: [number, number] = [1, 1_000_000];

interface Snapshot {
  name: string;
  servers: string;
  bufferSize: string;
  infiniteBuffers: boolean;
  picture: string;
  single: DistributionDraft;
  perClass: ReadonlyMap<number, DistributionDraft>;
}

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.name !== b.name || a.servers !== b.servers || a.bufferSize !== b.bufferSize || a.infiniteBuffers !== b.infiniteBuffers || a.picture !== b.picture) return false;
  if (!draftsEqual(a.single, b.single)) return false;
  if (a.perClass.size !== b.perClass.size) return false;
  for (const [c, d] of a.perClass) {
    const o = b.perClass.get(c);
    if (!o || !draftsEqual(d, o)) return false;
  }
  return true;
}

export interface BulkUndo {
  before: ReadonlyMap<number, DistributionDraft>;
  result: ReadonlyMap<number, DistributionDraft>;
  /** "Class 1 copied to 5 classes". */
  announcement: string;
  /** "Copy to All Classes": the button reads "Undo <actionName>". */
  actionName: string;
}

/** A station's stored service law as the inspector edits it: a legacy Poisson station reads as Exponential (INS-068). */
export function stationServiceLaw(node: BnetNode): { distribution: ReturnType<typeof asDistribution>; parameters: string } {
  if (node.distribution !== "poisson") return { distribution: asDistribution(node.distribution), parameters: node.distributionParameters };
  const raw = Object.fromEntries(node.distributionParameters.split(",").map((p) => p.split("=").map((x) => x.trim())).filter((p) => p.length === 2));
  const rate = (raw.lambda !== undefined ? parseNumber(raw.lambda) : null) ?? (raw.rate !== undefined ? parseNumber(raw.rate) : null) ?? 1;
  return { distribution: "exponential", parameters: `rate=${fieldText(rate)}` };
}

/** The same law as the stored (family, string) pair, compared numerically (DIST-042). */
export function lawIsUnchanged(draft: DistributionDraft, distribution: string, parameters: string): boolean {
  if (draft.distribution !== distribution) return false;
  return parameterString(makeDraft(asDistribution(distribution), parameters)) === parameterString(draft);
}

export class NodeParameterDraft {
  nodeID: string | null = null;
  nameText = "";
  serversText = "1";
  bufferSizeText = "1";
  infiniteBuffersDraft = false;
  draft: DistributionDraft = defaultDraft("exponential");
  entryMode: EntryMode = "native";
  servedClasses: number[] = [];
  classDrafts = new Map<number, DistributionDraft>();
  classEntryMode: EntryMode = "native";
  activeClassRow: number | null = null;
  /** The SF Symbol name a .bnet stores; "" is No Picture. */
  stationPicture = "";
  nameIsFocused = false;
  /** Text fields holding the keyboard: the pane commits when the last one lets go. */
  fieldFocusCount = 0;
  bulkUndo: BulkUndo | null = null;
  stability: Stability | null = null;

  private baseline: Snapshot = this.current;
  private listeners = new Set<() => void>();
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityToken = 0;
  /** Bumped on every change, for React's useSyncExternalStore. */
  version = 0;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  /** Bumped only when a field changes (not the readout): what the pane's settle debounce follows. */
  fieldVersion = 0;

  /** Publishes a change of any field. */
  changed() {
    this.fieldVersion++;
    this.notify();
  }

  private notify() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /** Changes fields and publishes once. */
  update(f: (d: this) => void) {
    f(this);
    this.changed();
  }

  get current(): Snapshot {
    return {
      name: this.nameText,
      servers: this.serversText,
      bufferSize: this.bufferSizeText,
      infiniteBuffers: this.infiniteBuffersDraft,
      picture: this.stationPicture,
      single: this.draft,
      perClass: new Map(this.classDrafts),
    };
  }

  get isDirty(): boolean {
    return !snapshotsEqual(this.current, this.baseline);
  }

  /** The one field that differs from the baseline ("servers", "class2"…), for the pane's undo runs. */
  get changedFieldKey(): string | null {
    const a = this.current;
    const b = this.baseline;
    const keys: string[] = [];
    if (a.name !== b.name) keys.push("name");
    if (a.servers !== b.servers) keys.push("servers");
    if (a.bufferSize !== b.bufferSize) keys.push("bufferSize");
    if (a.infiniteBuffers !== b.infiniteBuffers) keys.push("infiniteBuffers");
    if (a.picture !== b.picture) keys.push("picture");
    if (!draftsEqual(a.single, b.single)) keys.push("single");
    for (const c of new Set([...a.perClass.keys(), ...b.perClass.keys()])) {
      const x = a.perClass.get(c);
      const y = b.perClass.get(c);
      if (!x || !y || !draftsEqual(x, y)) keys.push(`class${c}`);
    }
    return keys.length === 1 ? keys[0] : null;
  }

  // ── Load / refresh ─────────────────────────────────────────────────────────────────────────

  /** The selection changed: every field from the node, UI state reset, baseline recorded. */
  load(editor: Editor, nodeID: string) {
    // A readout scheduled for the previous node (or tab) must not land on this one.
    if (nodeID !== this.nodeID) this.cancelStabilityRefresh();
    this.nodeID = nodeID;
    this.activeClassRow = null;
    this.bulkUndo = null;
    this.fieldFocusCount = 0;
    const node = editor.node(nodeID);
    if (node) {
      this.fill(editor, node);
      this.activeClassRow = this.servedClasses[0] ?? null;
      this.baseline = this.current;
    }
    this.stability = null;
    this.changed();
    this.refreshStability(editor);
  }

  /** The document changed under the same node: field text and baseline move, UI state stays. */
  refresh(editor: Editor) {
    const node = editor.node(this.nodeID);
    if (!node) return;
    const keptRow = this.activeClassRow;
    const keptMode = this.entryMode;
    const keptClassMode = this.classEntryMode;
    this.fill(editor, node);
    if (keptMode === "moments") this.draft = syncMode(this.draft, "moments");
    if (keptClassMode === "moments") for (const c of this.servedClasses) this.classDrafts.set(c, syncMode(this.classDrafts.get(c)!, "moments"));
    this.entryMode = keptMode;
    this.classEntryMode = keptClassMode;
    this.activeClassRow = keptRow !== null && this.servedClasses.includes(keptRow) ? keptRow : (this.servedClasses[0] ?? null);
    this.baseline = this.current;
    this.changed();
    // Debounced: a burst of outside changes (nudges, undo after undo) asks Rust once.
    this.scheduleStabilityRefresh(editor);
  }

  /** Escape in the pane: every field back to the loaded (or last committed) values; UI state kept. */
  revertToBaseline() {
    if (this.nodeID === null) return;
    const b = this.baseline;
    this.nameText = b.name;
    this.serversText = b.servers;
    this.bufferSizeText = b.bufferSize;
    this.infiniteBuffersDraft = b.infiniteBuffers;
    this.stationPicture = b.picture;
    this.draft = b.single;
    this.classDrafts = new Map(b.perClass);
    this.bulkUndo = null;
    this.changed();
  }

  private fill(editor: Editor, node: BnetNode) {
    this.nameText = node.name;
    this.infiniteBuffersDraft = editor.infiniteBuffers;
    this.bufferSizeText = String(node.bufferSize);
    this.serversText = String(node.numberOfServers);
    this.stationPicture = node.picture ?? "";
    this.servedClasses = [];
    this.classDrafts = new Map();
    if (node.kind === "station") {
      this.servedClasses = editor.classesServedAtStation(node.id);
      const fallback = stationServiceLaw(node);
      for (const c of this.servedClasses) {
        const cfg = node.serviceDistributions?.[String(c)];
        this.classDrafts.set(c, cfg ? makeDraft(asDistribution(cfg.distribution), cfg.distributionParameters) : makeDraft(fallback.distribution, fallback.parameters));
      }
      this.draft = makeDraft(fallback.distribution, fallback.parameters);
    } else if (node.kind === "source") {
      this.draft = makeDraft(asDistribution(node.distribution), node.distributionParameters);
    }
  }

  private rebaseline() {
    this.baseline = this.current;
    this.bulkUndo = null;
  }

  // ── Typing, as the form's controls do (also what src/editor/replay.test.ts drives) ─────────

  /** The draft a field edits: the single law, or class `cls`'s row. */
  lawDraft(cls?: number): DistributionDraft {
    if (cls === undefined) return this.draft;
    return this.classDrafts.get(cls) ?? defaultDraft("exponential");
  }

  private setLaw(cls: number | undefined, d: DistributionDraft) {
    if (cls === undefined) this.draft = d;
    else this.classDrafts.set(cls, d);
    this.changed();
  }

  /** The Distribution picker: `changeDistribution(to:mode:)` in the entry mode that applies. */
  changeDistribution(to: string, cls?: number) {
    const mode = cls === undefined ? this.entryMode : this.classEntryMode;
    this.setLaw(cls, changeDistribution(this.lawDraft(cls), asDistribution(to), mode));
    if (cls !== undefined) this.activeClassRow = cls;
  }

  /** A native parameter field. */
  setParam(key: string, text: string, cls?: number) {
    this.setLaw(cls, setParam(this.lawDraft(cls), key, text));
  }

  /** The Mean field (Mean & SCV mode). */
  setMean(text: string, cls?: number) {
    this.setLaw(cls, setMeanText(this.lawDraft(cls), text));
  }

  /** The SCV field (Mean & SCV mode). */
  setScv(text: string, cls?: number) {
    this.setLaw(cls, setScvText(this.lawDraft(cls), text));
  }

  /** The single law's "Enter as" picker: `syncMode(to:)`, then the mode. */
  setEntryMode(mode: EntryMode) {
    if (mode === this.entryMode) return;
    this.draft = syncMode(this.draft, mode);
    this.entryMode = mode;
    this.changed();
  }

  /** The per-class "Enter as" picker: every class row is synced. */
  setClassEntryMode(mode: EntryMode) {
    if (mode === this.classEntryMode) return;
    for (const [c, d] of this.classDrafts) this.classDrafts.set(c, syncMode(d, mode));
    this.classEntryMode = mode;
    this.changed();
  }

  // ── Validation ─────────────────────────────────────────────────────────────────────────────

  get nameIsPending(): boolean {
    return this.nameIsFocused && this.nameText.trim() === "";
  }

  nameError(editor: Editor): string | null {
    const trimmed = this.nameText.trim();
    if (!trimmed) return w.nameEmpty;
    if (editor.nodes.some((n) => n.id !== this.nodeID && n.name === trimmed)) return w.nameTaken(trimmed);
    return null;
  }

  /** INS-030 (Changed, D5): a value beyond 10,000 now blocks Save, as its red caption says. */
  get serversError(): string | null {
    const v = parseInteger(this.serversText);
    if (v === null) return w.serversWhole;
    if (v < 1) return w.serversMin;
    if (v > SERVERS_RANGE[1]) return w.serversRange;
    return null;
  }

  /** INS-039 (Changed, D5): likewise beyond 1,000,000. */
  get bufferSizeError(): string | null {
    const v = parseInteger(this.bufferSizeText);
    if (v === null) return w.bufferWhole;
    if (v < 1) return w.bufferMin;
    if (v > BUFFER_RANGE[1]) return w.bufferRange;
    return null;
  }

  isValid(editor: Editor): boolean {
    return this.firstProblem(editor) === null && this.pendingNote(editor) === null;
  }

  /** The first blocking problem in visual order; fields still being typed are left to `pendingNote`. */
  firstProblem(editor: Editor): string | null {
    const node = editor.node(this.nodeID);
    if (!node) return null;
    if (!this.nameIsPending) {
      const e = this.nameError(editor);
      if (e) return e;
    }
    switch (node.kind) {
      case "buffer":
        if (!this.infiniteBuffersDraft && !isPending(this.bufferSizeText) && this.bufferSizeError) return this.bufferSizeError;
        break;
      case "station":
        if (!isPending(this.serversText) && this.serversError) return this.serversError;
        if (!this.servedClasses.length) {
          const e = settledErrors(this.draft, this.entryMode)[0];
          if (e) return e;
        } else
          for (const c of this.servedClasses) {
            const d = this.classDrafts.get(c);
            const e = d ? settledErrors(d, this.classEntryMode)[0] : undefined;
            if (e) return `${classLabel(c)}: ${e}`;
          }
        break;
      case "source": {
        const e = settledErrors(this.draft, this.entryMode)[0];
        if (e) return e;
        break;
      }
      case "sink":
        break;
    }
    return null;
  }

  /** "Still typing Rate (λ)": Save stays disabled, nothing turns red. */
  pendingNote(editor: Editor): string | null {
    const node = editor.node(this.nodeID);
    if (!node || this.firstProblem(editor) !== null) return null;
    const names: string[] = [];
    if (this.nameIsPending) names.push("Name");
    switch (node.kind) {
      case "buffer":
        if (!this.infiniteBuffersDraft && isPending(this.bufferSizeText)) names.push("Buffer size");
        break;
      case "station":
        if (isPending(this.serversText)) names.push("Servers");
        if (!this.servedClasses.length) names.push(...pendingFieldNames(this.draft, this.entryMode));
        else for (const c of this.servedClasses) names.push(...pendingFieldNames(this.classDrafts.get(c)!, this.classEntryMode).map((n) => `${classLabel(c)} ${n}`));
        break;
      case "source":
        names.push(...pendingFieldNames(this.draft, this.entryMode));
        break;
      case "sink":
        break;
    }
    if (!names.length) return null;
    return w.stillTyping(names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : ""));
  }

  /** What a discard throws away: `Servers ("abc")`, `Class 2 Rate (λ) ("")`… (INS-008). */
  invalidFieldSummaries(editor: Editor): string[] {
    const node = editor.node(this.nodeID);
    if (!node) return [];
    const q = (t: string) => `("${t}")`;
    const out: string[] = [];
    if (this.nameError(editor)) out.push(`Name ${q(this.nameText)}`);
    const fields = (d: DistributionDraft, mode: EntryMode, prefix: string) => {
      for (const key of Object.keys(draftErrors(d, mode)).sort()) {
        const text = key === MEAN_KEY ? displayMeanText(d) : key === SCV_KEY ? displayScvText(d) : displayParam(d, key);
        out.push(`${prefix}${fieldName(d, key)} ${q(text)}`);
      }
    };
    switch (node.kind) {
      case "buffer":
        if (!this.infiniteBuffersDraft && this.bufferSizeError) out.push(`Buffer size ${q(this.bufferSizeText)}`);
        break;
      case "station":
        if (this.serversError) out.push(`Servers ${q(this.serversText)}`);
        if (!this.servedClasses.length) fields(this.draft, this.entryMode, "");
        else for (const c of this.servedClasses) fields(this.classDrafts.get(c)!, this.classEntryMode, `${classLabel(c)} `);
        break;
      case "source":
        fields(this.draft, this.entryMode, "");
        break;
      case "sink":
        break;
    }
    return out;
  }

  // ── Bulk class actions (one-level revert, INS-062…065) ─────────────────────────────────────

  otherClassCount(excluding: number | null): number {
    return this.servedClasses.filter((c) => c !== excluding).length;
  }

  copyToAllClasses(source: number) {
    const src = this.classDrafts.get(source);
    if (!src) return;
    const targets = this.servedClasses.filter((c) => c !== source);
    if (!targets.length) return;
    this.applyBulk(w.bulkCopyAction, w.bulkCopied(classLabel(source), targets.length), () => {
      for (const c of targets) this.classDrafts.set(c, src);
    });
  }

  applyToAllClasses(template: DistributionDraft, named: string) {
    const n = this.servedClasses.length;
    if (!n) return;
    this.applyBulk(w.bulkApplyAction(named), w.bulkApplied(named, n), () => {
      for (const c of this.servedClasses) this.classDrafts.set(c, template);
    });
  }

  private applyBulk(actionName: string, announcement: string, change: () => void) {
    const before = new Map(this.classDrafts);
    change();
    this.bulkUndo = { before, result: new Map(this.classDrafts), announcement, actionName };
    this.changed();
  }

  get bulkUndoIsLive(): boolean {
    const b = this.bulkUndo;
    if (!b) return false;
    if (b.result.size !== this.classDrafts.size) return false;
    for (const [c, d] of this.classDrafts) {
      const r = b.result.get(c);
      if (!r || !draftsEqual(r, d)) return false;
    }
    return true;
  }

  revertBulk() {
    if (!this.bulkUndo) return;
    this.classDrafts = new Map(this.bulkUndo.before);
    this.bulkUndo = null;
    this.changed();
  }

  // ── The live load readout (INS-031…036, INV-022) ───────────────────────────────────────────

  /** Recomputes λ, c·μ and ρ 250 ms after the draft settles. */
  scheduleStabilityRefresh(editor: Editor) {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      this.refreshStability(editor);
    }, STABILITY_DELAY);
  }

  cancelStabilityRefresh() {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
    this.stabilityToken++;
  }

  refreshStability(editor: Editor) {
    const node = editor.node(this.nodeID);
    const token = ++this.stabilityToken;
    if (!node || node.kind !== "station") {
      if (this.stability !== null) {
        this.stability = null;
        this.notify();
      }
      return;
    }
    void stabilityOf(node.id, this.draftNodes(editor, node), editor.links, this.infiniteBuffersDraft).then((s) => {
      if (token !== this.stabilityToken) return;
      this.stability = s;
      this.notify();
    });
  }

  /** The nodes with this station's fields as they currently parse; half-typed ones keep the stored value. */
  draftNodes(editor: Editor, node: BnetNode): BnetNode[] {
    const copy: BnetNode = { ...node, serviceDistributions: { ...node.serviceDistributions } };
    const servers = parseInteger(this.serversText);
    if (servers !== null && servers >= 1) copy.numberOfServers = servers;
    if (!this.servedClasses.length) {
      const p = effectiveParams(this.draft, this.entryMode);
      if (p) {
        copy.distribution = this.draft.distribution;
        copy.distributionParameters = paramsString(this.draft.distribution, p);
      }
    } else {
      for (const c of this.servedClasses) {
        const d = this.classDrafts.get(c);
        const p = d ? effectiveParams(d, this.classEntryMode) : null;
        if (!d || !p) continue;
        copy.serviceDistributions[String(c)] = { distribution: d.distribution, distributionParameters: paramsString(d.distribution, p) };
      }
      const first = this.servedClasses[0];
      const d = this.classDrafts.get(first);
      const p = d ? effectiveParams(d, this.classEntryMode) : null;
      if (d && p) {
        copy.distribution = d.distribution;
        copy.distributionParameters = paramsString(d.distribution, p);
      }
    }
    return editor.nodes.map((n) => (n.id === node.id ? copy : n));
  }

  // ── Commit ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Writes the draft as ONE undo step ("Edit S1 Parameters") with one Status line. False when the
   * draft is invalid (nothing written). `coalescing` is the docked pane: a run of commits to one
   * field folds into the previous undo entry.
   */
  commit(editor: Editor, opts: boolean | { coalescing?: boolean } = false): boolean {
    const coalescing = typeof opts === "boolean" ? opts : !!opts.coalescing;
    const node = editor.node(this.nodeID);
    if (!node || !this.isValid(editor)) return false;
    if (!this.isDirty) {
      if (!coalescing) editor.status(w.noChanges(node.name));
      return true;
    }
    const notes: string[] = [];
    const changes: string[] = [];
    const trimmedName = this.nameText.trim();
    if (trimmedName !== node.name) changes.push(`renamed to ${trimmedName}`);

    let resolved = this.draft;
    const resolvedClasses = new Map(this.classDrafts);
    if (node.kind !== "buffer" && node.kind !== "sink") {
      if (this.entryMode === "moments" && (node.kind === "source" || !this.servedClasses.length)) {
        const r = commitMomentsToNative(resolved, "");
        resolved = r.draft;
        if (r.note) notes.push(r.note);
      }
      if (node.kind === "station" && this.classEntryMode === "moments")
        for (const c of this.servedClasses) {
          const d = resolvedClasses.get(c);
          if (!d) continue;
          const r = commitMomentsToNative(d, `${classLabel(c)}: `);
          resolvedClasses.set(c, r.draft);
          if (r.note) notes.push(r.note);
        }
    }

    const classChanged = (c: number) => {
      const d = resolvedClasses.get(c);
      const cfg = node.serviceDistributions?.[String(c)];
      return !!d && !(cfg && lawIsUnchanged(d, cfg.distribution, cfg.distributionParameters));
    };
    const first = this.servedClasses[0];
    const stationLawUnchanged = (d: DistributionDraft) => {
      const b = stationServiceLaw(node);
      return lawIsUnchanged(d, b.distribution, b.parameters);
    };
    const topLevelSyncChanged = first !== undefined && resolvedClasses.has(first) && classChanged(first) && !stationLawUnchanged(resolvedClasses.get(first)!);
    const servers = parseInteger(this.serversText);
    const size = parseInteger(this.bufferSizeText);

    switch (node.kind) {
      case "buffer":
        if (this.infiniteBuffersDraft !== editor.infiniteBuffers) changes.push(this.infiniteBuffersDraft ? "network buffers → infinite" : "network buffers → finite");
        if (!this.infiniteBuffersDraft && size !== null && size !== node.bufferSize) changes.push(`size ${node.bufferSize} → ${size}`);
        break;
      case "station":
        if (servers !== null && servers !== node.numberOfServers) changes.push(`servers ${node.numberOfServers} → ${servers}`);
        if (this.stationPicture !== (node.picture ?? "")) changes.push(`picture → ${stationPicture(this.stationPicture).displayName}`);
        if (!this.servedClasses.length) {
          if (!stationLawUnchanged(resolved)) changes.push(`service → ${card(resolved.distribution).displayName}(${compactSummary(resolved)})`);
        } else {
          for (const c of this.servedClasses) {
            const d = resolvedClasses.get(c);
            if (d && classChanged(c)) changes.push(`${classLabel(c)} → ${card(d.distribution).displayName}(${compactSummary(d)})`);
          }
          if (topLevelSyncChanged) changes.push(`default service law follows ${classLabel(first)}`);
        }
        break;
      case "source":
        if (!lawIsUnchanged(resolved, node.distribution, node.distributionParameters)) changes.push(`arrivals → ${card(resolved.distribution).pickerName}(${compactSummary(resolved)})`);
        break;
      case "sink":
        break;
    }

    const summary = changes.length ? `Edited ${node.name}: ${changes.join("; ")}.${notes.length ? " Note: " + notes.join(" ") : ""}` : null;
    const picture = stationPicture(this.stationPicture);
    const mutation = () => {
      editor.renameNode(node.id, trimmedName);
      switch (node.kind) {
        case "buffer":
          editor.setInfiniteBuffers(this.infiniteBuffersDraft);
          if (!this.infiniteBuffersDraft && size !== null) editor.updateBufferSize(node.id, size);
          break;
        case "station":
          if (servers !== null) editor.updateNumberOfServers(node.id, servers);
          editor.updateStationPicture(node.id, this.stationPicture, picture.displayName);
          if (!this.servedClasses.length) {
            if (!stationLawUnchanged(resolved)) editor.updateNodeDistribution(node.id, resolved.distribution, parameterString(resolved));
          } else {
            for (const c of this.servedClasses) {
              const d = resolvedClasses.get(c);
              if (d && classChanged(c)) editor.updateServiceDistribution(node.id, c, d.distribution, parameterString(d));
            }
            if (topLevelSyncChanged) {
              const d = resolvedClasses.get(first)!;
              editor.updateNodeDistribution(node.id, d.distribution, parameterString(d));
            }
          }
          break;
        case "source":
          if (!lawIsUnchanged(resolved, node.distribution, node.distributionParameters)) editor.updateNodeDistribution(node.id, resolved.distribution, parameterString(resolved));
          break;
        case "sink":
          break;
      }
    };

    const name = w.nodeUndoName(node.name);
    const key = this.changedFieldKey;
    let changed: boolean;
    if (coalescing && key !== null) changed = editor.performCoalescedParameterEdit(`${node.id}.${key}`, name, summary, mutation);
    else {
      editor.endParameterRun();
      changed = editor.performParameterEdit(name, summary, mutation);
    }
    if (!changed && !coalescing) editor.status(w.noChanges(node.name));

    // The committed values are the new "unchanged": in Mean & SCV the fields show what was written.
    if (this.entryMode === "moments") this.draft = syncMode(resolved, "moments");
    if (this.classEntryMode === "moments")
      for (const c of this.servedClasses) {
        const d = resolvedClasses.get(c);
        if (d) this.classDrafts.set(c, syncMode(d, "moments"));
      }
    this.rebaseline();
    this.changed();
    return true;
  }
}

/** 0.90.34 waited 250 ms after the draft settled before solving the traffic equations again. */
export const STABILITY_DELAY = 250;

export const kindName = (n: BnetNode) => KIND_NAMES[n.kind];
export type { StationPicture };
