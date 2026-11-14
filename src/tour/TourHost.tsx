// The guided tour on screen (new in 2.1, ROADMAP C2; ledger UX-201, UX-217…224): a callout beside
// what the current step is about, with a ring round it. It is not a dialog: nothing is covered or
// disabled, the student works in the real interface, and the tour follows.
//
// The callout and ring are drawn in the window their target is in (`ownerDocument`: a detached
// Inspector or Results pane is another window), fixed to that window, and placed again whenever
// the target moves — on resize, on scroll, and on a slow tick that also notices a pane detaching or
// a control appearing. Each step is read out through the app's polite live region. Escape ends the
// tour, from the callout always and from elsewhere when nothing else has a use for the key.
// App.tsx mounts `<TourHost />` once; it also registers `tour:start` (Help ▸ Guided Tour, and the
// Welcome view's button).
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GraduationCap, X } from "lucide-react";
import { Icon } from "../components/Icon";
import { editorFor } from "../editor";
import { announce } from "../lib/announce";
import { auxWindow } from "../lib/auxWindow";
import { runCommand, useCommands, type Command } from "../lib/commands";
import { modalOpen } from "../lib/overlays";
import { useCurrentFingerprint } from "../panes/results/fingerprint";
import { useResults } from "../runs/state";
import { useLiveRuns } from "../runs/ui/live";
import type { PaneId } from "../workspace/focus";
import { placedHost } from "../workspace/panes/hosts";
import { selectTab, useWorkspace } from "../workspace/store";
import { placeCallout, placeCorner, placeNear, ringBox, sameBox, type Box, type Placement, type Side } from "./position";
import { endTour, setTourFingerprint, startTour, tour, tourTabId, tourWorld, useTour } from "./state";
import { describe, verdictWords, type Find, type QnetStep, type World } from "./steps";
import "./tour.css";
import { tourWords as w } from "./words";

const DETACHED: PaneId[] = ["status", "results", "shell", "ai", "inspector"];

/** Every window the app is drawing in: the main one and each detached pane's. */
function documents(): Document[] {
  const out = [document];
  for (const p of DETACHED) {
    try {
      const win = auxWindow(`pane-${p}`)?.win;
      if (win && !win.closed) out.push(win.document);
    } catch {
      // A window that went away mid-look.
    }
  }
  return out;
}

/** The step's `Find`: a pane's own tree first (wherever it is placed), then any window's `[data-pane]`. */
export const find: Find = (pane, selector) => {
  if (pane === null) return selector ? document.querySelector(selector) : null;
  const roots: ParentNode[] = [];
  const host = placedHost(pane);
  if (host) roots.push(host);
  for (const d of documents()) roots.push(...d.querySelectorAll(`[data-pane="${pane}"]`));
  for (const root of roots) {
    const el = selector ? root.querySelector(selector) : root instanceof Element && root.matches("[data-pane]") ? root : (root.querySelector(`[data-pane="${pane}"]`) ?? null);
    if (el) return el;
  }
  return null;
};

/** The side a callout prefers for a target, by where the target lives: beside the narrow panes, below anything else. */
function preferredSide(el: Element): Exclude<Side, "inside" | "corner"> {
  const pane = el.closest("[data-pane]")?.getAttribute("data-pane");
  return pane === "tools" ? "right" : pane === "inspector" ? "left" : "bottom";
}

interface Measured {
  el: Element | null;
  doc: Document;
  box: Box | null;
  /** What the callout stands beside: the target, unless the step names something else. */
  anchor: Element | null;
  anchorBox: Box | null;
  /** The control the callout keeps near while it stays inside the anchor (a step's `beside`). */
  besideEl: Element | null;
  besideBox: Box | null;
  /** What the callout keeps off: the nodes and the empty-canvas hint while it is inside the canvas; the Results pane's header on the last card. */
  avoid: Box[];
  /** What it would rather not cover, but may: the empty canvas's hint. */
  soft: Box[];
  viewport: { width: number; height: number };
}

