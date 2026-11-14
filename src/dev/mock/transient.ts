// `transient_prepare`, `transient_analyze` and `transient_stop` in the browser preview and the
// tests (src-tauri/src/transient.rs). The preview can't run core, so this is a stand-in with the
// same shape and the same refusals, over the preview's own traffic model (./sweeps2
// `mockTraffic`): it treats each station as an M/M/c queue on its own, fed at its long-run
// arrival rate (times the surge factor), and integrates that queue's forward equations in small
// steps; the fluid stand-in is the same station on its own, dQ/dt = α − cμ held at zero. A real
// network's stations feed each other, so these numbers are a preview's, never Qnet's: the app's
// are core/src/transient.rs, which has the exact checks. Tests set `mockTransient.run` to answer
// exactly what a case needs, `hold` to keep a computation open, and read `calls` and `stops`.
import type { BnetDocument } from "../../lib/bnet";
import { openOnly } from "../../closed/shape";
import { refusal as featureRefusal } from "../../extended/shape";
import { profileProblem } from "../../extended/model";
import { trafficView } from "./extended";
import type { MockHandlers } from "../../test/tauri";
import { channelSend } from "../../test/tauri";
import type { TransientAnalysis, TransientPrepare, TransientRequest, TransientStation } from "../../transient/model";
import { mockTraffic, type MockStation } from "./sweeps2";

export const CLOSED = "Transient analysis covers open networks: this network has no source, so nothing arrives from outside.";
export const FINITE = "Transient analysis covers networks with infinite buffers: with finite buffers the result depends on the blocking rule, which this analysis does not model.";
export const NOT_MARKOV =
  "The exact calculation needs Poisson arrivals, exponential service times and one customer class at each station, so that the numbers at the stations form a Markov chain. The fluid approximation depends on the rates only.";

export const mockTransient = {
  /** Answers instead of the stand-in, when set. */
  run: null as null | ((request: TransientRequest) => TransientAnalysis),
  /** While true a computation stays open (sending no answer) until `transient_stop` or `release`. */
  hold: false,
  calls: [] as TransientRequest[],
  stops: [] as string[],
  /** Lets the held computations finish. */
  release() {
    held.splice(0).forEach((h) => h(false));
  },
};
const held: ((stopped: boolean) => void)[] = [];
const heldIds = new Map<string, (stopped: boolean) => void>();

/** Erlang C's mean number in system at utilisation ρ with c servers. */
function mmc(rho: number, c: number): number {
  const a = rho * c;
  let sum = 0;
  let term = 1;
  for (let n = 0; n < c; n++) {
    if (n > 0) term *= a / n;
    sum += term;
  }
  const tail = ((term * a) / c) / (1 - rho);
  return ((tail / (sum + tail)) * rho) / (1 - rho) + a;
}

const muOf = (s: MockStation) => (s.utilisation > 0 ? s.arrival / (s.utilisation * s.servers) : 1);

function stationsOf(traffic: MockStation[]): TransientStation[] {
  return traffic.map((s) => {
    const cap = muOf(s) * s.servers;
    const stable = s.utilisation > 0 && s.utilisation < 1;
    const gap = Math.sqrt(cap) - Math.sqrt(s.arrival);
    return { id: s.id, name: s.name, servers: s.servers, utilisation: Number.isFinite(s.utilisation) ? s.utilisation : null, stationary: stable ? mmc(s.utilisation, s.servers) : null, relaxation: stable ? 1 / (gap * gap) : null };
  });
}

function roundUp2(x: number): number {
  const unit = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.ceil(x / unit - 1e-9) * unit;
}

