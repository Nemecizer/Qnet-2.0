# Canvas — complete functional specification

A drop-in specification of the Qnet network canvas: a macOS/SwiftUI node-and-arrow
diagram editor with zoom/pan, link auto-routing around obstacles, smart alignment
guides, multi-selection, and vector export.

This document is written to be **self-contained**: every constant, formula,
gesture rule and edge case needed to rebuild the same behaviour is here. It
describes a queueing-network editor (nodes = stations/buffers/sources/sinks), but
the canvas machinery is domain-independent — substitute your own node kinds and
the rest transfers unchanged.

Platform assumed: macOS 14+, SwiftUI + AppKit interop. Notes for porting to other
stacks appear where a behaviour depends on an AppKit facility.

---

## 0. File map

The implementation is 8 files, ~5,500 lines. Keep this split — each file has one
job and the seams are load-bearing.

| File | Lines | Contents |
|---|---|---|
| `CanvasGeometry.swift` | 1600 | Pure value types: `CanvasTransform`, `NodeOutline`, `LinkGeometry`, `GridPath`, `CanvasObstacles`, `LinkRoutePlan`, `CanvasScene`, `SmartGuides`, `CanvasMath`, `CanvasProfiler`. No SwiftUI views, no actor isolation (except the profiler). |
| `NetworkCanvasLayers.swift` | 745 | The drawing layers: `GridCanvas`, `AlignmentGuideLayer`, `LinkLayerCanvas`, `LinkPreviewCanvas`, `NodeOutlineShape`, `NetworkNodeView`. |
| `NetworkCanvasView.swift` | 1565 | The interactive surface: `CanvasContentView` (gestures, hover, drag state machines), `SceneCache`, `AnimatedLinkLayer`, context menus. |
| `NetworkCanvasScrollContainer.swift` | 875 | `NSViewRepresentable` wrapper: legacy scrollers, `CanvasScrollMetrics`, and `CanvasClipView` (wheel/pinch/keyboard/cursor/middle-button). |
| `NetworkCanvasOverlays.swift` | 245 | Floating corner panels: class legend, zoom cluster, empty-canvas hint. |
| `NetworkEditorModel.swift` | 3000 | The document + view-state model (selection, tools, zoom, undo, mutations). Only its canvas-relevant half is specified here. |
| `CanvasImageExport.swift` | 440 | Offscreen render of the *same* layers to PNG / PDF / pasteboard / printer. |
| `CanvasExportOptionsSheet.swift` | 230 | Export options (`CanvasExportOptions`) + its sheet. |

Supporting: `Models.swift` (node/link/tool types), `ToolPaletteView.swift` (tool
palette + a hotkey guard), `DesignSystem.swift` (all colour/typography tokens).

---

## 1. Core principles

Five invariants explain nearly every design decision below. Violate one and bugs
reappear.

1. **One geometry, drawn and hit-tested.** Every layer (grid, links, nodes,
   marquee) and every hit test reads from a single `CanvasScene` built once per
   frame from one `CanvasTransform`. What is drawn is exactly what is clickable,
   at any zoom or pan.
2. **World space is plain.** Node positions are stored unscaled;
   `display = world · scale + pan`. At zoom 1 with no pan, world == display, so
   documents written before zoom existed still open in place.
3. **Routing is a property of the drawing, not the camera.** Which node an arrow
   must step over cannot change when you scroll. The route plan is computed in
   world space and reused verbatim across every pan and zoom.
4. **One meaning per gesture, one implementation per command.** Escape, Deselect
   All and the context menu all call `deselectAll()`. Click-to-link and
   drag-to-link both go through the same `handleNodeTap` calls.
5. **Cheap frames.** Two interactions run at frame rate (node drag, pan). Both
   are protected: the scene is memoised, the route plan is frozen during a drag,
   accessibility elements are dropped, and the utilisation recompute is debounced.

---

## 2. Data model

```swift
enum NodeKind: String, Codable, CaseIterable { case station, buffer, source, sink }

struct NetworkNode: Identifiable, Hashable, Codable {
    let id: UUID
    let kind: NodeKind
    var name: String
    var position: CGPoint        // world space, node CENTRE
    var bufferSize: Int
    var distribution: QueueDistribution
    var distributionParameters: String
    var numberOfServers: Int
    var serviceDistributions: [Int: ServiceDistributionConfig]  // per customer class
    var picture: StationPicture  // optional SF Symbol drawn inside a station
}

struct NetworkLink: Identifiable, Hashable, Codable {
    let id: UUID
    let fromNodeID: UUID
    let toNodeID: UUID           // == fromNodeID for a self-loop
    var routingProbability: Double   // 1.0 draws no label chip
    var customerClass: Int           // entry class → stroke colour
    var toCustomerClass: Int?        // exit class; non-nil+different → gradient stroke
}

struct NetworkDocument: Codable {
    let nodes: [NetworkNode]
    let links: [NetworkLink]
    var infiniteBuffers: Bool
    var canvasScale: CGFloat     // zoom is persisted with the document
    var canvasPanOffset: CGSize
}
```

Decoding uses `decodeIfPresent` with defaults for every field added after v1, so
old files keep loading. `position` is the node **centre**, which is why
"Align Left" is only an edge alignment because all node kinds are drawn at
similar widths.

Customer-class colours:

```swift
enum CustomerClass {
    static let palette: [Color] = [.red, .blue, .green, .orange,
                                   .purple, .cyan, .pink, .yellow]
    static func color(for i: Int) -> Color {
        if i < palette.count { return palette[i] }
        let overflow = i - palette.count
        let hue = Double(overflow) * 0.61803398875      // golden angle
        return Color(hue: hue - floor(hue),
                     saturation: overflow % 2 == 0 ? 0.72 : 0.88,
                     brightness: overflow % 3 == 0 ? 0.82 : 0.95)
    }
    static func label(for i: Int) -> String { "Class \(i + 1)" }
}
```

---

## 3. Coordinate transform

```swift
struct CanvasTransform: Equatable {
    var scale: CGFloat
    var pan: CGSize
    var viewportSize: CGSize
    static let identity = CanvasTransform(scale: 1, pan: .zero, viewportSize: .zero)

    func toDisplay(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x * scale + pan.width, y: p.y * scale + pan.height)
    }
    func toLogical(_ p: CGPoint) -> CGPoint {
        guard scale > 0 else { return p }
        return CGPoint(x: (p.x - pan.width) / scale, y: (p.y - pan.height) / scale)
    }
    func toDisplay(_ r: CGRect) -> CGRect {           // scales size, maps origin
        let o = toDisplay(r.origin)
        return CGRect(x: o.x, y: o.y, width: r.width * scale, height: r.height * scale)
    }
    var visibleWorldRect: CGRect { /* toLogical(.zero) … toLogical(viewport corner) */ }
    var viewportCentre: CGPoint { CGPoint(x: viewportSize.width/2, y: viewportSize.height/2) }

    /// Zoom keeping the world point under `displayAnchor` fixed.
    func zoomed(to newScale: CGFloat, about displayAnchor: CGPoint) -> CanvasTransform {
        let world = toLogical(displayAnchor)
        var t = self
        t.scale = newScale
        t.pan = CGSize(width:  displayAnchor.x - world.x * newScale,
                       height: displayAnchor.y - world.y * newScale)
        return t
    }

    /// Frame `worldRect` centred with `margin` display pt on every side.
    static func fitting(worldRect: CGRect, in viewport: CGSize,
                        margin: CGFloat, zoomRange: ClosedRange<CGFloat>) -> CanvasTransform {
        let availW = max(viewport.width  - 2*margin, 1)
        let availH = max(viewport.height - 2*margin, 1)
        let raw = min(availW / max(worldRect.width, 1), availH / max(worldRect.height, 1))
        let scale = min(zoomRange.upperBound, max(zoomRange.lowerBound, raw))
        let c = CGPoint(x: worldRect.midX, y: worldRect.midY)
        return CanvasTransform(scale: scale,
                               pan: CGSize(width:  viewport.width/2  - c.x*scale,
                                           height: viewport.height/2 - c.y*scale),
                               viewportSize: viewport)
    }
}
```

**Constants**

| Name | Value | Note |
|---|---|---|
| `zoomRange` | `0.1 ... 4.0` | Single source of truth: menus, cluster, wheel, pinch, all fit routines clamp to it. |
| `zoomStep` | `1.25` | Geometric step for ⌘= / ⌘− and the cluster buttons. |
| `wheelZoomFactor` | `1.1` | Per wheel notch, applied as `pow(1.1, delta)`. |
| `gridSpacing` | `28` world pt | Grid cell and the snap step. |
| fit margin | `88` display pt | Covers node body + label block + breathing room. |
| world clamp | `±100_000` | `CanvasMath.clampWorld`; sanity only, canvas is otherwise unbounded. |

---

## 4. Node outlines

Shape metrics in **world units at zoom 1**. Both the node view and the link
router read these, so an arrow always lands exactly on the drawn outline.

```swift
enum NodeOutline {
    static func size(for kind: NodeKind) -> CGSize {
        switch kind {
        case .station: CGSize(width: 48, height: 48)   // circle
        case .buffer:  CGSize(width: 52, height: 44)   // rectangle with 2 dividers
        case .source:  CGSize(width: 46, height: 46)   // diamond
        case .sink:    CGSize(width: 48, height: 48)   // rounded square
        }
    }
    static let sinkCornerRadius: CGFloat = 8

    // Label block hung under every node.
    static let labelBlockWidth: CGFloat = 76
    static let labelBlockGap: CGFloat = 4
    static func labelBlockHeight(for kind: NodeKind) -> CGFloat {
        switch kind {
        case .station, .source: 36   // name + distribution + μ·SCV rows
        case .buffer:           24   // name + buffer-size row
        case .sink:             13   // name only
        }
    }

    static func boundingRadius(for kind: NodeKind) -> CGFloat {
        let s = size(for: kind); return max(s.width, s.height)/2 + 2
    }
```

**Exact containment**, in node-local world coordinates (origin at centre, y down),
with a uniform `slop` widening:

