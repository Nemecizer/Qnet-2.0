// The Welcome view in the browser preview (src-tauri/src/welcome.rs): the example gallery's list,
// from the preview's in-memory examples folder, by file name, each as `document_read` gives it,
// the closed-network examples after the others and each said to be open or closed.
import { drawnAs } from "../../closed/shape";
import type { ExampleDocument } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";
import { closedExampleFiles, exampleFiles, extendedExampleFiles, resavedExample, writtenForm } from "./documents";

const baseName = (p: string) => p.split("/").pop() ?? p;
const byName = (files: Record<string, string>) => Object.entries(files).sort(([a], [b]) => (baseName(a) < baseName(b) ? -1 : baseName(a) > baseName(b) ? 1 : 0));

export function welcomeHandlers(): MockHandlers {
  return {
    examples_list: async (): Promise<ExampleDocument[]> => {
      const out: ExampleDocument[] = [];
      for (const [path, text] of [...byName(exampleFiles()), ...byName(extendedExampleFiles()), ...byName(closedExampleFiles())]) {
        try {
          const written = (await resavedExample(path, text)) ?? JSON.stringify(writtenForm(JSON.parse(text)));
          out.push({ path, name: baseName(path), text: written, drawn: drawnAs(JSON.parse(written)) });
        } catch {
          // Not a network: left out, as Rust leaves it out.
        }
      }
      return out;
    },
  };
}
