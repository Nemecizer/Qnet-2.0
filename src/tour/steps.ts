// The tour's eight steps (new in 2.1, ROADMAP C2; ledger UX-205…213): what each asks for, how the
// app shows it has been done, where the callout points, and what Show Me does. Conditions read the
// real stores (the tab's document, its editor, its Results records); Show Me goes through what the
// interface itself calls — the editor's tool and click handlers, the Inspector's draft and commit,
// and the Run menu's commands — so a step done for the student is the step the student would do.
//
// The network is the smallest that shows a queue behind a queue: Src → B → S → B → S → Sink. In
// Qnet a station is served through a buffer, so "two stations" is four nodes; the sink goes down
// before the links so that linking is one run of clicks from the source to the sink.
import { toolKey } from "../canvas/interaction/tools";
import { editorFor, type EditorTool, type EditorView } from "../editor";
import { displayFixed } from "../editor/numbers";
import { emptyDocument, type BnetDocument, type BnetNode, type NodeKind } from "../lib/bnet";
import { runCommand } from "../lib/commands";
import { getSetting } from "../lib/kv";
import { shortcutFor } from "../lib/menu";
import { NodeParameterDraft } from "../panes/inspector/drafts/node";
import { startAgreementCommands } from "../panes/results/agreement/commands";
import { showResultsView } from "../panes/results/agreement/view";
import { agreementWords } from "../panes/results/agreement/words";
import { asResult, type ResultRecord } from "../panes/results/model";
import { agreement, bestRun, bottleneck, currentRuns, stationValues, tierOf } from "../results/insight";
import { resultsFor } from "../runs/state";
import { liveRun } from "../runs/ui/live";
import type { PaneId } from "../workspace/focus";
import { reveal } from "../workspace/panes/commands";
import { isPaneEnabled } from "../workspace/panes/model";
import { activeTab, selectTab, tabById } from "../workspace/store";
import type { TourStep } from "./engine";
import { tourWords as w, type StepId } from "./words";

// ── The world a condition reads ──────────────────────────────────────────────────────────────

export interface World {
  tabId: string | null;
  /** The tour's tab is still open. */
  open: boolean;
  /** …and is the tab on screen. */
  active: boolean;
  doc: BnetDocument;
  view: EditorView | null;
  /** The completed runs of the network as it is now, one per method, best tier first. */
  runs: ResultRecord[];
  /** A run is in progress. */
  busy: boolean;
}

const EMPTY = emptyDocument();

/** The tour tab's state, from the stores. `fingerprint` is the network's, once Rust has said (null: nothing reads as stale). */
export function readWorld(tabId: string | null, fingerprint: string | null = null): World {
  const tab = tabId ? tabById(tabId) : undefined;
  if (!tab) return { tabId, open: false, active: false, doc: EMPTY, view: null, runs: [], busy: false };
  return {
    tabId,
    open: true,
    active: activeTab().id === tab.id,
    doc: tab.document,
    view: editorFor(tab.id).view,
    runs: currentRuns(resultsFor(tab.id).map(asResult), fingerprint),
    busy: liveRun() !== null,
  };
}

// ── Reading the network ──────────────────────────────────────────────────────────────────────

const ofKind = (doc: BnetDocument, kind: NodeKind) => doc.nodes.filter((n) => n.kind === kind).sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1]);

/** The line the tour means, left to right, with whatever of it exists: source, buffer, station, buffer, station, sink. */
export function chain(doc: BnetDocument): BnetNode[] {
  const [b, s] = [ofKind(doc, "buffer"), ofKind(doc, "station")];
  return [ofKind(doc, "source")[0], b[0], s[0], b[1], s[1], ofKind(doc, "sink")[0]].filter((n): n is BnetNode => !!n);
}

/** The neighbours in the line that no link joins yet. */
export function missingLinks(doc: BnetDocument): [BnetNode, BnetNode][] {
  const c = chain(doc);
  const out: [BnetNode, BnetNode][] = [];
  for (let i = 0; i + 1 < c.length; i++) if (!doc.links.some((l) => l.fromNodeID === c[i].id && l.toNodeID === c[i + 1].id)) out.push([c[i], c[i + 1]]);
  return out;
}

