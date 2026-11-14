// The edits a problem offers (new in 2.1, ROADMAP C4). Every one goes through the editor's own
// mutations, so it is one undoable step, writes its Status line and triggers the analysis like the
// same edit made by hand. The numbers (how many servers, which rate) are Rust's; nothing is
// worked out here beyond where to put a new node.
import type { Editor } from "../../editor/editor";
import type { BnetNode } from "../../lib/bnet";
import type { Diagnostic } from "./model";
import { validationWords as w } from "./words";
import { convertToClosed, makeClosed } from "../../closed/commands";

export interface Fix {
  id: string;
  label: string;
  run: () => void;
}

/** How far a node added by a fix sits from the node it is for. */
const STEP = 112;

const distance = (a: BnetNode, b: BnetNode) => Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]);
const nearest = (to: BnetNode, among: readonly BnetNode[]) => among.reduce<BnetNode | undefined>((best, n) => (!best || distance(n, to) < distance(best, to) ? n : best), undefined);

/** Several mutations in one task are one undo group; this names it. */
function group(editor: Editor, name: string, block: () => void) {
  const selection = editor.view.selectedNodeID;
  block();
  editor.undoManager.setActionName(name);
  // A fix leaves the node it was for selected, not the helper it added.
  if (selection && editor.node(selection)) editor.setView({ selectedNodeID: selection, selectedLinkID: null, pendingLinkStartID: null });
}

/** The classes work arrives at `node` as (a link's exit class), or Class 1 when nothing arrives yet. */
function arrivingClasses(editor: Editor, node: BnetNode): number[] {
  const classes = new Set(editor.links.filter((l) => l.toNodeID === node.id).map((l) => l.toCustomerClass ?? l.customerClass));
  return classes.size ? [...classes].sort((a, b) => a - b) : [0];
}

function connectToSink(editor: Editor, station: BnetNode, sink: BnetNode) {
  for (const c of arrivingClasses(editor, station)) {
    if (!editor.links.some((l) => l.fromNodeID === station.id && l.toNodeID === sink.id && l.customerClass === c)) editor.addLink(station.id, sink.id, c);
  }
}

const inspector = (editor: Editor, d: Diagnostic): Fix[] => {
  const node = editor.node(d.nodeIds[0]);
  if (node && node.kind !== "sink") return [{ id: "inspector", label: w.fix.inspector, run: () => editor.openParameterEditor(node.id) }];
  const link = !node ? editor.link(d.linkIds[0]) : undefined;
  if (link) return [{ id: "inspector", label: w.fix.inspector, run: () => editor.openLinkParameterEditor(link.id) }];
  return [];
};

