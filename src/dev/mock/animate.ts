// `animate_start`, `animate_next`, `animate_skip` and `animate_stop` in the browser preview and
// the tests (src-tauri/src/animate.rs).
//
// PREVIEW ONLY. The preview can't run core, so this is a stand-in event generator with the same
// wire shapes: a small discrete-event loop in which EVERY law is drawn as an exponential with the
// law's mean. It is not the app's simulator (core/src/sim.rs, which samples each family exactly
// and has the validation tests), and no number it produces is checked against theory. It exists
// so that the animation can be looked at and its interface tested without Rust.
import type { BnetDocument, BnetNode } from "../../lib/bnet";
import type { AnimateChunk, AnimateEvents, AnimateLayout, AnimateSnapshot, AnimateStart, AnimateStats, Who } from "../../animate/model";
import type { MockHandlers } from "../../test/tauri";
import { standInLive } from "./live";

export const FINITE_SENTENCE =
  "The animation covers infinite buffers. With finite buffers what happens at a full buffer depends on a blocking rule (loss, or blocking after service) that is chosen for each run and is not part of the network, so there is no single behaviour to draw. To animate this network, choose Network ▸ Buffer Model ▸ Infinite buffers (a new, empty network starts with finite buffers). To keep finite buffers, use Run ▸ Solve instead.";

const refuse = (code: string, message: string): never => {
  throw { kind: "invalid", message, detail: code };
};

/** mulberry32: a small seeded generator, enough for a stand-in. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
}

const param = (text: string, key: string, fallback: number): number => {
  const m = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*([^,]+)`).exec(text);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

/** The mean of a law (the stand-in draws an exponential with it). */
function meanOf(distribution: string, p: string): number {
  switch (distribution) {
    case "poisson":
      return 1 / param(p, "lambda", 1);
    case "gamma":
      return param(p, "shape", 2) * param(p, "scale", 1);
    case "uniform":
      return (param(p, "min", 0.5) + param(p, "max", 1.5)) / 2;
    case "constant":
      return param(p, "value", 1);
    case "erlang":
      return param(p, "k", 2) / param(p, "rate", 1);
    case "lognormal":
      return Math.exp(param(p, "mu", 0) + param(p, "sigma", 0.25) ** 2 / 2);
    case "pareto":
      return (param(p, "shape", 2.5) * param(p, "scale", 1)) / (param(p, "shape", 2.5) - 1);
    case "weibull":
      return param(p, "scale", 1) * 0.9;
    default:
      return 1 / param(p, "rate", 1);
  }
}

const suffix = (name: string) => Number(/\d+$/.exec(name)?.[0] ?? 1e9);
const ordered = (nodes: BnetNode[]) => [...nodes].sort((a, b) => suffix(a.name) - suffix(b.name));

interface Branch {
  upto: number;
  station: number;
  sink: number;
  cls: number;
}

interface Scheduled {
  time: number;
  seq: number;
  source: number;
  station: number;
  server: number;
}

class StandIn {
  layout: AnimateLayout;
  now = 0;
  private random: () => number;
  private agenda: Scheduled[] = [];
  private seq = 0;
  private nextId = 0;
  private queues: Who[][];
  private servers: (Who | null)[][];
  private sourceMeans: number[] = [];
  private sourceRoutes: Branch[][] = [];
  private serviceMean: (station: number, cls: number) => number;
  private routes: Map<string, Branch[]> = new Map();
  private stats: AnimateStats;
  private since: number[];

