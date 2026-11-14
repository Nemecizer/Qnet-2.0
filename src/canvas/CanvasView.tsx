// The canvas itself (0.90.34 NetworkCanvasScrollContainer + NetworkCanvasView + CanvasContentView,
// canvas.md §12–§17): it measures itself for the editor, keeps the scene memoised (SceneCache:
// rebuilt only when the nodes, links, transform, class filter or route plan change), eases a
// route-plan change over 150 ms and a programmatic zoom over 0.20 s (nothing under Reduce
// Motion; wheel and pinch track 1:1), feeds every pointer, wheel, pinch and key event to the
// gesture controller (src/canvas/interaction/controller.ts), owns the cursor, shows the context
// menus and the legacy scrollers, and hands the frame's scene to the drawing area's layers.
//
// One canvas per tab: the pane renders this keyed on the tab, so a tab switch rebinds everything
// (editor, gesture memo, camera) to the new tab's editor (ledger CAN-222).
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useEditorView, type Editor } from "../editor";
import { focusedTextField } from "../editor/commands";
import { modalOpen } from "../lib/overlays";
import { useWorkspace } from "../workspace/store";
import { PopupMenu } from "../workspace/panes/PopupMenu";
import { buildScene, interpolatePlans, plansEqual, type CanvasScene, type LinkRoutePlan } from "./geometry/scene";
import { chromeInsets, NO_INSETS, type CanvasTransform } from "./geometry/transform";
import { canvasMenu, linkMenu, menuPresenter, nodeMenu, popupNative, toPopupItems, type MenuEntry } from "./interaction/contextMenu";
import { CanvasController, type PointerInput } from "./interaction/controller";
import { cursorFor } from "./interaction/cursor";
import { scrollMetrics } from "./interaction/metrics";
import { CameraMotion, easeInOut, motionClock, PLAN_EASE_MS, reduceMotion } from "./interaction/motion";
import { linkPreview } from "./interaction/preview";
import { Scroller } from "./interaction/Scrollers";
import { placedNodeKind, toolForKey } from "./interaction/tools";
import { interactionWords as w } from "./interaction/words";
import { CanvasOverlays, SceneLayers, useSceneColors, type SceneTransient } from "./interaction/layers";
import type { BnetLink, BnetNode } from "../lib/bnet";
import { useStationUtilisation } from "../panes/status/analysis";
import { ResultsLegend } from "./overlay/ResultsLegend";
import { useResultsOverlay } from "./overlay/useResultsOverlay";
import { ProblemsLayer } from "./validation/ProblemsLayer";
import { AnimateLayer, animateKey, useAnimateOn } from "../animate";
import { shortcutFor } from "../lib/menu";
import { CanvasOutline, CanvasSpeech, OUTLINE_COMMAND, outlineWords } from "./outline";
import "./interaction/interaction.css";

const NO_NODES: readonly BnetNode[] = [];
/** The floating chrome a fit keeps clear of: the results legend chip (overlay.css) at the top, the animation's control bar (animate.css) at the bottom. */
const FIT_CHROME = { top: ".canvas-results-legend", bottom: ".animate-bar" };
const NO_LINKS: readonly BnetLink[] = [];

interface PlanEase {
  to: LinkRoutePlan | null;
  from: LinkRoutePlan | null;
  /** The plan last drawn (mid-ease, the blend), where a new ease starts from. */
  shown: LinkRoutePlan | null;
  startedAt: number;
}