```swift
    static func contains(kind: NodeKind, localPoint p: CGPoint, slop: CGFloat = 0) -> Bool {
        let s = size(for: kind)
        let hw = s.width/2 + slop, hh = s.height/2 + slop
        switch kind {
        case .station: return p.x*p.x + p.y*p.y <= hw*hw          // circle (hw == hh)
        case .source:  return abs(p.x)/hw + abs(p.y)/hh <= 1      // diamond
        case .buffer:  return abs(p.x) <= hw && abs(p.y) <= hh    // rect
        case .sink:                                               // rounded rect
            guard abs(p.x) <= hw, abs(p.y) <= hh else { return false }
            let cr = sinkCornerRadius + slop
            let ix = abs(p.x) - (hw - cr), iy = abs(p.y) - (hh - cr)
            if ix > 0 && iy > 0 { return ix*ix + iy*iy <= cr*cr }
            return true
        }
    }
```

**Exit distance** — how far from `origin` along unit vector `u` the outline is.
A 14-step bisection against `contains` gives one code path for every shape,
including offset (parallel) rays used by multi-class link bundles:

```swift
    static func exitDistance(kind: NodeKind, from origin: CGPoint, direction u: CGPoint) -> CGFloat {
        guard contains(kind: kind, localPoint: origin) else { return 0 }
        var lo: CGFloat = 0, hi = boundingRadius(for: kind) * 1.5
        for _ in 0..<14 {
            let mid = (lo + hi) / 2
            let p = CGPoint(x: origin.x + u.x*mid, y: origin.y + u.y*mid)
            if contains(kind: kind, localPoint: p) { lo = mid } else { hi = mid }
        }
        return (lo + hi) / 2
    }
}
```

Adding a node kind means: a `size`, a `contains` branch, a `NodeOutlineShape`
path, a label-block height. Nothing else in the router changes.

---

## 5. Link geometry

```swift
struct LinkGeometry: Equatable {
    enum Route: Equatable { case straight, quad(control: CGPoint), cubic(c1: CGPoint, c2: CGPoint) }
    let start: CGPoint      // on the source outline
    let base: CGPoint       // arrowhead base — where the stroke ends
    let tip: CGPoint        // arrowhead tip, on the target outline
    let wingLeft, wingRight: CGPoint
    let route: Route
    let labelAnchor: CGPoint
    let polyline: [CGPoint] // flattened stroke + tip, for distance queries

    static func arrowLength(scale: CGFloat) -> CGFloat { max(6, 10 * scale) }
    static let arrowHalfAngle: CGFloat = 28 * .pi / 180
    static func lineWidth(scale: CGFloat) -> CGFloat { max(1, 2 * scale) }
    static let hitTolerance: CGFloat = 5     // half-width of the 10 pt hit slab
}
```

`strokePath` moves to `start` and adds the line/quad/cubic to `base`;
`arrowPath` is the closed triangle `tip → wingLeft → wingRight`.
`distance(to:)` is the min over `pointToSegmentDistance` across the polyline.

### 5.1 `between(...)` — a link joining two distinct nodes

Inputs: the two display centres and kinds, `scale`, `parallelOffset` (display-space
perpendicular shift for bundle members), `bulge` (display-space sideways bow;
0 = straight; positive bows to the right of travel).

```
gap = 1.5                                    // clear air between outline and stroke
u    = unit(fromCentre → toCentre)
perp = (-u.y, u.x)
fromC = fromCentre + perp*parallelOffset     // bundle-shifted centres
toC   = toCentre   + perp*parallelOffset
localOffset = perp*parallelOffset / scale    // same shift in node-local world units
arrowLen   = arrowLength(scale)
wingSpread = arrowLen * tan(arrowHalfAngle)
```

**Straight (`bulge == 0`)**

```
tFrom = exitDistance(fromKind, from: localOffset, direction:  u)*scale + gap
tTo   = exitDistance(toKind,   from: localOffset, direction: -u)*scale + gap
start = fromC + u*tFrom
tip   = toC   - u*tTo
base  = tip - u*arrowLen
wingLeft/Right = base ± perp*wingSpread
polyline = [start, base, tip]
labelAnchor: midpoint of (start, base), offset by n*(9 + lineWidth) where
  n = perp flipped outward when parallelOffset < 0; when parallelOffset == 0,
      n = perp flipped so n.y <= 0 ("above" the segment).
```

**Curved (`bulge != 0`)** — end tangents aim at the control point so the stroke
leaves and enters the outlines *along the curve*, not along the chord:

```
mid     = (fromC + toC)/2
control = mid + perp*bulge
dirStart = unit(fromC → control);  dirEnd = unit(control → toC)
tFrom = exitDistance(fromKind, localOffset,  dirStart)*scale + gap
tTo   = exitDistance(toKind,   localOffset, -dirEnd  )*scale + gap
start = fromC + dirStart*tFrom
tip   = toC   - dirEnd  *tTo
base  = tip - dirEnd*arrowLen
endPerp = (-dirEnd.y, dirEnd.x);  wings = base ± endPerp*wingSpread
polyline = flattenQuad(start, control, base, segments: 12) + [tip]
labelAnchor = quadPoint(start, control, base, t: 0.5) + perp*sign(bulge)*(9 + lineWidth)
route = .quad(control)
```

### 5.2 `selfLoop(...)` — a feedback arc above the node

```
a1 = -55°, a2 = -125°          // upper-right and upper-left (y is down)
d1 = (cos a1, sin a1), d2 = (cos a2, sin a2)
r1 = exitDistance(kind, .zero, d1)*scale + 1.5
r2 = exitDistance(kind, .zero, d2)*scale + 1.5
loop = 40*scale + extraRadius   // extraRadius nests multi-class loops outward
start = centre + d1*r1
tip   = centre + d2*r2
c1 = centre + d1*(r1 + loop) + (4*scale, 0)
c2 = centre + d2*(r2 + loop) - (4*scale, 0)
dirEnd = unit(c2 → tip);  base = tip - dirEnd*arrowLen
polyline = flattenCubic(start, c1, c2, base, segments: 16) + [tip]
labelAnchor = cubicPoint(start,c1,c2,base, t:0.5) - (0, 9 + lineWidth)
route = .cubic(c1, c2)
```

---

## 6. Link bundling and route planning

### 6.1 Bundling siblings

Links sharing a directed pair (multi-class) are spread perpendicular:

```swift
struct PairKey: Hashable { let from, to: UUID }
static let bundleSpacing: CGFloat = 8   // world pt between siblings
static let pairBulge: CGFloat = 24      // bow given to an opposite-direction pair

static func bundleGroups(_ links: [NetworkLink]) -> [PairKey: [NetworkLink]] {
    // group by (from,to); sort each group by customerClass
}
```

For link *i* of *n* siblings: `offsetWorld = (i - (n-1)/2) * bundleSpacing`.
Grouping uses **all** links, not just the visible ones, so toggling a class
filter never makes the bundle jump. Self-loops instead nest:
`extraRadius = i * bundleSpacing * scale`.

If the reversed pair `(to, from)` also exists, the link gets `baseBulge = ±pairBulge`
and its side is **locked** — the two directions must stay on opposite sides.

### 6.2 Obstacles

```swift
final class CanvasObstacles {
    static let padding: CGFloat = 6        // world slack round a node BODY
    static let labelPadding: CGFloat = 2   // world slack round a LABEL block
    struct Obstacle { let rect: CGRect; let isLabel: Bool }
    struct Hits: Equatable {
        var bodies = 0, labels = 0
        var isClear: Bool { bodies == 0 && labels == 0 }
        static func < (a: Hits, b: Hits) -> Bool {   // any body crossing is worse
            a.bodies != b.bodies ? a.bodies < b.bodies : a.labels < b.labels
        }
    }
}
```

Two obstacles per node (body, label), bucketed into a uniform grid with
`cell = max(48, 200 * max(scale, 0.05))`. Skipped entirely for ≤ 2 nodes.
A per-body visit-stamp `Int32` array (bumped token per query, reset on wrap)
avoids allocating a `Set` per query. Two queries:

* `hits(polyline, excluding: a, b, stopAtFirstBody:)` — tallies crossings, never
  counting the link's own endpoints; Liang–Barsky segment-vs-rect.
* `obstacles(near: a, to: b, reach:, excluding:)` — everything a bow of at most
  `reach` could meet: keeps rects whose centre is within
  `reach + halfDiagonal` of the chord. Gathered **once per link** so the bulge
  search that follows is a plain loop over a short array.

A **body** crossing is hard (an arrow through a station is wrong); a **label**
crossing is soft (avoid it when possible, never at the price of a body).

### 6.3 `LinkRoutePlan`

```swift
struct LinkRoutePlan: Equatable {
    private var bulges: [UUID: CGFloat] = [:]   // world pt; absent == straight
    static let empty = LinkRoutePlan()
    func bulge(for id: UUID) -> CGFloat { bulges[id] ?? 0 }

    /// Bow-by-bow blend so routes ease instead of teleporting.
    static func interpolated(from a: Self, to b: Self, t: CGFloat) -> Self {
        if t <= 0 { return a };  if t >= 1 || a == b { return b }
        // for each id in b: from + (target-from)*t  (from = a[id] ?? 0)
        // for each id only in a: from * (1 - t)
        // drop zeros
    }
}
```

`build(nodes:links:)` works in world space (`scale: 1, pan: .zero`), computes the
node **centroid** (tie-break: send detours away from the crowd), builds the
obstacles once, then solves per link. Self-loops are skipped (they never bow).

**Search constants**

```swift
static let bulgeLadder: [CGFloat] = [14, 24, 48, 96, 160, 240]   // 24 == pairBulge
static let probeSegments = 8       // flattening while probing a candidate
static let clearanceMargin: CGFloat = 10   // clear air the solved bow leaves
static let maxBulge: CGFloat = 260         // beyond this, keep the least-bad route
static let solveWindow: CGFloat = 0.2      // chord fraction at each end where the
                                           // closed-form solve declines to act
```

A quadratic bow displaces its own midpoint by **half** the control offset, so a
rung of `2h` steps the apex clear of a body of half-height `h`: 14 pt grazes a
corner, 96 pt steps over one station, 240 pt clears a whole column.

**`solve(...)` — three tiers, in order of preference**

(a) the gentlest route clearing every body **and** every label;
(b) failing that, the gentlest route clearing every body;
(c) failing that, the route crossing the fewest bodies, then fewest labels.