export function standInPrepare(doc: BnetDocument): TransientPrepare {
  const nodes = doc.nodes ?? [];
  const none = (reason: string): TransientPrepare => ({ exactReason: reason, fluidReason: reason, stations: [], suggestedHorizon: null });
  const refusal = openOnly(doc, "Transient analysis");
  if (refusal) return none(refusal.sentence);
  if (!nodes.some((n) => n.kind === "source")) return none(CLOSED);
  if (!doc.infiniteBuffers) return none(FINITE);
  if (!nodes.some((n) => n.kind === "station")) return none("The network has no stations.");
  // New in 2.1: a rate profile is followed here; priorities and batch arrivals are not modelled.
  const unmodelled = featureRefusal(doc, "Transient analysis", ["timeVaryingRates"]);
  if (unmodelled) return none(unmodelled);
  const profile = storedProfile(doc);
  const traffic = mockTraffic(baseView(doc));
  const stations = stationsOf(traffic);
  const exponential = nodes.every((n) => (n.kind !== "station" && n.kind !== "source") || n.distribution === "exponential" || (n.kind === "source" && n.distribution === "poisson"));
  const over = traffic.find((s) => s.utilisation >= 1);
  const exactReason = over
    ? `${over.name} is overloaded (utilisation ${over.utilisation.toFixed(3)}), so the network has no steady state.`
    : !exponential || traffic.some((s) => s.flows.size !== 1)
      ? NOT_MARKOV
      : null;
  const fluidReason = traffic.some((s) => s.flows.size > 1) ? `${traffic.find((s) => s.flows.size > 1)!.name} serves customer classes at different rates, so its fluid path depends on the order of service, which this analysis does not model.` : null;
  const horizon = Math.max(...stations.map((s, i) => Math.max(2 * (s.relaxation ?? 0), 5 / muOf(traffic[i]))));
  const shown = profile ? (profile.periodic ? 2 * profile.span : 1.5 * profile.span) : 0;
  return { exactReason, fluidReason, stations, suggestedHorizon: fluidReason && exactReason ? null : Math.max(roundUp2(horizon), shown), profile: profile ? { sources: profile.sources, periodic: profile.periodic, span: profile.span } : null };
}

/** The document at its sources' own rates, without the profile keys (the profile is applied in time, below). */
const baseView = (doc: BnetDocument): BnetDocument => trafficView({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, rateProfile: n.rateProfile ? { periodic: false, segments: n.rateProfile.segments } : undefined })) });

/**
 * The stored rate profile as the stand-in follows it: the first profiled source's, applied to
 * every arrival (a preview's simplification; core/src/transient.rs `profile_of` keeps each
 * source its own).
 */
function storedProfile(doc: BnetDocument): { sources: string[]; periodic: boolean; span: number; at: (t: number) => number; breaks: (horizon: number) => number[] } | null {
  const with_ = doc.nodes.filter((n) => n.kind === "source" && n.rateProfile && n.rateProfile.segments.length > 0 && !profileProblem(n.rateProfile));
  if (!with_.length) return null;
  const p = with_[0].rateProfile!;
  const span = p.segments[p.segments.length - 1].until;
  const at = (t: number) => {
    const u = p.periodic ? ((t % span) + span) % span : t;
    return p.segments.find((s) => u < s.until)?.multiplier ?? 1;
  };
  const breaks = (horizon: number) => {
    const out: number[] = [];
    for (let base = 0; base < horizon && out.length < 2000; base += span) {
      for (const s of p.segments) if (base + s.until < horizon) out.push(base + s.until);
      if (!p.periodic) break;
    }
    return out;
  };
  return { sources: with_.map((n) => n.name), periodic: with_.some((n) => n.rateProfile!.periodic), span: Math.max(...with_.map((n) => n.rateProfile!.segments[n.rateProfile!.segments.length - 1].until)), at, breaks };
}

function grid(request: TransientRequest, breaks: number[] = []): number[] {
  const m = request.intervals ?? 200;
  const t = Array.from({ length: m + 1 }, (_, k) => (request.horizon * k) / m);
  for (const b of request.surge ? [request.surge.from, request.surge.until] : breaks) if (b > 0 && b < request.horizon && !t.some((x) => Math.abs(x - b) < 1e-12 * request.horizon)) t.push(b);
  return t.sort((a, b) => a - b);
}