export function CanvasView({ editor }: { editor: Editor }) {
  const view = useEditorView(editor);
  const doc = useWorkspace((ws) => ws.tabs.find((t) => t.id === editor.tabId)?.document);
  const nodes = doc?.nodes ?? NO_NODES;
  const links = doc?.links ?? NO_LINKS;
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => ({ ...editor.view.viewportSize }));
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const sceneRef = useRef<CanvasScene | null>(null);
  const ctrl = useMemo(() => new CanvasController(editor, () => sceneRef.current ?? editor.makeScene(), redraw), [editor]);
  // A gesture still in flight when the canvas goes away is ended, not left holding a mutation open.
  useEffect(() => () => ctrl.dispose(), [ctrl]);
  const [webMenu, setWebMenu] = useState<{ items: MenuEntry[]; x: number; y: number; label: string } | null>(null);
  const colors = useSceneColors();
  const utilisation = useStationUtilisation(editor.tabId);
  const overlay = useResultsOverlay(editor.tabId, doc, view.isDraggingNode);
  // Animation mode (src/animate): the run takes the canvas, so results, ρ badges and problem marks step aside.
  const animateMode = useAnimateOn(editor.tabId);

  // ── Size ──────────────────────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = surface.current;
    if (!el) return;
    const report = (width: number, height: number) => {
      if (!(width >= 0 && height >= 0)) return;
      editor.setViewportSize({ width, height });
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) report(r.width, r.height);
    const ro = new ResizeObserver((entries) => {
      const c = entries[entries.length - 1]?.contentRect;
      if (c) report(c.width, c.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [editor]);

  // What a fit keeps clear of (gap FIX-106): the results legend hanging from the top edge and the
  // animation's control bar standing on the bottom one, measured when the fit is asked for.
  useEffect(() => {
    const measure = () => {
      const el = surface.current;
      const clip = el?.parentElement;
      if (!el || !clip) return NO_INSETS;
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      };
      const all = (selector: string) => [...clip.querySelectorAll(selector)].map(box);
      return chromeInsets(box(el), all(FIT_CHROME.top), all(FIT_CHROME.bottom));
    };
    editor.fitInsets = measure;
    return () => {
      if (editor.fitInsets === measure) editor.fitInsets = null;
    };
  }, [editor]);

  // A one-shot fit a bulk insert asked for, once the viewport is known (`consumePendingFit`).
  useEffect(() => {
    if (!view.pendingFitOnAppear || !(size.width > 1)) return;
    editor.setView({ pendingFitOnAppear: false });
    editor.zoomToFit();
  }, [editor, view.pendingFitOnAppear, size.width]);

  useEffect(() => ctrl.syncWithView(), [ctrl, view.pendingLinkStartID, view.tool]);

  // ── The camera (glides on the token) and the scene (memoised; plan changes ease) ───────────
  const camera = useRef<CameraMotion | null>(null);
  if (!camera.current) camera.current = new CameraMotion({ scale: view.canvasScale, panX: view.canvasPanOffset.width, panY: view.canvasPanOffset.height }, view.canvasAnimationToken);
  const cam = camera.current.frame({ scale: view.canvasScale, panX: view.canvasPanOffset.width, panY: view.canvasPanOffset.height }, view.canvasAnimationToken);
  const transform: CanvasTransform = useMemo(
    () => ({ scale: cam.scale, pan: { width: cam.panX, height: cam.panY }, viewportSize: size }),
    [cam.scale, cam.panX, cam.panY, size],
  );
  const plan = editor.routePlan;
  const scene = useMemo(() => buildScene({ nodes, links, transform, classFilter: view.classFilter, routePlan: plan }), [nodes, links, transform, view.classFilter, plan]);
  const ease = useRef<PlanEase>({ to: null, from: null, shown: null, startedAt: 0 });
  const e = ease.current;
  if (e.to !== plan) {
    if (e.to && !plansEqual(e.to, plan) && !reduceMotion()) {
      e.from = e.shown ?? e.to;
      e.startedAt = motionClock.now();
    } else e.from = null;
    e.to = plan;
  }
  let frame = scene;
  if (e.from) {
    const t = (motionClock.now() - e.startedAt) / PLAN_EASE_MS;
    if (t >= 1) e.from = null;
    else {
      const blended = interpolatePlans(e.from, plan, easeInOut(t));
      e.shown = blended;
      frame = buildScene({ nodes, links, transform, classFilter: view.classFilter, routePlan: blended });
    }
  }
  if (!e.from) e.shown = plan;
  sceneRef.current = frame;
  const animating = camera.current.animating || e.from !== null;
  useEffect(() => {
    if (!animating || typeof requestAnimationFrame === "undefined") return;
    const id = requestAnimationFrame(() => redraw());
    return () => cancelAnimationFrame(id);
  });

  // ── Transient bits the drawing shows ────────────────────────────────────────────────────────
  const startID = ctrl.linkStartID;
  const startNode = view.tool === "addLink" && startID ? frame.nodeIndex.get(startID) : undefined;
  let preview = null;
  if (startNode && view.pendingLinkPoint) {
    const target = view.hoveredNodeID && view.hoveredNodeID !== startNode.id ? frame.nodeIndex.get(view.hoveredNodeID) ?? null : null;
    preview = linkPreview({ start: startNode, pointer: view.pendingLinkPoint, target, loopsBack: ctrl.pointerOverLinkStart && startNode.kind === "station", links, transform });
  }
  const ghostKind = placedNodeKind(view.tool);
  const transient: SceneTransient = {
    linkPreview: preview?.geometry ?? null,
    linkPreviewHasArrow: preview?.hasArrow ?? false,
    linkStartID: view.tool === "addLink" ? startID : null,
    ghost: ghostKind && ctrl.ghost && !view.isSpacePanning ? { kind: ghostKind, world: ctrl.ghost } : null,
    marqueeLive: view.multiSelectRect !== null,
  };

  // ── Events ──────────────────────────────────────────────────────────────────────────────────
  const local = useCallback((ev: { clientX: number; clientY: number; shiftKey: boolean; metaKey: boolean; altKey: boolean; ctrlKey: boolean }): PointerInput => {
    const r = surface.current?.getBoundingClientRect();
    return { x: ev.clientX - (r?.left ?? 0), y: ev.clientY - (r?.top ?? 0), shift: ev.shiftKey, meta: ev.metaKey, alt: ev.altKey, ctrl: ev.ctrlKey };
  }, []);

  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button === 1) {
      ev.preventDefault();
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
      ctrl.middleDown(local(ev));
      return;
    }
    if (ev.button !== 0) return;
    // A canvas gesture takes the keyboard from a text field, or ⌘Z keeps going to it (§12.6),
    // and the canvas takes it so Delete, the arrows and Space work from the first click.
    focusedTextField()?.blur();
    surface.current?.focus({ preventScroll: true });
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    ctrl.pointerDown(local(ev));
  };

  const onContextMenu = (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const p = local(ev);
    const target = ctrl.contextTarget(p);
    let items: MenuEntry[];
    let label: string = w.canvasMenu;
    if (target.kind === "node") {
      const n = editor.node(target.id)!;
      items = nodeMenu(editor, n);
      label = w.nodeMenu(n.name);
    } else if (target.kind === "link") {
      items = linkMenu(editor, editor.link(target.id)!);
      label = w.linkMenu;
    } else items = canvasMenu(editor);
    if (menuPresenter.native) void popupNative(items, ev.clientX, ev.clientY).catch(() => setWebMenu({ items, x: ev.clientX, y: ev.clientY, label }));
    else setWebMenu({ items, x: ev.clientX, y: ev.clientY, label });
  };

  // Wheel and pinch need non-passive listeners to keep the page from scrolling or zooming.
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const p = local(ev);
      ctrl.wheel({ x: p.x, y: p.y, deltaX: ev.deltaX, deltaY: ev.deltaY, deltaMode: ev.deltaMode, alt: ev.altKey, meta: ev.metaKey, ctrl: ev.ctrlKey });
    };
    // WebKit's trackpad pinch: GestureEvent, `scale` cumulative from gesturestart.
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (ev: Event) => {
      ev.preventDefault();
      ctrl.pinchStart();
    };
    const onGestureChange = (ev: Event) => {
      ev.preventDefault();
      const g = ev as Gesture;
      const r = el.getBoundingClientRect();
      ctrl.pinchChange(g.scale, { x: g.clientX - r.left, y: g.clientY - r.top });
    };
    const onGestureEnd = (ev: Event) => {
      ev.preventDefault();
      ctrl.pinchEnd();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [ctrl, local]);

  // Escape mid-drag, seen before anything else hears the key (the local monitor of §12.3), and
  // ⌥ / ⌃ anywhere in the window (`flagsChanged`: the copy cursor, ⌃ live mid-drag).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && ctrl.dragIsCancellable && ctrl.cancelDragInFlight()) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.key === "Alt" || ev.key === "Control") ctrl.modifiersChanged(ev.type === "keydown" ? ev.altKey || ev.key === "Alt" : ev.altKey && ev.key !== "Alt", ev.type === "keydown" ? ev.ctrlKey || ev.key === "Control" : ev.ctrlKey && ev.key !== "Control");
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [ctrl]);

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (ev.defaultPrevented || ev.nativeEvent.isComposing || ev.key === "Alt" || ev.key === "Control") return;
    // Space plays or pauses the animation while it is on (src/animate), instead of starting a pan.
    if (animateKey(editor.tabId, ev)) return;
    // A dialog over the canvas keeps the tool letters and Delete (ledger CAN-216).
    if (modalOpen() && (toolForKey(ev.key) || ev.key === "Backspace" || ev.key === "Delete")) return;
    if (ctrl.keyDown({ key: ev.key, shift: ev.shiftKey, meta: ev.metaKey, ctrl: ev.ctrlKey, alt: ev.altKey, repeat: ev.repeat })) ev.preventDefault();
  };

  const onKeyUp = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (ev.key === "Alt" || ev.key === "Control") return;
    if (ctrl.keyUp({ key: ev.key })) ev.preventDefault();
  };

  const metrics = scrollMetrics(nodes, { scale: view.canvasScale, pan: view.canvasPanOffset, viewportSize: size });
  const cursor = cursorFor(view, ctrl.optionHeld);

  return (
    <div className="canvas-view" data-tab={editor.tabId}>
      <div className="canvas-clip" data-animating={animateMode || undefined}>
        <div
          ref={surface}
          className="canvas-surface canvas-placeholder"
          tabIndex={0}
          data-focus-default
          role="application"
          aria-label={w.canvasLabel}
          aria-description={outlineWords.canvasHelp(shortcutFor(OUTLINE_COMMAND) ?? outlineWords.menuTitle)}
          data-cursor={cursor}
          data-camera={`${cam.scale} ${cam.panX} ${cam.panY}`}
          data-easing={[camera.current.animating && "camera", e.from && "routes"].filter(Boolean).join(" ") || undefined}
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={(ev) => ctrl.pointerMove(local(ev))}
          onPointerUp={(ev) => ctrl.pointerUp(local(ev))}
          onPointerCancel={() => ctrl.pointerCancel()}
          onLostPointerCapture={() => ctrl.pointerCancel()}
          onPointerLeave={() => ctrl.hoverEnded()}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => ctrl.blur()}
        >
          <SceneLayers
            scene={frame}
            view={view}
            colors={colors}
            transient={transient}
            infiniteBuffers={doc?.infiniteBuffers ?? false}
            utilisation={animateMode ? undefined : utilisation}
            results={animateMode ? null : overlay.results}
            linkDescription={(l) => editor.linkDescription(l)}
            onNodePress={(id) => editor.handleNodeTap(id)}
            onLinkPress={(id) => editor.handleLinkTap(id)}
          />
        </div>
        <ProblemsLayer editor={editor} scene={frame} document={doc} utilisation={utilisation} />
        <CanvasOverlays editor={editor} />
        <ResultsLegend tabId={editor.tabId} overlay={overlay} />
        <AnimateLayer editor={editor} scene={frame} document={doc} />
        <CanvasSpeech editor={editor} results={animateMode ? null : overlay.results} utilisation={utilisation} surface={surface} />
        <CanvasOutline editor={editor} document={doc} results={animateMode ? null : overlay.results} utilisation={utilisation} surface={surface} />
      </div>
      <Scroller axis="v" metrics={metrics} editor={editor} />
      <Scroller axis="h" metrics={metrics} editor={editor} />
      <div className="canvas-scroller-corner" />
      {webMenu && (
        <PopupMenu
          items={toPopupItems(webMenu.items)}
          anchor={new DOMRect(webMenu.x, webMenu.y - 2, 0, 0)}
          label={webMenu.label}
          onClose={(chosen) => {
            setWebMenu(null);
            surface.current?.focus({ preventScroll: true });
            chosen?.();
          }}
        />
      )}
    </div>
  );
}
