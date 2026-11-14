// The diagram export and the archetype gallery in the browser preview (src-tauri/src/canvas_export.rs,
// src-tauri/src/archetypes.rs). The preview can't render a PDF, fill the pasteboard or print: it
// records what it was asked (for the tests) and answers as Rust would. The archetype is built
// exactly as Rust builds it (./archetypes.ts).
import type { ArchetypeRequest } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";
import { buildArchetype } from "./archetypes";

export interface DiagramCall {
  cmd: "diagram_export" | "diagram_copy" | "diagram_print" | "diagram_page_setup";
  args: Record<string, unknown>;
}

/** What the preview was asked to write, copy or print, oldest first. */
export const diagramCalls: DiagramCall[] = [];
/** Files the preview "wrote", path → format. */
export const diagramFiles = new Map<string, string>();

const baseName = (p: string) => p.split("/").pop() ?? p;
const svgOk = (svg: unknown) => typeof svg === "string" && svg.startsWith("<svg") && svg.endsWith("</svg>");

export function exportHandlers(): MockHandlers {
  return {
    diagram_export: (args: { svg: string; format: string; scale: number; path: string }) => {
      diagramCalls.push({ cmd: "diagram_export", args });
      if (!svgOk(args.svg) || !["pdf", "png"].includes(args.format)) throw { kind: "invalid", message: "Qnet couldn't render the diagram." };
      if (args.path.includes("/read-only/")) throw { kind: "failed", message: "Permission denied (os error 13)" };
      diagramFiles.set(args.path, args.format);
      return baseName(args.path);
    },
    diagram_copy: (args: { pdfSvg: string; imageSvg: string; scale: number }) => {
      diagramCalls.push({ cmd: "diagram_copy", args });
      if (!svgOk(args.pdfSvg) || !svgOk(args.imageSvg)) throw { kind: "invalid", message: "Qnet couldn't render the diagram." };
      return null;
    },
    diagram_print: (args: { svg: string; jobTitle: string }) => {
      diagramCalls.push({ cmd: "diagram_print", args });
      if (!svgOk(args.svg)) throw { kind: "invalid", message: "Qnet couldn't render the diagram." };
      return null;
    },
    diagram_page_setup: () => {
      diagramCalls.push({ cmd: "diagram_page_setup", args: {} });
      return null;
    },
    network_archetype: ({ request }: { request: ArchetypeRequest }) => buildArchetype(request),
  };
}

/** For tests. */
export function resetDiagramMock() {
  diagramCalls.length = 0;
  diagramFiles.clear();
}
