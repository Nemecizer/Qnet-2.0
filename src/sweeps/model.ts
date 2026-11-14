// What a what-if sweep can vary (new in 2.1, ROADMAP B4): the parameters a network offers, found
// in its document, and the same document with one of them set to another value. Pure functions
// over the `.bnet` object; a rate is read and written through the inspector's own parsing and
// formatting (src/panes/inspector/distributions); a rate moves by rescaling the law's time
// (`TIME_SCALE`), so the family and its shape stay exactly and the point at the value the
// parameter has now is the document itself.
//
// Offered:
// - a source's arrival rate (1 / its mean inter-arrival time);
// - a station's service rate, per customer class where the station serves more than one;
// - a station's number of servers;
// - a buffer's size, in a finite-buffer network;
// - a routing probability, where exactly one other link leaves the same node on the same class:
//   that one takes the rest, so the two still sum to what they summed to. With no sibling, or with
//   two or more, "the rest" has no one meaning and the probability is not offered;
// - the load factor: every arrival rate times it (the classic ρ sweep; 1 is the network as it is);
// - a closed network's population N (new in 2.1; no source, no sink, `closedPopulation` set):
//   throughput against N is the closed network's own classic curve.
import type { BnetDocument, BnetLink, BnetNode } from "../lib/bnet";
import { drawnAs } from "../closed/shape";
import { inExportOrder } from "../editor/naming";
import { asDistribution, computeMean, storedParams, type Distribution } from "../panes/inspector/distributions";
import { fieldText } from "../panes/inspector/distributions/numbers";
import { sweepWords as w } from "./words";

export type ParameterKind = "load" | "population" | "arrival" | "service" | "servers" | "buffer" | "routing";
export const PARAMETER_KINDS: ParameterKind[] = ["load", "population", "arrival", "service", "servers", "buffer", "routing"];

/** The largest population a closed network is solved for (core/src/closed.rs `MAX_POPULATION`). */
export const MAX_POPULATION = 10000;

export interface SweepParameter {
  /** "load", "arrival:<node>", "service:<node>:<class or empty>", "servers:<node>", "buffer:<node>", "routing:<link>". */
  id: string;
  kind: ParameterKind;
  /** "Src1 arrival rate", "S2 service rate, Class 1", "Load factor". */
  label: string;
  /** A short axis name: "λ at Src1", "μ at S2", "Load factor". */
  axis: string;
  /** The value in the document now. */
  current: number;
  integer: boolean;
  /** The values it may take: `min` exclusive for a rate, inclusive otherwise. */
  min: number;
  max: number | null;
  /** "per time unit", "servers", "customers", or "" for a pure number. */
  unit: string;
  nodeId?: string;
  /** The customer class of a per-class service rate; null for the station's one law. */
  customerClass?: number | null;
  linkId?: string;
  /** The sibling link that takes the rest, and what the two sum to. */
  complementId?: string;
  rowSum?: number;
}

const rateOf = (distribution: string, parameters: string): number | null => {
  const mean = computeMean(asDistribution(distribution), storedParams(parameters));
  // Twelve digits: 1 / (1 / 0.9) is 0.9 again.
  return mean !== null && Number.isFinite(mean) && mean > 0 ? Number((1 / mean).toPrecision(12)) : null;
};

/**
 * The stored parameters that carry each family's time scale. A law at another rate is the same law
 * with time rescaled by s = (new mean) / (mean now): the keys under `times` are multiplied by s,
 * those under `rates` divided by it, and `shift` (a log-mean) has ln s added. Every other
 * parameter — the shape — keeps its stored text, character for character. All nine families have
 * such a parameter, so a rate can be swept for each of them.
 */
export const TIME_SCALE: Record<Distribution, { times?: string[]; rates?: string[]; shift?: string[] }> = {
  exponential: { rates: ["rate"] },
  poisson: { rates: ["lambda"] },
  erlang: { rates: ["rate"] },
  gamma: { times: ["scale"] },
  weibull: { times: ["scale"] },
  pareto: { times: ["scale"] },
  constant: { times: ["value"] },
  uniform: { times: ["min", "max"] },
  lognormal: { shift: ["mu"] },
};

/**
 * `parameters` of `distribution` at rate `rate` (mean 1/`rate`): the same law with its time scale
 * changed (`TIME_SCALE`), so its shape is exactly what it was. At the rate it has now the string
 * comes back untouched. Null when the law's mean can't be read or a scale parameter is missing.
 */
