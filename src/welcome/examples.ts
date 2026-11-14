// The bundled examples for the gallery: read once per page through `examples_list`
// (src-tauri/src/welcome.rs), parsed and described once, then kept.
import { api } from "../lib/api";
import { parseDocument, type BnetDocument } from "../lib/bnet";
import { describe, factsOf, type ExampleFacts } from "./describe";

export interface Example {
  /** The file's path: what opening it reads. */
  path: string;
  /** The file name without ".bnet". */
  name: string;
  document: BnetDocument;
  facts: ExampleFacts;
  description: string;
}

let cache: Promise<Example[]> | null = null;

export function loadExamples(): Promise<Example[]> {
  cache ??= api.examplesList().then(
    (files) =>
      files.flatMap((f): Example[] => {
        try {
          const document = parseDocument(f.text);
          if (!Array.isArray(document.nodes) || !Array.isArray(document.links)) return [];
          const facts = factsOf(document, f.drawn);
          return [{ path: f.path, name: f.name.replace(/\.bnet$/i, ""), document, facts, description: describe(facts) }];
        } catch {
          return [];
        }
      }),
    () => {
      // A failed read is tried again the next time the view opens.
      cache = null;
      return [];
    },
  );
  return cache;
}

/** For tests. */
export function resetExamples() {
  cache = null;
}
