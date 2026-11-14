// Animation of a simulation on the canvas (new in 2.1, ROADMAP Phase E): the shapes the commands
// answer in (src-tauri/src/animate.rs) and the bookkeeping of who is where as events are played.
//
// The simulation itself is Rust's (core/src/sim.rs, which has the exact checks). What is kept
// here is only what a picture needs: the tokens, each station's queue and servers, a short
// history of each station's count for the strip chart, and the running time integral of each
// count, which a test holds to the simulator's own (fixtures/jackson-feedback.json).

export interface AnimateStation {
  id: string;
  name: string;
  servers: number;
  /** The buffer in front of the station, where its queue is drawn. */
  bufferId: string;
  /** The exact long-run mean number in system (customers), when a closed form applies. */
  exactNumber: number | null;
  /** With priority service (new in 2.1): each class's rank, 0 the highest, by class index. Absent for first come, first served. */
  rank?: number[];
}

export interface AnimateLayout {
  stations: AnimateStation[];
  sources: { id: string; name: string; class: number }[];
  /** Ids of the sinks customers leave by. */
  sinks: string[];
  classes: number;
  /** A closed network's population. */
  population: number | null;
  /** Stations with utilisation ≥ 1: no steady state exists. */
  unstable: string[];
  /** Service completions per time unit over the whole network, in the long run. */
  eventRate: number;
}

/** [customer, class]. */
export type Who = [number, number];

export interface AnimateSnapshot {
  time: number;
  /** The head of each queue: the simulator names only the first few hundred of a long one. */
  queues: Who[][];
  /** How many wait at each station in all. Absent: as many as `queues` names. */
  waiting?: number[];
  servers: (Who | null)[][];
}

export interface AnimateStats {
  time: number;
  areaNumber: number[];
  areaQueue: number[];
  arrivals: number[];
  departures: number[];
  created: number;
  left: number;
}

/** Events as columns (one array per field). */
export interface AnimateEvents {
  t: number[];
  k: number[];
  c: number[];
  cls: number[];
  s: number[];
  srv: number[];
  o: number[];
}

export interface AnimateStart {
  session: number;
  seed: number;
  layout: AnimateLayout;
  snapshot: AnimateSnapshot;
}

export interface AnimateChunk {
  /** Every event up to this time is in the chunks sent so far. */
  time: number;
  events: AnimateEvents;
  stats: AnimateStats;
  snapshot?: AnimateSnapshot;
  /** The run has stopped for good (a queue past the simulator's size limit): the sentence saying so. */
  stopped?: string;
}

/** The kinds, as core/src/sim.rs `Kind` numbers them. */
export const ARRIVE = 0;
export const START = 1;
export const DEPART = 2;
export const ROUTE = 3;
export const LEAVE = 4;
/** Preemptive-resume priority (new in 2.1): the customer in service goes back to the head of its class's queue. */
export const PREEMPT = 5;

/** Where a token is coming from, for drawing it on its way. Node ids; null when unknown. */
export interface Travel {
  kind: "arrive" | "route" | "leave" | "serve";
  from: string | null;
  to: string | null;
  /** The class the link is drawn for (the class the customer had on leaving `from`). */
  viaClass: number;
}

export interface Token {
  id: number;
  cls: number;
  /** Station index, or −1 once it has left the network. */
  station: number;
  /** Server index, or −1 while waiting. */
  server: number;
  /** Set by the bookkeeping when the token changes place; the renderer consumes it. */
  travel: Travel | null;
  /** Where it was last drawn, in world coordinates (the renderer's). */
  x: number;
  y: number;
  drawn: boolean;
}

/** A queue that can be very long (an unstable network): removing the head never copies. */
export class Fifo<T> {
  private items: T[] = [];
  private head = 0;
  // A snapshot names only the head of a long queue (src-tauri/src/animate.rs SNAPSHOT_HEAD):
  // behind the `named` items that were given stand `unnamed` customers known only by number,
  // and behind those whatever is pushed afterwards.
  private named = 0;
  private unnamed = 0;