/** A customer can travel from a source through two stations to a sink. */
export function lineLinked(doc: BnetDocument): boolean {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const walk = (id: string, stations: number, seen: Set<string>): boolean => {
    const n = byId.get(id);
    if (!n || seen.has(id)) return false;
    if (n.kind === "sink") return stations >= 2;
    const here = stations + (n.kind === "station" ? 1 : 0);
    const next = new Set(seen).add(id);
    return doc.links.some((l) => l.fromNodeID === id && walk(l.toNodeID, here, next));
  };
  return doc.nodes.some((n) => n.kind === "source" && walk(n.id, 0, new Set()));
}

/** The service rate a new station is born with (src/editor/editor.ts `DEFAULT_SERVICE_RATE_LITERAL`). */
export const BORN_RATE = 1.1111111;
/** What the tour suggests instead. */
export const SUGGESTED_RATE = "2";

/** Some station's service law is no longer the one it was born with. */
export function rateEdited(doc: BnetDocument): boolean {
  return doc.nodes.some((n) => {
    if (n.kind !== "station") return false;
    return [n, ...Object.values(n.serviceDistributions ?? {})].some((law) => {
      const rate = /(?:^|,)\s*rate\s*=\s*([^,]+)/.exec(law.distributionParameters)?.[1];
      return law.distribution !== "exponential" || rate === undefined || Math.abs(Number(rate) - BORN_RATE) > 1e-9;
    });
  });
}

/**
 * The first station of the tour's line that serves no faster than customers arrive, or null. In a
 * line every customer of every source passes every station, so the test is the station's rate
 * (times its servers) against the sources' rates; a rate that is not a positive number counts too.
 * (The canvas's own problems, from Rust, say the same of any network a moment later; the step
 * cannot wait for that answer.)
 */
export function overloadedStation(doc: BnetDocument): BnetNode | null {
  const rateOf = (text: string, fallback: number) => {
    const m = /(?:^|,)\s*(?:rate|lambda)\s*=\s*([^,]+)/.exec(text)?.[1];
    return m === undefined ? fallback : Number(m);
  };
  const arriving = doc.nodes.filter((n) => n.kind === "source").reduce((sum, n) => sum + rateOf(n.distributionParameters, 1), 0);
  if (!(arriving > 0)) return null;
  return (
    ofKind(doc, "station").find((n) => {
      const classes = Object.values(n.serviceDistributions ?? {});
      const laws = classes.length ? classes : [n];
      // Only a rate that can be read is judged; another law is the Problems list's to judge.
      return laws.some((law) => law.distribution === "exponential" && !(rateOf(law.distributionParameters, BORN_RATE) * n.numberOfServers > arriving));
    }) ?? null
  );
}

const count = (doc: BnetDocument, kind: NodeKind) => doc.nodes.filter((n) => n.kind === kind).length;

/** The kind the "two stations" step wants placed next: buffer, station, buffer, station. */
export function nextQueuePart(doc: BnetDocument): "buffer" | "station" | null {
  const [b, s] = [count(doc, "buffer"), count(doc, "station")];
  if (b >= 2 && s >= 2) return null;
  return b < 2 && b <= s ? "buffer" : s < 2 ? "station" : "buffer";
}

// ── Show Me ──────────────────────────────────────────────────────────────────────────────────

const TOOL: Record<NodeKind, EditorTool> = { source: "addSource", buffer: "addBuffer", station: "addStation", sink: "addSink" };
/** Where Show Me puts the line, in canvas points: six places in a row. */
const PLACE = { x: 70, dx: 90, y: 120 };
const SLOT = { source: [0], buffer: [1, 3], station: [2, 4], sink: [5] } satisfies Record<NodeKind, number[]>;

/** One event of the interface: the editor closes its undo group when the event returns. */
const event = async (f: () => void) => {
  f();
  await Promise.resolve();
};

async function until(test: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!test() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
}

function editorOf(world: () => World) {
  const { tabId, open } = world();
  if (!tabId || !open) return null;
  selectTab(tabId);
  return editorFor(tabId);
}

