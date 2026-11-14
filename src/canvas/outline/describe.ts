// A node or a link as text (new in 2.1, ledger WF-603): what the Canvas Outline lists and what the
// canvas says when the selection changes. One reading for both, built from the same functions the
// drawing uses (labels.ts, the results overlay's items, the problems' sentences), so the text can
// never disagree with the picture.
import { nodeFeatures } from "../../extended/model";
import { KIND_NAMES, type Editor } from "../../editor";
import type { BnetLink, BnetNode } from "../../lib/bnet";
import { detailText, nodeDescription, rateDescription } from "../layers/labels";
import type { CanvasResults } from "../overlay/ResultsLayer";
import { overlayWords } from "../overlay/words";
import { countProblems, type Diagnostic } from "../validation/model";
import { validationWords } from "../validation/words";
import { outlineWords as w } from "./words";

export interface OutlineContext {
  editor: Editor;
  results: CanvasResults | null;
  diagnostics: readonly Diagnostic[];
  utilisation?: Readonly<Record<string, number>>;
}

export interface NodeFacts {
  node: BnetNode;
  kind: string;
  /** "c=2, service rate μ = 1.25 jobs per time unit per server, SCV 1 (exponential)". */
  parameters: string;
  /** "80.0 %", with "the bottleneck" when it is; null when the canvas shows no value for it. */
  result: string | null;
  problems: readonly Diagnostic[];
  /** The whole of it in one sentence, for a label or an announcement. */
  spoken: string;
}

export interface LinkFacts {
  link: BnetLink;
  /** "S1 → B2". */
  label: string;
  cls: string;
  probability: string;
  problems: readonly Diagnostic[];
  spoken: string;
}

/** "Results on canvas: Utilization, Product Form, Exact", with the stale note when it applies. */
export function resultsCaption(results: CanvasResults | null): string | null {
  if (!results) return null;
  const m = results.model;
  const caption = overlayWords.layerLabel(m.metric, m.method, overlayWords.tier[m.tier]);
  return m.stale ? `${caption} (${overlayWords.stale})` : caption;
}

function problemsSpoken(problems: readonly Diagnostic[]): string | null {
  const real = problems.filter((d) => d.severity !== "info");
  if (!real.length) return null;
  return w.spokenProblems(real.length, `${validationWords.severity[real[0].severity]}. ${validationWords.sentence(real[0])}`);
}

/** "2 errors, 1 warning", or "None". */
export function problemsSummary(problems: readonly Diagnostic[]): string {
  const c = countProblems(problems);
  return w.problems(c.errors, c.warnings, c.notes) || w.noProblems;
}

export function nodeFacts(ctx: OutlineContext, node: BnetNode): NodeFacts {
  const { editor, results } = ctx;
  const rho = ctx.utilisation?.[node.id];
  // With the model features new in 2.1 the node uses (priority order, batch sizes, rate profile).
  const parameters = [detailText(node, editor.infiniteBuffers), rateDescription(node), ...nodeFeatures(node).map((f) => f.outline)].filter(Boolean).join(", ");
  const item = results?.model.items.get(node.id.toUpperCase());
  let result: string | null = null;
  if (item) {
    result = item.plusMinus ? `${item.number} ${item.plusMinus} ${item.unit}`.trim() : item.text;
    if (item.bottleneck) result += ` (${item.tied ? w.tied : w.bottleneck})`;
    if (results!.model.stale) result += ` (${w.stale})`;
  }
  const problems = ctx.diagnostics.filter((d) => d.nodeIds.includes(node.id));
  const parts = [nodeDescription(node, editor.infiniteBuffers, rho)];
  if (item && results) parts.push(w.spokenResult(results.model.metric, result!));
  const p = problemsSpoken(problems);
  if (p) parts.push(p);
  return { node, kind: KIND_NAMES[node.kind], parameters, result, problems, spoken: parts.join(". ") };
}

export function linkFacts(ctx: OutlineContext, link: BnetLink): LinkFacts {
  const { editor } = ctx;
  const problems = ctx.diagnostics.filter((d) => d.linkIds.includes(link.id) && !d.nodeIds.length);
  const exits = link.toCustomerClass !== undefined && link.toCustomerClass !== link.customerClass ? ` → Class ${link.toCustomerClass + 1}` : "";
  const parts = [editor.linkDescription(link)];
  const p = problemsSpoken(problems);
  if (p) parts.push(p);
  return {
    link,
    label: editor.displayLabel(link),
    cls: `Class ${link.customerClass + 1}${exits}`,
    probability: String(Number(link.routingProbability.toPrecision(6))),
    problems,
    spoken: parts.join(". "),
  };
}

/** The links in the outline's order: by the node they leave (reading order), then by class. */
export function linksInOutlineOrder(editor: Editor): BnetLink[] {
  const order = new Map(editor.nodesInReadingOrder.map((n, i) => [n.id, i]));
  return [...editor.links].sort((a, b) => (order.get(a.fromNodeID) ?? 0) - (order.get(b.fromNodeID) ?? 0) || a.customerClass - b.customerClass || (order.get(a.toNodeID) ?? 0) - (order.get(b.toNodeID) ?? 0));
}

/** What the canvas says about the selection as it stands; null when it should say nothing new. */
export function selectionSpoken(ctx: OutlineContext): string {
  const { editor } = ctx;
  const v = editor.view;
  const link = editor.link(v.selectedLinkID);
  if (link) return w.spokenSelected(linkFacts(ctx, link).spoken);
  const ids = v.selectedNodeID ? [v.selectedNodeID] : [...v.selectedNodeIDs];
  if (ids.length === 1) {
    const node = editor.node(ids[0]);
    if (node) return w.spokenSelected(nodeFacts(ctx, node).spoken);
  }
  if (ids.length > 1) return w.spokenSeveral(ids.length);
  return w.spokenNone;
}