export function withRate(distribution: string, parameters: string, rate: number): string | null {
  if (!(rate > 0) || !Number.isFinite(rate)) return null;
  const now = rateOf(distribution, parameters);
  if (now === null) return null;
  if (rate === now) return parameters;
  const d = asDistribution(distribution);
  const stored = storedParams(parameters);
  const mean = computeMean(d, stored)!;
  const s = 1 / rate / mean;
  const scale = TIME_SCALE[d];
  const next = new Map<string, number>();
  // The one-rate families take the rate itself (0.85, not 0.85 by way of a quotient).
  for (const k of scale.rates ?? []) next.set(k, d === "erlang" ? stored[k] / s : rate);
  for (const k of scale.times ?? []) next.set(k, stored[k] * s);
  for (const k of scale.shift ?? []) next.set(k, stored[k] + Math.log(s));
  for (const v of next.values()) if (!Number.isFinite(v)) return null;
  // Only the scaled values are rewritten; the last pair of a key is the one that is read.
  const seen = new Set<string>();
  const pairs = parameters.split(",").reverse().map((pair) => {
    const parts = pair.split("=").filter((x) => x.length);
    const key = parts.length === 2 ? parts[0].trim() : null;
    if (key === null || !next.has(key) || seen.has(key)) return pair;
    seen.add(key);
    return `${key}=${fieldText(next.get(key)!)}`;
  });
  return seen.size === next.size ? pairs.reverse().join(",") : null;
}

const feeding = (doc: BnetDocument, stationId: string) => {
  const targets = new Set<string>([stationId]);
  for (const n of doc.nodes) {
    if (n.kind === "buffer" && doc.links.some((l) => l.fromNodeID === n.id && l.toNodeID === stationId)) targets.add(n.id);
  }
  return targets;
};

/**
 * The classes a station serves, ascending: the class each link delivers (its exit class when it
 * changes class on the way) to the station or to a buffer feeding it — the solver's rule
 * (core/src/traffic.rs: a link's target is reached in its `to_class`).
 */
export function classesServed(doc: BnetDocument, stationId: string): number[] {
  const targets = feeding(doc, stationId);
  const classes = new Set<number>();
  for (const l of doc.links) if (targets.has(l.toNodeID)) classes.add(l.toCustomerClass ?? l.customerClass);
  return [...classes].sort((a, b) => a - b);
}

/**
 * The classes 0.90.34's inspector listed at a station: each incoming link's ENTRY class. On a
 * line where customers change class the two rules differ, and a document saved by 0.90.34 (or by
 * 2.1 before the inspector took the solver's rule, ledger FIX-103) may hold a per-class law
 * under such a class; a sweep offers the classes served and names them by class wherever either
 * rule finds more than one.
 */
export function classesListed(doc: BnetDocument, stationId: string): number[] {
  const targets = feeding(doc, stationId);
  const classes = new Set<number>();
  for (const l of doc.links) if (targets.has(l.toNodeID)) classes.add(l.customerClass);
  return [...classes].sort((a, b) => a - b);
}

/** Every class either rule names at a station, ascending. */
const classesKnown = (doc: BnetDocument, stationId: string) => [...new Set([...classesServed(doc, stationId), ...classesListed(doc, stationId)])].sort((a, b) => a - b);

/** The law a station uses for `customerClass`: its per-class entry, else the station's own. */
function serviceLaw(node: BnetNode, customerClass: number | null): { distribution: string; distributionParameters: string } {
  const own = customerClass === null ? undefined : node.serviceDistributions?.[String(customerClass)];
  return own ?? { distribution: node.distribution, distributionParameters: node.distributionParameters };
}

const siblings = (doc: BnetDocument, link: BnetLink) => doc.links.filter((l) => l.id !== link.id && l.fromNodeID === link.fromNodeID && l.customerClass === link.customerClass);