/** Picks the kind's tool and clicks the canvas at its place in the row, as a student would. */
async function place(world: () => World, kind: NodeKind) {
  const e = editorOf(world);
  if (!e) return;
  const slot = SLOT[kind][Math.min(count(world().doc, kind), SLOT[kind].length - 1)];
  const at = { x: PLACE.x + PLACE.dx * slot, y: PLACE.y };
  while (e.nodes.some((n) => Math.hypot(n.position[0] - at.x, n.position[1] - at.y) < 50)) at.y += 100;
  await event(() => e.setTool(TOOL[kind]));
  await event(() => e.handleCanvasTap(at));
}

async function showLinks(world: () => World) {
  const e = editorOf(world);
  if (!e) return;
  await event(() => e.setTool("addLink"));
  for (const [from, to] of missingLinks(world().doc)) {
    if (e.view.pendingLinkStartID !== from.id) {
      // A click on the empty canvas lets go of a chain in progress; then the start node is clicked.
      if (e.view.pendingLinkStartID !== null) await event(() => e.handleCanvasTap({ x: -1e4, y: -1e4 }));
      await event(() => e.handleNodeTap(from.id));
    }
    await event(() => e.handleNodeTap(to.id));
  }
  await event(() => e.setTool("select"));
  // The whole line in view, as View ▸ Zoom to Fit would leave it, when part of it is off screen.
  const v = e.view;
  const off = e.nodes.some((n) => {
    const x = n.position[0] * v.canvasScale + v.canvasPanOffset.width;
    const y = n.position[1] * v.canvasScale + v.canvasPanOffset.height;
    return v.viewportSize.width > 0 && (x < 30 || y < 30 || x > v.viewportSize.width - 30 || y > v.viewportSize.height - 30);
  });
  if (off) e.zoomToFit();
}

/** The station the rate step names: the first in the line. */
const rateStation = (doc: BnetDocument) => chain(doc).find((n) => n.kind === "station") ?? null;

async function showRate(world: () => World) {
  const e = editorOf(world);
  const station = rateStation(world().doc);
  if (!e || !station) return;
  await event(() => e.setTool("select"));
  await event(() => e.handleNodeTap(station.id));
  // The Inspector's own draft: load the station, type the rate, commit (one undo step).
  const draft = new NodeParameterDraft();
  draft.load(e, station.id);
  draft.setParam("rate", SUGGESTED_RATE, draft.servedClasses[0]);
  await event(() => void draft.commit(e));
  draft.cancelStabilityRefresh();
}

async function run(world: () => World, command: "run:solve" | "run:check-another", enough: number) {
  if (!editorOf(world)) return;
  startAgreementCommands();
  await until(() => !world().busy);
  await runCommand(command);
  // The record is read back a moment after the run ends.
  await until(() => world().runs.length >= enough, 3000);
}

function bring(pane: PaneId) {
  if (!isPaneEnabled(pane)) void reveal(pane, () => {}).catch(() => {});
}

// ── The steps ────────────────────────────────────────────────────────────────────────────────

/** Finds an element: in a pane (wherever it is now — docked, or in a window of its own) or, with no pane, anywhere in the main window. */
export type Find = (pane: PaneId | null, selector?: string) => Element | null;

export interface QnetStep extends TourStep<World> {
  id: StepId;
  /** What the callout points at now; null floats it in the corner. */
  target: (w: World, find: Find) => Element | null;
  /**
   * What the callout stands beside, when that is not the target: while a network is being drawn
   * the ring moves between the tools and the canvas, and the callout stays put by the canvas
   * (beside a tool it would lie over the nodes just placed).
   */
  anchor?: (w: World, find: Find) => Element | null;
  /**
   * With `anchor`: the control the step is about (its tool), which the callout keeps as near as
   * the anchor allows for the whole step, wherever the ring is at the moment.
   */
  beside?: (w: World, find: Find) => Element | null;
}

const byCanvas = (_w: World, find: Find) => find("canvas");