const viewportOf = (doc: Document) => {
  const win = doc.defaultView ?? window;
  return { width: win.innerWidth, height: win.innerHeight };
};

/**
 * The part of an element that can be seen: its rectangle cut down by every scrolling ancestor and
 * by the window. An element scrolled out of sight inside its pane gives the pane's own rectangle
 * (the callout then points at the pane while the element is brought into view). Null for an element
 * with no size, which is not on screen at all (a hidden pane): the callout floats instead.
 */
export function visibleBox(el: Element | null): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return null;
  const view = el.ownerDocument.defaultView ?? window;
  let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  const cut = (c: { left: number; top: number; right: number; bottom: number }) => ({ left: Math.max(box.left, c.left), top: Math.max(box.top, c.top), right: Math.min(box.right, c.right), bottom: Math.min(box.bottom, c.bottom) });
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = view.getComputedStyle(p);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const c = p.getBoundingClientRect();
    if (c.width <= 0 && c.height <= 0) continue;
    const next = cut(c);
    if (next.right - next.left < 4 || next.bottom - next.top < 4) {
      box = { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
      break;
    }
    box = next;
  }
  box = cut({ left: 0, top: 0, right: view.innerWidth || box.right, bottom: view.innerHeight || box.bottom });
  return { left: box.left, top: box.top, width: Math.max(0, box.right - box.left), height: Math.max(0, box.bottom - box.top) };
}

const boxOf = visibleBox;

function measure(step: QnetStep | null, world: World): Measured {
  const el = step && world.active ? step.target(world, find) : null;
  const doc = el?.ownerDocument ?? document;
  const box = boxOf(el);
  const other = el && box && step?.anchor ? step.anchor(world, find) : null;
  const anchor = other && other.ownerDocument === doc && boxOf(other) ? other : el;
  const near = el && box && step?.anchor && step.beside ? step.beside(world, find) : null;
  const besideEl = near && near.ownerDocument === doc && boxOf(near) ? near : null;
  const boxes = (selector: string) => [...doc.querySelectorAll(selector)].map(boxOf).filter((b): b is Box => !!b && b.width > 0 && b.height > 0);
  const avoid = besideEl ? boxes(IN_THE_WAY) : !step && tour.state.phase === "finished" ? boxes(RESULTS_HEADER) : [];
  return { el, doc, box, anchor, anchorBox: anchor === el ? box : boxOf(anchor), besideEl, besideBox: boxOf(besideEl), avoid, soft: besideEl ? boxes(EMPTY_HINT) : [], viewport: viewportOf(doc) };
}

/** On the canvas: the nodes drawn so far, and the empty canvas's hint with its two buttons. */
const IN_THE_WAY = '[data-pane="canvas"] [data-node]';
const EMPTY_HINT = '[data-pane="canvas"] .canvas-empty';
/** The Results pane's header and view switcher, which the last card sends the reader to. */
const RESULTS_HEADER = '[data-pane="results"] .pane-header, [data-pane="results"] [role="tablist"], [data-pane="results"] .results-header';

const sameBoxes = (a: Box[], b: Box[]) => a.length === b.length && a.every((x, i) => sameBox(x, b[i]));
const sameMeasure = (a: Measured, b: Measured) => a.el === b.el && a.doc === b.doc && a.anchor === b.anchor && a.besideEl === b.besideEl && sameBox(a.box, b.box) && sameBox(a.anchorBox, b.anchorBox) && sameBox(a.besideBox, b.besideBox) && sameBoxes(a.avoid, b.avoid) && sameBoxes(a.soft, b.soft) && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height;

const isField = (t: EventTarget | null) => t instanceof Element && !!t.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");