```
if obstacles.isEmpty                            → baseBulge
nearby = obstacles.obstacles(near: a, to: b, reach: bulgeLadder.last, excluding: from,to)
if nearby.isEmpty                               → baseBulge

probeHits(bulge):  walk a bare quadratic a→control→b at probeSegments+1 points.
    Reject most of `nearby` with one hull-rect test first (a quadratic lies inside
    the hull of its three points). Costs no allocation, no outline bisection.
builtHits(bulge):  obstacles.hits(LinkGeometry.between(..., bulge).polyline)
    — acceptance is ALWAYS decided on the built polyline, because the trimmed
      curve leaves along the tangent and can sit a hair outside the probe.

consider(candidate):
    p = probeHits(candidate); if p < bestHits { best = candidate; bestHits = p }
    if p.bodies > 0 → false
    built = builtHits(candidate)
    if built.isClear → true                      (tier a: stop)
    if built.bodies == 0 && bodyClear == nil { bodyClear = candidate }   (tier b)
    → false

if consider(baseBulge) → baseBulge

outward = perp · (mid - centroid);  firstSign = outward >= 0 ? +1 : -1
signs = lockSide ? [sign(baseBulge)] : [firstSign, -firstSign]

for magnitude in bulgeLadder where magnitude > |baseBulge| + 0.001:
    for sign in signs: if consider(sign*magnitude) → return it
```

If no rung clears, **solve** for the bow rather than guessing. A quadratic of
control offset *B* displaces its curve by `2·t·(1−t)·B` at chord parameter *t*,
so the smallest *B* clearing an obstacle is `offsetNeeded / (2·t·(1−t))`, and the
bow clearing them all is the max:

```
chordLength = max(|b - a|, 0.001)
solvedBulge(sign, includingLabels):
    need = 0
    for obstacle in nearby where includingLabels || !obstacle.isLabel:
        c = obstacle.rect centre;  d = c - a
        t = (d · u) / chordLength
        skip unless solveWindow < t < 1 - solveWindow   // pinned near an endpoint
        along = d · perp
        half  = (|perp.x|*rect.width + |perp.y|*rect.height) / 2
        target = sign * (along + sign*(half + clearanceMargin))
        skip if target <= 0                              // already clear this side
        need = max(need, target / (2*t*(1-t)))
    return (need > 0 && need <= maxBulge) ? sign * max(need, |baseBulge|) : nil

for includingLabels in [true, false]:
    for sign in signs: if let c = solvedBulge(...), consider(c) → return c

return bodyClear ?? best
```

A chord that is already clear is **kept** — a straight chain must stay dead
straight, so only links that need the search pay for it.

**Freezing.** The model caches the plan on `(nodes, links)` and, while
`isDraggingNode` is set, hands out the last plan unchanged however far the nodes
have moved, re-planning once on release. Live re-planning cost ~4 ms/frame at 200
nodes and made links snap between ladder rungs as the dragged node grazed a chord.

---

## 7. The scene

```swift
struct CanvasScene: Equatable {
    struct LinkItem: Identifiable, Equatable { let id: UUID; let link: NetworkLink; let geometry: LinkGeometry }
    let transform: CanvasTransform
    let nodes: [NetworkNode]
    let nodeIndex: [UUID: NetworkNode]
    let displayCentres: [UUID: CGPoint]
    let links: [LinkItem]     // visible only, sorted by customerClass ascending
                              // so the highest class paints on top
}
```

`init(nodes:links:transform:classFilter:routePlan:)` — index the nodes, map every
centre to display space, group the bundles, then for each link (skipping ones the
`classFilter` excludes, and any whose endpoints are missing) build either
`selfLoop(extraRadius: i*bundleSpacing*scale)` or
`between(parallelOffset: offsetWorld*scale, bulge: plan.bulge(id)*scale)`.
Passing `routePlan: nil` plans on the spot (used by offline checkers).

**Hit testing (display space)**

```swift
func hitNode(at p: CGPoint) -> NetworkNode? {
    for node in nodes.reversed() {                 // later nodes draw on top
        let c = displayCentres[node.id]!
        let local = CGPoint(x: (p.x - c.x)/scale, y: (p.y - c.y)/scale)
        if NodeOutline.contains(kind: node.kind, localPoint: local, slop: 3/scale) { return node }
    }
    return nil
}
func hitLink(at p: CGPoint, tolerance: CGFloat = 5) -> NetworkLink? {
    // nearest visible link within the slab, topmost first on ties
}
```

The 3 pt slop is in **display** points (divided by scale before use), so the
forgiveness is constant on screen at every zoom.

**Rect helpers**

```swift
static func nodeWorldRect(_ n: NetworkNode) -> CGRect      // centre ± half outline
static func nodeLabelRect(_ n: NetworkNode) -> CGRect      // width 76, below body + 4 gap
static func marqueeSelects(_ n: NetworkNode, rect: CGRect) -> Bool {
    nodeWorldRect(n).intersects(rect.insetBy(dx: -0.01, dy: -0.01))   // zero-area band still selects
}
static func bounds(of nodes: [NetworkNode]) -> CGRect?     // bbox of CENTRES, nil when empty
```

Marquee selection is by **intersection with the body**, the OmniGraffle/Figma
rule — a node whose body the band touches is selected even if its centre is
outside. The live highlight, the live count and the commit all call this one
predicate, so what lights up is exactly what gets selected.

---

## 8. Grid

```swift
enum GridPath {
    static let dotSize: CGFloat = 1.5
    static let minorFadeStart: CGFloat = 16   // cell size (display pt) below which dots vanish
    static let minorFadeWidth: CGFloat = 8    // band over which they fade in
    struct Result { var minorDots: Path?; var minorAlpha: CGFloat
                    var majorLines: Path?; var majorAlpha: CGFloat }

    static func firstLine(offset: CGFloat, step: CGFloat) -> CGFloat {
        var v = offset.truncatingRemainder(dividingBy: step); if v < 0 { v += step }; return v
    }

    static func build(transform: CanvasTransform, size: CGSize, gridSpacing: CGFloat) -> Result {
        let cell = gridSpacing * transform.scale
        guard cell > 0.5 else { return empty }
        let major = cell * 4

        minorAlpha = clamp01((cell - 16) / 8)
        if minorAlpha > 0.02 {
            // 1.5 pt SQUARES (rects, not ellipses: 4 points each, pixel-aligned on
            // Retina), stepping by `cell` from firstLine(pan.width) / firstLine(pan.height)
        }
        majorAlpha = clamp01((major - 4) / 8)
        if majorAlpha > 0 {
            // hairlines every 4 cells, at x.rounded() + 0.5 for crispness
        }
    }
}
```

Worst case on a 1600×1000 viewport: ~6k dots at 16 pt cells (near-invisible),
~2.8k at full opacity — one `Path`, filled once.

`GridCanvas` is `Equatable` on the transform and wrapped `.equatable()`, so
during a node drag it never redraws.

---

## 9. Smart alignment guides

Shown while a node is dragged; the 1-pt guides every diagramming tool draws, plus
the small pull that makes alignment stick.

```swift
enum SmartGuides {
    static let tolerance: CGFloat = 4      // DISPLAY pt; callers pass tolerance/scale
    struct SpacingGuide: Equatable { var first, second: CGRect }   // zero-thickness gap rects
    struct Match: Equatable {
        var adjustment = CGSize.zero
        var x: CGFloat?, y: CGFloat?           // world coords of an edge/centre guide
        var anchor: CGRect?                    // dragged node's rect AFTER adjustment
        var xPartner: CGRect?, yPartner: CGRect?   // the neighbour it locked onto
        var xSpacing: SpacingGuide?, ySpacing: SpacingGuide?
        var isEmpty: Bool { x == nil && y == nil && xSpacing == nil && ySpacing == nil }
        mutating func dropX()   // grid won this axis: clear x, xPartner, xSpacing, adjustment.width
        mutating func dropY()
    }
}
```

**Two kinds of guide per axis**

1. **Edge / centre alignment.** Candidate values per rect are `[minX, midX, maxX]`
   and `[minY, midY, maxY]`. `match(anchor:others:tolerance:)` takes the closest
   pair under tolerance per axis, recording the partner rect so the layer can draw
   the guide *between* the two rather than across the whole viewport.
2. **Equal spacing**, tried only when that axis found no edge match (a node must
   never get two competing pulls). Neighbours are rects whose extent on the *other*
   axis is within one anchor-extent of the anchor's centre ("same row"). Three cases:
   * one neighbour on each side → equalise the gaps, `adjust = (gapR − gapL)/2`;
   * two neighbours to the left → repeat their gap, `adjust = gapPrev − gapNew`;
   * two to the right → mirror image.
   Best (smallest) adjustment under tolerance wins; the two gap rects are returned
   as bars to draw.

**Drawing** (`AlignmentGuideLayer`, one `Canvas`, `Equatable`, hit-testing off):
edge guides run from `min(anchor, partner)` to `max(...)` extended by
`overshoot = 8` display pt, with a `tick = 4` half-length cross at each end; every
coordinate is `.rounded() + 0.5` for crispness. Spacing guides draw each gap as a
bar with the same end ticks. Stroked in the accent colour at hairline width, faded
in/out with the "quick" animation inside its own container so the fade can never
leak onto node positions.

---

## 10. Layers

Bottom to top:

```
GridCanvas          world-space dot grid            (one Canvas, Equatable)
AnimatedLinkLayer   → LinkLayerCanvas               (one Canvas, Equatable)
LinkPreviewCanvas   dashed elastic line, only while drawing a link
pendingLinkIndicator  dashed ring on the chain's start node
ghostNode           faint outline where an add tool would place
ForEach node → NetworkNodeView                      (real views: context menu, a11y)
AlignmentGuideLayer only during a drag                (its own fade container)
marquee             one Rectangle while rubber-banding
```

### 10.1 `LinkLayerCanvas`

Styling inputs are separate from geometry so hover/selection never rebuilds the
scene:

```swift
struct LinkLayerState: Equatable {
    var selectedLinkID: UUID?
    var hoveredLinkID: UUID?
    var emphasisedClass: Int?   // while chain-building, other classes dim
    var scale: CGFloat
}
```

Draw order: ordinary links, then the hovered one, then the selected one, so
emphasis always paints on top.

Per link:

* `lineWidth = LinkGeometry.lineWidth(scale)`, ×1.5 (min 3) when hovered/selected.
* Shading: accent when selected; a **linear gradient** from entry-class colour at
  `start` to exit-class colour at `tip` when `toCustomerClass != customerClass`
  (arrowhead included); otherwise the flat class colour.
* Selected links get a halo first: both paths stroked in `linkHalo` at
  `lineWidth + 6`, round cap/join.