  get length(): number {
    return this.items.length - this.head + this.unnamed;
  }

  push(v: T) {
    this.items.push(v);
  }

  /** Behind the items pushed so far stand `n` more that are not named. */
  gap(n: number) {
    this.unnamed = Math.max(0, Math.floor(n));
    this.named = this.items.length - this.head;
  }

  /** The customer at the head is one of those known only by number. */
  get headUnnamed(): boolean {
    return this.unnamed > 0 && this.named === 0;
  }

  shift(): T | undefined {
    if (this.unnamed > 0) {
      if (this.named === 0) {
        this.unnamed--;
        return undefined;
      }
      this.named--;
    }
    if (this.head >= this.items.length) return undefined;
    const v = this.items[this.head++];
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return v;
  }

  /** The i-th from the head; undefined for one known only by number. */
  at(i: number): T | undefined {
    if (this.unnamed > 0 && i >= this.named) return i < this.named + this.unnamed ? undefined : this.items[this.head + i - this.unnamed];
    return this.items[this.head + i];
  }

  // ── Priority service (new in 2.1): a customer may leave from inside the queue, an interrupted
  // one comes back to its head, and an arrival takes its place by class. ─────────────────────

  /** Removes and returns the first named item for which `is` holds; undefined when there is none. */
  take(is: (v: T) => boolean): T | undefined {
    for (let k = this.head; k < this.items.length; k++) {
      if (is(this.items[k])) {
        const [v] = this.items.splice(k, 1);
        if (this.unnamed > 0 && k < this.head + this.named) this.named--;
        return v;
      }
    }
    return undefined;
  }

  /** One of the customers known only by number leaves the queue; false when there is none. */
  takeUnnamed(): boolean {
    if (this.unnamed === 0) return false;
    this.unnamed--;
    return true;
  }

  /** Puts `v` at the head. */
  unshift(v: T) {
    this.items.splice(this.head, 0, v);
    if (this.unnamed > 0) this.named++;
  }

  /** Puts `v` before the first item for which `after` holds, else at the end (at the end too while part of the queue is known only by number). */
  insertBefore(v: T, after: (x: T) => boolean) {
    if (this.unnamed === 0) {
      for (let k = this.head; k < this.items.length; k++) {
        if (after(this.items[k])) {
          this.items.splice(k, 0, v);
          return;
        }
      }
    }
    this.items.push(v);
  }

  indexOf(v: T, limit: number): number {
    const end = Math.min(this.length, limit);
    for (let i = 0; i < end; i++) if (this.at(i) === v) return i;
    return -1;
  }
}

export interface StationState {
  queue: Fifo<Token>;
  servers: (Token | null)[];
  busy: number;
  /** ∫ N dt up to `since`, and the time it is brought up to. */
  area: number;
  since: number;
  /** [time, number in system] at each change, oldest first, trimmed to the chart's window. */
  history: number[];
}

const numberAt = (s: StationState) => s.queue.length + s.busy;

/** Who is where, as the events played so far leave it. */
export class AnimState {
  readonly layout: AnimateLayout;
  stations: StationState[] = [];
  /** Tokens on their way out of the network: drawn until they arrive, then forgotten. */
  leaving: Token[] = [];
  /** Tokens whose `travel` the renderer has not yet picked up. */
  moved: Token[] = [];
  /** The time of the last event applied (or of the snapshot). */
  time = 0;
  /** When the running totals start: 0 unless the run was adopted mid-way. */
  origin = 0;
  created = 0;
  left = 0;
  /** How much history is kept, in time units. */
  window: number;
  /** Events that did not fit the state (a bug if ever non-zero; tests assert 0). */
  faults = 0;
  private inHand: Token | null = null;

  constructor(layout: AnimateLayout, snapshot: AnimateSnapshot, window: number) {
    this.layout = layout;
    this.window = window;
    this.adopt(snapshot, null);
  }

