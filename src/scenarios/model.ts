// Scenarios (new in 2.1, ROADMAP E1): named variants of ONE network — "Baseline", "Add a server at
// S2", "Peak hour" — that differ only in parameter values, never in topology. Pure functions over
// the document; nothing here computes a queue.
//
// How a document holds them (the file form is the same: core/src/bnet.rs):
//
// - `nodes`, `links` and `closedPopulation` are always the values of the variant being shown, so
//   the canvas, the inspector, live results, Solve, a run's fingerprint and an old reader of the
//   file all see one plain network and need to know nothing about scenarios.
// - `scenarios.items[i].overrides` is what scenario i changes, as values relative to the baseline.
//   The active scenario's list is kept equal to what is shown.
// - `scenarios.baseline`, present while a scenario is active, holds the baseline's own values for
//   exactly the fields the active scenario overrides — so the baseline can always be put back.
//
// What can be overridden: a buffer's size, a station's servers, a node's law (its distribution
// with its parameters, as one value — a rate without its family means nothing), a station's
// per-class laws (the whole table), a link's routing probability, a closed network's population.
// Everything else — which nodes and links exist, their kinds, names, classes, places, and the
// buffer regime — is the network itself, shared by every scenario.
import type { BnetDocument, BnetLink, BnetNode, ServiceConfig } from "../lib/bnet";

export type OverrideField = "bufferSize" | "numberOfServers" | "distribution" | "serviceDistributions" | "routingProbability" | "closedPopulation";

/** What an override is of: a node's field, a link's, or (neither) the network's. */
export interface OverrideTarget {
  node?: string;
  link?: string;
  field: OverrideField;
}

export interface Override extends OverrideTarget {
  /** A whole number, a probability, `{distribution, distributionParameters}`, the per-class table, or null (no population). */
  value: unknown;
}

export interface Scenario {
  /** An upper-case UUID. */
  id: string;
  name: string;
  overrides: Override[];
}

export interface ScenarioSet {
  /** The scenario being shown; absent while the baseline is. */
  active?: string;
  /** With `active`: the baseline's values for the fields the active scenario overrides. */
  baseline?: Override[];
  items: Scenario[];
}

export const NODE_FIELDS = ["bufferSize", "numberOfServers", "distribution", "serviceDistributions"] as const;

export const keyOf = (o: OverrideTarget) => `${o.node ?? o.link ?? ""}|${o.field}`;

/** The target is not in the document. */
export const MISSING = Symbol("missing");

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v === undefined ? null : v;
}

/** Two override values are the same value (1 and 1.0, a table whatever its key order). */
export const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The scenarios block in the one form its content is compared in (the tab's edited state,
 * src/workspace/store.ts): every object's keys in alphabetical order, and each list of overrides
 * in the order of its targets. The file's writer (core/src/bnet.rs) orders keys alphabetically
 * and the functions below build `{node, field, value}`; a list of overrides is a set, one entry
 * per target, whose order follows the history of edits. None of that is content. The order of
 * the scenarios themselves is (it is the order they are listed in), and is kept.
 */
export function canonicalScenarios(set: ScenarioSet | undefined): unknown {
  if (set === undefined) return undefined;
  const list = (os: readonly Override[] | undefined) => (os === undefined ? undefined : [...os].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0)).map(canonical));
  const out: Record<string, unknown> = {};
  if (set.active !== undefined) out.active = set.active;
  const baseline = list(set.baseline);
  if (baseline !== undefined) out.baseline = baseline;
  out.items = set.items.map((s) => ({ id: s.id, name: s.name, overrides: list(s.overrides) ?? [] }));
  return out;
}

const lawOf = (n: BnetNode): ServiceConfig => ({ distribution: n.distribution, distributionParameters: n.distributionParameters });

function nodeValue(n: BnetNode, field: OverrideField): unknown {
  switch (field) {
    case "bufferSize": return n.bufferSize;
    case "numberOfServers": return n.numberOfServers;
    case "distribution": return lawOf(n);
    case "serviceDistributions": return n.serviceDistributions ?? {};
    default: return MISSING;
  }
}

/** The field's value in `doc` as it stands, or `MISSING` when its node or link is not there. */
export function readField(doc: BnetDocument, o: OverrideTarget): unknown {
  if (o.field === "closedPopulation") return doc.closedPopulation ?? null;
  if (o.field === "routingProbability") {
    const l = doc.links.find((x) => x.id === o.link);
    return l ? l.routingProbability : MISSING;
  }
  const n = doc.nodes.find((x) => x.id === o.node);
  return n ? nodeValue(n, o.field) : MISSING;
}

