// The nine tools the assistant may call (0.90.34 AITools.swift `AIToolFactory`, `ToolRegistry`,
// `AICommand`; QnetGUIApp.swift `registerDefaultAITools`, `dispatch(aiCommand:)`; ledger §13.5):
// their names, descriptions, JSON schemas, validation and result sentences, exactly 0.90.34's.
// They act on the editor of the tab the conversation belongs to, through the same Editor methods
// the inspectors use, with no confirmation (decision D9); each editor call is its own undo step,
// as 0.90.34 made it. `run_command` goes through the Run menu's own handlers, which act on the
// tab in front, and answers with what the run wrote to that tab's Status log.
import type { Editor } from "../../editor";
import type { BnetLink, BnetNode } from "../../lib/bnet";
import type { AiToolSpec } from "../../lib/types";
import { analyzeNetwork, showNetworkPrimitives } from "../../analysis/report";
import { modalOpen } from "../../lib/overlays";
import { runMenuItemFor } from "../../runs/ui/commands";
import { getRunState } from "../../runs/state";
import { hasBeenAnalyzed } from "../status/analysis";
import { formattedLine } from "../status/entries";
import { activeTab, addStatus, tabById } from "../../workspace/store";
import { EXPLAIN_EDITING_TOOLS, EXPLAIN_HANDLERS, EXPLAIN_SPECS } from "./explain/tools";
import { batchMean, featureSentences, profileMean } from "../../extended/model";
import { TOOL_DESCRIPTIONS } from "./toolText";

type Input = Record<string, unknown>;

/** 0.90.34 `ToolError`: what a tool's refusal reads as (`errorDescription`). */
export class ToolError extends Error {
  static unknown = (name: string) => new ToolError(`Unknown tool: ${name}`);
  static invalidInput = (msg: string) => new ToolError(`Invalid tool input: ${msg}`);
  static executionFailed = (msg: string) => new ToolError(`Tool execution failed: ${msg}`);
}

/** Thrown out of a tool that was waiting when Stop was pressed. */
export class ToolCancelled extends Error {}

export interface ToolContext {
  /** The conversation's tab (the busy tab while a request runs). */
  tabId: string;
  editor: Editor;
  /** True once the request was stopped: a waiting tool gives up. */
  cancelled: () => boolean;
}

// ── Swift's and Foundation's text forms ──────────────────────────────────────────────────────