* Opacity: `dim` (0.20) when filtered out by `emphasisedClass`, `1` when
  hovered/selected, else `linkStroke` (0.75).
* Stroke the path (butt cap, round join), fill the arrow triangle.

**Probability chips** (drawn only when `routingProbability != 1.0`):

* Below `linkLabelMinScale = 0.5` no chip is drawn at all.
* Above it, chips **declutter**: a chip whose rect intersects one already placed
  this frame is skipped (the link is still drawn). The hovered and selected links'
  chips are *reserved before anything else is placed*, so they always win —
  hovering a link is how a dropped chip is revealed.
* The chip is a rounded rect filled `surfaceRaised`, stroked (separator, or the
  label colour when hovered/selected), with the number centred on
  `geometry.labelAnchor`. Rect = text size + `2·xs` horizontal, `+2` vertical.
* Chips are drawn at **full** opacity, not the softened link opacity, so they stay
  legible against the grid in dark mode.

### 10.2 `LinkPreviewCanvas`

Dashed rubber-band while a link is being drawn, in the chain's class colour (or
accent before a class is fixed):

* `d = max(0.6, scale)`; `StrokeStyle(lineWidth: LinkGeometry.lineWidth(scale),
  lineCap: .round, dash: [6d, 4d])` — the dash keeps its rhythm as you zoom and
  never dissolves into dots.
* **Over the start node again** (`selfLoopRadius != nil`): draw the exact
  `LinkGeometry.selfLoop` release would create.
* **Over another node**: draw the exact `LinkGeometry.between` release would create
  — the user sees which boundary the arrow lands on before committing.
* **Over empty canvas**: a bare line from the start node's *outline*
  (`exitDistance` along the pointer direction, × scale) to the pointer. No
  arrowhead — there is no target to point at.

### 10.3 `NetworkNodeView`

`Equatable` on `(node, scale, isSelected, isHovered, isMarqueeCandidate,
isPendingLinkStart, infiniteBuffers, utilisation, contrast)`. Note the contrast
setting is **passed in** rather than read here, precisely because the view is
`Equatable` on its inputs; the exporter leaves it `.standard` so a file never
depends on the exporting Mac's accessibility settings.

The **body** is drawn through the zoom (frame = world size × scale) while the
**label block below is laid out in display space with a clamped point size**, so
text stays crisp instead of being rasterised by a `scaleEffect`.

```
ZStack:
  hover ring       NodeOutlineShape(cornerRadius: 8*scale + 3), stroke hoverRing,
                   frame = size + 6, opacity (isHovered || isMarqueeCandidate) && !isSelected
  selection ring   NodeOutlineShape(cornerRadius: 8*scale + 4), stroke accentStroke,
                   lineWidth 1.5, frame = size + 8, shadow(selectionGlow, radius 6)
  body icon        per kind (below)
.overlay(top)      label block, offset y = size.height + 4
.overlay(topTrailing)  ρ badge, offset (+s, −s)
```

Nodes have a fixed size, so there are deliberately **no corner handles** — they
would promise a resize that does not exist.

**Body per kind** — stroke width `max(1, 2*scale)`, border = accent when selected
else `nodeStroke`, fill = `selectionFillStrong` when it is the pending link start,
else the kind's fill token:

* station — `Circle`, plus an optional SF Symbol inscribed with padding
  `bodyWidth * 0.18` so the glyph never touches the stroke;
* buffer — rectangle with two vertical dividers at ⅓ and ⅔; in *infinite* mode the
  left edge is omitted (open box) and only the right ⅔ is filled;
* source — diamond; sink — rounded rect, radius `8 * scale`.

**Label block** — `VStack(spacing: 1)`, width `max(56, 76 * min(scale, 1.4))`,
hit-testing off. Rows drop out with zoom:

| Row | Min scale | Content |
|---|---|---|
| name | `0.35` (kept at any zoom while hovered or selected) | semibold, monospaced digits, `lineLimit(1)`, middle truncation |
| detail | `0.45` | buffer: `b=N` (finite only); station: distribution name + ` c=N` when >1 server, or `Multi-class`; source: distribution name; sink: none |
| rates | `0.6` | `μ=2.5 · SCV=1` (station) or `λ=…` (source), medium weight |

Fonts: base `labelSize = 10`; `nameSize(scale) = max(9, min(13, 10*scale))`;
detail = `max(8, nameSize − 2)`; link label = `max(9, min(12, 9*scale))`.

**ρ badge** — a capsule showing `ρ 0.87`, tinted danger ≥ 0.9, warning ≥ 0.7,
success below, using a *legible* tint with on-tint text (white on the raw system
tint measured 2.0:1 in dark mode; the certified pair is 5.8:1+).

**Accessibility.** Each node is one element: label = `"<Kind> <name>, <detail>,
<rate description>, utilisation ρ …"`, trait `.isButton` plus `.isSelected`. The
tooltip is that description plus a glossary line per symbol drawn (λ, μ, SCV), so
the canvas is never where a user meets undefined notation with no way to ask.

**Links and VoiceOver.** Links live in one `Canvas`, which VoiceOver sees as a
single opaque image. Fix: publish one **zero-size accessibility element per visible
link**, positioned on `geometry.labelAnchor`, with the link's description, its
selected state, and actions *Edit Parameters* / *Delete Link*. This list is
rebuilt on every body evaluation, so it is **dropped for the length of a node drag
or a pan** (`interacting`) and restored on release.

---

## 11. Tools

```swift
enum EditorTool: String, CaseIterable {
    case select, multiSelect, pan, addStation, addBuffer, addSource, addSink, addLink
}
```

| Tool | Key | Cursor | Behaviour |
|---|---|---|---|
| Pointer | **V** | arrow (copy cursor while ⌥ held over a node) | select, drag, marquee, double-click to sticky-pan |
| Multi-Select | **M** | crosshair | rubber-band from press with no threshold |
| Pan | **H** | open hand (closed while dragging) | drags the whole surface; nodes stop taking hits |
| Source | **O** | crosshair | click to place |
| Station | **S** | crosshair | click to place |
| Buffer | **B** | crosshair | click to place |
| Sink | **X** | crosshair | click to place |
| Link | **L** | pointing hand over a node, else arrow | click-click or press-drag to connect |

Palette grouping: `[[select, multiSelect, pan], [addSource, addStation, addBuffer, addSink], [addLink]]` —
node tools in **flow order**, matching the status bar's counts.

`setTool(_:)` is the **single writer** of `selectedTool` (the property is
`private(set)`), because a tool change is never only a mode change:

```swift
func setTool(_ tool: EditorTool) {
    selectedTool = tool
    if tool != .pan { toolBeforeStickyPan = nil }      // an explicit choice ends sticky pan
    if tool != .addLink { pendingLinkStartID = nil; activeLinkSourceID = nil; pendingLinkPoint = nil }
    if tool != .select && tool != .multiSelect { clearMultiSelection() }
}
```

No status line on a tool change — the palette's selected state and the menu check
mark already say it, and letter hotkeys would flood the log.

**Hotkey guard (AppKit-specific).** The Tools menu binds the bare letters with no
modifier so they display correctly, but AppKit dispatches menu key equivalents
*before* the first responder's `keyDown`, which would steal those letters from
text fields and terminals. A local `NSEvent` monitor intercepts a single
unmodified letter that maps to a tool and, when the first responder is an
`NSTextView` / `NSTextField` / terminal view, calls `window.sendEvent(event)`
directly and swallows the monitor's copy.

---

## 12. Gestures

All gesture state lives in the **view** (`@State`), never the model; the model
learns only about committed changes. Coordinate space is a named `"canvas"` space.

**Thresholds**

```swift
dragThreshold          = 2   // display pt: below this a press is a click
linkDragThreshold      = 3   // a link needs more travel, so a shaky click still selects/cycles
marqueeThreshold       = 5   // Pointer-tool empty-canvas travel before a rubber-band
canvasDoubleClickSlop  = 3   // how far the 2nd click of a canvas double-click may land
doubleClickInterval    = NSEvent.doubleClickInterval   // the user's own setting
```

### 12.1 Node gesture (`DragGesture(minimumDistance: 0)` on each node view)

**On change**

1. Resign text focus (below), then bail if this drag was Escape-cancelled.
2. **Link tool** → drag-to-connect. Once travel exceeds `dragThreshold`, record
   `dragLinkFromID`. Every frame: publish `pendingLinkPoint` (clamped world),
   hit-test the pointer, publish the target as `hoveredNodeID` (**never** the start
   node — it already wears the pending ring), set `dragLinkLeftSource` once the
   pointer leaves the source, and set `pointerOverLinkStart` when it is back over
   the source **having once left**. Nothing reaches the model until release.
3. **Pointer / Multi-Select** → move. On crossing `dragThreshold`:
   * If the node is not in the selection: it becomes the sole selection, or joins
     the group when ⇧/⌘ was held at mouse-down.
   * `beginMutation("Move Node(s)")` / `"Duplicate and Move Node(s)"`.
   * If ⌥ was held at mouse-down: `duplicateSelectionInPlaceForDrag()` (zero
     offset — the drag supplies the displacement); the copies become the selection
     and are what the drag carries. Set `dragDuplicated`.
   * Snapshot `dragStartPositions` for every node in the group, set `isDraggingNode`.
   * Every subsequent frame: `moveAnchoredNodes(by: translation, scale:)`.
4. Any other tool: ignore.

**On end**

* Cancelled → consume and return.
* Was a move → `finishNodeMove()`: `endMutation()`, clear `isDraggingNode`,
  `snapSuspended`, guides and all drag state.
* Was a link drag → clear the gesture memo, hit-test the release point:
  * a target that is a **different** node, *or* the source node after having left it
    (the self-loop gesture) → `completeLinkDrag(from:to:)`;
  * the source node **never having left it** → treat it as the click it was:
    `handleNodeTap(nodeID: fromID)` (silently dropping it made an unsteady hand
    feel like a dead canvas);
  * empty canvas → abandon silently, Mac convention, leaving the network untouched.
* Otherwise a **plain click**: with no modifier, in Pointer/Multi-Select, a second
  click on the same node inside `doubleClickInterval` opens the parameter
  inspector; else record the memo and `handleNodeTap(nodeID:extendingSelection:)`.

`completeLinkDrag` **replays the two-click flow** so the class rules, the refusal
to repeat a pair and chain continuation have one implementation:

```swift
if editor.pendingLinkStartID != from {
    editor.pendingLinkStartID = nil          // a chain part-built elsewhere must not
    editor.handleNodeTap(nodeID: from)       // read this tap as its CLOSE
    guard editor.pendingLinkStartID == from else { return }
}
editor.handleNodeTap(nodeID: to)
```

### 12.2 `moveAnchoredNodes` — snapping and guides

```swift
var delta = translation / scale                          // display → world
let suspended = NSEvent.modifierFlags.contains(.control) // read LIVE, not at mouse-down
editor.snapSuspended = suspended

if !suspended, let anchorID = dragNodeID ?? dragStartPositions.keys.first, … {
    candidate = the anchor's world rect at start + delta
    others    = every node NOT being dragged, as world rects
    guides    = SmartGuides.match(anchor: candidate, others: others,
                                  tolerance: SmartGuides.tolerance / max(scale, 0.01))
    var adjust = guides.adjustment
    if editor.snapToGrid {
        grid = snapIfNeeded(candidateCentre) - candidateCentre
        // axis by axis, the NEARER of guide and grid wins
        if !guideX || |grid.width|  <= |adjust.width|  { adjust.width  = grid.width;  guides.dropX() }
        if !guideY || |grid.height| <= |adjust.height| { adjust.height = grid.height; guides.dropY() }
    }
    guides.anchor = candidate.offsetBy(adjust)
    delta += adjust
}
editor.activeAlignGuides = guides
for (id, start) in dragStartPositions {
    editor.moveNode(id: id, to: clampWorld(start + delta), snap: false)   // snap already resolved
}
```

The group moves **rigidly** by the resolved delta: the dragged node lands on the
guide or the grid, its companions keep their offsets. The model's own per-node
snap is bypassed (`snap: false`) precisely so a group at mixed sub-grid offsets is
not collapsed.

**⌃ is the free-placement override** — read live so the user can press and release
it mid-drag and watch the node come off the grid. ⌃ and not ⌘, because ⌘ at
mouse-down means "extend selection" and one key must not mean two things inside
one drag; and a ⌃-mouse-down is a context click, so it can never *start* a drag.

### 12.3 Escape cancels a drag

`dragIsCancellable` = a link drag, a link-endpoint drag, or a node drag that did
**not** duplicate. While it is true (and only then) install a local `keyDown`
monitor for key code 53 with no modifiers; a local monitor sees the key before the
responder chain, which is the only way to give Escape a second meaning without
taking its first away. Return `nil` (swallow) when something was actually
cancelled, the event otherwise.

```swift
func cancelDragInFlight() -> Bool {
    if dragLinkFromID != nil {          // a link being drawn holds NO model state
        clear the gesture memo, pendingLinkPoint, hoveredNodeID
        nodeDragCancelled = true; return true
    }
    guard !dragStartPositions.isEmpty, !dragDuplicated else { return false }
    for (id, start) in dragStartPositions { editor.moveNode(id: id, to: start, snap: false) }
    editor.endMutation()               // positions restored BEFORE the group closes, so
    …                                  // endMutation sees no change and registers no undo
    if dragNodeID != nil { nodeDragCancelled = true } else { canvasDragCancelled = true }
    clear all drag state; return true
}
```

Two separate cancel flags, because the node gesture and the canvas gesture both
end on the same mouse-up in an unspecified order and neither may clear the other's
memo before it is read. The mouse is still down after a cancel, so the gesture
keeps delivering and everything it delivers from there to the release is ignored.

**An ⌥-drag is deliberately not cancellable.** It has already made the copies it
is carrying; putting those back would stack an invisible duplicate on every
original — the exact corruption a cancel exists to prevent. Removing them needs a
model call that discards the pending snapshot; until it exists, Escape keeps its
other meaning there.

### 12.4 Canvas gesture (pan / marquee / link drag / tap)

Resolved **once** on the first `onChanged` (`dragOrigin`: `.node`, `.link(id)`,
`.empty`) instead of hit-testing the start location every frame.

* **Pan** when the tool is Pan, Space is held, or a pan is already in flight:
  record `panStartOffset` on the first frame, then
  `canvasPanOffset = start + translation`. Deliberately **unclamped** — the user
  may drag the network out of frame and bring it back; the scrollers track the
  overflow.
* **`.node`** → the node's own gesture owns it; return.
* **`.link`** (Pointer only) → past `linkDragThreshold`, drag **both endpoints**
  live as one undo step named "Move Link"; selects the link but never cycles its
  class the way a repeated click does. Reuses `moveAnchoredNodes`.
* **`.empty`** → rubber-band. Multi-Select opens on press with no threshold;
  Pointer needs `> marqueeThreshold` so a plain click (place node / clear
  selection) still fires cleanly.

**On end** (after the cancel and pan checks):

1. `.node` → return.
2. `.link` → if it was a drag, `finishNodeMove()`. Otherwise, in Pointer: a second
   click on the same link inside the double-click interval opens the link
   inspector; a slower second click cycles its class (`handleLinkTap`).
   Other tools fall through and treat a link like empty canvas.
3. **A rubber-band with zero area is a click, not a selection.** Multi-Select opens
   its band on press, so *every* plain click in that tool arrives holding a
   zero-area rect; committing it would eat the click before the double-click test
   and put sticky pan out of reach in the one other tool documented to offer it.
   Clear the rect and origin (not `clearMultiSelection()`, which would also drop
   the selection a ⇧-click is building) and fall through.
4. ⇧/⌘-click on empty canvas in a selection tool → leave the selection alone; the
   user is building a group, not abandoning it.
5. **Empty canvas click.** Two gestures share it, so the memo is kept here.
   Compute `world = snapIfNeeded(clampWorld(toLogical(location)))`.
   Refresh `lastCanvasTapTime` / `lastCanvasTapPoint` on **every** empty click,
   suppressed ones included, so a rapid triple-click is still one placement.
   Inside the double-click window:
   * Pointer / Multi-Select → **sticky pan**, but only when the second click landed
     within `canvasDoubleClickSlop` of the first (a click-and-a-half that was
     really the start of a marquee must not hand the canvas to the hand).
   * Add-node tools → suppress the second placement **only when it would land on
     the same point**: `previousWorld == world || nearPreviousClick`. This is
     deliberately a different test from sticky pan's: with Snap to Grid on, two
     clicks a whole cell apart resolve to one grid point; with it off, two clicks
     inside the slop overlap even though their world points differ by a hair.
     Sharing one test left a double-placement bug reachable from any trackpad
     double-click that wandered 4 pt.
   * Pan / Link → nothing (a Pan click never reaches here; a Link tool's empty
     click just cancels a pending chain, and twice is once).
6. `editor.handleCanvasTap(at: world)`.

**Pan end.** A pan *drag* only ever moves the view. A pan *click* (travel ≤
`dragThreshold`) is where sticky pan ends: every click in the Pan tool arrives here
(the whole surface pans and nodes stop taking hits), so this is the one place that
can hear "a single click anywhere". `exitStickyPan()` is a no-op unless
`enterStickyPan()` armed it, so a deliberately chosen Pan tool is unaffected.

### 12.5 Sticky pan

```swift
@Published private(set) var toolBeforeStickyPan: EditorTool?
func enterStickyPan() {
    guard toolBeforeStickyPan == nil, selectedTool != .pan else { return }  // re-entry is a NO-OP,
    toolBeforeStickyPan = selectedTool                                       // never an overwrite
    setTool(.pan)
}
func exitStickyPan() {
    guard let previous = toolBeforeStickyPan else { return }
    toolBeforeStickyPan = nil
    setTool(previous)
}
```

Double-click on empty canvas in Pointer/Multi-Select borrows the hand; the next
single click anywhere gives the tool back. It is the **only** gesture that changes
the active tool — H, the palette and the Space bar are the other routes to Pan,
and none of them is undone by a click. No cursor work is needed: the clip view
subscribes to `$selectedTool` and already returns the open hand for `.pan`.

### 12.6 Text focus

A canvas gesture must take keyboard focus away from any text field that still owns
it, or ⌘Z/⌘X/⌘C keep going to an invisible search box for the rest of the session:

```swift
guard let window = NSApp.keyWindow, window.firstResponder is NSText else { return }
window.endEditing(for: nil)
if window.firstResponder is NSText { window.makeFirstResponder(nil) }  // SwiftUI can hand it back
```

Called at the head of both `onChanged` handlers. The `is NSText` guard makes the
common case two property reads. `CanvasClipView.mouseDown` carries the same three
lines but cannot do the job alone — the SwiftUI hosting view above it consumes the
event, so that override never runs for a canvas click.

### 12.7 Hover

One `onContinuousHover` in the named canvas space drives everything. Hover follows
the tool's semantics:

* Frozen entirely while a node drag, a pan, or a link drag is in flight (a drag
  owns the pointer; the rings must not flicker under the dragged element).
* **Link preview free end** — published only while `pendingLinkStartID != nil` in
  the Link tool; the editor is otherwise idle in that state, so this is its only
  per-frame publish.
* **Ghost node** — with an add tool active, publish `snapIfNeeded(clampWorld(...))`;
  the ghost draws a dashed, `disabled`-opacity outline of the node that click would
  place, at exactly that point.
* **Node hover** in Pointer, Multi-Select and Link; **link hover** only in Pointer
  and only when no node was hit.
* The Link tool's **pending start node is kept out of `hoveredNodeID`** — it
  already wears the dashed pending ring, and a hover ring on top says a second,
  different thing. The two-click flow's self-loop arming requires
  `hoverLeftPendingStart` first (otherwise the very click that set the start would
  arm a loop under the cursor that made it); `pointerOverLinkStart` then tells the
  preview to draw the loop arc.
* On `.ended`: clear hovers, ghost and preview — **unless** a link drag owns the
  preview, in which case the pointer leaving the tracker must not erase the line it
  is drawing.

Both `pendingLinkStartID` changes and tool changes reset `hoverLeftPendingStart`
and `pointerOverLinkStart`, because a new pending start begins a new gesture.

### 12.8 Context menus

**Empty canvas / link** (SwiftUI `.contextMenu` on the canvas). The clip view
records the link under the right-click *before* the menu is built
(`contextMenuLinkID`); hover is the fallback for keyboard-driven menus.

* Link present → *Edit Parameters…*, a *Customer Class* picker (submenu with native
  check marks, rows as class chips) when there is more than one class, an
  *Exit Class* picker (`Same as entry (Class N)` + a divider + existing classes plus
  one "next" slot so a link can be promoted to a brand-new derived class), then
  *Delete Link* (destructive).