  constructor(doc: BnetDocument, seed: number) {
    const stations = ordered(doc.nodes.filter((n) => n.kind === "station"));
    const sources = ordered(doc.nodes.filter((n) => n.kind === "source"));
    const sinks = doc.nodes.filter((n) => n.kind === "sink");
    const closed = stations.length > 0 && !sources.length && !sinks.length;
    if (!stations.length) refuse("network", "The network has no stations.");
    if (closed && doc.closedPopulation === undefined) refuse("closed", "The network has no source and no sink, but no number of customers is set. Set the population to make it a closed network.");
    if (!closed && !sources.length) refuse("network", "The network has no source node.");
    if (!closed && !sinks.length) refuse("network", "The network has no sink node.");
    if (!closed && !doc.infiniteBuffers) refuse("finiteBuffers", FINITE_SENTENCE);
    const index = new Map(stations.map((s, i) => [s.id, i]));
    const bufferOf = (s: BnetNode) => doc.nodes.find((b) => b.kind === "buffer" && doc.links.some((l) => l.fromNodeID === b.id && l.toNodeID === s.id));
    for (const s of stations) if (!bufferOf(s)) refuse("network", `Station ${s.name} has no buffer feeding into it.`);
    const resolve = (id: string): number => {
      const n = doc.nodes.find((x) => x.id === id);
      if (n?.kind === "station") return index.get(n.id) ?? -1;
      if (n?.kind === "buffer") for (const l of doc.links) if (l.fromNodeID === n.id && index.has(l.toNodeID)) return index.get(l.toNodeID)!;
      return -1;
    };
    const sinkIds: string[] = [];
    const cumulative = (from: string, cls: number | null, enter: number | null): Branch[] => {
      let sum = 0;
      const out: Branch[] = [];
      for (const l of doc.links) {
        if (l.fromNodeID !== from || (cls !== null && l.customerClass !== cls) || !(l.routingProbability > 0)) continue;
        const station = resolve(l.toNodeID);
        if (enter !== null && station < 0) continue;
        let sink = -1;
        if (station < 0 && doc.nodes.find((n) => n.id === l.toNodeID)?.kind === "sink") {
          sink = sinkIds.indexOf(l.toNodeID);
          if (sink < 0) sink = sinkIds.push(l.toNodeID) - 1;
        }
        sum += l.routingProbability;
        out.push({ upto: sum, station, sink, cls: enter ?? l.toCustomerClass ?? l.customerClass });
      }
      if (sum >= 1 - 1e-9 && out.length) out[out.length - 1].upto = Infinity;
      return out;
    };
    sources.forEach((s, k) => {
      this.sourceMeans.push(meanOf(s.distribution, s.distributionParameters));
      this.sourceRoutes.push(cumulative(s.id, null, k));
    });
    const classes = Math.max(sources.length, 1, ...doc.links.map((l) => Math.max(l.customerClass, l.toCustomerClass ?? 0) + 1));
    stations.forEach((s, i) => {
      for (let c = 0; c < classes; c++) this.routes.set(`${i}|${c}`, cumulative(s.id, c, null));
    });
    this.serviceMean = (i, c) => {
      const s = stations[i];
      const law = s.serviceDistributions?.[String(c)] ?? { distribution: s.distribution, distributionParameters: s.distributionParameters };
      return meanOf(law.distribution, law.distributionParameters);
    };
    let live: ReturnType<typeof standInLive> | null = null;
    try {
      live = closed ? null : standInLive(doc);
    } catch {
      live = null;
    }
    const exact = (id: string) => (live?.tier === "exact" ? (live.perStation.find((p) => p.stationId === id)?.meanInSystem ?? null) : null);
    const rates = live?.perStation.map((p) => p.throughput) ?? [];
    this.layout = {
      stations: stations.map((s) => ({ id: s.id, name: s.name, servers: Math.max(1, s.numberOfServers), bufferId: bufferOf(s)!.id, exactNumber: exact(s.id) })),
      sources: sources.map((s, k) => ({ id: s.id, name: s.name, class: k })),
      sinks: sinkIds,
      classes,
      population: closed ? doc.closedPopulation! : null,
      unstable: live?.reasonIfPartial === "unstable" ? live.reasonDetail.split(", ").filter(Boolean) : [],
      eventRate: rates.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) || stations.reduce((a, _, i) => a + 1 / this.serviceMean(i, 0), 0) / 2,
    };
    this.random = generator(seed);
    this.queues = stations.map(() => []);
    this.servers = this.layout.stations.map((s) => Array.from({ length: s.servers }, () => null));
    const zeros = () => stations.map(() => 0);
    this.stats = { time: 0, areaNumber: zeros(), areaQueue: zeros(), arrivals: zeros(), departures: zeros(), created: 0, left: 0 };
    this.since = zeros();
    if (closed) {
      for (let n = 0; n < doc.closedPopulation!; n++) this.queues[0].push([this.nextId++, 0]);
      this.fill(0, null);
    } else sources.forEach((_, k) => this.schedule(this.exp(this.sourceMeans[k]), k, -1, -1));
  }

  private exp(mean: number): number {
    return -Math.log(this.random()) * mean;
  }

  private schedule(delay: number, source: number, station: number, server: number) {
    this.agenda.push({ time: this.now + delay, seq: this.seq++, source, station, server });
  }

  private pop(until: number): Scheduled | null {
    let best = -1;
    for (let i = 0; i < this.agenda.length; i++) {
      const a = this.agenda[i];
      if (best < 0 || a.time < this.agenda[best].time || (a.time === this.agenda[best].time && a.seq < this.agenda[best].seq)) best = i;
    }
    if (best < 0 || this.agenda[best].time > until) return null;
    return this.agenda.splice(best, 1)[0];
  }

  private account(i: number) {
    const dt = this.now - this.since[i];
    const busy = this.servers[i].reduce((n, s) => n + (s ? 1 : 0), 0);
    this.stats.areaQueue[i] += this.queues[i].length * dt;
    this.stats.areaNumber[i] += (this.queues[i].length + busy) * dt;
    this.since[i] = this.now;
  }

  private emit(out: AnimateEvents | null, k: number, who: Who, s: number, srv: number, o: number) {
    if (!out) return;
    out.t.push(this.now);
    out.k.push(k);
    out.c.push(who[0]);
    out.cls.push(who[1]);
    out.s.push(s);
    out.srv.push(srv);
    out.o.push(o);
  }

  private fill(i: number, out: AnimateEvents | null) {
    for (;;) {
      const server = this.servers[i].indexOf(null);
      if (server < 0 || !this.queues[i].length) return;
      this.account(i);
      const who = this.queues[i].shift()!;
      this.servers[i][server] = who;
      this.schedule(this.exp(this.serviceMean(i, who[1])), -1, i, server);
      this.emit(out, 1, who, i, server, -1);
    }
  }

  private join(i: number, who: Who) {
    this.account(i);
    this.queues[i].push(who);
    this.stats.arrivals[i]++;
  }

  run(maxSteps: number, until: number, out: AnimateEvents | null) {
    for (let steps = 0; steps < maxSteps; steps++) {
      const s = this.pop(until);
      if (!s) {
        if (Number.isFinite(until) && until > this.now) this.now = until;
        return;
      }
      this.now = s.time;
      const u = this.random();
      if (s.source >= 0) {
        this.schedule(this.exp(this.sourceMeans[s.source]), s.source, -1, -1);
        const b = this.sourceRoutes[s.source].find((x) => u < x.upto);
        if (!b) continue;
        const who: Who = [this.nextId++, s.source];
        this.stats.created++;
        this.join(b.station, who);
        this.emit(out, 0, who, b.station, -1, s.source);
        this.fill(b.station, out);
      } else {
        const i = s.station;
        this.account(i);
        const who = this.servers[i][s.server]!;
        this.servers[i][s.server] = null;
        this.stats.departures[i]++;
        this.emit(out, 2, who, i, s.server, -1);
        const b = this.routes.get(`${i}|${who[1]}`)?.find((x) => u < x.upto);
        if (b && b.station >= 0) {
          const moved: Who = [who[0], b.cls];
          this.join(b.station, moved);
          this.emit(out, 3, moved, i, -1, b.station);
          this.fill(i, out);
          if (b.station !== i) this.fill(b.station, out);
        } else {
          this.stats.left++;
          this.emit(out, 4, who, i, -1, b?.sink ?? -1);
          this.fill(i, out);
        }
      }
    }
  }

  snapshot(): AnimateSnapshot {
    // As the command answers: the head of each queue, and how many wait in all.
    return { time: this.now, queues: this.queues.map((q) => q.slice(0, 512).map((w) => [...w] as Who)), waiting: this.queues.map((q) => q.length), servers: this.servers.map((row) => row.map((w) => (w ? ([...w] as Who) : null))) };
  }

  totals(): AnimateStats {
    this.layout.stations.forEach((_, i) => this.account(i));
    return { ...this.stats, time: this.now, areaNumber: [...this.stats.areaNumber], areaQueue: [...this.stats.areaQueue], arrivals: [...this.stats.arrivals], departures: [...this.stats.departures] };
  }
}

