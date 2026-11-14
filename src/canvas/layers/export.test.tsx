// The export path: the image export renders the very same SceneLayers with react-dom/server, in
// the light ("aqua") colours. The markup must stand alone: no CSS variable, no currentColor, no
// accessibility element, the same picture whatever the screen's appearance (0.90.34 drew every
// export inside NSAppearance(.aqua); ledger ANA-191 for the badges).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canvasColors } from "./colors";
import { SceneLayers } from "./SceneLayers";
import { byName, example, EXAMPLE_NAMES, quietView, sceneOf } from "./testkit";

function exportSvg(name: string, extra: { utilisation?: Record<string, number>; grid?: boolean; background?: string | null } = {}) {
  const d = example(name);
  return renderToStaticMarkup(
    <SceneLayers scene={sceneOf(d)} view={quietView({ selectedNodeID: d.nodes[0].id, hoveredLinkID: d.links[0]?.id ?? null })} colors={canvasColors("light")} infiniteBuffers={d.infiniteBuffers} snapshot {...extra} />,
  );
}

describe("SceneLayers through renderToStaticMarkup", () => {
  it.each(EXAMPLE_NAMES)("%s renders a standalone SVG with no CSS variables", (name) => {
    const svg = exportSvg(name, { background: "#ffffff" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toMatch(/var\(--/);
    expect(svg).not.toMatch(/currentColor/i);
    expect(svg).not.toMatch(/role="button"/);
    expect(svg).not.toMatch(/<title>/);
  });

  it("draws the ρ badges, the pictures and the labels, and leaves out hover and selection", () => {
    const d = example("5stationtandem.inf.bnet");
    const svg = exportSvg("5stationtandem.inf.bnet", { utilisation: { [byName(d, "S1").id]: 0.9 } });
    expect(svg).toContain("ρ 0.9");
    expect(svg).toContain('data-picture="person.fill"');
    expect(svg).toContain(">S1</text>");
    expect(svg).not.toContain('data-part="selection-ring"');
    expect(svg).not.toContain('data-part="hover-ring"');
    expect(svg).not.toContain(canvasColors("light").linkHalo);
  });

  it("is the same picture in a dark-mode session: the colours are an argument, not the screen's", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const a = exportSvg("2dtandem.bnet").replace(/_r_[\w-]+?-/g, "");
    document.documentElement.removeAttribute("data-theme");
    const b = exportSvg("2dtandem.bnet").replace(/_r_[\w-]+?-/g, "");
    expect(a).toBe(b);
    expect(a).toContain(canvasColors("light").stationFill);
    expect(a).not.toContain(canvasColors("dark").stationFill);
  });

  it("leaves the grid out on request (the export's default)", () => {
    expect(exportSvg("2dtandem.bnet", { grid: false })).not.toContain('data-layer="grid"');
    expect(exportSvg("2dtandem.bnet")).toContain('data-layer="grid"');
  });
});
