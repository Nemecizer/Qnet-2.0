// Test helpers for the inspectors: an example opened into the workspace store as Rust's reader
// would give it (0.90.34's decode defaults filled in), and the node and link lookups by name.
import { act } from "@testing-library/react";
import type { BnetDocument, BnetLink, BnetNode } from "../../lib/bnet";
import { exampleFiles } from "../../dev/mock/documents";
import { activeEditor, type Editor } from "../../editor";
import { activeTab, replaceWorkspace } from "../../workspace/store";

/** `examples/<stem>.bnet` with the decode defaults (MODEL-003, MODEL-005, MODEL-007). */
export function exampleDocument(stem: string): BnetDocument {
  const text = exampleFiles()[`/examples/${stem}.bnet`];
  if (!text) throw new Error(`no example ${stem}`);
  const raw = JSON.parse(text) as { nodes: Partial<BnetNode>[]; links: Partial<BnetLink>[]; infiniteBuffers?: boolean; canvasScale?: number };
  return {
    nodes: raw.nodes.map((n) => ({ numberOfServers: 1, serviceDistributions: {}, picture: "", ...n }) as BnetNode),
    links: raw.links.map((l) => ({ customerClass: 0, ...l }) as BnetLink),
    infiniteBuffers: raw.infiniteBuffers ?? false,
    canvasScale: raw.canvasScale ?? 1,
    canvasPanOffset: [0, 0],
  };
}

/** Opens an example as the only tab and returns its editor. */
export function openExample(stem: string): Editor {
  act(() => replaceWorkspace({ tabs: [{ id: "TAB-1", title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: exampleDocument(stem), revision: 0, savedRevision: 0, log: [] }], activeId: "TAB-1" }));
  return activeEditor();
}

export const nodeNamed = (e: Editor, name: string): BnetNode => {
  const n = e.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node ${name}`);
  return n;
};

export const linkBetween = (e: Editor, from: string, to: string, cls?: number): BnetLink => {
  const f = nodeNamed(e, from).id;
  const t = nodeNamed(e, to).id;
  const l = e.links.find((x) => x.fromNodeID === f && x.toNodeID === t && (cls === undefined || x.customerClass === cls));
  if (!l) throw new Error(`no link ${from} → ${to}`);
  return l;
};

/** The active tab's Status lines, oldest first. */
export const statusLines = () => activeTab().log.map((e) => e.text);
