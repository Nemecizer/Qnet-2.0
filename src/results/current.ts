// Whether a run was made from the network as it is now.
//
// 0.90.34 compared fingerprints, and a fingerprint covers everything in the document's nodes and
// links — positions included. So tidying a diagram marked every result "Network changed since this
// run" although nothing a solver reads had changed. 2.1 also accepts a run whose network differs
// from the current one only in layout (node positions and pictures): the fingerprint stays what
// records store and exports print (ledger RES-050, Changed).
//
// The current document's structure is noted against its fingerprint when the fingerprint is
// learned (src/panes/results/fingerprint.ts), so every caller keeps passing the one string.

type Snapshot = { nodes?: unknown; links?: unknown; infiniteBuffers?: unknown; closedPopulation?: unknown };

/** What of a node is layout, not model. */
const LAYOUT_KEYS = new Set(["position", "picture"]);

function canonical(v: unknown, top = false): unknown {
  if (Array.isArray(v)) return v.map((x) => canonical(x));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      if (top && LAYOUT_KEYS.has(k)) continue;
      out[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  // 1 and 1.0 are one number; -0 is 0.
  return typeof v === "number" && Object.is(v, -0) ? 0 : v;
}

const byId = (a: unknown, b: unknown) => String((a as { id?: unknown })?.id ?? "").localeCompare(String((b as { id?: unknown })?.id ?? ""));

/** The network without its layout, in a form two equal networks share. */
export function structureKey(doc: Snapshot | null | undefined): string | null {
  if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.links)) return null;
  const nodes = [...doc.nodes].sort(byId).map((n) => canonical(n, true));
  const links = [...doc.links].sort(byId).map((l) => canonical(l));
  // A closed network's population is structure (new in 2.1); an open network's key is as before.
  const closed = typeof doc.closedPopulation === "number" ? { closedPopulation: doc.closedPopulation } : {};
  return JSON.stringify({ ...closed, infiniteBuffers: !!doc.infiniteBuffers, links, nodes });
}

const structureOf = new Map<string, string>();
const runKeys = new WeakMap<object, string | null>();

/** Called when `fingerprint` is learned for `doc`. Keeps the newest few. */
export function noteStructure(fingerprint: string, doc: Snapshot): void {
  const key = structureKey(doc);
  if (key === null) return;
  structureOf.delete(fingerprint);
  structureOf.set(fingerprint, key);
  // Generous, and least-recently-used: every tab's current network stays known while it is being
  // read (`sameNetwork` refreshes an entry each time it is asked about).
  while (structureOf.size > 512) structureOf.delete(structureOf.keys().next().value as string);
}

interface RunLike {
  provenance: { networkFingerprint: string; networkSnapshot?: unknown };
}

/** True when `run` was made from the network `fingerprint` names, or one that differs only in layout. */
export function sameNetwork(run: RunLike, fingerprint: string): boolean {
  if (run.provenance.networkFingerprint === fingerprint) return true;
  const now = structureOf.get(fingerprint);
  if (now === undefined) return false;
  structureOf.delete(fingerprint);
  structureOf.set(fingerprint, now);
  let then = runKeys.get(run);
  if (then === undefined) {
    then = structureKey(run.provenance.networkSnapshot as Snapshot);
    runKeys.set(run, then);
  }
  return then !== null && then === now;
}

/** For tests. */
export function resetStructures(): void {
  structureOf.clear();
}