/** Every parameter `doc` offers, in the order the panel lists them: the load factor, then by kind and export order. */
export function discoverParameters(doc: BnetDocument): SweepParameter[] {
  const out: SweepParameter[] = [];
  const name = new Map(doc.nodes.map((n) => [n.id, n.name]));
  const sources = inExportOrder(doc.nodes.filter((n) => n.kind === "source"), (n) => n.name);
  const stations = inExportOrder(doc.nodes.filter((n) => n.kind === "station"), (n) => n.name);
  const buffers = inExportOrder(doc.nodes.filter((n) => n.kind === "buffer"), (n) => n.name);

  const sweepable = sources.filter((s) => {
    const rate = rateOf(s.distribution, s.distributionParameters);
    return rate !== null && withRate(s.distribution, s.distributionParameters, rate) !== null;
  });
  if (typeof doc.closedPopulation === "number" && drawnAs(doc) === "closed") {
    out.push({ id: "population", kind: "population", label: w.populationLabel, axis: w.populationAxis, current: doc.closedPopulation, integer: true, min: 1, max: MAX_POPULATION, unit: w.populationUnit });
  }
  if (sweepable.length && sweepable.length === sources.length) {
    out.push({ id: "load", kind: "load", label: w.loadLabel, axis: w.loadAxis, current: 1, integer: false, min: 0, max: null, unit: "" });
  }
  for (const s of sweepable) {
    const rate = rateOf(s.distribution, s.distributionParameters)!;
    out.push({ id: `arrival:${s.id}`, kind: "arrival", label: w.arrivalLabel(s.name), axis: w.arrivalAxis(s.name), current: rate, integer: false, min: 0, max: null, unit: w.rateUnit, nodeId: s.id });
  }
  for (const s of stations) {
    const served = classesServed(doc, s.id);
    // Named by class wherever the station has more than one class by either rule, so a class the
    // inspector doesn't list is still called what it is.
    const perClass = classesKnown(doc, s.id).length > 1;
    for (const c of perClass ? served : [served[0] ?? null]) {
      const law = serviceLaw(s, c);
      const rate = rateOf(law.distribution, law.distributionParameters);
      if (rate === null || withRate(law.distribution, law.distributionParameters, rate) === null) continue;
      out.push({
        id: `service:${s.id}:${perClass ? c : ""}`,
        kind: "service",
        label: perClass ? w.serviceClassLabel(s.name, (c as number) + 1) : w.serviceLabel(s.name),
        axis: perClass ? w.serviceClassAxis(s.name, (c as number) + 1) : w.serviceAxis(s.name),
        current: rate,
        integer: false,
        min: 0,
        max: null,
        unit: w.rateUnit,
        nodeId: s.id,
        customerClass: c,
      });
    }
  }
  for (const s of stations) {
    out.push({ id: `servers:${s.id}`, kind: "servers", label: w.serversLabel(s.name), axis: w.serversAxis(s.name), current: Math.max(1, s.numberOfServers ?? 1), integer: true, min: 1, max: null, unit: w.serversUnit, nodeId: s.id });
  }
  if (!doc.infiniteBuffers) {
    for (const b of buffers) {
      out.push({ id: `buffer:${b.id}`, kind: "buffer", label: w.bufferLabel(b.name), axis: w.bufferAxis(b.name), current: Math.max(1, b.bufferSize ?? 1), integer: true, min: 1, max: null, unit: w.bufferUnit, nodeId: b.id });
    }
  }
  for (const l of doc.links) {
    const others = siblings(doc, l);
    if (others.length !== 1) continue;
    const from = name.get(l.fromNodeID) ?? "?";
    const to = name.get(l.toNodeID) ?? "?";
    const rest = name.get(others[0].toNodeID) ?? "?";
    const sum = tidy(l.routingProbability + others[0].routingProbability);
    if (!(sum > 0)) continue;
    const classes = new Set(doc.links.map((x) => x.customerClass)).size > 1 ? l.customerClass + 1 : null;
    out.push({
      id: `routing:${l.id}`,
      kind: "routing",
      label: w.routingLabel(from, to, rest, classes),
      axis: w.routingAxis(from, to),
      current: l.routingProbability,
      integer: false,
      min: 0,
      max: sum,
      unit: "",
      linkId: l.id,
      complementId: others[0].id,
      rowSum: sum,
    });
  }
  return out;
}

/** The parameter `id` as `doc` offers it now, or null when the network no longer has it. */
export function parameterById(doc: BnetDocument, id: string): SweepParameter | null {
  return discoverParameters(doc).find((p) => p.id === id) ?? null;
}

/** Twelve significant digits: enough for any value typed, and no 0.30000000000000004. */
export const tidy = (x: number) => Number(x.toPrecision(12));

/** Whether `value` is one the parameter can take. */
export function allowed(p: SweepParameter, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (p.integer && !Number.isInteger(value)) return false;
  const rate = p.kind === "arrival" || p.kind === "service" || p.kind === "load";
  if (rate ? !(value > p.min) : value < p.min) return false;
  return p.max === null || value <= p.max + 1e-12;
}

const setNode = (doc: BnetDocument, id: string, f: (n: BnetNode) => BnetNode): BnetDocument => ({ ...doc, nodes: doc.nodes.map((n) => (n.id === id ? f(n) : n)) });

function withSourceRate(n: BnetNode, rate: number): BnetNode {
  const next = withRate(n.distribution, n.distributionParameters, rate);
  return next === null ? n : { ...n, distributionParameters: next };
}

/**
 * `doc` with parameter `p` set to `value`: a new document sharing every untouched node and link.
 * Null when the value isn't one the parameter can take, or the network no longer has the parameter.
 */