function tourCommands(): Command[] {
  const running = (): true | string => (tour.state.phase === "running" ? true : w.ended);
  const g = "Help";
  return [
    { id: "tour:start", title: w.menuTitle, group: g, subtitle: w.commandSubtitle, icon: GraduationCap, keywords: ["tutorial", "walkthrough", "first model", "learn", "getting started"], run: () => startTour() },
    { id: "tour:show-me", title: `${w.menuTitle}: ${w.showMe}`, group: g, subtitle: w.showMeHelp, when: running, run: () => tour.showMe() },
    { id: "tour:next", title: `${w.menuTitle}: ${w.next}`, group: g, subtitle: w.skipHelp, when: running, run: () => tour.next() },
    { id: "tour:back", title: `${w.menuTitle}: ${w.back}`, group: g, subtitle: w.backHelp, when: running, run: () => tour.back() },
    { id: "tour:end", title: w.end, group: g, subtitle: w.endHelp, when: () => (tour.state.phase === "idle" ? w.ended : true), run: () => endTour() },
    {
      id: "tour:focus",
      title: w.focus,
      group: g,
      subtitle: w.focusHelp,
      when: () => (tour.state.phase === "idle" ? w.ended : true),
      run: () => {
        for (const d of documents()) d.querySelector<HTMLElement>(".tour-callout")?.focus();
      },
    },
  ];
}

/** Mounted once by App.tsx. Registers the tour's commands and draws the tour while it runs. */
export function TourHost() {
  useCommands(tourCommands(), []);
  const state = useTour();
  return state.phase === "idle" ? null : <TourView />;
}