/** Swift's `"\(x)"` for a Double: "1.0", "0.5", "1e-05". */
export function swiftDouble(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const abs = Math.abs(x);
  if (abs >= 1e16 || abs < 1e-4) return exponentForm(x);
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

function exponentForm(x: number): string {
  const [m, e] = x.toExponential().split("e");
  const exp = Number(e);
  return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

function jsonNumber(x: number): string {
  if (!Number.isFinite(x)) return "null";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return String(x);
  const abs = Math.abs(x);
  return abs >= 1e16 || abs < 1e-4 ? exponentForm(x) : String(x);
}

function jsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "/") out += "\\/";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** `JSONSerialization` with `.prettyPrinted` and `.sortedKeys`: two-space indent, `"key" : value`. */
export function prettyJSON(v: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return jsonNumber(v);
  if (typeof v === "string") return jsonString(v);
  if (Array.isArray(v)) {
    if (!v.length) return `[\n\n${pad}]`;
    return `[\n${v.map((x) => inner + prettyJSON(x, depth + 1)).join(",\n")}\n${pad}]`;
  }
  const keys = Object.keys(v as object).sort();
  if (!keys.length) return `{\n\n${pad}}`;
  return `{\n${keys.map((k) => `${inner}${jsonString(k)} : ${prettyJSON((v as Input)[k], depth + 1)}`).join(",\n")}\n${pad}}`;
}

/** The transcript's pretty-printed tool input (`AIModel.prettyJSON`): "{}" for no arguments. */
export function inputText(input: Input): string {
  return Object.keys(input).length ? prettyJSON(input) : "{}";
}

/** The collapsed row's one-line summary (`formatInput`): keys sorted, values cut at 40 characters. */
export function inputSummary(input: Input): string {
  return Object.keys(input)
    .sort()
    .map((key) => {
      const raw = input[key];
      let v = typeof raw === "string" ? raw : raw === null ? "<null>" : typeof raw === "boolean" ? (raw ? "1" : "0") : typeof raw === "number" ? String(raw) : JSON.stringify(raw);
      if ([...v].length > 40) v = [...v].slice(0, 40).join("") + "…";
      return `${key}=${v}`;
    })
    .join(", ");
}

// ── Reading arguments as Swift's `as?` casts did ─────────────────────────────────────────────

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** `as? Int`: a JSON number with no fraction; anything else counts as not given. */
const asInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const asDouble = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

// ── The model's words ────────────────────────────────────────────────────────────────────────

/** `NodeKind.allCases` and `QueueDistribution.allCases`, in 0.90.34's order. */
export const KIND_NAMES = ["station", "buffer", "source", "sink"] as const;
export const DIST_NAMES = ["exponential", "gamma", "uniform", "constant", "weibull", "erlang", "lognormal", "pareto", "poisson"] as const;

/** `AICommand`: the menu commands `run_command` may drive, with their labels. */
export const AI_COMMANDS: [name: string, label: string][] = [
  ["RunComparison", "Run Comparison"],
  ["RunMonteCarlo", "Run Monte Carlo"],
  ["RunSpectralMethod", "Run Spectral Method"],
  ["RunFiniteElement", "Run Finite Element (finite buffers only)"],
  ["RunQNA", "Run Whitt QNA (infinite buffers only)"],
  ["RunSBD", "Run SBD (infinite buffers only)"],
  ["RunMultiClassSRBM", "Run Multi-Class SRBM (experimental)"],
  ["RunExactSimulation", "Run SRBM MLMC (infinite buffers only)"],
  ["RunLinearProgram", "Run Linear Program (infinite buffers only)"],
  ["RunFiniteLP", "Run Finite-Buffer LP (finite buffers only)"],
  ["ShowNetworkPrimitives", "Show Network Primitives report"],
  ["AnalyzeNetwork", "Analyze the active network"],
];
const COMMAND_NAMES = AI_COMMANDS.map(([n]) => n);

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const int = (description: string, minimum: number, extra: Record<string, unknown> = {}) => ({ type: "integer", minimum, description, ...extra });
const FROM = str("Source node's display name.");
const TO = str("Destination node's display name.");

const SPECS: AiToolSpec[] = [
  { name: "get_network_summary", description: TOOL_DESCRIPTIONS.get_network_summary, inputSchema: object({}, []) },
  {
    name: "add_node",
    description: TOOL_DESCRIPTIONS.add_node,
    inputSchema: object(
      {
        kind: str("Node kind to create.", { enum: [...KIND_NAMES] }),
        name: str("Optional explicit name. Auto-named if omitted."),
        number_of_servers: int("Initial server count (station only).", 1),
        buffer_size: int("Initial buffer capacity (buffer-kind only).", 1),
        distribution: str("Initial service / interarrival distribution (station or source).", { enum: [...DIST_NAMES] }),
        distribution_parameters: str("Initial parameter string for the distribution."),
      },
      ["kind"],
    ),
  },
  { name: "delete_node", description: TOOL_DESCRIPTIONS.delete_node, inputSchema: object({ name: str("Display name of the node to delete.") }, ["name"]) },
  {
    name: "add_link",
    description: TOOL_DESCRIPTIONS.add_link,
    inputSchema: object(
      {
        from_node_name: FROM,
        to_node_name: TO,
        routing_probability: { type: "number", minimum: 0, maximum: 1, description: "Outgoing routing probability (default 1.0)." },
        customer_class: int("Customer-class index a job has when entering the link (default 0).", 0),
        to_customer_class: int("Customer-class index when exiting the link (omit for no class transition).", 0),
      },
      ["from_node_name", "to_node_name"],
    ),
  },
  {
    name: "delete_link",
    description: TOOL_DESCRIPTIONS.delete_link,
    inputSchema: object({ from_node_name: FROM, to_node_name: TO, customer_class: int("Disambiguator for parallel links — the link's customer_class.", 0) }, ["from_node_name", "to_node_name"]),
  },
  {
    name: "update_node",
    description: TOOL_DESCRIPTIONS.update_node,
    inputSchema: object(
      {
        name: str("Current display name of the node to edit."),
        new_name: str("Rename the node. Must be unique among existing nodes."),
        number_of_servers: int("Server count (station only).", 1),
        buffer_size: int("Buffer capacity (buffer-kind nodes only).", 1),
        distribution: str("Service (station) or interarrival (source) distribution family.", { enum: [...DIST_NAMES] }),
        distribution_parameters: str('Parameter string in "key=value,..." form. See tool description for per-distribution examples.'),
      },
      ["name"],
    ),
  },
  {
    name: "update_link",
    description: TOOL_DESCRIPTIONS.update_link,
    inputSchema: object(
      {
        from_node_name: FROM,
        to_node_name: TO,
        customer_class: int("Disambiguator for parallel links — the link's CURRENT customer_class.", 0),
        new_routing_probability: { type: "number", minimum: 0, maximum: 1, description: "New outgoing routing probability." },
        new_customer_class: int("Set the link's entering customer-class index.", 0),
        new_to_customer_class: { type: ["integer", "null"], minimum: 0, description: "Set the link's exit customer-class index (null clears any class transition)." },
      },
      ["from_node_name", "to_node_name"],
    ),
  },
  {
    name: "run_command",
    description: TOOL_DESCRIPTIONS.run_command(AI_COMMANDS.map(([n, l]) => `- ${n}: ${l}`).join("\n")),
    inputSchema: object(
      {
        name: str("The command to execute.", { enum: COMMAND_NAMES }),
        timeout_seconds: { type: "number", description: "Max seconds to wait for the run to settle (default 60, max 600).", minimum: 1, maximum: 600 },
      },
      ["name"],
    ),
  },
  {
    name: "read_status",
    description: TOOL_DESCRIPTIONS.read_status,
    inputSchema: object({ tail: { type: "integer", description: "Number of most-recent lines to return (default 50, max 500).", minimum: 1, maximum: 500 } }, []),
  },
];

/** The catalog as the provider is sent it: sorted by name (`ToolRegistry.allDefinitions`). */
export function toolSpecs(): AiToolSpec[] {
  // 0.90.34's nine, then 2.1's explaining tools (./explain/tools.ts).
  return [...SPECS, ...EXPLAIN_SPECS].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

const q = (s: string) => `"${s}"`;

/** `findNode(named:in:)`: names are unique within a tab. */
function findNode(name: string, editor: Editor): BnetNode {
  const node = editor.nodes.find((n) => n.name === name);
  if (!node) {
    const available = editor.nodes.map((n) => n.name).sort().join(", ");
    throw ToolError.invalidInput(`No node named ${q(name)}. Existing nodes: ${available === "" ? "(none)" : available}.`);
  }
  return node;
}

/** The one link between two named nodes, or the refusal that lists the classes to choose from. */
function findLink(input: Input, editor: Editor): { from: BnetNode; to: BnetNode; link: BnetLink } {
  const fromName = asString(input.from_node_name);
  if (!fromName) throw ToolError.invalidInput("`from_node_name` is required.");
  const toName = asString(input.to_node_name);
  if (!toName) throw ToolError.invalidInput("`to_node_name` is required.");
  const from = findNode(fromName, editor);
  const to = findNode(toName, editor);
  const candidates = editor.links.filter((l) => l.fromNodeID === from.id && l.toNodeID === to.id);
  if (!candidates.length) throw ToolError.invalidInput(`No link from ${q(fromName)} to ${q(toName)}.`);
  const classFilter = asInt(input.customer_class);
  const classes = (ls: BnetLink[]) => ls.map((l) => l.customerClass).sort((a, b) => a - b).join(", ");
  let matches = candidates;
  if (classFilter !== undefined) {
    matches = candidates.filter((l) => l.customerClass === classFilter);
    if (!matches.length) throw ToolError.invalidInput(`No link from ${q(fromName)} to ${q(toName)} with customer_class=${classFilter}. Available classes on this pair: ${classes(candidates)}.`);
  }
  if (matches.length !== 1) throw ToolError.invalidInput(`Multiple parallel links from ${q(fromName)} to ${q(toName)} (customer_class values: ${classes(matches)}). Pass \`customer_class\` to disambiguate.`);
  return { from, to, link: matches[0] };
}

function parseDistribution(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!(DIST_NAMES as readonly string[]).includes(raw)) throw ToolError.invalidInput(`\`distribution\` must be one of: ${DIST_NAMES.join(", ")}.`);
  return raw;
}

/** `nextNodePosition`: 120 pt right of the rightmost node, or (300, 200) on an empty canvas. */
function nextNodePosition(editor: Editor): { x: number; y: number } {
  let rightmost: readonly [number, number] | null = null;
  // Swift's `max(by:)` keeps the last of equal maxima.
  for (const n of editor.nodes) if (!rightmost || !(n.position[0] < rightmost[0])) rightmost = n.position;
  return rightmost ? { x: rightmost[0] + 120, y: rightmost[1] } : { x: 300, y: 200 };
}

// ── The tools ────────────────────────────────────────────────────────────────────────────────

function getNetworkSummary(_input: Input, { editor, tabId }: ToolContext): string {
  const names = new Map(editor.nodes.map((n) => [n.id, n.name]));
  const tab = tabById(tabId);
  const summary: Input = {
    infinite_buffers: editor.infiniteBuffers,
    has_been_analyzed: tab ? hasBeenAnalyzed(tab) : false,
    node_count: editor.nodes.length,
    station_count: editor.nodes.filter((n) => n.kind === "station").length,
    link_count: editor.links.length,
    customer_class_count: Math.max(1, editor.view.activeCustomerClass + 1),
    nodes: editor.nodes.map((node) => {
      const entry: Input = { name: node.name, kind: node.kind };
      if (node.kind === "station") {
        entry.number_of_servers = node.numberOfServers;
        entry.distribution = node.distribution;
        entry.distribution_parameters = node.distributionParameters;
        // New in 2.1, only when set (a plain station's entry is 0.90.34's): priority service.
        if (node.serviceDiscipline && node.serviceDiscipline !== "fcfs") {
          entry.service_discipline = node.serviceDiscipline;
          entry.priority_order_highest_first = [...(node.priorityOrder ?? [])];
        }
      } else if (node.kind === "source") {
        entry.distribution = node.distribution;
        entry.distribution_parameters = node.distributionParameters;
        // New in 2.1, only when set: batch arrivals and a rate profile.
        if (node.batchSize) entry.batch_size = { ...node.batchSize, mean: batchMean(node.batchSize) };
        if (node.rateProfile) entry.rate_profile = { periodic: node.rateProfile.periodic, segments: node.rateProfile.segments.map((s) => ({ until: s.until, multiplier: s.multiplier })), long_run_mean_multiplier: profileMean(node.rateProfile) };
      } else if (node.kind === "buffer") entry.buffer_size = node.bufferSize;
      return entry;
    }),
    links: editor.links.map((link) => {
      const entry: Input = {
        from: names.get(link.fromNodeID) ?? "?",
        to: names.get(link.toNodeID) ?? "?",
        routing_probability: link.routingProbability,
        customer_class: link.customerClass,
      };
      if (link.toCustomerClass !== undefined && link.toCustomerClass !== null) entry.to_customer_class = link.toCustomerClass;
      return entry;
    }),
  };
  // What the features mean, in words: update_node cannot edit them, and no run_command method
  // but the simulation inside Qnet models them (review finding FIX-208d).
  const features = editor.nodes.flatMap(featureSentences);
  if (features.length) summary.model_features = features;
  return prettyJSON(summary);
}

function addNode(input: Input, { editor }: ToolContext): string {
  const rawKind = asString(input.kind);
  if (rawKind === undefined || !(KIND_NAMES as readonly string[]).includes(rawKind)) throw ToolError.invalidInput(`\`kind\` must be one of: ${KIND_NAMES.join(", ")}.`);
  const kind = rawKind as BnetNode["kind"];
  // .whitespaces: spaces and tabs.
  const requestedName = asString(input.name)?.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
  if (requestedName && editor.nodes.some((n) => n.name === requestedName)) throw ToolError.invalidInput(`A node named ${q(requestedName)} already exists.`);

  const servers = asInt(input.number_of_servers);
  const bufSize = asInt(input.buffer_size);
  const distRaw = asString(input.distribution);
  const distPars = asString(input.distribution_parameters);
  if (servers !== undefined && kind !== "station") throw ToolError.invalidInput("`number_of_servers` only applies to station nodes.");
  if (bufSize !== undefined && kind !== "buffer") throw ToolError.invalidInput("`buffer_size` only applies to buffer-kind nodes.");
  if ((distRaw !== undefined || distPars !== undefined) && kind !== "station" && kind !== "source") throw ToolError.invalidInput("`distribution` / `distribution_parameters` only apply to station and source nodes.");
  const dist = parseDistribution(distRaw);

  const node = editor.addNode(kind, nextNodePosition(editor), requestedName);
  const applied: string[] = [];
  if (servers !== undefined) {
    editor.updateNumberOfServers(node.id, servers);
    applied.push(`number_of_servers=${servers}`);
  }
  if (bufSize !== undefined) {
    editor.updateBufferSize(node.id, bufSize);
    applied.push(`buffer_size=${bufSize}`);
  }
  if (dist !== undefined || distPars !== undefined) {
    const resolvedDist = dist ?? node.distribution;
    const resolvedPars = distPars ?? node.distributionParameters;
    editor.updateNodeDistribution(node.id, resolvedDist, resolvedPars);
    applied.push(`distribution=${resolvedDist}`);
    if (distPars !== undefined) applied.push(`distribution_parameters=${q(resolvedPars)}`);
  }
  return `Added ${kind} ${q(node.name)}${applied.length ? ` with ${applied.join(", ")}` : ""}.`;
}

function deleteNode(input: Input, { editor }: ToolContext): string {
  const name = asString(input.name);
  if (!name) throw ToolError.invalidInput("`name` is required.");
  const node = findNode(name, editor);
  const touching = editor.links.filter((l) => l.fromNodeID === node.id || l.toNodeID === node.id).length;
  editor.deleteNode(node.id);
  return touching > 0 ? `Deleted ${node.kind} ${q(node.name)} and ${touching} connected link(s).` : `Deleted ${node.kind} ${q(node.name)}.`;
}

function addLink(input: Input, { editor }: ToolContext): string {
  const fromName = asString(input.from_node_name);
  if (!fromName) throw ToolError.invalidInput("`from_node_name` is required.");
  const toName = asString(input.to_node_name);
  if (!toName) throw ToolError.invalidInput("`to_node_name` is required.");
  const from = findNode(fromName, editor);
  const to = findNode(toName, editor);
  if (from.kind === "sink") throw ToolError.invalidInput(`${q(fromName)} is a sink and cannot be the source of a link.`);
  if (to.kind === "source") throw ToolError.invalidInput(`${q(toName)} is a source and cannot be the destination of a link.`);

  const prob = asDouble(input.routing_probability) ?? 1.0;
  const cls = asInt(input.customer_class) ?? 0;
  const toCls = asInt(input.to_customer_class);
  if (!(prob >= 0 && prob <= 1)) throw ToolError.invalidInput(`\`routing_probability\` must be between 0 and 1 (got ${swiftDouble(prob)}).`);
  if (cls < 0) throw ToolError.invalidInput("`customer_class` must be ≥ 0.");
  if (toCls !== undefined && toCls < 0) throw ToolError.invalidInput("`to_customer_class` must be ≥ 0.");
  if (editor.links.some((l) => l.fromNodeID === from.id && l.toNodeID === to.id && l.customerClass === cls)) {
    throw ToolError.invalidInput(`A link from ${q(fromName)} to ${q(toName)} with customer_class=${cls} already exists. Use update_link to edit it.`);
  }
  const link = editor.addLink(from.id, to.id, cls, toCls ?? null, prob);
  let desc = `Added link ${from.name} → ${to.name} (class ${link.customerClass}, routing_probability=${swiftDouble(link.routingProbability)}`;
  if (link.toCustomerClass !== undefined && link.toCustomerClass !== null) desc += `, to_customer_class=${link.toCustomerClass}`;
  return desc + ").";
}

function deleteLink(input: Input, { editor }: ToolContext): string {
  const { from, to, link } = findLink(input, editor);
  editor.deleteLink(link.id);
  return `Deleted link ${from.name} → ${to.name} (class ${link.customerClass}).`;
}

function updateNode(input: Input, { editor }: ToolContext): string {
  const name = asString(input.name);
  if (!name) throw ToolError.invalidInput("`name` is required and must be non-empty.");
  // A copy as it was before any change, as 0.90.34's value-type node was: the sentences quote it.
  const node = findNode(name, editor);

  const newName = asString(input.new_name) || undefined;
  const servers = asInt(input.number_of_servers);
  const bufSize = asInt(input.buffer_size);
  const distRaw = asString(input.distribution);
  const distPars = asString(input.distribution_parameters);

  // Everything is validated against the node's kind before anything changes.
  if (newName !== undefined && newName !== node.name && editor.nodes.some((n) => n.name === newName)) throw ToolError.invalidInput(`Cannot rename to ${q(newName)}: another node already has that name.`);
  if (servers !== undefined && node.kind !== "station") throw ToolError.invalidInput(`\`number_of_servers\` only applies to station nodes (got kind=${node.kind}).`);
  if (bufSize !== undefined && node.kind !== "buffer") throw ToolError.invalidInput(`\`buffer_size\` only applies to buffer-kind nodes (got kind=${node.kind}).`);
  if ((distRaw !== undefined || distPars !== undefined) && node.kind !== "station" && node.kind !== "source") {
    throw ToolError.invalidInput(`\`distribution\` / \`distribution_parameters\` only apply to station and source nodes (got kind=${node.kind}).`);
  }
  const dist = parseDistribution(distRaw);

  const changes: string[] = [];
  if (newName !== undefined && newName !== node.name) {
    editor.renameNode(node.id, newName);
    changes.push(`name: ${q(node.name)} → ${q(newName)}`);
  }
  if (servers !== undefined) {
    editor.updateNumberOfServers(node.id, servers);
    changes.push(`number_of_servers: ${node.numberOfServers} → ${servers}`);
  }
  if (bufSize !== undefined) {
    editor.updateBufferSize(node.id, bufSize);
    changes.push(`buffer_size: ${node.bufferSize} → ${bufSize}`);
  }
  if (dist !== undefined || distPars !== undefined) {
    const newDist = dist ?? node.distribution;
    const newPars = distPars ?? node.distributionParameters;
    editor.updateNodeDistribution(node.id, newDist, newPars);
    if (newDist !== node.distribution) changes.push(`distribution: ${node.distribution} → ${newDist}`);
    if (newPars !== node.distributionParameters) changes.push(`distribution_parameters: ${q(node.distributionParameters)} → ${q(newPars)}`);
  }
  if (!changes.length) return "No changes — every requested value already matched the node's current state.";
  return `Updated ${node.kind} ${q(node.name)}:\n  - ${changes.join("\n  - ")}`;
}

function updateLink(input: Input, { editor }: ToolContext): string {
  const { from, to, link } = findLink(input, editor);
  const newProb = asDouble(input.new_routing_probability);
  const newClass = asInt(input.new_customer_class);
  // Tri-state: absent leaves the exit class alone, null clears it, an integer sets it.
  const toClassPresent = Object.prototype.hasOwnProperty.call(input, "new_to_customer_class");
  const toClassValue = asInt(input.new_to_customer_class) ?? null;
  if (newProb !== undefined && !(newProb >= 0 && newProb <= 1)) throw ToolError.invalidInput(`\`new_routing_probability\` must be between 0 and 1 (got ${swiftDouble(newProb)}).`);

  const changes: string[] = [];
  if (newProb !== undefined && Math.abs(newProb - link.routingProbability) > 1e-12) {
    editor.updateLinkProbability(link.id, newProb);
    changes.push(`routing_probability: ${swiftDouble(link.routingProbability)} → ${swiftDouble(newProb)}`);
  }
  if (newClass !== undefined && newClass !== link.customerClass) {
    editor.updateLinkCustomerClass(link.id, newClass);
    changes.push(`customer_class: ${link.customerClass} → ${newClass}`);
  }
  if (toClassPresent) {
    const old = link.toCustomerClass ?? null;
    if (old !== toClassValue) {
      editor.updateLinkExitClass(link.id, toClassValue);
      changes.push(`to_customer_class: ${old ?? "null"} → ${toClassValue ?? "null"}`);
    }
  }
  const label = `${from.name} → ${to.name} (class ${link.customerClass})`;
  if (!changes.length) return `No changes — every requested value already matched the link's current state on ${label}.`;
  return `Updated link ${label}:\n  - ${changes.join("\n  - ")}`;
}

/** How `run_command` waits: it reads the Status log every `intervalMs` and settles after `quietMs` without a new line. Tests shorten them. */
export const RUN_WAIT = { intervalMs: 250, quietMs: 2000 };

/**
 * `runCommandRefusal`: the menu handlers act on the tab in front, so while the conversation's tab
 * is not that one the tool refuses, naming both (0.90.34's sentence, `read_network` and all).
 */
export function runCommandRefusal(tabId: string): string | null {
  const front = activeTab();
  const mine = tabById(tabId);
  if (!mine || front.id === tabId) return null;
  return (
    `Not run: this conversation belongs to the tab “${mine.title}”, but “${front.title}” is in front and menu commands act on the front tab. ` +
    `Ask the user to switch back to “${mine.title}” and try again; read_network and the update tools still work on the right tab meanwhile.`
  );
}

/** `dispatch(aiCommand:)`: the Run menu's own handlers, with its buffer-mode guards as Status lines. */
export function dispatchAiCommand(name: string, tabId: string): void {
  const inf = tabById(tabId)?.document.infiniteBuffers ?? true;
  const run = (id: string) => void runMenuItemFor(id, tabId);
  const only = (text: string) => addStatus(text, undefined, tabId);
  switch (name) {
    case "RunComparison":
      return run("run:comparison");
    case "RunMonteCarlo":
      return run(inf ? "run:monte-carlo-infinite" : "run:monte-carlo-finite");
    case "RunSpectralMethod":
      return run(inf ? "run:spectral-infinite" : "run:spectral-finite");
    case "RunFiniteElement":
      return inf ? only("AI: Finite Element is finite-buffer only.") : run("run:finite-element");
    case "RunQNA":
      return inf ? run("run:qna") : only("AI: Whitt QNA is infinite-buffer only.");
    case "RunSBD":
      return inf ? run("run:sbd") : only("AI: SBD is infinite-buffer only.");
    case "RunMultiClassSRBM":
      return run("run:multiclass");
    case "RunExactSimulation":
      return inf ? run("run:mlmc") : only("AI: SRBM MLMC is infinite-buffer only.");
    case "RunLinearProgram":
      return inf ? run("run:lp") : only("AI: Linear Program is infinite-buffer only.");
    case "RunFiniteLP":
      return inf ? only("AI: Finite LP is finite-buffer only.") : run("run:finite-lp");
    case "ShowNetworkPrimitives":
      return void showNetworkPrimitives(tabId);
    case "AnalyzeNetwork":
      return void analyzeNetwork(tabId);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runCommand(input: Input, ctx: ToolContext): Promise<string> {
  const raw = asString(input.name);
  if (raw === undefined) throw ToolError.invalidInput("Missing 'name' argument.");
  const cmd = AI_COMMANDS.find(([n]) => n === raw);
  if (!cmd) throw ToolError.invalidInput(`'${raw}' is not a valid command. Valid: ${COMMAND_NAMES.join(", ")}`);
  const timeout = Math.min(600, Math.max(1, asDouble(input.timeout_seconds) ?? 60));
  const refusal = runCommandRefusal(ctx.tabId);
  if (refusal) return refusal;

  const log = () => tabById(ctx.tabId)?.log ?? [];
  const baseline = log().length;
  dispatchAiCommand(raw, ctx.tabId);

  // Settled once at least one new line has appeared and none for the quiet window; else the timeout.
  // 0.90.34 knew no more than the Status lines, so a solver that worked in silence "settled" while
  // it still ran, and a method that asked with its parameter sheet was waited on to the timeout.
  // 2.0 knows both (ledger AI-061, Changed): a run still going for this tab is never settled, and
  // a sheet left open or closed without running is reported as that.
  const started = Date.now();
  const running = () => getRunState().active?.tabId === ctx.tabId;
  const dialogBefore = modalOpen();
  let lastCount = baseline;
  let lastChange = started;
  let sheet: "none" | "open" | "closed" = "none";
  while (Date.now() - started < timeout * 1000) {
    await sleep(RUN_WAIT.intervalMs);
    if (ctx.cancelled()) throw new ToolCancelled();
    const now = log().length;
    const asking = !dialogBefore && modalOpen() && !running();
    if (asking && sheet !== "open") sheet = "open";
    else if (!asking && sheet === "open") {
      sheet = "closed";
      lastChange = Date.now();
    }
    if (now !== lastCount) {
      lastCount = now;
      lastChange = Date.now();
    } else if (running() || asking) lastChange = Date.now();
    else if ((now > baseline || sheet === "closed") && Date.now() - lastChange >= RUN_WAIT.quietMs) break;
  }
  const lines = log().slice(baseline).map(formattedLine);
  const timedOut = Date.now() - started >= timeout * 1000;
  const waiting = timedOut && sheet === "open" && !running();
  const header = waiting
    ? `(${cmd[1]} — its parameter sheet is open and waiting for the user to press Run or Cancel; nothing has started after ${Math.trunc(timeout)}s:)`
    : timedOut
      ? `(${cmd[1]} — timed out after ${Math.trunc(timeout)}s${running() ? "; the run is still going" : ""}; partial output:)`
      : `(${cmd[1]} — settled with ${lines.length} new line(s):)`;
  return lines.length ? `${header}\n${lines.join("\n")}` : `${header}\n(no status output captured)`;
}

function readStatus(input: Input, { tabId }: ToolContext): string {
  const n = Math.min(500, Math.max(1, asInt(input.tail) ?? 50));
  const lines = (tabById(tabId)?.log ?? []).slice(-n);
  return lines.length ? lines.map(formattedLine).join("\n") : "(Status pane is empty.)";
}

const EDITING_TOOLS = new Set(["add_node", "delete_node", "add_link", "delete_link", "update_node", "update_link"]);

const HANDLERS: Record<string, (input: Input, ctx: ToolContext) => string | Promise<string>> = {
  get_network_summary: getNetworkSummary,
  add_node: addNode,
  delete_node: deleteNode,
  add_link: addLink,
  delete_link: deleteLink,
  update_node: updateNode,
  update_link: updateLink,
  run_command: runCommand,
  read_status: readStatus,
};

/** `ToolRegistry.execute`: runs a tool by name; throws ToolError with 0.90.34's sentence. */
export async function executeTool(name: string, input: Input, ctx: ToolContext): Promise<string> {
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : Object.prototype.hasOwnProperty.call(EXPLAIN_HANDLERS, name) ? EXPLAIN_HANDLERS[name] : undefined;
  if (!handler) throw ToolError.unknown(name);
  // The Edit menu waits while a dialog or parameter panel is up (MENU-198) and so do the tools
  // that change the network: a panel's draft was made from the network as it was. A node being
  // dragged is the same case.
  if (EDITING_TOOLS.has(name) || EXPLAIN_EDITING_TOOLS.has(name)) {
    if (modalOpen()) throw ToolError.executionFailed("A dialog or parameter panel is open in Qnet. Ask the user to close it, then try again.");
    if (ctx.editor.view.isDraggingNode) throw ToolError.executionFailed("The user is dragging a node on the canvas. Try again in a moment.");
  }
  return handler(input ?? {}, ctx);
}