const isLaw = (v: unknown): v is ServiceConfig => !!v && typeof v === "object" && typeof (v as ServiceConfig).distribution === "string" && typeof (v as ServiceConfig).distributionParameters === "string";

/** `doc` with the field set; unchanged when the target is gone or the value is not one the field takes. */
export function writeField(doc: BnetDocument, o: Override): BnetDocument {
  const v = o.value;
  if (o.field === "closedPopulation") {
    if (v === null || v === undefined) {
      if (doc.closedPopulation === undefined) return doc;
      const next = { ...doc };
      delete next.closedPopulation;
      return next;
    }
    return typeof v === "number" && doc.closedPopulation !== v ? { ...doc, closedPopulation: v } : doc;
  }
  if (o.field === "routingProbability") {
    const i = doc.links.findIndex((x) => x.id === o.link);
    if (i < 0 || typeof v !== "number" || doc.links[i].routingProbability === v) return doc;
    const links = [...doc.links];
    links[i] = { ...links[i], routingProbability: v };
    return { ...doc, links };
  }
  const i = doc.nodes.findIndex((x) => x.id === o.node);
  if (i < 0) return doc;
  const n = doc.nodes[i];
  let next: BnetNode | null = null;
  if (o.field === "bufferSize" && typeof v === "number") next = { ...n, bufferSize: v };
  else if (o.field === "numberOfServers" && typeof v === "number") next = { ...n, numberOfServers: v };
  else if (o.field === "distribution" && isLaw(v)) next = { ...n, distribution: v.distribution, distributionParameters: v.distributionParameters };
  else if (o.field === "serviceDistributions" && v && typeof v === "object") next = { ...n, serviceDistributions: v as Record<string, ServiceConfig> };
  if (!next || sameValue(nodeValue(n, o.field), nodeValue(next, o.field))) return doc;
  const nodes = [...doc.nodes];
  nodes[i] = next;
  return { ...doc, nodes };
}

export function applyOverrides(doc: BnetDocument, overrides: readonly Override[]): BnetDocument {
  return overrides.reduce(writeField, doc);
}

/** The document without its scenarios: one plain network. */
export function plain(doc: BnetDocument): BnetDocument {
  if (doc.scenarios === undefined) return doc;
  const next = { ...doc };
  delete next.scenarios;
  return next;
}

export const scenariosOf = (doc: BnetDocument | null | undefined): Scenario[] => doc?.scenarios?.items ?? [];
export const activeId = (doc: BnetDocument | null | undefined): string | null => doc?.scenarios?.active ?? null;

export function activeScenario(doc: BnetDocument | null | undefined): Scenario | null {
  const id = activeId(doc);
  return id === null ? null : scenariosOf(doc).find((s) => s.id === id) ?? null;
}

/** The baseline as one plain network. */
export function baselineDocument(doc: BnetDocument): BnetDocument {
  return activeScenario(doc) ? applyOverrides(plain(doc), doc.scenarios?.baseline ?? []) : plain(doc);
}

/**
 * Scenario `id` (null: the baseline) as one plain network — what Solve, live results and a
 * fingerprint read for it. The variant being shown comes back around the document's own arrays.
 */
export function scenarioDocument(doc: BnetDocument, id: string | null): BnetDocument {
  if (id === activeId(doc)) return plain(doc);
  const base = baselineDocument(doc);
  const s = id === null ? null : scenariosOf(doc).find((x) => x.id === id);
  return s ? applyOverrides(base, s.overrides) : base;
}

function withSet(doc: BnetDocument, set: ScenarioSet | undefined): BnetDocument {
  const next = { ...doc };
  if (set && set.items.length) next.scenarios = set;
  else delete next.scenarios;
  return next;
}

/** Shows scenario `id` (null: the baseline): its values go into the network, and the baseline's are kept beside. */
export function switchScenario(doc: BnetDocument, id: string | null): BnetDocument {
  const set = doc.scenarios;
  if (!set || id === activeId(doc)) return doc;
  const target = id === null ? null : set.items.find((s) => s.id === id);
  if (id !== null && !target) return doc;
  const base = baselineDocument(doc);
  if (!target) return withSet({ ...base }, { items: set.items });
  // Only what the baseline still has can be overridden; the rest is dropped here, quietly.
  const live = target.overrides.filter((o) => readField(base, o) !== MISSING);
  const items = live.length === target.overrides.length ? set.items : set.items.map((s) => (s === target ? { ...s, overrides: live } : s));
  return withSet(applyOverrides(base, live), { active: target.id, baseline: live.map((o) => ({ ...target_(o), value: readField(base, o) })), items });
}

