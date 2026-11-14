// The archetype gallery's onInsert (0.90.34 QnetGUIApp.swift `syncArchetypePanel`): build the
// archetype (`NetworkArchetypeBuilder.build`, Rust's port in src-tauri/src/archetypes.rs; the
// preview's exact copy in src/dev/mock/archetypes.ts), then `insertSubnetwork(nodes, links,
// infiniteBuffers, at: canvasOrigin, actionName: "Insert " + title, detail: summary)` — one undo
// step. The gallery's Insert and golden/edits/archetype-insert's `insertArchetype` steps both
// come here.
import { api } from "../../lib/api";
import { parseDocument } from "../../lib/bnet";
import type { ArchetypeRequest } from "../../lib/types";
import type { Editor } from "../../editor";
import { blueprint, type ArchetypeKind } from "./catalogue";
import { archetypeWords as w } from "./words";

/** 0.90.34's `ArchetypeParameters()`; `insertArchetype` takes any subset over them. */
export type ArchetypeParameters = Omit<ArchetypeRequest, "kind">;

export const DEFAULT_PARAMETERS: Readonly<ArchetypeParameters> = Object.freeze({
  stations: 3,
  servers: 1,
  targetRho: 0.9,
  feedbackProbability: 0.3,
  infiniteBuffers: true,
  bufferCapacity: 10,
  arrivalRate: 1.0,
});

/** Inserts `archetype` built with `parameters` (over the defaults) into `editor`; resolves to the new node ids. */
export async function insertArchetype(editor: Editor, archetype: ArchetypeKind, parameters: Partial<ArchetypeParameters> = {}): Promise<Set<string>> {
  const built = await api.networkArchetype({ kind: archetype, ...DEFAULT_PARAMETERS, ...parameters });
  const doc = parseDocument(built.text);
  return editor.insertSubnetwork(doc.nodes, doc.links, doc.infiniteBuffers, { x: built.origin[0], y: built.origin[1] }, w.actionName(blueprint(archetype).title), built.summary);
}
