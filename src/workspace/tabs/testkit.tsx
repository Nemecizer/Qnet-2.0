// Helpers for the tabs tests: a workspace of given tabs, and answering the alert on screen.
import { expect } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { emptyDocument, type BnetDocument, type BnetNode } from "../../lib/bnet";
import { replaceWorkspace, type Tab } from "../store";

export function node(id: string, name = id): BnetNode {
  return { id, kind: "station", name, position: [100, 100], bufferSize: 0, distribution: "exponential", distributionParameters: "rate=1.0", numberOfServers: 1, serviceDistributions: {}, picture: "" };
}

export function docWith(nodes: number, extra: Partial<BnetDocument> = {}): BnetDocument {
  return { ...emptyDocument(), nodes: Array.from({ length: nodes }, (_, i) => node(`N${i}`)), ...extra };
}

/** A tab: `dirty` makes it unsaved; `nodes` gives it content. */
export function tab(id: string, opts: { title?: string; path?: string | null; dirty?: boolean; nodes?: number; log?: Tab["log"]; document?: BnetDocument } = {}): Tab {
  return {
    id,
    title: opts.title ?? (opts.path ? opts.path.split("/").pop()! : "Untitled"),
    path: opts.path ?? null,
    document: opts.document ?? docWith(opts.nodes ?? 1),
    revision: opts.dirty ? 2 : 1,
    savedRevision: 1,
    log: opts.log ?? [],
  };
}

export function seed(tabs: Tab[], activeId = tabs[0].id) {
  act(() => replaceWorkspace({ tabs, activeId }));
}

/** Waits for the alert titled `title` (when given) and clicks `button`. */
export async function answer(button: string, title?: string | RegExp, opts: { tick?: boolean } = {}) {
  const dialog = await screen.findByRole("alertdialog");
  if (title) await waitFor(() => expect(dialog).toHaveTextContent(title));
  if (opts.tick) fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
  });
}
