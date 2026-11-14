/**
 * The canvas drawing (P5 drawing area): 0.90.34's NetworkCanvasLayers.swift as one pure SVG.
 *
 * ```tsx
 * <SceneLayers
 *   scene={scene}                 // CanvasScene for this frame (geometry/scene.ts buildScene)
 *   view={editor.view}            // SceneView: tool, selectedNodeID, selectedNodeIDs, selectedLinkID,
 *                                 //   hoveredNodeID, hoveredLinkID, multiSelectRect (world), pendingLinkStartID,
 *                                 //   activeLinkSourceID, activeCustomerClass, activeAlignGuides,
 *                                 //   isDraggingNode, isPanningCanvas, isSpacePanning
 *   colors={useCanvasColors()}    // CanvasColors: plain colour strings; canvasColors("light") for an export
 *   transient={{                  // SceneTransient (optional; NO_TRANSIENT when absent)
 *     linkPreview,                //   LinkGeometry | null, display space: the exact geometry release would make
 *     linkPreviewHasArrow,        //   boolean, default true; false for the bare line over empty canvas
 *     linkStartID,                //   string | null, optional: a link DRAG's start node (ring + fill);
 *                                 //   falls back to view.pendingLinkStartID
 *     ghost,                      //   { kind: NodeKind, world: Point } | null: the add tool's ghost (snapped)
 *     marqueeLive,                //   boolean: draw the band and its live highlight (needs view.multiSelectRect)
 *   }}
 *   infiniteBuffers={doc.infiniteBuffers}
 *   utilisation={useStationUtilisation(tabId)}   // optional: station id → ρ (ρ badges)
 *   results={overlay.results}  // optional: the results overlay (../overlay): a run's value beside each station
 *   snapshot={false}              // optional: true = export copy (no hover/selection/marquee/guides/preview/ghost/a11y)
 *   grid={true}                   // optional: draw the dot grid
 *   background={null}             // optional: a colour string painted under everything
 *   linkDescription={(l) => editor.linkDescription(l)}   // optional: VoiceOver label of a link
 *   onNodePress={(id) => …}       // optional: VoiceOver pressed a node (a click with event.detail === 0)
 *   onLinkPress={(id) => editor.handleLinkTap(id)}       // optional: likewise for a link
 *   className="…"                 // optional
 * />
 * ```
 *
 * - One `<svg>` of `scene.transform.viewportSize`, layers bottom to top: background, grid, links
 *   (+ one 1-pt accessibility probe per link, dropped while `isDraggingNode || isPanningCanvas`),
 *   link preview, pending-link ring (Link tool), ghost, nodes (labels, ρ badges), alignment
 *   guides, marquee.
 * - Hit-testing is the scene's (`hitNode` / `hitLink`), never `event.target`. Node groups and ρ
 *   badges take pointer events so their native tooltips (`<title>`) show; every other layer is
 *   `pointer-events: none`. Events bubble to the CanvasView that owns the gestures.
 * - Links and nodes are drawn in groups translated by the pan, so a pure pan re-renders neither.
 * - No effect, no DOM read: `renderToStaticMarkup(<SceneLayers snapshot … colors={canvasColors("light")} />)`
 *   is a standalone SVG with no CSS variables (export.test.tsx).
 * - Fades (hover / selection rings, guides, ρ badge) use the `canvas-fade` / `canvas-appear`
 *   classes in ../canvas.css, which import it; they last --dur-1 and are instant under Reduce Motion.
 */
export { SceneLayers, NO_TRANSIENT, sceneLinkDescription, type SceneLayersProps, type SceneTransient, type SceneView } from "./SceneLayers";
export { canvasColors, canvasToken, classColor, kindFill, OPACITY, type CanvasColors, type CanvasTheme } from "./colors";
export { useCanvasColors, useCanvasColors as useSceneColors, useIncreasedContrast, useReducedMotion } from "./useCanvasColors";
export { KIND_ICONS, TOOL_ICONS, SYMBOLS } from "./icons";
export { nodeDescription, nodeTooltip, rhoBadgeText, rhoTooltip, rhoLevel } from "./labels";
export { measureChipText } from "./LinkLayer";
export { CanvasOverlays, ClassLegend, ZoomCluster, EmptyHint } from "../overlays/CanvasOverlays";
export { CanvasStatusBar, type CanvasStatusBarProps } from "../StatusBar";
