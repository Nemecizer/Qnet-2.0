// The canvas in animation mode (new in 2.1, ROADMAP Phase E): a 2D canvas over the drawing, on
// which one random run of the network is played — customers as tokens arriving, queueing, being
// served and moving on — and a control bar under it.
//
// A sibling of the drawing surface, as the problems layer is: nothing here can reach an exported
// diagram (the export renders SceneLayers alone), nothing is written to the document, and no run
// record is made. The frames are driven by `requestAnimationFrame` of the window that owns the
// canvas, stop while that window is hidden or nothing moves, and are cancelled on the way out.
//
// Editing while animating: the drawing stays editable. Moving a node moves the animation with
// it; a change to the network's structure (a node, a link, a rate, the buffers) starts the run
// again from time 0 with the same seed, and the bar says so.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Editor } from "../editor/editor";
import type { BnetDocument } from "../lib/bnet";
import type { CanvasScene } from "../canvas/geometry/scene";
import { liveKey } from "../live/store";
import { AnimateBar } from "./AnimateBar";
import { useAnimateCommands } from "./commands";
import { AnimationEngine, newSeed } from "./engine";
import { readPalette, Stage, STEP_MS, type Pen } from "./render";
import { registerEngine, useAnimateOn } from "./store";
import { animateWords as w } from "./words";
import "./animate.css";

/** Reduce Motion for the window an element is in: Qnet's own setting on <html>, else the system's. */
export function reducedMotionIn(doc: Document): boolean {
  const m = doc.documentElement.getAttribute("data-motion");
  if (m) return m === "reduce";
  try {
    return doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function penOf(canvas: HTMLCanvasElement): Pen | null {
  try {
    return (canvas.getContext("2d") as Pen | null) ?? null;
  } catch {
    return null;
  }
}

interface Props {
  editor: Editor;
  scene: CanvasScene;
  document: BnetDocument | undefined;
}

/** Mounted with the canvas; draws nothing until the tab is put in animation mode. */
export function AnimateLayer(props: Props) {
  useAnimateCommands();
  const on = useAnimateOn(props.editor.tabId);
  return on ? <Running {...props} /> : null;
}

function Running({ editor, scene, document }: Props) {
  const tabId = editor.tabId;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<AnimationEngine | null>(null);
  const [stage] = useState(() => new Stage());
  const [seed, setSeed] = useState(() => newSeed());
  /** Bumped by Restart: the same seed again. */
  const [again, setAgain] = useState(0);
  const [restarted, setRestarted] = useState(false);
  const [reduced, setReduced] = useState(false);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const repaint = useRef<() => void>(() => {});

  // The run: one engine while the layer is mounted, ended (and freed in Rust) on the way out.
  useEffect(() => {
    const e = new AnimationEngine();
    setEngine(e);
    const off = registerEngine(tabId, e);
    return () => {
      off();
      e.dispose();
    };
  }, [tabId]);

  // Started for the network as it is; started again when its structure changes.
  const key = liveKey(document);
  const started = useRef<{ key: string | null; engine: AnimationEngine | null }>({ key: null, engine: null });
  useEffect(() => {
    if (!engine || !document) return;
    const first = started.current.engine !== engine;
    const changed = !first && started.current.key !== key;
    started.current = { key, engine };
    setRestarted(changed);
    stage.reset();
    void engine.start(document, seed, { play: true });
    // `document` is read when the structure key, the seed or the restart count changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, key, seed, again, stage]);

  useSyncExternalStore(engine?.subscribe ?? noSubscribe, () => engine?.version ?? 0);

  // The frames.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !engine) return;
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    let raf = 0;
    let lastStep = -Infinity;
    let palette = readPalette(el);
    let paletteAt = -Infinity;

    let lastPaint = -Infinity;
    const paint = (now: number) => {
      lastPaint = win.performance.now();
      const pen = penOf(el);
      const state = engine.state;
      const sc = sceneRef.current;
      const size = sc.transform.viewportSize;
      if (!pen) return;
      const dpr = win.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(size.width * dpr));
      const height = Math.max(1, Math.round(size.height * dpr));
      if (el.width !== width || el.height !== height) {
        el.width = width;
        el.height = height;
      }
      if (now - paletteAt > 1000) {
        palette = readPalette(el);
        paletteAt = now;
      }
      pen.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!state || engine.phase !== "running") {
        pen.clearRect(0, 0, size.width, size.height);
        return;
      }
      const counts = stage.draw(pen, state, sc, palette, now, size);
      el.dataset.tokens = String(counts.resting + counts.moving);
      el.dataset.moving = String(counts.moving);
    };

    const frame = (now: number) => {
      raf = 0;
      engine.frame(now);
      const still = reducedMotionIn(doc);
      if (still !== stage.reduced) {
        stage.reduced = still;
        stage.reset();
        setReduced(still);
      }
      if (engine.state) stage.pickUp(engine.state, now, engine.clock.speed);
      if (!still || now - lastStep >= STEP_MS) {
        lastStep = now;
        paint(now);
      }
      if (!raf && !doc.hidden && (engine.playing || stage.busy)) raf = win.requestAnimationFrame(frame);
    };
    const wake = () => {
      if (!raf && !doc.hidden) raf = win.requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      if (doc.hidden) {
        if (raf) win.cancelAnimationFrame(raf);
        raf = 0;
        engine.rest();
      } else wake();
    };
    repaint.current = () => {
      lastStep = -Infinity;
      paint(win.performance.now());
    };
    stage.reduced = reducedMotionIn(doc);
    setReduced(stage.reduced);
    doc.addEventListener("visibilitychange", onVisibility);
    const off = engine.subscribe(() => {
      // A start, a skip or a pause changes the picture even when no frame is due, or when the
      // window's frames are held back (a window in the background).
      if (!engine.playing || win.performance.now() - lastPaint > 2 * STEP_MS) repaint.current();
      wake();
    });
    wake();
    return () => {
      off();
      doc.removeEventListener("visibilitychange", onVisibility);
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;
      repaint.current = () => {};
    };
  }, [engine, stage]);

  // A pan, a zoom or a dragged node redraws the picture, also while paused.
  useLayoutEffect(() => repaint.current(), [scene]);

  return (
    <div className="animate-layer" data-animate={engine?.phase ?? "starting"} data-reduced={reduced || undefined}>
      <canvas ref={canvas} className="animate-canvas" aria-hidden="true" data-label={w.canvasLabel} />
      {engine && (
        <AnimateBar
          editor={editor}
          engine={engine}
          reduced={reduced}
          restarted={restarted}
          onRestart={() => {
            setRestarted(false);
            setAgain((n) => n + 1);
          }}
          onNewRun={() => {
            setRestarted(false);
            setSeed(newSeed());
          }}
        />
      )}
    </div>
  );
}

const noSubscribe = () => () => {};