function TourView() {
  const state = useTour();
  const tabId = tourTabId();
  // Everything a condition reads re-renders this: the tabs and documents, the tour tab's editor
  // (tool, selection, a link in progress), its records, and the run slot.
  useWorkspace((ws) => ws);
  const records = useResults(tabId ?? "");
  useLiveRuns();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const open = !!tabId && tourWorld().open;
  useEffect(() => (open && tabId ? editorFor(tabId).subscribe(tick) : undefined), [open, tabId]);
  const fingerprint = useCurrentFingerprint(open ? tourWorld().doc : null, records);

  setTourFingerprint(fingerprint);
  const world = tourWorld();
  const step = state.phase === "running" ? (tour.steps[state.index] as QnetStep) : null;

  // The app changed: has the step been done? A closed tab ends the tour.
  useEffect(() => {
    if (!world.open) endTour();
    else tour.observe();
  });

  // ── Where the callout points ───────────────────────────────────────────────────────────────
  const [at, setAt] = useState<Measured>(() => measure(step, world));
  const remeasure = useCallback(() => {
    const s = tour.state.phase === "running" ? (tour.steps[tour.state.index] as QnetStep) : null;
    const next = measure(s, tourWorld());
    setAt((prev) => (sameMeasure(prev, next) ? prev : next));
  }, []);
  useLayoutEffect(remeasure);
  useEffect(() => {
    const timer = setInterval(remeasure, 200);
    return () => clearInterval(timer);
  }, [remeasure]);
  useEffect(() => {
    const wins = [...new Set([window, at.doc.defaultView ?? window])];
    for (const win of wins) {
      win.addEventListener("resize", remeasure);
      win.addEventListener("scroll", remeasure, true);
    }
    return () => {
      for (const win of wins) {
        win.removeEventListener("resize", remeasure);
        win.removeEventListener("scroll", remeasure, true);
      }
    };
  }, [at.doc, remeasure]);
  // A control scrolled out of sight inside its pane comes into view once, when it becomes the target.
  useEffect(() => {
    const r = at.el?.getBoundingClientRect();
    if (at.el && r && at.box && !sameBox(at.box, { left: r.left, top: r.top, width: r.width, height: r.height })) at.el.scrollIntoView?.({ block: "center", inline: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at.el]);

  const card = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 340, height: 190 });
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const next = { width: el.offsetWidth || 340, height: el.offsetHeight || 190 };
    if (next.width !== size.width || next.height !== size.height) setSize(next);
  });
  // Inside the canvas and as near the step's tool as that allows (steps 1–4); in a free corner of
  // the window with no target (the last card); beside the target otherwise.
  const near = at.besideBox && at.anchorBox && at.anchor?.getAttribute("data-pane") === "canvas";
  const placed: Placement = near
    ? placeNear(at.besideBox!, at.anchorBox!, size, at.viewport, at.avoid, at.soft)
    : !at.anchorBox
      ? placeCorner(size, at.viewport, at.avoid)
      : placeCallout(at.anchorBox, size, at.viewport, at.anchor ? preferredSide(at.anchor) : "bottom");
  // The pointer is for the thing ringed: none when the callout stands by something else.
  const placement: Placement = (near ? at.besideEl === at.el : at.anchor === at.el) ? placed : { ...placed, arrow: null };
  // Drawn inside the edge of a target the callout sits in (the canvas); round anything else.
  const within = placement.side === "inside" && (!near || at.el === at.anchor);
  const ring = at.box ? ringBox(at.box, at.viewport, within ? -3 : 4) : null;

  // ── Words, and reading them out ────────────────────────────────────────────────────────────
  const total = tour.steps.length;
  const words = step ? describe(step.id, world, !!at.el) : null;
  const elsewhere = !world.active;
  const spoken =
    state.phase === "finished"
      ? `${w.finish.title}. ${verdictWords(world)} ${w.finish.meaning}`
      : elsewhere
        ? `${w.elsewhereTitle}. ${w.elsewhere}`
        : words
          ? `${w.announce(state.index + 1, total, words.title, words.text)}${words.note ? ` ${words.note}` : ""}`
          : "";
  useEffect(() => {
    if (spoken) announce(spoken);
  }, [spoken]);

  // ── The keyboard ───────────────────────────────────────────────────────────────────────────
  // The callout takes the keyboard when the tour starts, and keeps it when it moves to another window.
  const hadFocus = useRef(true);
  useLayoutEffect(() => {
    if (hadFocus.current) card.current?.focus({ preventScroll: true });
    hadFocus.current = false;
  }, [at.doc]);
  useEffect(() => {
    const docs = [...new Set([document, at.doc])];
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return;
      const inside = e.target instanceof Node && !!card.current?.contains(e.target);
      if (!inside) {
        // Elsewhere, Escape is first of all the app's: a dialog or a menu to close, a field to leave,
        // a link being drawn, a tool to put down, a selection to drop. Only an idle Escape ends the tour.
        const id = tourTabId();
        const editor = id && tourWorld().open ? editorFor(id) : null;
        const doc = e.target instanceof Node ? (e.target.ownerDocument ?? document) : document;
        if (e.defaultPrevented || modalOpen() || isField(e.target) || doc.querySelector("[role='menu'], [role='dialog'], [role='alertdialog']")) return;
        if (editor && (editor.view.tool !== "select" || editor.view.pendingLinkStartID !== null || editor.view.isDraggingNode || editor.hasAnySelection)) return;
      }
      e.preventDefault();
      e.stopPropagation();
      endTour();
    };
    // In the capture phase: the canvas answers Escape itself, and would leave nothing to hear.
    for (const d of docs) d.addEventListener("keydown", onKey, true);
    return () => {
      for (const d of docs) d.removeEventListener("keydown", onKey, true);
    };
  }, [at.doc]);
  // Leaving this window for another keeps the keyboard in the callout if it was there.
  const noteFocus = () => {
    hadFocus.current = !!card.current?.contains(card.current.ownerDocument.activeElement);
  };

  const finishWith = (command?: string) => {
    endTour();
    if (command) void runCommand(command);
  };

  const stepDone = !!step && step.done(world);
  const head = (
    <div className="tour-head">
      {state.phase === "running" ? (
        <>
          <span className="tour-progress" aria-label={w.progressA11y(state.index + 1, total)}>
            {w.progress(state.index + 1, total)}
          </span>
          <span className="tour-track" aria-hidden>
            {tour.steps.map((s, i) => (
              <span key={s.id} data-state={i < state.index ? "past" : i === state.index ? "now" : "next"} />
            ))}
          </span>
        </>
      ) : (
        <span className="spacer" />
      )}
      <button type="button" className="icon-btn" aria-label={w.end} title={w.endHelp} onClick={() => endTour()}>
        <Icon icon={X} size={12} />
      </button>
    </div>
  );

  let body;
  if (state.phase === "finished") {
    const next: [string, string, string][] = [
      ["run:what-if-sweep", w.finish.sweep, w.finish.sweepHelp],
      ["file:open-example", w.finish.example, w.finish.exampleHelp],
      ["run:choose-method", w.finish.chooser, w.finish.chooserHelp],
    ];
    body = (
      <>
        <h2 className="tour-title" id="tour-title">
          {w.finish.title}
        </h2>
        <p className="tour-text">{verdictWords(world)}</p>
        <p className="tour-note">{w.finish.meaning}</p>
        <h3 className="tour-subhead">{w.finish.nextHeading}</h3>
        <ul className="tour-next">
          {next.map(([id, title, help]) => (
            <li key={id}>
              <button type="button" data-next={id} onClick={() => finishWith(id)}>
                <strong>{title}</strong>
                <small>{help}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="tour-actions">
          <button type="button" className="btn" title={w.backHelp} onClick={() => tour.back()}>
            {w.back}
          </button>
          <span className="spacer" />
          <button type="button" className="btn primary" title={w.finish.closeHelp} onClick={() => finishWith()}>
            {w.finish.close}
          </button>
        </div>
      </>
    );
  } else if (elsewhere) {
    body = (
      <>
        <h2 className="tour-title" id="tour-title">
          {w.elsewhereTitle}
        </h2>
        <p className="tour-text">{w.elsewhere}</p>
        <div className="tour-actions">
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={() => tabId && selectTab(tabId)}>
            {w.returnToTab}
          </button>
        </div>
      </>
    );
  } else if (step && words) {
    // After Back onto a step already done, and on a step to read, the way on is Next.
    const waits = step.manual ? stepDone : stepDone && !state.armed;
    const showMe = (
      <button type="button" className={`btn${waits ? "" : " primary"}`} title={w.showMeHelp} disabled={state.working || (waits && !step.manual)} data-tour-action="show-me" onClick={() => void tour.showMe()}>
        {state.working ? w.working : w.showMe}
      </button>
    );
    body = (
      <>
        <h2 className="tour-title" id="tour-title">
          {words.title}
        </h2>
        <p className="tour-text">{words.text}</p>
        {words.note || (waits && !step.manual) ? <p className="tour-note">{waits && !step.manual ? w.stepDone : words.note}</p> : null}
        <div className="tour-actions">
          <button type="button" className="btn" title={w.backHelp} disabled={state.index === 0 || state.working} data-tour-action="back" onClick={() => tour.back()}>
            {w.back}
          </button>
          <span className="spacer" />
          {waits ? showMe : null}
          <button type="button" className={`btn${waits ? " primary" : ""}`} title={waits ? w.nextHelp : w.skipHelp} disabled={state.working} data-tour-action="next" onClick={() => tour.next()}>
            {waits ? w.next : w.skip}
          </button>
          {waits ? null : showMe}
        </div>
      </>
    );
  }

  return createPortal(
    <>
      {ring && !elsewhere && state.phase === "running" ? <div className="tour-ring" data-tour-ring style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }} aria-hidden /> : null}
      <div
        ref={card}
        className="tour-callout"
        role="region"
        aria-label={w.label}
        aria-describedby="tour-title"
        tabIndex={-1}
        data-side={placement.side}
        data-step={step?.id ?? state.phase}
        style={{ left: placement.left, top: placement.top }}
        onBlur={noteFocus}
        onFocus={noteFocus}
      >
        {placement.arrow !== null ? <span className="tour-arrow" aria-hidden style={placement.side === "bottom" || placement.side === "top" ? { left: placement.arrow } : { top: placement.arrow }} /> : null}
        {head}
        {body}
      </div>
    </>,
    at.doc.body,
  );
}
