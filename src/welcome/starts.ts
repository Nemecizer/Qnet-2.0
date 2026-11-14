// The Welcome view's start actions (ledger UX-102…104). Each ends with a network (or a blank
// canvas) in the active tab and the view gone.
import { activeEditor } from "../editor";
import { getCommand, runCommand } from "../lib/commands";
import { addStatus, activeTab, addTab, isBlankTab } from "../workspace/store";
import { openPath } from "../workspace/files/documents";
import { insertArchetype, type ArchetypeParameters } from "../windows/archetypes/insert";
import { closeWelcome } from "./state";
import { welcomeWords as w } from "./words";

/**
 * The first network: Src1 → B1 → S1 → B2 → S2 → Sink1, one server each, arrivals at rate 1 and
 * every station serving at rate 1.25 (ρ = 0.8 < 1, so it is stable), on infinite buffers, where
 * the exact method applies. Built by the archetype builder, so it is laid out as the gallery's is.
 */
export const TANDEM: Readonly<Partial<ArchetypeParameters>> = Object.freeze({ stations: 2, servers: 1, targetRho: 0.8, arrivalRate: 1.0, infiniteBuffers: true });

/** Start with a Tandem Line: into the blank tab (a new one if the active tab has a network). */
export async function startTandem(): Promise<boolean> {
  if (!isBlankTab(activeTab())) addTab();
  const editor = activeEditor();
  try {
    const ids = await insertArchetype(editor, "tandemLine", TANDEM);
    if (!ids.size) return false;
  } catch (e) {
    addStatus(w.tandemFailed(e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)), "error");
    return false;
  }
  // The insert selects what it added; a first network reads better with nothing selected.
  editor.deselectAll();
  addStatus(w.tandemStatus, "info", editor.tabId);
  closeWelcome();
  focusCanvas();
  return true;
}

function focusCanvas() {
  if (getCommand("window:focus-canvas")) void runCommand("window:focus-canvas");
}

/** New Empty Network: the blank tab under the view is the new network. */
export function startEmpty(): void {
  if (!isBlankTab(activeTab())) addTab();
  closeWelcome();
  focusCanvas();
}

/** Open…: File ▸ Open's own panel; the view goes when a network arrives. */
export function startOpen(): void {
  if (getCommand("file:open")) void runCommand("file:open");
}

/** A recent file or an example. */
export async function openFromWelcome(path: string): Promise<boolean> {
  const ok = await openPath(path);
  if (ok) closeWelcome();
  return ok;
}