const target_ = (o: OverrideTarget): OverrideTarget => (o.node !== undefined ? { node: o.node, field: o.field } : o.link !== undefined ? { link: o.link, field: o.field } : { field: o.field });

/**
 * New Scenario from Current Values: a scenario that holds what is shown now (the active
 * scenario's overrides, or none from the baseline), and becomes the one shown — so the next edit
 * of a value is its.
 */
export function newScenario(doc: BnetDocument, id: string, name: string): BnetDocument {
  const now = activeScenario(doc);
  const set = doc.scenarios;
  const overrides = now ? now.overrides.map((o) => ({ ...o })) : [];
  return withSet(doc, { active: id, baseline: now ? set?.baseline ?? [] : [], items: [...(set?.items ?? []), { id, name, overrides }] });
}

export function renameScenario(doc: BnetDocument, id: string, name: string): BnetDocument {
  const set = doc.scenarios;
  if (!set || !set.items.some((s) => s.id === id && s.name !== name)) return doc;
  return withSet(doc, { ...set, items: set.items.map((s) => (s.id === id ? { ...s, name } : s)) });
}

/** Deletes scenario `id`; when it is the one shown, the baseline is shown instead. The last one gone, the document has no scenarios at all. */
export function deleteScenario(doc: BnetDocument, id: string): BnetDocument {
  if (!scenariosOf(doc).some((s) => s.id === id)) return doc;
  const at = id === activeId(doc) ? switchScenario(doc, null) : doc;
  const set = at.scenarios!;
  return withSet(at, { ...set, items: set.items.filter((s) => s.id !== id) });
}

/** The baseline's value of a field the active scenario overrides, or `MISSING` when it does not. */
export function baselineValue(doc: BnetDocument | null | undefined, o: OverrideTarget): unknown {
  if (!doc || !activeScenario(doc)) return MISSING;
  const k = keyOf(o);
  const b = doc.scenarios?.baseline?.find((x) => keyOf(x) === k);
  return b ? b.value : MISSING;
}

/** Reset to baseline: the field takes the baseline's value again and the active scenario stops overriding it. */
export function resetOverride(doc: BnetDocument, o: OverrideTarget): BnetDocument {
  const value = baselineValue(doc, o);
  const active = activeScenario(doc);
  if (value === MISSING || !active) return doc;
  const k = keyOf(o);
  const set = doc.scenarios!;
  const next = writeField(doc, { ...target_(o), value });
  return withSet(next, {
    active: active.id,
    baseline: (set.baseline ?? []).filter((x) => keyOf(x) !== k),
    items: set.items.map((s) => (s === active ? { ...s, overrides: s.overrides.filter((x) => keyOf(x) !== k) } : s)),
  });
}

