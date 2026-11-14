// .bnet files in the browser preview: an in-memory folder holding the 50 examples (under
// /examples/) and whatever the preview saves. Reading refuses what isn't a network in the same
// words as src-tauri/src/documents.rs; writing keeps the JSON (not byte-exact: that's Rust's job).
import type { OpenedDocument } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";

const examples = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// The closed-network examples (new in 2.1) live one folder down, as in the app
// (src-tauri/src/welcome.rs `CLOSED_FOLDER`), so the 50 examples 0.90.34 shipped stay a set of their own.
const closedExamples = import.meta.glob("../../../examples/closed/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// The examples of priorities, batch arrivals and rate profiles (new in 2.1), likewise
// (src-tauri/src/welcome.rs `EXTENDED_FOLDER`).
const extendedExamples = import.meta.glob("../../../examples/extended/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Where the preview's examples live. */
export const MOCK_EXAMPLES_DIR = "/examples";

export function exampleFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, text] of Object.entries(examples)) out[`${MOCK_EXAMPLES_DIR}/${k.split("/").pop()}`] = text;
  return out;
}

/** The closed-network examples, under /examples/closed/. */
export function closedExampleFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, text] of Object.entries(closedExamples)) out[`${MOCK_EXAMPLES_DIR}/closed/${k.split("/").pop()}`] = text;
  return out;
}

/** The examples of the model features new in 2.1, under /examples/extended/. */
export function extendedExampleFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, text] of Object.entries(extendedExamples)) out[`${MOCK_EXAMPLES_DIR}/extended/${k.split("/").pop()}`] = text;
  return out;
}

const baseName = (p: string) => p.split("/").pop() ?? p;

// 0.90.34's own re-save of each example: the form Rust's reader hands a file back in (every field
// present). The examples themselves are sparse (a link has no `customerClass`, the document no
// `canvasPanOffset`), and the canvas, which Rust never shows such a document, can't draw one.
const resaved = import.meta.glob("../../../golden/*/resave.bnet", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;

/** A network's text as src-tauri/src/documents.rs `read` returns it: the reader's defaults filled in. */
export function writtenForm(v: Record<string, unknown>): Record<string, unknown> {
  const list = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
  return {
    infiniteBuffers: false,
    canvasScale: 1,
    canvasPanOffset: [0, 0],
    ...v,
    nodes: list(v.nodes).map((n) => ({ bufferSize: 1, distribution: "exponential", distributionParameters: "rate=1.0", numberOfServers: 1, serviceDistributions: {}, picture: "", ...n })),
    links: list(v.links).map((l) => ({ routingProbability: 1, customerClass: 0, ...l })),
  };
}

/** A bundled example exactly as 0.90.34 re-saved it, or null for any other file. */
export async function resavedExample(path: string, text: string): Promise<string | null> {
  const load = path.startsWith(`${MOCK_EXAMPLES_DIR}/`) && examples[`../../../examples/${baseName(path)}`] === text ? resaved[`../../../golden/${baseName(path).replace(/\.bnet$/, "")}/resave.bnet`] : undefined;
  return load ? load() : null;
}

export function documentHandlers(opts: { files?: Record<string, string> } = {}): MockHandlers {
  const files: Record<string, string> = { ...exampleFiles(), ...extendedExampleFiles(), ...closedExampleFiles(), ...(opts.files ?? {}) };
  return {
    document_read: async ({ path }: { path: string }): Promise<OpenedDocument> => {
      const text = files[path];
      if (text === undefined) throw { kind: "notFound", message: `Qnet couldn't read “${baseName(path)}”.`, detail: "No such file or directory (os error 2)" };
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch (e) {
        throw { kind: "invalid", message: `“${baseName(path)}” isn't a Qnet network.`, detail: String(e) };
      }
      const o = v as { nodes?: unknown; links?: unknown };
      if (!o || !Array.isArray(o.nodes) || !Array.isArray(o.links)) throw { kind: "invalid", message: `“${baseName(path)}” isn't a Qnet network.`, detail: !o || !Array.isArray(o.nodes) ? "nodes: required" : "links: required" };
      return { path, name: baseName(path), text: (await resavedExample(path, text)) ?? JSON.stringify(writtenForm(v as Record<string, unknown>), null, 2) };
    },
    // The browser has no responder chain to send to; the field keeps its own edit.
    native_edit: () => null,
    document_write: ({ path, document }: { path: string; document: unknown }): OpenedDocument => {
      const text = JSON.stringify(document, null, 2);
      files[path] = text;
      return { path, name: baseName(path), text };
    },
  };
}
