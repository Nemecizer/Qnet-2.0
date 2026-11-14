// The files area in the browser preview: the examples folder, the exports, Generate Random
// Network, and the Open and Save panels (`plugin:dialog|open`, `plugin:dialog|save`), which the
// preview can't show natively, so it asks for a path with the browser's prompt. The exporters and
// the generator are Rust's (src-tauri/src/files.rs); the preview only says what it would write.
import type { ExamplesLookup, ExportAllReport, GeneratedNetwork } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";
import { exampleFiles, MOCK_EXAMPLES_DIR } from "./documents";
import { pickPath } from "./picker";

const baseName = (p: string) => p.split("/").pop() ?? p;

interface PanelOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  filters?: { extensions?: string[] }[];
}

/** The preview's stand-in for a file panel: a prompt with the suggested path. */
function promptPath(o: PanelOptions | undefined): string | null {
  if (typeof window === "undefined" || typeof window.prompt !== "function") return null;
  try {
    const answer = window.prompt(o?.title ?? "Choose a file", o?.defaultPath ?? "");
    return answer && answer.trim() ? answer.trim() : null;
  } catch {
    return null;
  }
}

export function fileHandlers(): MockHandlers {
  const written: Record<string, string> = {};
  return {
    "plugin:dialog|open": ({ options }: { options?: PanelOptions }) => {
      // One file, in a real browser: a list to click (./picker.ts). Folders, and the tests' jsdom, keep the prompt.
      if (options?.directory || typeof document === "undefined" || import.meta.env.MODE === "test") return promptPath(options);
      const wanted = (options?.filters ?? []).flatMap((f) => f.extensions ?? []).map((x) => `.${x.toLowerCase()}`);
      const paths = [...Object.keys(exampleFiles()), ...Object.keys(written)].filter((p) => !wanted.length || wanted.some((x) => p.toLowerCase().endsWith(x)));
      // Nothing of the kind asked for (a settings file): the prompt takes a typed path.
      return paths.length ? pickPath(document, { title: options?.title ?? "Open", folder: options?.defaultPath, paths }) : promptPath(options);
    },
    "plugin:dialog|save": ({ options }: { options?: PanelOptions }) => promptPath(options),
    examples_locate: (): ExamplesLookup => ({ path: MOCK_EXAMPLES_DIR, searched: [MOCK_EXAMPLES_DIR], trail: MOCK_EXAMPLES_DIR, home: "/" }),
    export_text: ({ format }: { format: string }) => `(the browser preview doesn't export; Qnet writes the ${format} file here)\n`,
    export_save: ({ path, text }: { path: string; text: string }) => {
      written[path] = text;
      return baseName(path);
    },
    export_all_inputs: ({ folder, convention, document }: { folder: string; convention: string; document: { infiniteBuffers?: boolean } }): ExportAllReport => {
      const files = ["sm.in", "fm.in", "lp.in", "sim.txt", "qna.qna", "cmp_sm.in", "cmp_sim.sim"];
      const titles: Record<string, string> = { manufacturing: "Manufacturing blocking (SRBM default)", loss: "Loss-network correction", bas: "BAS + external-loss correction" };
      const note = document?.infiniteBuffers ? "" : ` Blocking convention: ${titles[convention] ?? convention}.`;
      return { written: files, summary: `Exported ${files.length} solver input file(s) to ${folder}: ${files.join(", ")}.${note}` };
    },
    network_generate: ({ request }: { request: { title: string; stations: number; classes: number; infiniteBuffers: boolean; targetRho: number; topology: string } }): GeneratedNetwork => {
      // The preview has no generator: it opens a bundled example of the chosen buffer regime.
      const name = request.infiniteBuffers ? "3d3ctandem.inf.bnet" : "3d3cfin.bnet";
      const text = exampleFiles()[`${MOCK_EXAMPLES_DIR}/${name}`] ?? '{"nodes":[],"links":[],"infiniteBuffers":true,"canvasScale":1}';
      const label: Record<string, string> = { feedForward: "feed-forward", jacksonFeedback: "Jackson feedback", generalPMatrix: "general P-matrix", reentrantFeedback: "reentrant (class-change)" };
      return {
        text,
        lines: [
          { text: `Generated ${request.title}: d=${request.stations}, c=${request.classes}, ${request.infiniteBuffers ? "infinite" : "finite"} buffers, target ρ=${request.targetRho.toFixed(2)}, topology=${label[request.topology] ?? request.topology}.` },
          { text: "No warnings — banner should stay hidden." },
        ],
      };
    },
  };
}