/** `base`, or "base 2", "base 3"… when a scenario (or the baseline's own name) already has it. */
export function uniqueName(doc: BnetDocument | null | undefined, base: string, baselineName: string, except?: string): string {
  const taken = new Set([baselineName.toLowerCase(), ...scenariosOf(doc).filter((s) => s.id !== except).map((s) => s.name.trim().toLowerCase())]);
  const stem = base.trim() || baselineName;
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`;
}

// ── An edit made by the editor ──────────────────────────────────────────────────────────────────

export interface EditOutcome {
  doc: BnetDocument;
  /** Overrides that lost their node or link, per scenario. */
  dropped: { name: string; count: number }[];
  /** The edit changed the network itself (what every scenario shares) while other variants exist. */
  topology: boolean;
}

/** A station's per-class table without the entries that only repeat its own law. */
function ownLaws(n: BnetNode): Record<string, ServiceConfig> {
  const out: Record<string, ServiceConfig> = {};
  for (const [cls, c] of Object.entries(n.serviceDistributions ?? {})) if (c.distribution !== n.distribution || c.distributionParameters !== n.distributionParameters) out[cls] = c;
  return out;
}

const sameLinkShape = (a: BnetLink, b: BnetLink) => a.fromNodeID === b.fromNodeID && a.toNodeID === b.toNodeID && a.customerClass === b.customerClass && a.toCustomerClass === b.toCustomerClass;

function topologyChanged(prev: BnetDocument, next: BnetDocument): boolean {
  if (prev.infiniteBuffers !== next.infiniteBuffers) return true;
  if (prev.nodes !== next.nodes) {
    if (prev.nodes.length !== next.nodes.length) return true;
    const was = new Map(prev.nodes.map((n) => [n.id, n]));
    for (const n of next.nodes) {
      const p = was.get(n.id);
      if (!p || p.kind !== n.kind) return true;
    }
  }
  if (prev.links !== next.links) {
    if (prev.links.length !== next.links.length) return true;
    const was = new Map(prev.links.map((l) => [l.id, l]));
    for (const l of next.links) {
      const p = was.get(l.id);
      if (!p || (p !== l && !sameLinkShape(p, l))) return true;
    }
  }
  return false;
}

/**
 * What an edit that took the network from `prev` to `next` means for the scenarios. A changed
 * value becomes (or updates, or — back at the baseline's value — ends) an override of the active
 * scenario; with the baseline shown it is simply the baseline's new value. A change of the
 * network itself is everyone's, and overrides whose node or link has gone are dropped. `doc` is
 * `next` itself when there is nothing to record.
 */
export function reconcile(prev: BnetDocument, next: BnetDocument): EditOutcome {
  const set = prev.scenarios;
  const nothing: EditOutcome = { doc: next, dropped: [], topology: false };
  if (!set || !set.items.length) return nothing;
  if (prev.nodes === next.nodes && prev.links === next.links && prev.closedPopulation === next.closedPopulation && prev.infiniteBuffers === next.infiniteBuffers) return nothing;
  let items = set.items;
  let baseline = set.baseline ?? [];
  const active = set.active === undefined ? undefined : items.find((s) => s.id === set.active);
  let changed = false;

  if (active) {
    const base = new Map(baseline.map((o) => [keyOf(o), o]));
    const mine = new Map(active.overrides.map((o) => [keyOf(o), o]));
    let touched = false;
    const consider = (t: OverrideTarget, before: unknown, after: unknown) => {
      if (before === MISSING || after === MISSING || sameValue(before, after)) return;
      const k = keyOf(t);
      const b = base.get(k);
      if (b && sameValue(b.value, after)) {
        base.delete(k);
        mine.delete(k);
      } else {
        if (!b) base.set(k, { ...t, value: before });
        mine.set(k, { ...t, value: after });
      }
      touched = true;
    };
    if (prev.nodes !== next.nodes) {
      const was = new Map(prev.nodes.map((n) => [n.id, n]));
      for (const n of next.nodes) {
        const p = was.get(n.id);
        if (!p || p === n) continue;
        for (const field of NODE_FIELDS) {
          // A class's entry equal to the station's own law says nothing new (the inspector writes
          // such entries when it commits): a table that differs only by those is not an override.
          if (field === "serviceDistributions" && sameValue(ownLaws(p), ownLaws(n))) continue;
          consider({ node: n.id, field }, nodeValue(p, field), nodeValue(n, field));
        }
      }
    }
    if (prev.links !== next.links) {
      const was = new Map(prev.links.map((l) => [l.id, l]));
      for (const l of next.links) {
        const p = was.get(l.id);
        if (p && p !== l) consider({ link: l.id, field: "routingProbability" }, p.routingProbability, l.routingProbability);
      }
    }
    consider({ field: "closedPopulation" }, prev.closedPopulation ?? null, next.closedPopulation ?? null);
    if (touched) {
      baseline = [...base.values()];
      items = items.map((s) => (s === active ? { ...s, overrides: [...mine.values()] } : s));
      changed = true;
    }
  }

  // Overrides of what is no longer there.
  const dropped: EditOutcome["dropped"] = [];
  if (prev.nodes !== next.nodes || prev.links !== next.links) {
    const nodes = new Set(next.nodes.map((n) => n.id));
    const links = new Set(next.links.map((l) => l.id));
    const alive = (o: OverrideTarget) => (o.node !== undefined ? nodes.has(o.node) : o.link !== undefined ? links.has(o.link) : true);
    if (baseline.some((o) => !alive(o))) {
      baseline = baseline.filter(alive);
      changed = true;
    }
    if (items.some((s) => s.overrides.some((o) => !alive(o)))) {
      items = items.map((s) => {
        const kept = s.overrides.filter(alive);
        if (kept.length === s.overrides.length) return s;
        dropped.push({ name: s.name, count: s.overrides.length - kept.length });
        return { ...s, overrides: kept };
      });
      changed = true;
    }
  }

  const topology = topologyChanged(prev, next);
  if (!changed) return { doc: next, dropped, topology };
  const out: ScenarioSet = active ? { active: active.id, baseline, items } : { items };
  return { doc: { ...next, scenarios: out }, dropped, topology };
}