  /** Replaces the state with a snapshot (the start, or after a skip), and the totals with the simulator's. */
  adopt(snapshot: AnimateSnapshot, stats: AnimateStats | null) {
    const token = ([id, cls]: Who, station: number, server: number): Token => ({ id, cls, station, server, travel: null, x: 0, y: 0, drawn: false });
    this.time = snapshot.time;
    this.stations = this.layout.stations.map((_, i) => {
      const queue = new Fifo<Token>();
      for (const w of snapshot.queues[i] ?? []) queue.push(token(w, i, -1));
      // The rest of a long queue is a number, not a list (the simulator sends only its head).
      queue.gap((snapshot.waiting?.[i] ?? queue.length) - queue.length);
      const servers = (snapshot.servers[i] ?? []).map((w, k) => (w ? token(w, i, k) : null));
      const busy = servers.reduce((n, s) => n + (s ? 1 : 0), 0);
      return { queue, servers, busy, area: stats?.areaNumber[i] ?? 0, since: snapshot.time, history: [snapshot.time, queue.length + busy] };
    });
    this.leaving = [];
    this.moved = [];
    this.inHand = null;
    if (stats) {
      this.created = stats.created;
      this.left = stats.left;
    } else {
      this.origin = snapshot.time;
      this.created = 0;
      this.left = 0;
    }
  }

  number(i: number): number {
    return numberAt(this.stations[i]);
  }

  waiting(i: number): number {
    return this.stations[i].queue.length;
  }

  /** Customers in the network. */
  total(): number {
    return this.stations.reduce((n, s) => n + numberAt(s), 0);
  }

  /** The time-average number at station `i` from the start of the run to time `t` (≥ the last event). */
  average(i: number, t: number): number | null {
    const s = this.stations[i];
    const span = t - this.origin;
    if (!(span > 0)) return null;
    return (s.area + numberAt(s) * Math.max(0, t - s.since)) / span;
  }

  /** ∫ N_i dt from the start of the run to `t`. */
  area(i: number, t: number): number {
    const s = this.stations[i];
    return s.area + numberAt(s) * Math.max(0, t - s.since);
  }

  private touch(i: number, t: number) {
    const s = this.stations[i];
    s.area += numberAt(s) * (t - s.since);
    s.since = t;
  }

  private note(i: number, t: number) {
    const s = this.stations[i];
    const h = s.history;
    h.push(t, numberAt(s));
    // Trim in blocks: keep one point at or before the window's start.
    if (h.length > 64 && h[2] < t - this.window) {
      let cut = 0;
      while (cut + 2 < h.length && h[cut + 2] <= t - this.window) cut += 2;
      if (cut > 0) h.splice(0, cut);
    }
  }

  private join(token: Token, i: number, t: number) {
    this.touch(i, t);
    token.station = i;
    token.server = -1;
    // At a priority station a customer waits behind its own class and every higher one.
    const rank = this.layout.stations[i].rank;
    if (rank?.length) this.stations[i].queue.insertBefore(token, (x) => (rank[x.cls] ?? rank.length) > (rank[token.cls] ?? rank.length));
    else this.stations[i].queue.push(token);
    this.note(i, t);
  }