export function substitute(doc: BnetDocument, p: SweepParameter, value: number): BnetDocument | null {
  if (!allowed(p, value)) return null;
  switch (p.kind) {
    case "population":
      if (typeof doc.closedPopulation !== "number") return null;
      return doc.closedPopulation === value ? doc : { ...doc, closedPopulation: value };
    case "load": {
      const sources = doc.nodes.filter((n) => n.kind === "source");
      if (!sources.length) return null;
      let ok = true;
      const nodes = doc.nodes.map((n) => {
        if (n.kind !== "source") return n;
        const rate = rateOf(n.distribution, n.distributionParameters);
        const next = rate === null ? null : withRate(n.distribution, n.distributionParameters, tidy(rate * value));
        if (next === null) ok = false;
        return next === null || next === n.distributionParameters ? n : { ...n, distributionParameters: next };
      });
      return ok ? { ...doc, nodes } : null;
    }
    case "arrival": {
      const n = doc.nodes.find((x) => x.id === p.nodeId && x.kind === "source");
      if (!n || withRate(n.distribution, n.distributionParameters, value) === null) return null;
      return setNode(doc, n.id, (x) => withSourceRate(x, value));
    }
    case "service": {
      const n = doc.nodes.find((x) => x.id === p.nodeId && x.kind === "station");
      if (!n) return null;
      const c = p.customerClass ?? null;
      const law = serviceLaw(n, c);
      const next = withRate(law.distribution, law.distributionParameters, value);
      if (next === null) return null;
      // Nothing to write: the document is the one asked for.
      if (next === law.distributionParameters) return doc;
      const known = classesKnown(doc, n.id);
      const listed = classesListed(doc, n.id);
      return setNode(doc, n.id, (x) => {
        const out = { ...x };
        // A station with one class and no entry of its own is its own law alone.
        const perClass = c !== null && (x.serviceDistributions?.[String(c)] !== undefined || known.length > 1);
        if (!perClass) {
          out.distribution = law.distribution;
          out.distributionParameters = next;
          return out;
        }
        // Every other class that was reading the station's own law gets that law as its own entry
        // first (as an inspector commit writes every row), so only the swept class moves.
        const entries = { ...x.serviceDistributions };
        for (const k of known) entries[String(k)] ??= { distribution: x.distribution, distributionParameters: x.distributionParameters };
        entries[String(c)] = { distribution: law.distribution, distributionParameters: next };
        out.serviceDistributions = entries;
        // The station's own law follows the first class the inspector lists, as the inspector keeps it.
        if ((listed[0] ?? known[0]) === c) {
          out.distribution = law.distribution;
          out.distributionParameters = next;
        }
        return out;
      });
    }
    case "servers": {
      const n = doc.nodes.find((x) => x.id === p.nodeId && x.kind === "station");
      if (!n) return null;
      return Math.max(1, n.numberOfServers ?? 1) === value ? doc : setNode(doc, n.id, (x) => ({ ...x, numberOfServers: value }));
    }
    case "buffer": {
      const n = doc.nodes.find((x) => x.id === p.nodeId && x.kind === "buffer");
      if (!n || doc.infiniteBuffers) return null;
      return Math.max(1, n.bufferSize ?? 1) === value ? doc : setNode(doc, n.id, (x) => ({ ...x, bufferSize: value }));
    }
    case "routing": {
      const link = doc.links.find((l) => l.id === p.linkId);
      const other = doc.links.find((l) => l.id === p.complementId);
      if (!link || !other || siblings(doc, link).length !== 1) return null;
      if (value === link.routingProbability) return doc;
      const sum = tidy(link.routingProbability + other.routingProbability);
      // Never moved to fit: a value the row can't hold now is refused, not clamped.
      if (value < 0 || value > sum + 1e-12) return null;
      const mine = Math.min(value, sum);
      const rest = tidy(sum - mine);
      return { ...doc, links: doc.links.map((l) => (l.id === link.id ? { ...l, routingProbability: tidy(mine) } : l.id === other.id ? { ...l, routingProbability: rest } : l)) };
    }
  }
}

/** The sweep's x values: `points` evenly from `from` to `to`, rounded to readable values (whole numbers, each once, for a count). */
export function sweepValues(p: Pick<SweepParameter, "integer">, from: number, to: number, points: number): number[] {
  const n = Math.max(2, Math.min(MAX_POINTS, Math.round(points)));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const raw = Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
  // Values a person can read and type again: two more decimal places than the step needs
  // (0.5, 0.5577, 0.6154 … for a step of 0.0577), the two ends exactly as given.
  const step = Math.abs(to - from) / (n - 1);
  const places = Math.max(0, Math.min(12, Math.ceil(-Math.log10(step)) + 2));
  const round = (x: number, i: number) => (i === 0 ? tidy(from) : i === n - 1 ? tidy(to) : step > 0 ? Number(x.toFixed(places)) : tidy(x));
  const values = p.integer ? raw.map((x) => Math.round(x)) : raw.map(round);
  return [...new Set(values)];
}

export const DEFAULT_POINTS = 12;
export const MAX_POINTS = 60;

/** A value as a field and an axis show it: up to ten significant digits, no trailing zeros. */
export const valueText = (x: number) => fieldText(x);
