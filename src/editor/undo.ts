// A per-tab undo stack with NSUndoManager's semantics, which 0.90.34's editor used
// (NetworkEditorModel.undoManager, groupsByEvent = true):
//
// - Every registration made during one event (one synchronous task here: a click handler, a
//   menu command, a key press) lands in one group, closed when the task ends. Two mutations in one
//   handler are one ⌘Z, exactly as in 0.90.34.
// - The group's name is the last `setActionName` made while it was open ("Undo Add Station").
// - Undoing runs the group's actions last-first; whatever they register goes onto the redo stack
//   as one group with the same name, and redoing does the converse. A new registration outside an
//   undo or redo clears the redo stack.
// - `undo()` and `redo()` first close a group still open in this task, as NSUndoManager does.

export type UndoAction = () => void;

interface Group {
  name: string;
  actions: UndoAction[];
}

export class UndoManager {
  private undoStack: Group[] = [];
  private redoStack: Group[] = [];
  private open: Group | null = null;
  private mode: "normal" | "undoing" | "redoing" = "normal";
  private listeners = new Set<() => void>();
  /** Closes the open group at the end of the current task; tests may replace it. */
  static schedule: (f: () => void) => void = (f) => queueMicrotask(f);

  get isUndoing(): boolean {
    return this.mode === "undoing";
  }

  get isRedoing(): boolean {
    return this.mode === "redoing";
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || (this.mode === "normal" && !!this.open?.actions.length);
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The name the Edit menu shows after "Undo"; "" when there is none. */
  get undoActionName(): string {
    if (this.mode === "normal" && this.open?.actions.length) return this.open.name;
    return this.undoStack.at(-1)?.name ?? "";
  }

  get redoActionName(): string {
    return this.redoStack.at(-1)?.name ?? "";
  }

  /** Follows every change of the stacks (the menu's titles and enablement). */
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  registerUndo(action: UndoAction): void {
    if (this.mode !== "normal") {
      // Inside an undo (or redo) the registration is the reverse step: it joins the group being
      // built for the other stack, which `undo()` / `redo()` push when they finish.
      this.reverse!.actions.push(action);
      return;
    }
    if (!this.open) {
      this.open = { name: "", actions: [] };
      UndoManager.schedule(() => this.closeGroup());
    }
    this.open.actions.push(action);
    this.redoStack = [];
    this.notify();
  }

  setActionName(name: string): void {
    if (this.mode !== "normal") {
      if (this.reverse) this.reverse.name = name;
      return;
    }
    if (this.open) this.open.name = name;
    else if (this.undoStack.length) this.undoStack[this.undoStack.length - 1].name = name;
    this.notify();
  }

  undo(): void {
    this.closeGroup();
    const g = this.undoStack.pop();
    if (!g) return;
    this.run(g, "undoing", this.redoStack);
  }

  redo(): void {
    this.closeGroup();
    const g = this.redoStack.pop();
    if (!g) return;
    this.run(g, "redoing", this.undoStack);
  }

  removeAllActions(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.open = null;
    this.notify();
  }

  /** Ends the open group now (what the end of an event does); harmless when none is open. */
  closeGroup(): void {
    const g = this.open;
    if (!g) return;
    this.open = null;
    if (g.actions.length) this.undoStack.push(g);
    this.notify();
  }

  private reverse: Group | null = null;

  private run(g: Group, mode: "undoing" | "redoing", into: Group[]) {
    this.mode = mode;
    this.reverse = { name: g.name, actions: [] };
    try {
      for (let i = g.actions.length - 1; i >= 0; i--) g.actions[i]();
    } finally {
      const rev = this.reverse;
      this.mode = "normal";
      this.reverse = null;
      if (rev.actions.length) into.push(rev);
      this.notify();
    }
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }
}