/** The fixes for `d` in the document as it is now; the first is the one to recommend. */
export function fixesFor(d: Diagnostic, editor: Editor): Fix[] {
  const node = editor.node(d.nodeIds[0]);
  const link = editor.link(d.linkIds[0]);
  const v = d.values;
  const out: Fix[] = [];
  const sinks = editor.nodes.filter((n) => n.kind === "sink");
  switch (d.code) {
    case "unstable":
    case "overloaded":
    case "nearlyUnstable": {
      if (!node) break;
      const n = v.suggestedServers;
      if (n !== undefined && n > node.numberOfServers) {
        out.push({ id: "servers", label: n === node.numberOfServers + 1 ? w.fix.addServer : w.fix.useServers(n), run: () => editor.updateNumberOfServers(node.id, n) });
      }
      if (v.suggestedParameters && v.suggestedRate !== undefined) {
        const parameters = v.suggestedParameters;
        out.push({ id: "rate", label: w.fix.raiseRate(v.suggestedRate), run: () => editor.updateNodeDistribution(node.id, node.distribution, parameters) });
      }
      break;
    }
    case "noWayOut":
    case "noPathToSink": {
      const sink = node && node.kind === "station" ? nearest(node, sinks) : undefined;
      if (node && sink) out.push({ id: "connect-sink", label: w.fix.connectToSink, run: () => group(editor, w.undo.connectToSink, () => connectToSink(editor, node, sink)) });
      break;
    }
    case "noSink": {
      const stations = editor.nodes.filter((n) => n.kind === "station");
      if (!editor.nodes.length) break;
      out.push({
        id: "add-sink",
        label: w.fix.addSink,
        run: () =>
          group(editor, w.undo.addSink, () => {
            // To the right of the rightmost node, and every station that leads nowhere leads to it.
            const right = editor.nodes.reduce((a, b) => (b.position[0] > a.position[0] ? b : a));
            const sink = editor.addNode("sink", { x: right.position[0] + STEP, y: right.position[1] });
            for (const s of stations) if (!editor.links.some((l) => l.fromNodeID === s.id)) connectToSink(editor, s, sink);
          }),
      });
      break;
    }
    case "noSource": {
      if (!editor.nodes.length) break;
      out.push({
        id: "add-source",
        label: w.fix.addSource,
        run: () => {
          const left = editor.nodes.reduce((a, b) => (b.position[0] < a.position[0] ? b : a));
          editor.addNode("source", { x: left.position[0] - STEP, y: left.position[1] });
        },
      });
      break;
    }
    case "stationNeedsBuffer": {
      if (!node) break;
      out.push({
        id: "add-buffer",
        label: w.fix.addBuffer,
        run: () =>
          group(editor, w.undo.addBuffer, () => {
            const classes = arrivingClasses(editor, node);
            const incoming = editor.links.filter((l) => l.toNodeID === node.id && l.fromNodeID !== node.id);
            const buffer = editor.addNode("buffer", { x: node.position[0] - STEP, y: node.position[1] });
            // What led to the station now leads to its buffer, with the same class and weight.
            for (const l of incoming) {
              editor.deleteLink(l.id);
              editor.addLink(l.fromNodeID, buffer.id, l.customerClass, l.toCustomerClass ?? null, l.routingProbability);
            }
            for (const c of classes) editor.addLink(buffer.id, node.id, c);
          }),
      });
      break;
    }
    case "sourceUnconnected": {
      const buffer = node ? nearest(node, editor.nodes.filter((n) => n.kind === "buffer")) : undefined;
      if (node && buffer) {
        out.push({ id: "connect", label: w.fix.connectTo(buffer.name), run: () => group(editor, w.undo.connect, () => void editor.addLink(node.id, buffer.id, editor.customerClassIndex(node.id))) });
      }
      break;
    }
    case "badArrivalRate":
    case "badServiceRate":
      // A class's own law is the Inspector's to edit; the node's own goes back to its default.
      if (node && v.classIndex === undefined) out.push({ id: "reset-rate", label: w.fix.resetRate, run: () => editor.updateNodeDistribution(node.id, node.distribution, "") });
      break;
    case "noServers":
      if (node) out.push({ id: "one-server", label: w.fix.oneServer, run: () => editor.updateNumberOfServers(node.id, 1) });
      break;
    case "bufferSizeZero":
      if (node) out.push({ id: "size-one", label: w.fix.sizeOne, run: () => editor.updateBufferSize(node.id, 1) });
      break;
    case "sinkUnused":
      if (node) out.push({ id: "delete-sink", label: w.fix.deleteSink, run: () => editor.deleteNode(node.id) });
      break;
    case "routingOverOne": {
      // The numbers are Rust's, and it sends them only when the scaled network still lets the
      // class leave (scaling a row to 1 when its station was the way out closed the loop). With
      // none, the row is the Inspector's to edit.
      const to = v.suggestedProbabilities;
      const links = d.linkIds.map((id) => editor.link(id)).filter((l) => l !== undefined);
      if (to && links.length && to.length === d.linkIds.length && links.length === d.linkIds.length) {
        out.push({
          id: "scale",
          label: w.fix.scaleRouting(to, v.exit),
          run: () =>
            group(editor, w.undo.scaleRouting, () => {
              links.forEach((l, i) => editor.updateLinkProbability(l.id, to[i]));
            }),
        });
      }
      break;
    }
    case "routingSinkOverOne": {
      // Rust's numbers again: what the row's other links leave, shared among its sink links.
      const to = v.suggestedProbabilities;
      const links = d.linkIds.map((id) => editor.link(id)).filter((l) => l !== undefined);
      if (to && links.length && to.length === d.linkIds.length && links.length === d.linkIds.length) {
        out.push({
          id: "sink-share",
          label: w.fix.sinkShare(to),
          run: () =>
            group(editor, w.undo.sinkShare, () => {
              links.forEach((l, i) => editor.updateLinkProbability(l.id, to[i]));
            }),
        });
      }
      break;
    }
    case "sourceMustFeedBuffer": {
      const from = link && editor.node(link.fromNodeID);
      const to = link && editor.node(link.toNodeID);
      const own = to && editor.nodes.find((n) => n.kind === "buffer" && editor.links.some((l) => l.fromNodeID === n.id && l.toNodeID === to.id));
      if (link && from && own) {
        // The station has its buffer already: the source should lead there.
        out.push({
          id: "connect",
          label: w.fix.connectTo(own.name),
          run: () =>
            group(editor, w.undo.connect, () => {
              editor.deleteLink(link.id);
              editor.addLink(from.id, own.id, link.customerClass, null, link.routingProbability);
            }),
        });
      } else if (link && from && to && to.kind === "station") {
        out.push({
          id: "insert-buffer",
          label: w.fix.insertBuffer,
          run: () =>
            group(editor, w.undo.insertBuffer, () => {
              const buffer = editor.addNode("buffer", { x: (from.position[0] + to.position[0]) / 2, y: (from.position[1] + to.position[1]) / 2 });
              editor.deleteLink(link.id);
              editor.addLink(from.id, buffer.id, link.customerClass, null, link.routingProbability);
              editor.addLink(buffer.id, to.id, link.toCustomerClass ?? link.customerClass);
            }),
        });
      }
      if (link) out.push({ id: "delete-link", label: w.fix.deleteLink, run: () => editor.deleteLink(link.id) });
      break;
    }
    // Closed networks (new in 2.1). The population offered is Rust's.
    case "closedCandidate":
      if (v.population !== undefined) out.push({ id: "make-closed", label: w.fix.makeClosed(v.population), run: () => makeClosed(editor, v.population) });
      break;
    case "closedLoop": {
      // "Never leaves": if that is what was meant, the source and the sink go and the customers stay.
      const n = v.population;
      if (n !== undefined) out.push({ id: "make-closed", label: w.fix.makeClosed(n), run: () => convertToClosed(editor, n) });
      break;
    }
    case "populationIgnored":
      out.push({ id: "remove-population", label: w.fix.removePopulation, run: () => editor.setClosedPopulation(null) });
      break;
    case "closedPopulationRange":
      out.push({ id: "reset-population", label: w.fix.resetPopulation(Math.max(2, 2 * editor.nodes.filter((n) => n.kind === "station").length)), run: () => makeClosed(editor) });
      break;
    case "closedBufferTooSmall":
      out.push({ id: "infinite-buffers", label: w.fix.infiniteBuffers, run: () => editor.setInfiniteBuffers(true) });
      break;
    case "linkOutOfSink":
    case "sinkFedByBuffer":
    case "linkNeverUsed":
      if (link) out.push({ id: "delete-link", label: w.fix.deleteLink, run: () => editor.deleteLink(link.id) });
      break;
  }
  // A link that is simply wrong has nothing to edit in the Inspector.
  if (d.code !== "linkOutOfSink" && d.code !== "sinkUnused") out.push(...inspector(editor, d));
  return out;
}
