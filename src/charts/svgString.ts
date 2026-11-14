// A chart as a standalone SVG string for the export (new in 2.1, ROADMAP B5): the chart's own
// <svg>, without its hover and focus furniture, on white, every `var(--token)` replaced by the
// light theme's value (theme.ts `lightValue`). The diagram export's renderer
// (src-tauri/src/canvas_export.rs) turns it into a PDF or PNG and embeds the font it names.
import { lightValue } from "./theme";

/** Paper white, as the diagram export's (figure.tsx `PAPER_WHITE`). */
export const CHART_PAPER = "#ffffff";
/** The paper left round an exported chart, in points. */
export const CHART_MARGIN = 16;

const VAR = /var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g;

/** Replaces every `var(--token)` in `markup` with the token's light value. Throws for a token styles.css lacks. */
export function resolveTokens(markup: string): string {
  return markup.replace(VAR, (_all, name: string) => lightValue(name));
}

/** The chart's <svg> under (or at) `el`. */
export function chartSvgElement(el: Element | null | undefined): SVGSVGElement | null {
  if (!el) return null;
  if (el.matches("svg[data-chart]")) return el as SVGSVGElement;
  return el.querySelector<SVGSVGElement>("svg[data-chart]");
}

/**
 * `el`'s chart, serialised: light colours whatever the app shows, a white ground with a margin, no interactive
 * parts (`data-export="skip"`), no ids, classes, ARIA or tab stop. Null when `el` holds no chart.
 */
export function chartSvgString(el: Element | null | undefined): string | null {
  const svg = chartSvgElement(el);
  const doc = svg?.ownerDocument;
  const win = doc?.defaultView;
  if (!svg || !doc || !win) return null;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.querySelectorAll('[data-export="skip"]').forEach((n) => n.remove());
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      if (attr.name === "class" || attr.name === "tabindex" || attr.name === "role" || attr.name === "style" || attr.name.startsWith("aria-") || attr.name.startsWith("data-")) node.removeAttribute(attr.name);
    }
  }
  // The drawing keeps its size; the figure is that plus a margin of paper all round.
  const width = Number(svg.getAttribute("width") ?? 0) + 2 * CHART_MARGIN;
  const height = Number(svg.getAttribute("height") ?? 0) + 2 * CHART_MARGIN;
  const ns = "http://www.w3.org/2000/svg";
  const drawing = doc.createElementNS(ns, "g");
  drawing.setAttribute("transform", `translate(${CHART_MARGIN},${CHART_MARGIN})`);
  while (copy.firstChild) drawing.appendChild(copy.firstChild);
  const ground = doc.createElementNS(ns, "rect");
  ground.setAttribute("width", String(width));
  ground.setAttribute("height", String(height));
  ground.setAttribute("fill", CHART_PAPER);
  copy.appendChild(ground);
  copy.appendChild(drawing);
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  copy.setAttribute("viewBox", `0 0 ${width} ${height}`);
  // The serialiser declares the SVG namespace itself; a browser that leaves it out gets it here.
  const text = new win.XMLSerializer().serializeToString(copy);
  return resolveTokens(/^<svg[^>]*\sxmlns=/.test(text) ? text : text.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"'));
}
