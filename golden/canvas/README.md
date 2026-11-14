# Canvas scenes

What Qnet 0.90.34's canvas draws for each of the 50 shipped examples (`../../examples/`), and for four hand-made networks in `fixtures/`, so the TypeScript scene (P5, `docs/specs/canvas.md`) can be compared with it field by field. Made by `scripts/make-golden-canvas.sh` with `Qnet --golden-canvas <bnet> <out.json>` (`../tools/GoldenCanvas.swift`); never edit a file here by hand. `PROVENANCE.json` names the commit, the toolchain, the changes made to the throwaway copy, and a SHA-256 for every file.

The dump loads the file into a fresh `NetworkEditorModel` with `loadNetwork(document:)` (as File ▸ Open does), sets `canvasViewportSize` to 1200 × 800, runs `refreshStationUtilisation()` once (the debounced recompute the app runs after a load), takes `editor.routePlan` (`LinkRoutePlan.build`, world space), and builds `CanvasScene(nodes:links:transform:classFilter: nil, routePlan:)` for each camera below. Nothing is hovered, selected or pending, and no class filter is set.

## Numbers

Every double is printed with C's `%.17g`, so it parses back to the same IEEE double: compare numerically and exactly, not as text. (`CGFloat` is `Double` on arm64.) Integers print as integers. No value is NaN or infinite in this corpus; if one were, it would be the string `"NaN"`, `"Infinity"` or `"-Infinity"`.

Rects are `{"x", "y", "width", "height"}` (`CGRect.origin` and `.size`; every rect here is standardised). Points and sizes are `[x, y]` / `[width, height]`. Fields that 0.90.34 holds as optionals are `null` when absent.

## `fixtures/`

Inputs in `../tools/canvas-fixtures/`, for geometry no shipped example has (no example has a self-loop, and none needs a solved bow):

| Fixture | What it exercises |
|---|---|
| `selfloops-and-bundles` | Self-loops on a station (three classes, nested by `extraRadius`), on a buffer, a source and a sink (loadable from a file though the Link tool refuses them), two-class bundles, routing chips below 1, class transitions (`toCustomerClass`), and a link to a node that does not exist (drawn by nobody: `visible: false`) |
| `detours-and-pairs` | A column of stations crossed by chords (ladder rungs up to 240), opposite-direction pairs with a two-class bundle (`baseBulge` 24, side locked), a document zoom of 0.8125 and pan of (37.5, −12.25) |
| `dense-grid` | A 4 × 4 grid with chords across it: the ladder's far rungs and both signs |
| `solved-bow` | A chord whose obstacle sits at t ≈ 0.3, so no rung clears and the closed-form solve returns −250 |

## Top level

| Field | Swift |
|---|---|
| `file` | the input's file name |
| `numberFormat` | always `"%.17g"` |
| `viewportSize` | the viewport every view is built for: 1200 × 800 |
| `documentCanvasScale`, `documentCanvasPanOffset` | `NetworkDocument.canvasScale`, `.canvasPanOffset` as decoded (pan defaults to zero; File ▸ Save never writes it) |
| `infiniteBuffers` | `NetworkEditorModel.infiniteBuffers` |
| `nodes`, `links` | below, in document order |
| `routePlanBowedCount` | `LinkRoutePlan.bowedCount` |
| `contentBounds` | `CanvasScene.bounds(of: nodes)`: the bounding box of node CENTRES, what Zoom to Fit frames; `null` for an empty network |
| `zoomToFit.margin` | 88, the display margin `NetworkEditorModel.fit(nodes:)` passes |
| `zoomToFit.scale`, `.pan` | `canvasScale` / `canvasPanOffset` after `NetworkEditorModel.zoomToFit()` with the 1200 × 800 viewport |
| `zoomToFit.fittingScale`, `.fittingPan` | `CanvasTransform.fitting(worldRect: contentBounds, in: viewport, margin: 88, zoomRange: 0.1...4.0)` called directly (equal to the two above) |
| `exportContentRect` | `CanvasImageExport.contentRect(nodes:links:routePlan:)`: every body, every label block and every link polyline point at zoom 1, outset by `DS.Spacing.l`; what the image export draws |
| `exportMargin` | `CanvasImageExport.margin` (`DS.Spacing.xl`) |
| `views` | one per camera, below |

## `nodes[i]` (world space)