const empty = (): AnimateEvents => ({ t: [], k: [], c: [], cls: [], s: [], srv: [], o: [] });
const gone = (): never => {
  throw { kind: "invalid", message: "This animation has ended. Restart it." };
};

/** The runs open in the preview, for tests: how many, and each command's count. */
export const mockAnimate: { open: Map<number, StandIn>; calls: Record<string, number> } = { open: new Map(), calls: {} };

export function animateHandlers(): MockHandlers {
  let next = 0;
  mockAnimate.open = new Map();
  mockAnimate.calls = { animate_start: 0, animate_next: 0, animate_skip: 0, animate_stop: 0 };
  const count = (c: string) => void mockAnimate.calls[c]++;
  return {
    animate_start: ({ document, seed }: { document: BnetDocument; seed: number }): AnimateStart => {
      count("animate_start");
      const sim = new StandIn(document, seed);
      const session = ++next;
      mockAnimate.open.set(session, sim);
      return { session, seed, layout: sim.layout, snapshot: sim.snapshot() };
    },
    animate_next: ({ session, maxSteps, until }: { session: number; maxSteps: number; until: number }): AnimateChunk => {
      count("animate_next");
      const sim = mockAnimate.open.get(session) ?? gone();
      const events = empty();
      sim.run(Math.max(1, Math.min(20000, maxSteps)), until, events);
      return { time: sim.now, events, stats: sim.totals() };
    },
    animate_skip: ({ session, until }: { session: number; until: number }): AnimateChunk => {
      count("animate_skip");
      const sim = mockAnimate.open.get(session) ?? gone();
      sim.run(200000, until, null);
      return { time: sim.now, events: empty(), stats: sim.totals(), snapshot: sim.snapshot() };
    },
    animate_stop: ({ session }: { session: number }) => {
      count("animate_stop");
      mockAnimate.open.delete(session);
      return null;
    },
  };
}