  /** Applies event `n` of `e`. */
  apply(e: AnimateEvents, n: number) {
    const t = e.t[n];
    const i = e.s[n];
    const st = this.stations[i];
    this.time = t;
    if (!st) {
      this.faults++;
      return;
    }
    switch (e.k[n]) {
      case ARRIVE: {
        const token: Token = { id: e.c[n], cls: e.cls[n], station: i, server: -1, travel: { kind: "arrive", from: this.layout.sources[e.o[n]]?.id ?? null, to: this.layout.stations[i].bufferId || this.layout.stations[i].id, viaClass: e.cls[n] }, x: 0, y: 0, drawn: false };
        this.created++;
        this.join(token, i, t);
        this.moved.push(token);
        break;
      }
      case START: {
        // The head of a queue the snapshot cut is known only by number: the event names it.
        let token: Token | undefined = st.queue.headUnnamed ? { id: e.c[n], cls: e.cls[n], station: i, server: -1, travel: null, x: 0, y: 0, drawn: false } : st.queue.at(0);
        const ranked = Boolean(this.layout.stations[i].rank?.length);
        if (ranked && st.servers[e.srv[n]] === null && (!token || token.id !== e.c[n])) {
          // Priority service: the customer named may stand anywhere in the queue, or among
          // those a long queue's snapshot gave only by number.
          token = st.queue.take((x) => x.id === e.c[n]);
          if (!token && st.queue.takeUnnamed()) token = { id: e.c[n], cls: e.cls[n], station: i, server: -1, travel: null, x: 0, y: 0, drawn: false };
          if (!token) {
            this.faults++;
            return;
          }
        } else {
          if (!token || token.id !== e.c[n] || st.servers[e.srv[n]] !== null) {
            this.faults++;
            return;
          }
          st.queue.shift();
        }
        st.servers[e.srv[n]] = token;
        st.busy++;
        token.server = e.srv[n];
        // On its way already (it arrived to a free server): it keeps going, to the server.
        if (!token.travel) {
          token.travel = { kind: "serve", from: null, to: null, viaClass: token.cls };
          this.moved.push(token);
        }
        break;
      }
      case DEPART: {
        const token = st.servers[e.srv[n]];
        if (!token || token.id !== e.c[n]) {
          this.faults++;
          return;
        }
        this.touch(i, t);
        st.servers[e.srv[n]] = null;
        st.busy--;
        this.note(i, t);
        this.inHand = token;
        break;
      }
      case ROUTE: {
        const token = this.inHand;
        const j = e.o[n];
        if (!token || token.id !== e.c[n] || !this.stations[j]) {
          this.faults++;
          return;
        }
        this.inHand = null;
        token.travel = { kind: "route", from: this.layout.stations[i].id, to: this.layout.stations[j].bufferId || this.layout.stations[j].id, viaClass: token.cls };
        token.cls = e.cls[n];
        this.join(token, j, t);
        this.moved.push(token);
        break;
      }
      case LEAVE: {
        const token = this.inHand;
        if (!token || token.id !== e.c[n]) {
          this.faults++;
          return;
        }
        this.inHand = null;
        this.left++;
        token.station = -1;
        token.server = -1;
        token.travel = { kind: "leave", from: this.layout.stations[i].id, to: this.layout.sinks[e.o[n]] ?? null, viaClass: token.cls };
        this.leaving.push(token);
        this.moved.push(token);
        break;
      }
      case PREEMPT: {
        // The number at the station does not change: one customer moves from a server to the queue's head.
        const token = st.servers[e.srv[n]];
        if (!token || token.id !== e.c[n]) {
          this.faults++;
          return;
        }
        st.servers[e.srv[n]] = null;
        st.busy--;
        token.server = -1;
        token.travel = { kind: "serve", from: null, to: null, viaClass: token.cls };
        st.queue.unshift(token);
        this.moved.push(token);
        break;
      }
      default:
        this.faults++;
    }
  }
}

/** A cursor over the chunks received and not yet played. */
export class EventBuffer {
  private chunks: AnimateEvents[] = [];
  private at = 0;
  /** Events waiting. */
  pending = 0;

  push(e: AnimateEvents) {
    if (!e.t.length) return;
    this.chunks.push(e);
    this.pending += e.t.length;
  }

  clear() {
    this.chunks = [];
    this.at = 0;
    this.pending = 0;
  }

  /** Plays every waiting event with time ≤ `until` into `state`; returns how many. */
  playInto(state: AnimState, until: number): number {
    let played = 0;
    while (this.chunks.length) {
      const c = this.chunks[0];
      while (this.at < c.t.length && c.t[this.at] <= until) {
        state.apply(c, this.at++);
        played++;
      }
      if (this.at < c.t.length) break;
      this.chunks.shift();
      this.at = 0;
    }
    this.pending -= played;
    return played;
  }
}