| Field | Swift |
|---|---|
| `index` | position in `editor.nodes` |
| `id`, `name`, `kind`, `position` | `NetworkNode.id` (the file's UUID), `.name`, `.kind.rawValue`, `.position` (the node centre) |
| `outlineSize` | `NodeOutline.size(for:)` |
| `boundingRadius` | `NodeOutline.boundingRadius(for:)` |
| `worldRect` | `CanvasScene.nodeWorldRect`: the body, the rect a marquee intersects |
| `labelRect` | `CanvasScene.nodeLabelRect`: the label block under the body, the router's label obstacle |
| `labelBlockHeight` | `NodeOutline.labelBlockHeight(for:)` |
| `detailText` | `NetworkNodeView.detailText`: the label's second row (`b=N`, family name, ` c=N`, `Multi-class`), `null` when the kind has none |
| `rateText` | `NetworkNodeView.rateText`: the third row (`μ=… · SCV=…` or `λ=…`) |
| `utilisation` | `editor.stationUtilisation[id]` (ρ from the traffic equations), `null` when there is no badge |
| `utilisationBadgeText` | the badge's text, `"ρ " + DS.Number.format(ρ, significantDigits: 2)` |

`detailText` and `rateText` are read from a `NetworkNodeView` built with the node and the document's buffer regime; the copy makes these two properties internal (they were `private`) so they can be read, and changes nothing else.

## `links[i]` (route plan, world space)

| Field | Swift |
|---|---|
| `index`, `id` | position in `editor.links`, `NetworkLink.id` |
| `fromIndex`, `toIndex`, `from`, `to` | the end nodes' indices and names (`null` / `"?"` for a missing node) |
| `customerClass`, `toCustomerClass`, `routingProbability` | the link's own fields |
| `isSelfLoop` | `fromNodeID == toNodeID` |
| `bundleIndex`, `bundleCount` | the link's place in `CanvasScene.bundleGroups(links)[PairKey(from, to)]` (all links, sorted by class) and that group's size |
| `offsetWorld` | `(bundleIndex − (bundleCount − 1) / 2) · CanvasScene.bundleSpacing` (8), as `LinkRoutePlan.build` and `CanvasScene.init` compute it; a self-loop ignores it |
| `selfLoopExtraRadiusWorld` | `bundleIndex · bundleSpacing` for a self-loop (the scene multiplies it by the scale), else `null` |
| `hasOpposite`, `lockSide` | the reversed pair exists (always false for a self-loop, which the planner skips) |
| `baseBulge` | `CanvasScene.pairBulge` (24) when `hasOpposite`, else 0 |
| `bulge` | `LinkRoutePlan.bulge(for: id)`: the world-space bow the router chose; 0 = straight |
| `bulgeSide` | the sign of `bulge` (+1 bows to the right of travel, −1 to the left, 0 straight) |
| `bulgeKind` | derived from the value, not stored by 0.90.34: `straight` (0), `base` (equal to `baseBulge`), `ladder` (its magnitude is a rung of `CanvasScene.bulgeLadder` = 14, 24, 48, 96, 160, 240), `solved` (anything else: `solvedBulge`'s closed form, or a `bodyClear`/`best` fallback) |

## `views[k]`

Seven cameras, each `CanvasTransform(scale:, pan:, viewportSize: 1200 × 800)`:

| `name` | scale | pan | covers |
|---|---|---|---|
| `identity` | 1 | (0, 0) | the scene the acceptance test compares: world == display |
| `document` | the file's `canvasScale` | the file's `canvasPanOffset` | what 0.90.34 shows on open |
| `scale0.3` | 0.3 | (40, −25) | below `DS.Canvas.nameRowMinScale` (0.35): no label rows, no chips, the 6 pt arrow floor, the 1 pt line floor, the faded grid |
| `scale0.4` | 0.4 | (−12.5, 33) | names only (detail row needs 0.45) |
| `scale0.5` | 0.5 | (120.5, 60.25) | exactly `DS.Canvas.linkLabelMinScale`: chips on, detail on, rates off (0.6) |
| `scale2` | 2 | (−300, −150.75) | everything on, label block width `76 · min(scale, 1.4)`, font sizes at their caps |
| `zoomToFit` | `zoomToFit.scale` | `zoomToFit.pan` | the fitted camera (absent for an empty network) |

| Field | Swift |
|---|---|
| `name`, `scale`, `pan`, `viewportSize` | the transform |
| `visibleWorldRect` | `CanvasTransform.visibleWorldRect` |
| `grid.cell`, `grid.major` | `gridSpacing · scale` and four times it |
| `grid.minorAlpha`, `grid.majorAlpha` | `GridPath.build(transform:size: viewport, gridSpacing: 28)` |
| `grid.minorDotCount`, `grid.majorLineCount` | the number of subpaths (move-to elements) in its `minorDots` and `majorLines` paths: dots drawn, hairlines drawn (0 when the path is nil) |
| `grid.minorFirstX/Y`, `grid.majorFirstX/Y` | `GridPath.firstLine(offset: pan.width / pan.height, step: cell / major)` |
| `chipsShown` | `scale >= DS.Canvas.linkLabelMinScale` |
| `nodes[i].index` | as above |
| `nodes[i].displayCentre` | `CanvasScene.displayCentres[id]` (`transform.toDisplay(position)`) |
| `nodes[i].bodyDisplaySize` | `NodeOutline.size · scale` (the body view's frame) |
| `nodes[i].displayRect`, `.labelDisplayRect` | `transform.toDisplay(worldRect)`, `transform.toDisplay(labelRect)` |
| `nodes[i].hitSlopLocal` | `3 / scale`, the slop `CanvasScene.hitNode` hands `NodeOutline.contains` |
| `nodes[i].strokeWidth` | `max(1, 2 · scale)` (`NetworkNodeView.strokeWidth`) |
| `nodes[i].nameRowShown` | `scale >= 0.35` (a hovered or selected node keeps its name at any zoom; nothing is either here) |
| `nodes[i].detailRowShown`, `.rateRowShown` | `scale >= 0.45` / `0.6` and the row has text |
| `nodes[i].labelBlockDisplayWidth` | `max(56, 76 · min(scale, 1.4))` |
| `nodes[i].nameFontSize`, `.detailFontSize` | `DS.Canvas.nameSize(scale:)` = `max(9, min(13, 10 · scale))`, and `max(8, nameSize − 2)` |
| `links[i].index` | document index; `visible: false` (and nothing else) when the scene has no item for it (an end node is missing) |
| `links[i].drawOrder` | the item's position in `CanvasScene.links` (sorted by `customerClass`, so the highest class paints on top) |
| `links[i].parallelOffset` | `offsetWorld · scale` (0 for a self-loop), what `LinkGeometry.between` receives |
| `links[i].selfLoopExtraRadius` | `bundleIndex · 8 · scale` for a self-loop, what `LinkGeometry.selfLoop` receives |
| `links[i].bulge` | `routePlan.bulge(for:) · scale` |
| `links[i].lineWidth`, `.arrowLength`, `.wingSpread` | `LinkGeometry.lineWidth(scale:)`, `.arrowLength(scale:)`, `arrowLength · tan(arrowHalfAngle)` |
| `links[i].start`, `.base`, `.tip`, `.wingLeft`, `.wingRight`, `.labelAnchor` | `LinkGeometry`'s fields (display space) |
| `links[i].route` | `{"type": "straight"}`, `{"type": "quad", "control"}` or `{"type": "cubic", "c1", "c2"}` (`LinkGeometry.Route`) |
| `links[i].polyline` | `LinkGeometry.polyline`: the flattened stroke and the tip, what `hitLink` measures against |
| `links[i].chipPolicy` | `never` (below 0.5, or probability exactly 1) or `declutter` (the chip is offered and drawn unless it overlaps one already placed this frame; nothing is hovered or selected, so no chip is `always`) |
| `links[i].chipText` | `DS.Number.format(routingProbability, significantDigits: 2)`, `null` at probability 1 |
| `links[i].chipFontSize` | `max(9, min(12, 9 · scale))` (`DS.Canvas.linkLabelDisplayFont`) |

## Left out

- **Which chips the declutter pass drops.** `LinkLayerCanvas` measures each chip's text with SwiftUI's `GraphicsContext.resolve(_:).measure(in:)`, which has no headless equivalent that is guaranteed to give the same widths, and a browser measures differently anyway. The anchor, text, font size and policy are here; the overlap test (`chip = text size + 2·DS.Spacing.xs` by `+ 2`, centred on `labelAnchor`, placed in `scene.links` order with the hovered and selected chips reserved first) is the port's to apply.
- Colours, opacities, halos and the hover / selection / pending-link / marquee-candidate states (all `false` here), the alignment-guide layer, the link preview, and the accessibility elements.

Re-running the dump gives byte-identical files (checked): the route plan does not depend on hash order.
