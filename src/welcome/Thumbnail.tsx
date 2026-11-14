// An example's picture: the canvas's own drawing (SceneLayers in its snapshot form, with the
// canvas's routing and colours), fitted into a small frame. Nothing is drawn until the card is
// near the visible part of the list, so fifty examples cost fifty empty boxes to show.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { BnetDocument } from "../lib/bnet";
import { NO_GUIDES } from "../editor";
import { buildRoutePlan, buildScene, sceneContentRect } from "../canvas/geometry/scene";
import { fitting } from "../canvas/geometry/transform";
import { SceneLayers, type SceneView } from "../canvas/layers/SceneLayers";
import { useCanvasColors } from "../canvas/layers/useCanvasColors";

export const THUMB_SIZE = { width: 200, height: 112 } as const;
const THUMB_MARGIN = 6;
/** A thumbnail never magnifies a small network past the canvas's own size. */
const THUMB_ZOOM = { lower: 0.02, upper: 1 } as const;

/** Nothing selected, hovered or in progress. */
const STILL: SceneView = Object.freeze({
  tool: "select",
  selectedNodeID: null,
  selectedNodeIDs: new Set<string>(),
  selectedLinkID: null,
  hoveredNodeID: null,
  hoveredLinkID: null,
  multiSelectRect: null,
  pendingLinkStartID: null,
  activeLinkSourceID: null,
  activeCustomerClass: 0,
  activeAlignGuides: NO_GUIDES,
  isDraggingNode: false,
  isPanningCanvas: false,
  isSpacePanning: false,
});

/** True once `ref`'s element has come within a screen of the scrolling view (at once where that can't be watched). */
function useSeen(ref: React.RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const IO = el.ownerDocument.defaultView?.IntersectionObserver;
    if (!IO) {
      setSeen(true);
      return;
    }
    const io = new IO(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

export const Thumbnail = memo(function Thumbnail({ document }: { document: BnetDocument }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const colors = useCanvasColors();
  const scene = useMemo(() => {
    if (!seen) return null;
    const plan = buildRoutePlan(document.nodes, document.links);
    const content = sceneContentRect(document.nodes, document.links, plan);
    if (!content) return null;
    const transform = fitting(content, THUMB_SIZE, THUMB_MARGIN, THUMB_ZOOM);
    return buildScene({ nodes: document.nodes, links: document.links, transform, classFilter: null, routePlan: plan });
  }, [seen, document]);
  return (
    <div ref={ref} className="qn-welcome-thumb" aria-hidden="true" data-drawn={scene ? true : undefined}>
      {scene && <SceneLayers scene={scene} view={STILL} colors={colors} snapshot grid={false} infiniteBuffers={document.infiniteBuffers} />}
    </div>
  );
});