/** The stand-in's answer. */
export function standInTransient(request: TransientRequest): TransientAnalysis {
  const doc = request.document as BnetDocument;
  const prepare = standInPrepare(doc);
  const base: TransientAnalysis = { times: [], stations: prepare.stations, exact: null, exactReason: prepare.exactReason, fluid: null, fluidReason: prepare.fluidReason, stopped: false };
  if (prepare.fluidReason && prepare.exactReason) return { ...base, stations: [] };
  if (!(request.horizon > 0)) throw { kind: "invalid", message: "The time horizon must be a positive number." };
  const traffic = mockTraffic(baseView(doc));
  const profile = storedProfile(doc);
  if (profile && request.surge) throw { kind: "invalid", message: "The network's own rate profile is in force; a surge cannot be added on top of it." };
  const profileBreaks = profile ? profile.breaks(request.horizon) : [];
  const times = grid(request, profileBreaks);
  const surge = request.surge ?? null;
  const factor = (a: number, b: number) => (profile ? profile.at((a + b) / 2) : surge && (a + b) / 2 >= surge.from && (a + b) / 2 < surge.until ? surge.factor : 1);
  // The pointwise stationary approximation: the M/M/c mean at each moment's rate, null where that overloads.
  const factorAt = (t: number) => (profile ? profile.at(t) : surge && t >= surge.from && t < surge.until ? surge.factor : 1);
  const psa = (profile || surge) && !prepare.exactReason ? traffic.map((s) => times.map((t) => (s.utilisation * factorAt(t) < 1 ? (s.utilisation * factorAt(t) > 0 ? mmc(s.utilisation * factorAt(t), s.servers) : 0) : null))) : null;
  const start = (i: number) => (request.initial.kind === "given" ? (request.initial.numbers?.[i] ?? 0) : 0);

  // Fluid, one station at a time.
  const emptied: { station: number; time: number }[] = [];
  const level = traffic.map((s, i) => {
    const cap = muOf(s) * s.servers;
    let q = start(i);
    const out = [q];
    for (let k = 1; k < times.length; k++) {
      const slope = s.arrival * factor(times[k - 1], times[k]) - cap;
      const next = Math.max(0, q + slope * (times[k] - times[k - 1]));
      if (q > 0 && next === 0) emptied.push({ station: i, time: times[k - 1] + q / -slope });
      q = next;
      out.push(q);
    }
    return out;
  });
  const fluid = prepare.fluidReason ? null : { level, emptied };
  if (prepare.exactReason) return { ...base, times, fluid, profileBreaks };

  // "Exact": each station's own birth–death chain, forward equations by small Euler steps.
  const mean: number[][] = [];
  const empty: number[][] = [];
  const settling: (number | null)[] = [];
  const shortfall: (number | null)[] = [];
  const uncertified: boolean[] = [];
  const levels: number[] = [];
  const settleFrom = profile ? (profile.periodic ? request.horizon : (profileBreaks[profileBreaks.length - 1] ?? 0)) : surge ? Math.min(surge.until, request.horizon) : 0;
  const peakOfProfile = profile ? Math.max(1, ...times.map((t) => profile.at(t))) : 1;
  traffic.forEach((s, i) => {
    const mu = muOf(s);
    const l = prepare.stations[i].stationary ?? 0;
    const peakFactor = profile ? peakOfProfile : surge ? Math.max(1, surge.factor) : 1;
    const size = Math.min(600, Math.ceil(start(i) + 12 * l + 30 + Math.max(0, s.arrival * peakFactor - mu * s.servers) * request.horizon * 1.5 + 8 * Math.sqrt(s.arrival * peakFactor * request.horizon)));
    levels.push(size);
    let p = new Array<number>(size + 1).fill(0);
    if (request.initial.kind === "steady") {
      // The M/M/c stationary law, built up by its ratios.
      p[0] = 1;
      for (let n = 1; n <= size; n++) p[n] = (p[n - 1] * s.arrival) / (mu * Math.min(n, s.servers));
      const total = p.reduce((a, b) => a + b, 0);
      p = p.map((x) => x / total);
    } else p[Math.min(size, start(i))] = 1;
    const read = () => [p.reduce((a, x, n) => a + n * x, 0), p[0]];
    const ms = [read()[0]];
    const es = [read()[1]];
    for (let k = 1; k < times.length; k++) {
      const lambda = s.arrival * factor(times[k - 1], times[k]);
      const dt = times[k] - times[k - 1];
      const steps = Math.max(1, Math.ceil(dt * (lambda + mu * s.servers) * 4));
      const h = dt / steps;
      for (let step = 0; step < steps; step++) {
        const q = new Array<number>(size + 1);
        for (let n = 0; n <= size; n++) {
          const out = (n < size ? lambda : 0) + mu * Math.min(n, s.servers);
          q[n] = p[n] * (1 - h * out) + (n > 0 ? p[n - 1] * lambda * h : 0) + (n < size ? p[n + 1] * mu * Math.min(n + 1, s.servers) * h : 0);
        }
        p = q;
      }
      const [m, e] = read();
      ms.push(m);
      es.push(e);
    }
    mean.push(ms);
    empty.push(es);
    // The last entry into the band, as core's `settling_time`; after a surge that overloads the
    // station core certifies no settling time (no bound on the error of the mean).
    const band = request.settleFraction * l;
    let k = times.length - 1;
    const overloaded = profile ? s.arrival * peakOfProfile >= mu * s.servers : !!surge && surge.factor > 1 && surge.from < request.horizon && s.arrival * surge.factor >= mu * s.servers;
    shortfall.push(overloaded ? null : 1e-9);
    uncertified.push(overloaded && Math.abs(ms[k] - l) <= band && !profile?.periodic);
    if (overloaded || profile?.periodic || Math.abs(ms[k] - l) > band) settling.push(null);
    else {
      while (k > 0 && times[k - 1] >= settleFrom && Math.abs(ms[k - 1] - l) <= band) k--;
      if (k === 0 || times[k - 1] < settleFrom) settling.push(Math.max(times[k], settleFrom));
      else {
        const edge = ms[k - 1] > l ? l + band : l - band;
        settling.push(times[k - 1] + ((edge - ms[k - 1]) / (ms[k] - ms[k - 1])) * (times[k] - times[k - 1]));
      }
    }
  });
  const distance = times.map((_, k) => Math.min(1, Math.max(...mean.map((m, i) => Math.abs(m[k] - (prepare.stations[i].stationary ?? 0)) / Math.max(1, prepare.stations[i].stationary ?? 1)))));
  return {
    ...base,
    times,
    fluid,
    psa,
    profileBreaks,
    profilePeriodic: profile?.periodic ?? false,
    exact: { mean, shortfall, uncertified, empty, distance, settling, settleFrom, levels, states: levels.reduce((a, k) => a * (k + 1), 1), uniformisationRate: traffic.reduce((a, s) => a + s.arrival + muOf(s) * s.servers, 0), products: 0, poissonBound: 0, missingMass: 0, stationaryTail: 0 },
  };
}

export function transientHandlers(): MockHandlers {
  mockTransient.run = null;
  mockTransient.hold = false;
  mockTransient.calls = [];
  mockTransient.stops = [];
  held.length = 0;
  heldIds.clear();
  return {
    transient_prepare: ({ document }: { document: BnetDocument }) => standInPrepare(document),
    transient_analyze: async ({ request, channel }: { request: TransientRequest; channel: unknown }) => {
      mockTransient.calls.push(request);
      let stopped = false;
      if (mockTransient.hold) {
        channelSend(channel, { fraction: 0.25 });
        stopped = await new Promise<boolean>((resolve) => {
          held.push(resolve);
          heldIds.set(request.id, resolve);
        });
        heldIds.delete(request.id);
      }
      const answer = (mockTransient.run ?? standInTransient)(request);
      return stopped ? { ...answer, exact: null, stopped: true } : answer;
    },
    transient_stop: ({ id }: { id: string }) => {
      mockTransient.stops.push(id);
      heldIds.get(id)?.(true);
      return null;
    },
  };
}