* Otherwise → Paste · Duplicate Selection │ Select All · Deselect All │ Zoom to
  Fit · Zoom to Selection · Actual Size │ Snap to Grid toggle.

**Node** (`.contextMenu` on each node view): when the right-clicked node is part of
a ≥2-node selection, the eight align/distribute commands first, then a divider.
Then Copy / Cut / Duplicate — labelled `"Copy (3 nodes)"` when acting on a group —
and Paste; then *Edit Parameters…*; then *Delete <Kind>*. A right-clicked node
**not** already in the selection becomes the sole selection first, so the
operation acts on it; a node inside a multi-selection keeps its group.

**Right-click menus carry no `keyboardShortcut`.** Every command is also in the
menu bar, which owns and displays its key equivalent; repeating it here would
register a second competing equivalent that a shortcut audit cannot see. Titles
are copied verbatim from the menu bar so one command never wears two names.

---

## 13. Keyboard, wheel, cursor (the AppKit clip view)

`CanvasClipView: NSView` is `isFlipped` (SwiftUI lays out top-left origin, so
flipping makes AppKit event locations line up with SwiftUI's space) and
`acceptsFirstResponder`.

### 13.1 Mouse-down monitor

A local monitor for `.leftMouseDown` / `.rightMouseDown` runs **before SwiftUI
sees the click** (installed in `viewDidMoveToWindow`, removed when the window goes
away), guarded on `event.window === window` and `bounds.contains(point)`:

* right-click or ⌃-click → record `contextMenuLinkID = editor.makeScene().hitLink(at:)?.id`;
* left mouse-down → record `lastMouseDownExtendsSelection` (⇧ or ⌘) and
  `lastMouseDownDuplicates` (⌥), and take first responder (unless a text field has
  it) so Delete, arrows and Space work from the first click.

These are **plain stored properties, not `@Published`** — they are read once when
the click resolves and must not trigger a redraw.

### 13.2 Wheel, pinch, smart zoom, middle button

```swift
override func scrollWheel(with e: NSEvent) {
    if e.modifierFlags.contains(.option) || .command {
        let delta = e.hasPreciseScrollingDeltas ? e.scrollingDeltaY/10 : e.deltaY
        editor.zoom(by: pow(1.1, delta), about: convert(e.locationInWindow, from: nil))
    } else {
        let step = e.hasPreciseScrollingDeltas ? 1 : 20      // linePanStep for a mouse wheel
        editor.pan(by: CGSize(width: e.scrollingDeltaX*step, height: e.scrollingDeltaY*step))
    }
}
override func magnify(with e: NSEvent) {
    editor.zoom(by: 1 + e.magnification, about: convert(e.locationInWindow, from: nil))
}
override func smartMagnify(with e: NSEvent) {   // two-finger double-tap
    editor.canZoomToSelection ? editor.zoomToFitSelection() : editor.zoomToFit()
}
```

Wheel and pinch zooms **leave the animation token alone** so they track the
pointer 1:1; menu/cluster/fit zooms bump it and glide.

Middle button (`otherMouseDown/Dragged/Up`) pans without changing the tool, using
deltas between view-space locations (sign-safe in the flipped view).

### 13.3 Keys

Never hijack a key while ⌘/⌃/⌥ is down (those go through the menu) — except
⌥Tab / ⌥⇧Tab, which walk the links attached to the selected node.

| Key | Action |
|---|---|
| Space (down/up, `isARepeat` ignored) | `isSpacePanning` — temporary pan in every tool |
| ⌫ / ⌦ (51, 117) | `deleteSelection()` |
| Esc (53) | `deselectAll()` — never reaches here mid-drag; the canvas monitor spends it |
| Return / keypad Enter (36, 76) | `openParameterEditorForSelection()` |
| Tab / ⇧Tab | walk nodes in reading order, revealing an off-screen target; falls through to `super` when there is nothing to walk |
| ⌥Tab / ⌥⇧Tab | walk the links attached to the selected node, revealing both endpoints |
| Arrows | **with a selection**: nudge it; **with nothing selected**: scroll the view by one wheel line (⇧ = four) |
| single letters | tool switch via `EditorTool(shortcutCharacter:)` |
| anything else | `super.keyDown` |

Arrow nudge step: `snapToGrid ? gridSpacing * (shift ? 4 : 1) : (shift ? 10 : 1)`
world pt — a whole grid cell under Snap to Grid so an arrow can never knock a
snapped node off the grid. The pan step is in **display** points (the wheel's own
line step), so a keyboard scroll covers the same distance on screen at every zoom
— which is what a scroll is, and what a nudge deliberately is not.

`keyUp` on any arrow calls `endNudgeRun()` so a held key lands as exactly one
"Move Nodes" undo step; `resignFirstResponder` also ends a Space pan and closes an
open nudge run (the key-up would otherwise never arrive).

`revealIfOffscreen` pans just enough to bring a node inside the viewport with an
88 pt margin (wide enough to clear the body and its label block); a node already
on screen is left alone so tabbing through a visible row never jitters the view.

### 13.4 Cursor

The clip view is the **sole owner** of the cursor: one cursor rect over `bounds`,
re-evaluated by `refreshCursor()` whenever tool / hover / drag flags change (driven
by a Combine merge). No push/pop pairs anywhere, so a tool switch while the pointer
is elsewhere can never leave a stale cursor behind.

```swift
if isPanningCanvas || isDraggingNode → .closedHand
if isSpacePanning                    → .openHand
switch selectedTool {
case .pan                                              → .openHand
case .multiSelect, .addStation/.addBuffer/.addSource/.addSink → .crosshair
case .addLink   → hoveredNodeID != nil ? .pointingHand : .arrow
case .select    → hoveredNodeID != nil ? (optionHeld ? .dragCopy : .arrow)
                : hoveredLinkID != nil ? .pointingHand : .arrow
}
```

**One meaning per cursor:** the hand is panning and nothing else; the plain arrow
is "movable object" (HIG, OmniGraffle, Keynote and Figma all agree); the copy
cursor previews an ⌥-drag. `flagsChanged` refreshes while the pointer sits over a
node so the ⌥ affordance is visible *before* the drag starts. `refreshCursor()`
also flips the cursor immediately when the pointer is already inside, instead of
waiting for the next mouse move.

---

## 14. Scroll container and metrics

The canvas sits in an `NSView` holding a clip view (with the SwiftUI hosting view
pinned to its four edges), a legacy-style vertical `NSScroller` on the right, a
horizontal one on the bottom, and a corner filler — all AutoLayout, so the
scrollers keep the always-visible / grey-when-inactive legacy appearance.

**Coordinator subscriptions** (re-bound when the tab switches, which also swaps
the hosting view's root and the clip view's editor):

* geometry (`$nodes`, `$canvasScale`, `$canvasPanOffset`) merged and **throttled to
  16 ms** — `nodes` publishes on every drag frame, so this is one scroller refresh
  per frame at most;
* cursor state (tool, hovers, pan/drag/space flags) → `refreshCursor()`;
* `$pendingFitOnAppear` filtered to `true` → consume a one-shot fit.

**Pending fit.** A bulk insert can land a sub-network clear off-screen. The model
raises `pendingFitOnAppear`; only the view side knows the viewport, so only it can
act. It is consumed in **two** places — a `.onChange` in `NetworkCanvasView` (fast
path) and this Combine sink (the guarantee, because the canvas view is the root of
the hosting view and its `body` is not re-evaluated on every editor publish).
Whichever reaches the flag first clears it; the other becomes a no-op. Both clear
the flag **before** the fit (so the re-layout the fit provokes cannot run it twice)
and skip while the viewport is under 1 pt (`zoomToFit()` is a no-op there and would
silently swallow the request); the sink substitutes the clip view's own bounds when
the canvas has not reported a size yet.

### `CanvasScrollMetrics`

A pure function of nodes + transform. Only node geometry feeds it — banners and
overlays never contribute.

```swift
static let contentMargin: CGFloat = 16      // half-node pad
static let overflowEpsilon: CGFloat = 2     // sub-pixel floor

raw{Min,Max}{X,Y} = worldBounds.{min,max}{X,Y} * scale ∓ contentMargin   // pan-INDEPENDENT
on-screen bbox    = raw + pan
oLeft = max(0, -minX);  oRight = max(0, maxX - viewport.width);  (same for top/bottom)
each overflow < epsilon → 0
hEnabled = (oLeft + oRight) > epsilon
hKnob    = viewport.width / (viewport.width + oLeft + oRight)
panAt0X  = -rawMinX                       // content's left edge at display x = 0
panAt1X  = viewport.width - rawMaxX       // content's right edge at the viewport edge
hValue   = clamp01((pan.width - panAt0X) / (panAt1X - panAt0X))
offsetX(forNormalized n) = panAt0X + n*(panAt1X - panAt0X)
```

Scroll targets are expressed in **pan space** via `panAt0/1` from the
*pan-independent* bbox, so the mapping stays stable while the user drags the knob
and a network dragged off anywhere can still be brought back to a well-defined
"left edge" view. Pan is never snapped back when overflow disappears — the user is
allowed to drag the network off-frame and recover it manually.

Scroller actions: `decrementPage`/`incrementPage` step `max(0.05, knob*0.9)`,
`decrementLine`/`incrementLine` step `0.05`, `knob`/`knobSlot` take
`sender.doubleValue`.

---

## 15. Model API (canvas-relevant surface)

### 15.1 Published state

```
selectedTool (private(set))   nodes    links    infiniteBuffers
selectedNodeID  selectedNodeIDs  selectedLinkID
multiSelectRect  multiSelectOrigin
pendingLinkStartID  pendingLinkPoint  activeLinkSourceID  activeCustomerClass
hoveredNodeID  hoveredLinkID
canvasScale  canvasPanOffset  canvasAnimationToken  canvasViewportSize (plain)
snapToGrid  snapSuspended  activeAlignGuides
isPanningCanvas  isDraggingNode  isSpacePanning
classFilter  stationUtilisation  pendingFitOnAppear  toolBeforeStickyPan (private(set))
```

Plain (non-published, read once, must not redraw):
`lastMouseDownExtendsSelection`, `lastMouseDownDuplicates`, `contextMenuLinkID`,
`nudgeRunIDs`, `lastNudgeTime`.

### 15.2 Selection

```swift
var selectionUnion: Set<UUID>            // selectedNodeIDs ∪ {selectedNodeID}
var hasAnySelection: Bool                // nodes or a link
var canZoomToSelection: Bool             // !selectionUnion.isEmpty

func setNodeSelection(_ group: Set<UUID>)   // 1 → selectedNodeID, n → selectedNodeIDs,
                                            // 0 → both cleared; ends a nudge run on change
func toggleNodeInSelection(_ id: UUID)      // ⇧/⌘-click; promotes the single selection
                                            // into the group first
func deselectAll()                          // the ONE implementation behind Escape,
                                            // ⌥⌘A and the context menu
func selectAll()                            // all nodes, then setTool(.select)
func handleCanvasTap(at world: CGPoint)     // add tools place; selection tools clear
                                            // selection, pending link AND the class filter
func handleNodeTap(nodeID:extendingSelection:)
func handleLinkTap(linkID:)                 // select; a repeat click cycles the class
```

Normalising a one-node group back to `selectedNodeID` is what keeps ⌘I and Return
working. The one exception: a **marquee result stays a group even at one node**, so
the align commands and the status-bar count agree with what the user just drew.

### 15.3 Multi-select

```swift
func beginMultiSelect(at world: CGPoint)          // origin + zero-size rect
func updateMultiSelect(to world: CGPoint)         // normalised rect
func finalizeMultiSelect(extending: Bool = false) // marqueeSelects predicate; ⇧ unions;
                                                  // then setTool(.select)
func clearMultiSelection()
var marqueeNodeCount: Int?                        // live count for the status bar
```

### 15.4 Zoom / pan

```swift
static let zoomRange: ClosedRange<CGFloat> = 0.1...4.0
static let zoomStep: CGFloat = 1.25
var canvasTransform: CanvasTransform

func zoomIn()  / zoomOut()                  // ×zoomStep about the viewport centre, animated
func zoom(by factor:, about displayAnchor:, animated: Bool = false)
func zoom(to newScale:, about displayAnchor:, animated:)   // clamped; no-op if unchanged
func setZoom(_ s: CGFloat)                  // absolute, about the centre, animated
func pan(by delta: CGSize)
func resetZoom()                            // ⌘0 — scale 1, pan .zero
func zoomToFit()                            // ⇧⌘0 — fit(nodes)
func zoomToFitSelection()                   // ⌥⇧⌘0 — fit(selection) or everything

private func fit(nodes targets:) {
    guard let bounds = CanvasScene.bounds(of: targets), viewport > 1 else { return }
    apply(CanvasTransform.fitting(worldRect: bounds, in: viewportSize,
                                  margin: 88, zoomRange: zoomRange), animated: true)
}
private func apply(_ t:, animated:) {
    if animated { canvasAnimationToken &+= 1 }   // the ONLY animation trigger
    canvasScale = t.scale; canvasPanOffset = t.pan
}
```

### 15.5 Snapping and nudging

```swift
static let gridSpacing: CGFloat = 28
func snapIfNeeded(_ p: CGPoint) -> CGPoint {
    guard snapToGrid, !snapSuspended else { return p }
    return CGPoint(x: (p.x/28).rounded()*28, y: (p.y/28).rounded()*28)
}
func nudgeStep(coarse: Bool) -> CGFloat
func nudgeSelection(by delta: CGSize)   // coalesced run, see below
func endNudgeRun()
```

**Nudge coalescing.** Holding an arrow fires ~15×/s; one undo per press would bury
the Edit menu. The first press of a run opens **one** undo group; every press
within `nudgeRunTimeout = 1.2 s` on the **same selection** mutates inside it. The
group closes on key-up, on a selection change, when another mutation begins, or
when the run goes quiet. Snapping is applied to the **anchor node only** (the
single selection, else the first in reading order) and the resulting delta given to
the whole group — re-snapping each node independently would collapse a group whose
members sit at different sub-grid offsets, silently destroying a hand-made layout.
If a whole-cell nudge on an already-snapped anchor rounds to zero, fall back to the
raw delta: an arrow press must never do nothing.

### 15.6 Node / link mutations

```swift
func addNode(kind:at:name:) -> NetworkNode      // auto-names S1/B1/Src1/Sink1
func addLink(fromID:toID:customerClass:toCustomerClass:routingProbability:) -> NetworkLink
func moveNode(id:to:snap: Bool = true)
func deleteNode(id:)      // also removes every attached link
func deleteLink(id:)
func deleteSelection()    // nodes + their links AND a selected link; names the undo step
                          // "Delete Link" / "Delete Node" / "Delete Selection"
func copySelection() / cutSelection() / pasteSelection() / duplicateSelection()
func duplicateSelectionInPlaceForDrag() -> Set<UUID>
func insertSubnetwork(nodes:links:…:at:actionName:detail:) -> Set<UUID>
func straightenNetwork()  / fitNetworkToWindow()
func clear() / loadNetwork(document:)
```

Clipboard: nodes plus **only the links whose two endpoints are both in the
selection** (linking out of the clipboard is meaningless). Paste offsets copies by
60 pt (≈ two grid cells) so a paste is visibly separate; the ⌥-drag path passes
offset 0 and `announce: false`. All three paths go through one
`appendRenamedCopies` helper that re-primes the name counters against what is
actually on the canvas (`max(counter, observedMax)`) and rebuilds links against a
fresh id map — three call sites that must agree or the document grows two nodes
called "S3".

`cutSelection` refuses a link-only selection (Cut is copy-then-delete and the
clipboard holds nodes; ⌘X must not destroy what ⌘V cannot bring back), and drops a
separately-selected link from a mixed selection before deleting.

**Alignment / distribution** (context menu; no-ops below 2 nodes, distribution below
3): Align Top / Bottom / Left / Right (to the extreme of the selection),
Align Horizontal / Vertical Centres (to the midpoint of the selection's own
extent), Distribute Horizontally / Vertically (ends fixed, interior evenly spaced).

### 15.7 Link creation rules (`handleLinkSelection`)

First click sets the chain start:
* a **sink** is refused with a reason (nothing may leave a sink);
* a **source** additionally fixes `activeCustomerClass = customerClassIndex(for:)`
  and `activeLinkSourceID`;
* status: `"Link start: <name>. Click target node."`

Second click on the **same** node = self-loop: allowed on a station; refused with a
specific sentence for a source ("no service to repeat"), a sink ("where jobs
leave") and a buffer ("no service to repeat — put the loop on the station it
feeds"), each clearing the pending start.

Otherwise: candidate classes are `[classOf(source)]` for a source, or the set of
**incoming** classes for a buffer/station (refused when it has no incoming links).
Subtract the classes already used on this exact directed pair; refuse when nothing
is left ("All available classes already linked from A to B."). Prefer class 0, else
the lowest available. Create the link at `p = 1.0`, select it, and **continue the
chain** by making the target the new pending start — unless it is a sink, which
ends the chain.

After creating, sum the outgoing probabilities on that class from the start node;
if it exceeds 1 + 1e-6, say so and point at the inspector's "Balance to 1". A
self-loop hits this every time (the station's forward link already carries 1.0),
which would otherwise leave the document silently unrunnable.

`cycleLinkCustomerClass` walks `(current + offset) % totalClasses` and takes the
first class not already used by another link on the same pair.

---

## 16. Overlays

Shared chrome (`canvasFloatingPanel()`): `Spacing.s` padding, a **flat, opaque**
`surface` rounded rect (never a material — a blurred panel over a dotted grid
shifts tone as the user pans and drops the legend chips below the certified
contrast), a hairline separator stroke, a card shadow, and another `Spacing.s` of
outer padding.

* **Class legend** — bottom-**leading**, only when `numberOfCustomerClasses > 1`.
  One chip per class; clicking pins `classFilter`, clicking again clears it;
  non-active chips dim while a filter stands. Tooltip and accessibility value say
  which.
* **Zoom cluster** — bottom-**trailing**: zoom-out button (disabled at the floor),
  a percentage menu (50 / 100 / 200 %, divider, Zoom to Fit, Zoom to Selection),
  zoom-in (disabled at the ceiling), a vertical rule, Zoom to Fit, and a Snap to
  Grid toggle that dims to `disabled` opacity while `snapSuspended` (⌃ held) so the
  override is visible, not merely in effect.
* The two corner panels **never share a corner**, so they cannot collide at any
  window width.
* **Empty hint** — centred, shown when `nodes.isEmpty`: an empty state with an icon,
  a title, a message that states the model's shape, and up to two action buttons
  (archetype first — it is the shortest path from a blank page to a result — then
  examples). It is an **overlay, not a replacement**, so the canvas keeps its frame
  and gestures; there is deliberately **no blanket `allowsHitTesting(false)`** —
  the empty state opts its icon and text blocks out individually, so a click
  through the middle of the text still reaches the canvas and places a node while
  the buttons stay live. Neither button carries a key equivalent (the File menu
  already owns those keys), and their existence is *not* gated on live AppKit menu
  state — reading that from inside a `body` made the most prominent control on an
  empty canvas blink out on unrelated re-renders.
* **Status bar** below the canvas: tool · zoom % · selection summary (or
  "Selecting N nodes" in accent while a marquee is live) · primitive counts
  (`ViewThatFits`: full words, else symbols) · snap state (with "Free placement"
  while suspended) · buffer regime · pan offset when non-zero · run progress ·
  maximize button. 11-pt with monospaced digits so numbers do not jitter.

---

## 17. Performance architecture

**Scene memoisation.** `CanvasContentView.body` runs on every editor publish
(status entries, hover, tool changes). A `SceneCache` (a `@State` reference type)
returns the cached `CanvasScene` unless `(nodes, links, transform, classFilter,
routePlan)` changed. Unchanged arrays compare by buffer identity, so the check is
O(1) on the frames that matter. The route plan is part of the key precisely
because it is frozen during a drag — the release is exactly the frame on which the
nodes are unchanged and the plan is not.

**Route-plan freeze + eased transition.** The plan is cached on `(nodes, links)`;
while `isDraggingNode`, the last plan is returned if `links` still matches. When
the plan does change, the view records the old one and bumps a generation counter
inside `withAnimation`:

```swift
private struct AnimatedLinkLayer: View, Animatable {
    nonisolated var progress: CGFloat     // animatableData
    let generation: Int
    let fromPlan, toPlan: LinkRoutePlan
    let scene: CanvasScene                // already built on toPlan
    let links: [NetworkLink]              // ALL links, so a blended scene bundles identically
    let classFilter: Int?
    let state: LinkLayerState

    var body: some View {
        let t = min(max(progress - CGFloat(generation - 1), 0), 1)
        if t >= 1 || fromPlan == toPlan {
            LinkLayerCanvas(scene: scene, state: state).equatable()      // free
        } else {
            LinkLayerCanvas(scene: CanvasScene(nodes: scene.nodes, links: links,
                                               transform: scene.transform,
                                               classFilter: classFilter,
                                               routePlan: .interpolated(fromPlan, toPlan, t)),
                            state: state).equatable()
        }
    }
}
```

A transition costs ~0.03 ms of plan interpolation plus ~0.3 ms of scene build per
frame for the 150 ms it lasts; a frame with no transition costs nothing extra.

**Animatable transform.** `CanvasContentView` is `Animatable` on
`(scale, panX, panY)` (`nonisolated` stored properties so SwiftUI's non-isolated
animation system can interpolate them) and carries
`.dsAnimation(canvasGlide, value: canvasAnimationToken)`. Programmatic zooms bump
the token and the whole scene glides as one; wheel and pinch leave it alone and
track the pointer 1:1.

**Other measures.** Grid, link, guide and preview layers are all `Equatable`
`Canvas`es with `.equatable()`. Node views are `Equatable`. Accessibility elements
for links are dropped while interacting. `stationUtilisation` is recomputed on a
**150 ms debounce** of `(nodes, links, infiniteBuffers)`, so a drag does not
re-solve the traffic equations per frame. Scroller refresh is throttled to 16 ms.

**Profiler.** `QNET_CANVAS_PROFILE=1` prints per-layer ms/frame and ms-between-frames
every 60 frames for four layers (`frame`, `nodes`, `links`, `grid`). Node cost
accumulates across a frame's `ForEach` and is flushed at the start of the next.
Measured budget (Apple silicon, `-O`, 1600×1000, 200 nodes / 400 links): route plan
4.2 ms once per layout change; scene build 0.28–0.29 ms; grid path 0.002–0.055 ms;
node inputs 0.007 ms; hit test 0.015–0.017 ms. A worst-case camera frame ≈ 0.35 ms
(~2 % of a 60 fps budget); a worst-case *edit* frame ≈ 4.5 ms, once.

Two offline gates worth reproducing: a **bench** driving the shipping
`LinkRoutePlan` / `CanvasScene` / `GridPath` builders (so the measured code is the
shipped code), and a **routing check** that fails if any link in any bundled
example is drawn through a node it is not attached to — the check that keeps the
probe shortcut honestly conservative.

---

## 18. Export

`CanvasSnapshotView` is a frozen copy of the canvas — no selection, hover, marquee
or gestures — composed from the **same** `GridCanvas`, `LinkLayerCanvas` and
`NetworkNodeView`, plus an optional class legend. That reuse is the point: the
figure cannot drift from the screen.

```swift
struct CanvasExportOptions: Equatable {
    enum Background { case canvas, white, transparent }
    var pixelScale = 2          // 1× / 2× / 4×, PNG only
    var background = .canvas
    var includesGrid = false
    var includesLegend = true
    static func load() -> Self  // remembered in UserDefaults
}
```

**Content rect.** Measured from a scene built at zoom 1 with no pan (where display
== world), so the bows the router actually chose are included rather than guessed:
union every `nodeWorldRect`, every `nodeLabelRect` and every point of every link
polyline, then inset by `−Spacing.l` for the ρ badge and a self-loop chip.

**Snapshot.** `size = content × zoom + 2·margin (+ legendBand when >1 class)`;
`pan = margin − content.min × zoom`; margin = `Spacing.xl`.

Commands: *Export Diagram as PDF…* and *as PNG…* (options sheet first, answers
remembered), *Copy as Image* (⌥⌘C — writes **both** PDF and TIFF to the pasteboard
so the receiving app picks; exports the selection when there is one, else
everything), *Print Diagram…* (⌘P — draws the same PDF page vector through a
`CGPDFPage` in a custom `NSView`, so paper and the panel's "Save as PDF" get vector,
not a 4× raster).

Everything renders **inside `NSAppearance(named: .aqua).performAsCurrentDrawingAppearance`**:
a figure landing in a paper sits on white, and one exported at midnight must look
the same as one exported at noon.

---

## 19. Design tokens

Views compose tokens; no view writes a raw colour, point size, opacity or radius.

**Colours** — `stationFill` / `bufferFill` / `sourceFill` / `sinkFill` (light/dark
pairs), `nodeStroke`, `nodeGlyph`, `gridDot` (black 26 % / white 30 %), `gridLine`
(black 12 % / white 14 %), `accent`, `accentStroke`, `hoverRing` (accent 35 %),
`selectionGlow` (accent 35 %), `selectionFillStrong` (accent 35 %), `marqueeFill`
(accent 8 %), `linkHalo` (accent 25 %), `surface`, `surfaceRaised`, `textPrimary` /
`textSecondary` / `textTertiary`, `separator(contrast)`.

**Opacity** — `linkStroke 0.75`, `arrowHead 0.85`, `linkHalo 0.25`, `dim 0.20`,
`disabled 0.40`, `marqueeFill 0.08`, `selectionFillStrong 0.35`.

**Stroke** — `hairline 1`, `hairlineBold 1.5`, `selectionRing 1.5`;
`hairline(contrast)` returns 1.5 under Increase Contrast.

**Motion** — `quick` (fast), `standard` (normal), and one canvas-only curve:

```swift
static let glide: Double = 0.20
static var canvasGlide: Animation? { reduceMotion ? nil : .easeOut(duration: glide) }
```

Eased **out only**: a viewport moving under the pointer must decelerate into place;
ease-in reads as lag on a gesture already committed to. Every motion token returns
`nil` under Reduce Motion, so route transitions, guide fades and camera glides all
land in one step instead of easing.

**Accessibility** is read from the *environment* (`\.accessibilityReduceMotion`,
`\.colorSchemeContrast`, differentiate-without-colour) inside views, not from
static flags — otherwise SwiftUI has no reason to re-run the body when the user
flips the switch.

---

## 20. Implementation order

1. `CanvasMath`, `CanvasTransform`, `NodeOutline` → a static canvas that draws
   nodes at the right places and hit-tests them.
2. `LinkGeometry.between` + `selfLoop`, `CanvasScene` without routing (`bulge = 0`)
   → arrows that land on outlines and are clickable.
3. `GridCanvas`, `NetworkNodeView`, `LinkLayerCanvas` → the picture.
4. Tools, canvas/node gestures, selection, marquee, undo grouping → an editor.
5. Zoom/pan: transform maths, `CanvasClipView` wheel/pinch/keyboard/cursor,
   scroll metrics, zoom cluster.
6. `CanvasObstacles` + `LinkRoutePlan` → routing. Add the offline routing check at
   the same time; it is what keeps the probe shortcut conservative.
7. `SmartGuides` + `AlignmentGuideLayer`, snap-vs-guide resolution, ⌃ override.
8. `SceneCache`, plan freezing, `AnimatedLinkLayer`, the profiler.
9. Link preview, drag-to-connect, self-loop gesture, sticky pan, Escape cancel.
10. Overlays, export, accessibility elements.

## 21. Acceptance checklist

Behaviours that are easy to lose and expensive to rediscover.

- [ ] At zoom 1 with pan zero, world == display; an old document opens in place.
- [ ] A click lands on exactly the node/link that is drawn under it, at 10 % and 400 % zoom.
- [ ] ⌥-scroll and pinch keep the world point under the pointer fixed, to the pixel.
- [ ] Zoom to Fit frames everything with an 88 pt margin and glides; wheel zoom does not glide.
- [ ] A tandem chain stays **dead straight**; only links that would cross a body bow.
- [ ] A bowed link uses the smallest ladder rung that clears; a detour bows *away* from the drawing's centroid.
- [ ] Opposite-direction pairs sit on opposite sides of the chord and stay there.
- [ ] Multi-class siblings bundle 8 world pt apart; extra self-loops nest outward.
- [ ] A class filter changes what is drawn but never where the bundles sit.
- [ ] Dragging a node does **not** re-plan routes; releasing eases them over 150 ms.
- [ ] Alignment guides run *between* the dragged node and the partner it locked onto, with end ticks.
- [ ] With Snap to Grid on, the nearer of grid and guide wins **per axis**.
- [ ] Holding ⌃ mid-drag suspends both, live, and the status bar + zoom cluster say so.
- [ ] ⌥-drag duplicates and carries the copies, as **one** undo step.
- [ ] Escape mid-drag restores the start positions and leaves **no** undo entry; Escape otherwise deselects.
- [ ] Escape during an ⌥-drag does **not** cancel (documented, not a bug).
- [ ] A marquee selects every node whose **body** it touches, and the live highlight matches the commit exactly.
- [ ] A zero-area band from a Multi-Select click is discarded, so double-click-to-pan works in both selection tools.
- [ ] Double-click on empty canvas borrows the hand; one click anywhere gives the tool back; choosing a tool ends the borrow.
- [ ] A double-click with an add tool places **one** node, at any zoom, with snapping on or off.
- [ ] Drag-to-connect shows the exact geometry release would create, self-loop included.
- [ ] Out-and-back onto the start node draws a self-loop; a shaky click that never left is honoured as a click.
- [ ] Releasing a link drag on empty canvas leaves the network untouched.
- [ ] Holding an arrow key produces **one** undo entry; a whole grid cell per press while snapping.
- [ ] Arrows with nothing selected scroll the view instead of doing nothing.
- [ ] Tab walks nodes in reading order and pans off-screen targets into view; ⌥Tab walks a node's links.
- [ ] Clicking the canvas takes focus away from a text field (⌘Z keeps working).
- [ ] The cursor is never stale after a tool switch made while the pointer is elsewhere.
- [ ] ⌥ over a node flips to the copy cursor before the drag starts.
- [ ] Probability chips disappear below 50 % zoom, declutter above it, and the hovered/selected chip always wins.
- [ ] Node label rows drop out at 0.35 / 0.45 / 0.6 zoom; a hovered or selected node keeps its name.
- [ ] VoiceOver can reach and act on every node **and** every link.
- [ ] Under Reduce Motion nothing eases — routes, guides and camera all land in one step.
- [ ] An export looks identical to the screen, on white, from a dark-mode session.