const toolButton = (tool: (w: World) => EditorTool) => (w: World, find: Find) => find("tools", `[data-tool="${tool(w)}"]`);
const toolOrCanvas = (tool: EditorTool) => (w: World, find: Find) => (w.view?.tool === tool ? find("canvas") : (find("tools", `[data-tool="${tool}"]`) ?? find("canvas")));
const nodeEl = (find: Find, n: BnetNode | null | undefined) => (n ? find("canvas", `[data-node="${n.id}"]`) : null);

/** The node the Link tool wants clicked next. */
export function nextLinkClick(w: World): BnetNode | null {
  const gap = missingLinks(w.doc)[0];
  if (!gap) return null;
  return w.view?.tool === "addLink" && w.view.pendingLinkStartID === gap[0].id ? gap[1] : gap[0];
}

/** Where the Solve button may be: the toolbar's, when it is there. */
const SOLVE_BUTTON = '[data-tour="solve"], [data-toolbar-item="solve"], [data-toolbar-item="run.solve"]';

function checkButton(find: Find): Element | null {
  const view = find("results", '[data-view="agreement"]');
  const prefix = agreementWords.checkWith("");
  return [...(view?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").trim().startsWith(prefix)) ?? null;
}

export const STEPS: QnetStep[] = [
  {
    id: "source",
    done: (w) => count(w.doc, "source") >= 1,
    show: (world) => place(world, "source"),
    enter: () => bring("tools"),
    target: toolOrCanvas("addSource"),
    anchor: byCanvas,
    beside: toolButton(() => "addSource"),
  },
  {
    id: "stations",
    done: (w) => count(w.doc, "buffer") >= 2 && count(w.doc, "station") >= 2,
    show: async (world) => {
      for (let kind = nextQueuePart(world().doc); kind; kind = nextQueuePart(world().doc)) await place(world, kind);
    },
    enter: () => bring("tools"),
    target: (w, find) => toolOrCanvas(TOOL[nextQueuePart(w.doc) ?? "station"])(w, find),
    anchor: byCanvas,
    beside: toolButton((w) => TOOL[nextQueuePart(w.doc) ?? "station"]),
  },
  {
    id: "sink",
    done: (w) => count(w.doc, "sink") >= 1,
    show: (world) => place(world, "sink"),
    enter: () => bring("tools"),
    target: toolOrCanvas("addSink"),
    anchor: byCanvas,
    beside: toolButton(() => "addSink"),
  },
  {
    id: "link",
    done: (w) => lineLinked(w.doc),
    show: showLinks,
    enter: () => bring("tools"),
    target: (w, find) => (w.view?.tool === "addLink" ? (nodeEl(find, nextLinkClick(w)) ?? find("canvas")) : (find("tools", '[data-tool="addLink"]') ?? find("canvas"))),
    anchor: byCanvas,
    beside: toolButton(() => "addLink"),
  },
  {
    id: "rate",
    // A rate that overloads the line would leave the student stuck at Solve: not done yet.
    done: (w) => rateEdited(w.doc) && !overloadedStation(w.doc),
    show: showRate,
    enter: () => bring("inspector"),
    target: (w, find) => {
      const station = rateStation(w.doc);
      const selected = !!station && w.view?.selectedNodeID === station.id;
      return (selected ? (find("inspector", '[data-inspector-field="param-rate"]') ?? find("inspector")) : null) ?? nodeEl(find, station) ?? find("canvas");
    },
    // Beside the Inspector, not over its labels.
    anchor: (w, find) => (rateStation(w.doc)?.id === w.view?.selectedNodeID ? find("inspector") : null),
  },
  {
    id: "solve",
    done: (w) => w.runs.length >= 1,
    show: (world) => run(world, "run:solve", 1),
    target: (_w, find) => find(null, SOLVE_BUTTON),
  },
  {
    id: "read",
    manual: true,
    done: (w) => w.runs.length >= 1,
    show: () => {
      showResultsView("agreement");
      return reveal("results", () => {}).catch(() => {});
    },
    enter: () => bring("results"),
    target: (w, find) => {
      const busiest = reading(w)?.stationID;
      return (busiest ? find("canvas", `[data-result="${busiest.toUpperCase()}"], [data-result="${busiest}"]`) : null) ?? find("results", ".agr-banner") ?? find("results");
    },
  },
  {
    id: "check",
    done: (w) => w.runs.length >= 2,
    show: (world) => run(world, "run:check-another", 2),
    enter: () => {
      showResultsView("agreement");
      bring("results");
    },
    target: (_w, find) => checkButton(find) ?? find("results"),
  },
];

// ── What the callout says ────────────────────────────────────────────────────────────────────

/** The busiest station of the best current run, with what the read step quotes. */
export function reading(world: World): { stationID: string; station: string; utilisation: number; count: number | null; countMetric: string; run: ResultRecord } | null {
  const best = bestRun(world.runs);
  const neck = best ? bottleneck(best) : null;
  if (!best || !neck) return null;
  for (const metric of Object.keys(w.steps.read.countIs)) {
    const v = stationValues(best, metric).find((x) => x.stationID === neck.stationID);
    if (v) return { stationID: neck.stationID, station: neck.stationName, utilisation: neck.value, count: v.value, countMetric: metric, run: best };
  }
  return { stationID: neck.stationID, station: neck.stationName, utilisation: neck.value, count: null, countMetric: "", run: best };
}

export interface StepWords {
  title: string;
  text: string;
  /** A second, quieter line: progress within the step, or where to find the control. */
  note?: string;
}

const DEFAULT_NAMES = ["Src1", "B1", "S1", "B2", "S2", "Sink1"];

/** A step's words for the app as it is now. `hasTarget` is whether the callout found its control. */
export function describe(id: StepId, world: World, hasTarget = true): StepWords {
  const s = w.steps;
  switch (id) {
    case "source":
      return { title: s.source.title, text: s.source.text(toolKey("addSource")) };
    case "stations": {
      const placed = Math.min(2, count(world.doc, "buffer")) + Math.min(2, count(world.doc, "station"));
      return { title: s.stations.title, text: s.stations.text(toolKey("addBuffer"), toolKey("addStation")), note: s.stations.count(placed) };
    }
    case "sink":
      return { title: s.sink.title, text: s.sink.text(toolKey("addSink")) };
    case "link": {
      const c = chain(world.doc);
      const next = world.view?.tool === "addLink" ? nextLinkClick(world) : null;
      return { title: s.link.title, text: s.link.text(toolKey("addLink"), (c.length === 6 ? c.map((n) => n.name) : DEFAULT_NAMES).join(", ")), note: next ? s.link.next(next.name) : undefined };
    }
    case "rate":
    {
      const slow = overloadedStation(world.doc);
      return { title: s.rate.title, text: s.rate.text(toolKey("select"), rateStation(world.doc)?.name ?? "S1", SUGGESTED_RATE), note: slow ? s.rate.tooSlow(slow.name, SUGGESTED_RATE) : undefined };
    }
    case "solve": {
      const key = shortcutFor("run:solve") ?? "⌘↩";
      return { title: s.solve.title, text: s.solve.text(key), note: hasTarget ? undefined : s.solve.menuHint(key) };
    }
    case "read": {
      const r = reading(world);
      const best = r?.run ?? bestRun(world.runs);
      if (!best) return { title: s.read.title, text: s.read.waiting };
      const decimals = Math.min(2, Number(getSetting<number>("output.decimals", 6)));
      const sure = s.read.sure[tierOf(best)];
      if (!r) return { title: s.read.title, text: sure, note: s.read.where };
      const text = s.read.reading(r.station, `${displayFixed(r.utilisation * 100, 0)} %`, r.count === null ? null : displayFixed(r.count, decimals), s.read.countIs[r.countMetric] ?? "");
      return { title: s.read.title, text: `${text} ${sure}`, note: s.read.where };
    }
    case "check":
      return { title: s.check.title, text: s.check.text };
  }
}

/** The finish card's sentence about the comparison. */
export function verdictWords(world: World): string {
  if (world.runs.length < 2) return w.finish.verdict.single;
  const a = agreement(world.runs);
  if (a.hasExact && a.comparedWithExact > 0 && (a.verdict === "agree" || a.verdict === "close" || a.verdict === "disagree")) return w.finish.withExact[a.verdict];
  return w.finish.verdict[a.verdict];
}
