// Canvas and editor golden dump for Qnet 0.90.34. NOT part of Qnet: scripts/make-golden-canvas.sh
// appends this file to a throwaway copy of 2_QNET's QnetGUIApp.swift (commit dc066f0, extracted
// outside Dropbox), adds one call (runGoldenCanvasIfRequested) at the end of QnetGUIApp.init, and
// makes one access-level edit to the copy so the node label rows can be read: `private var
// detailText` and `private var rateText` in NetworkCanvasLayers.swift (NetworkNodeView) lose their
// `private`. Nothing else in the copy changes.
//
//   Qnet --golden-canvas <file.bnet> <out.json>
//
// Loads the network into a NetworkEditorModel (loadNetwork, as File ▸ Open does) and writes the
// scene 0.90.34 draws for it: every node's world and display rects and label rows, every link's
// bundle slot, route-plan bow and fully built LinkGeometry, the grid, Zoom to Fit and the image
// export's content rect, at zoom 1 / pan 0 and at a handful of other (scale, pan) pairs.
// golden/canvas/README.md lists every field.
//
//   Qnet --golden-edits <scenario.json> <outdir> <examples-dir>
//
// Replays a scripted edit sequence through NetworkEditorModel's own methods and writes, after
// every step, step-NN.bnet (TabDocumentWriter.write, i.e. File ▸ Save) and step-NN.json (the
// model's observable state). After the last step the last file is reopened into a fresh model
// and saved again as reopened.bnet. golden/edits/README.md documents the step vocabulary.
//
// Every number is written with %.17g, so it parses back to the same Double.
import Foundation
import AppKit
import CoreGraphics

// MARK: - A small ordered JSON writer

indirect enum GoldenJSON {
    case num(Double)
    case int(Int)
    case str(String)
    case bool(Bool)
    case null
    case arr([GoldenJSON])
    case obj([(String, GoldenJSON)])

    static func pt(_ p: CGPoint) -> GoldenJSON { .arr([.num(Double(p.x)), .num(Double(p.y))]) }
    static func size(_ s: CGSize) -> GoldenJSON { .arr([.num(Double(s.width)), .num(Double(s.height))]) }
    static func rect(_ r: CGRect) -> GoldenJSON {
        .obj([("x", .num(Double(r.origin.x))), ("y", .num(Double(r.origin.y))),
              ("width", .num(Double(r.size.width))), ("height", .num(Double(r.size.height)))])
    }
    static func opt(_ v: GoldenJSON?) -> GoldenJSON { v ?? .null }

    private var isScalar: Bool {
        switch self {
        case .arr(let a): return a.allSatisfy { if case .arr = $0 { return false }; if case .obj = $0 { return false }; return true }
        case .obj: return false
        default: return true
        }
    }

    static func number(_ d: Double) -> String {
        if d.isNaN { return "\"NaN\"" }
        if d.isInfinite { return d > 0 ? "\"Infinity\"" : "\"-Infinity\"" }
        return String(format: "%.17g", d)
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }

    func render(_ indent: Int = 0) -> String {
        let pad = String(repeating: " ", count: indent)
        let inner = String(repeating: " ", count: indent + 1)
        switch self {
        case .num(let d): return Self.number(d)
        case .int(let i): return String(i)
        case .str(let s): return Self.quote(s)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .arr(let a):
            if a.isEmpty { return "[]" }
            if isScalar { return "[" + a.map { $0.render(0) }.joined(separator: ", ") + "]" }
            // An array of points stays one point per line.
            return "[\n" + a.map { inner + $0.render(indent + 1) }.joined(separator: ",\n") + "\n" + pad + "]"
        case .obj(let kv):
            if kv.isEmpty { return "{}" }
            return "{\n" + kv.map { inner + Self.quote($0.0) + ": " + $0.1.render(indent + 1) }.joined(separator: ",\n")
                + "\n" + pad + "}"
        }
    }
}

// MARK: - Entry point

extension QnetGUIApp {
    @MainActor
    func runGoldenCanvasIfRequested() {
        let args = CommandLine.arguments
        if args.count >= 4, args[1] == "--golden-canvas" {
            GoldenCanvasDump.run(input: URL(fileURLWithPath: args[2]), out: URL(fileURLWithPath: args[3]))
        }
        if args.count >= 5, args[1] == "--golden-edits" {
            GoldenEditReplay.run(scenario: URL(fileURLWithPath: args[2]),
                                 out: URL(fileURLWithPath: args[3]),
                                 examples: URL(fileURLWithPath: args[4]))
        }
    }
}

// MARK: - --golden-canvas

@MainActor
enum GoldenCanvasDump {
    typealias J = GoldenJSON

    /// The viewport every view is built for (the canvas's GeometryReader size in the app).
    static let viewport = CGSize(width: 1200, height: 800)

    static func run(input: URL, out: URL) -> Never {
        guard let data = try? Data(contentsOf: input),
              let doc = try? JSONDecoder().decode(NetworkDocument.self, from: data) else {
            print("ERROR: could not read or decode \(input.path)")
            exit(1)
        }
        let editor = NetworkEditorModel()
        editor.loadNetwork(document: doc)
        editor.currentFileURL = input
        editor.canvasViewportSize = viewport
        editor.refreshStationUtilisation()
        let nodes = editor.nodes, links = editor.links
        let plan = editor.routePlan
        let nodeIndex = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, $0.offset) })

        // Nodes: world-space facts, independent of the camera.
        var nodeRows: [J] = []
        for (i, n) in nodes.enumerated() {
            let probe = NetworkNodeView(node: n, scale: 1, isSelected: false, isHovered: false,
                                        isMarqueeCandidate: false, isPendingLinkStart: false,
                                        infiniteBuffers: editor.infiniteBuffers,
                                        utilisation: editor.stationUtilisation[n.id])
            let rho = editor.stationUtilisation[n.id]
            nodeRows.append(.obj([
                ("index", .int(i)),
                ("id", .str(n.id.uuidString)),
                ("name", .str(n.name)),
                ("kind", .str(n.kind.rawValue)),
                ("position", .pt(n.position)),
                ("outlineSize", .size(NodeOutline.size(for: n.kind))),
                ("boundingRadius", .num(Double(NodeOutline.boundingRadius(for: n.kind)))),
                ("worldRect", .rect(CanvasScene.nodeWorldRect(n))),
                ("labelRect", .rect(CanvasScene.nodeLabelRect(n))),
                ("labelBlockHeight", .num(Double(NodeOutline.labelBlockHeight(for: n.kind)))),
                ("detailText", .opt(probe.detailText.map(J.str))),
                ("rateText", .opt(probe.rateText.map(J.str))),
                ("utilisation", .opt(rho.map(J.num))),
                ("utilisationBadgeText", .opt(rho.map { J.str("ρ \(DS.Number.format($0, significantDigits: 2))") })),
            ]))
        }

        // Links: bundle slot and route-plan bow (world space).
        let groups = CanvasScene.bundleGroups(links)
        var linkRows: [J] = []
        for (i, l) in links.enumerated() {
            let key = CanvasScene.PairKey(from: l.fromNodeID, to: l.toNodeID)
            let siblings = groups[key] ?? [l]
            let myIndex = siblings.firstIndex(where: { $0.id == l.id }) ?? 0
            let count = CGFloat(siblings.count)
            let offsetWorld = (CGFloat(myIndex) - (count - 1) / 2) * CanvasScene.bundleSpacing
            let selfLoop = l.fromNodeID == l.toNodeID
            let hasOpposite = !selfLoop && groups[CanvasScene.PairKey(from: l.toNodeID, to: l.fromNodeID)] != nil
            let baseBulge: CGFloat = hasOpposite ? CanvasScene.pairBulge : 0
            let bulge = plan.bulge(for: l.id)
            let kind: String
            if bulge == 0 { kind = "straight" }
            else if bulge == baseBulge { kind = "base" }
            else if CanvasScene.bulgeLadder.contains(abs(bulge)) { kind = "ladder" }
            else { kind = "solved" }
            linkRows.append(.obj([
                ("index", .int(i)),
                ("id", .str(l.id.uuidString)),
                ("fromIndex", .opt(nodeIndex[l.fromNodeID].map(J.int))),
                ("toIndex", .opt(nodeIndex[l.toNodeID].map(J.int))),
                ("from", .str(editor.node(with: l.fromNodeID)?.name ?? "?")),
                ("to", .str(editor.node(with: l.toNodeID)?.name ?? "?")),
                ("customerClass", .int(l.customerClass)),
                ("toCustomerClass", .opt(l.toCustomerClass.map(J.int))),
                ("routingProbability", .num(l.routingProbability)),
                ("isSelfLoop", .bool(selfLoop)),
                ("bundleIndex", .int(myIndex)),
                ("bundleCount", .int(siblings.count)),
                ("offsetWorld", .num(Double(offsetWorld))),
                ("selfLoopExtraRadiusWorld", .opt(selfLoop ? J.num(Double(CGFloat(myIndex) * CanvasScene.bundleSpacing)) : nil)),
                ("hasOpposite", .bool(hasOpposite)),
                ("baseBulge", .num(Double(baseBulge))),
                ("lockSide", .bool(hasOpposite)),
                ("bulge", .num(Double(bulge))),
                ("bulgeSide", .int(bulge > 0 ? 1 : (bulge < 0 ? -1 : 0))),
                ("bulgeKind", .str(kind)),
            ]))
        }

        // Camera views.
        var views: [(String, CGFloat, CGSize)] = [
            ("identity", 1, .zero),
            ("document", doc.canvasScale, doc.canvasPanOffset),
            ("scale0.3", 0.3, CGSize(width: 40, height: -25)),
            ("scale0.4", 0.4, CGSize(width: -12.5, height: 33)),
            ("scale0.5", 0.5, CGSize(width: 120.5, height: 60.25)),
            ("scale2", 2, CGSize(width: -300, height: -150.75)),
        ]
        // Zoom to Fit through the model's own command.
        editor.zoomToFit()
        let fitScale = editor.canvasScale, fitPan = editor.canvasPanOffset
        if let _ = CanvasScene.bounds(of: nodes) { views.append(("zoomToFit", fitScale, fitPan)) }

        var viewRows: [J] = []
        for (name, scale, pan) in views {
            let t = CanvasTransform(scale: scale, pan: pan, viewportSize: viewport)
            let scene = CanvasScene(nodes: nodes, links: links, transform: t, classFilter: nil, routePlan: plan)
            viewRows.append(view(name: name, transform: t, scene: scene, editor: editor, nodeIndex: nodeIndex))
        }

        let bounds = CanvasScene.bounds(of: nodes)
        let export = CanvasImageExport.contentRect(nodes: nodes, links: links, routePlan: plan)
        let fitted = bounds.map { CanvasTransform.fitting(worldRect: $0, in: viewport, margin: 88,
                                                          zoomRange: NetworkEditorModel.zoomRange) }
        let root: J = .obj([
            ("file", .str(input.lastPathComponent)),
            ("numberFormat", .str("%.17g")),
            ("viewportSize", .size(viewport)),
            ("documentCanvasScale", .num(Double(doc.canvasScale))),
            ("documentCanvasPanOffset", .size(doc.canvasPanOffset)),
            ("infiniteBuffers", .bool(editor.infiniteBuffers)),
            ("nodes", .arr(nodeRows)),
            ("links", .arr(linkRows)),
            ("routePlanBowedCount", .int(plan.bowedCount)),
            ("contentBounds", .opt(bounds.map(J.rect))),
            ("zoomToFit", .obj([
                ("margin", .num(88)),
                ("scale", .num(Double(fitScale))),
                ("pan", .size(fitPan)),
                ("fittingScale", .opt(fitted.map { J.num(Double($0.scale)) })),
                ("fittingPan", .opt(fitted.map { J.size($0.pan) })),
            ])),
            ("exportContentRect", .opt(export.map(J.rect))),
            ("exportMargin", .num(Double(CanvasImageExport.margin))),
            ("views", .arr(viewRows)),
        ])
        do {
            try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
            try (root.render() + "\n").write(to: out, atomically: true, encoding: .utf8)
        } catch {
            print("ERROR: \(error.localizedDescription)")
            exit(1)
        }
        print("golden-canvas: \(input.lastPathComponent)")
        exit(0)
    }

    static func view(name: String, transform t: CanvasTransform, scene: CanvasScene,
                     editor: NetworkEditorModel, nodeIndex: [UUID: Int]) -> GoldenJSON {
        let s = t.scale
        // Grid (GridPath.build, the GridCanvas builder).
        let grid = GridPath.build(transform: t, size: viewport, gridSpacing: NetworkEditorModel.gridSpacing)
        let cell = NetworkEditorModel.gridSpacing * s
        func moves(_ p: Path?) -> Int {
            guard let p else { return 0 }
            var n = 0
            p.forEach { if case .move = $0 { n += 1 } }
            return n
        }
        let gridRow: J = .obj([
            ("cell", .num(Double(cell))),
            ("major", .num(Double(cell * 4))),
            ("minorAlpha", .num(Double(grid.minorAlpha))),
            ("majorAlpha", .num(Double(grid.majorAlpha))),
            ("minorDotCount", .int(moves(grid.minorDots))),
            ("majorLineCount", .int(moves(grid.majorLines))),
            ("minorFirstX", .num(Double(GridPath.firstLine(offset: t.pan.width, step: cell)))),
            ("minorFirstY", .num(Double(GridPath.firstLine(offset: t.pan.height, step: cell)))),
            ("majorFirstX", .num(Double(GridPath.firstLine(offset: t.pan.width, step: cell * 4)))),
            ("majorFirstY", .num(Double(GridPath.firstLine(offset: t.pan.height, step: cell * 4)))),
        ])

        var nodeRows: [J] = []
        for (i, n) in scene.nodes.enumerated() {
            let probe = NetworkNodeView(node: n, scale: s, isSelected: false, isHovered: false,
                                        isMarqueeCandidate: false, isPendingLinkStart: false,
                                        infiniteBuffers: editor.infiniteBuffers,
                                        utilisation: editor.stationUtilisation[n.id])
            let size = NodeOutline.size(for: n.kind)
            nodeRows.append(.obj([
                ("index", .int(i)),
                ("displayCentre", .opt(scene.displayCentres[n.id].map(J.pt))),
                ("bodyDisplaySize", .size(CGSize(width: size.width * s, height: size.height * s))),
                ("displayRect", .rect(t.toDisplay(CanvasScene.nodeWorldRect(n)))),
                ("labelDisplayRect", .rect(t.toDisplay(CanvasScene.nodeLabelRect(n)))),
                ("hitSlopLocal", .num(Double(3 / s))),
                ("strokeWidth", .num(Double(max(1, 2 * s)))),
                ("nameRowShown", .bool(s >= DS.Canvas.nameRowMinScale)),
                ("detailRowShown", .bool(s >= DS.Canvas.detailRowMinScale && probe.detailText != nil)),
                ("rateRowShown", .bool(s >= DS.Canvas.rateRowMinScale && probe.rateText != nil)),
                ("labelBlockDisplayWidth", .num(Double(max(56, NodeOutline.labelBlockWidth * min(s, 1.4))))),
                ("nameFontSize", .num(Double(DS.Canvas.nameSize(scale: s)))),
                ("detailFontSize", .num(Double(max(8, DS.Canvas.nameSize(scale: s) - 2)))),
            ]))
        }

        let chipsOn = s >= DS.Canvas.linkLabelMinScale
        // Bundle slots, as CanvasScene.init computes them (over ALL links).
        let groups = CanvasScene.bundleGroups(editor.links)
        func slot(_ l: NetworkLink) -> CGFloat {
            let siblings = groups[CanvasScene.PairKey(from: l.fromNodeID, to: l.toNodeID)] ?? [l]
            return CGFloat(siblings.firstIndex(where: { $0.id == l.id }) ?? 0)
        }
        func offsetWorld(_ l: NetworkLink) -> CGFloat {
            let count = CGFloat((groups[CanvasScene.PairKey(from: l.fromNodeID, to: l.toNodeID)] ?? [l]).count)
            return (slot(l) - (count - 1) / 2) * CanvasScene.bundleSpacing
        }
        var drawOrder: [UUID: Int] = [:]
        for (k, item) in scene.links.enumerated() { drawOrder[item.id] = k }
        var geometryByID: [UUID: LinkGeometry] = [:]
        for item in scene.links { geometryByID[item.id] = item.geometry }
        var linkRows: [J] = []
        for (i, l) in editor.links.enumerated() {
            guard let g = geometryByID[l.id] else {
                linkRows.append(.obj([("index", .int(i)), ("visible", .bool(false))]))
                continue
            }
            let route: J
            switch g.route {
            case .straight: route = .obj([("type", .str("straight"))])
            case .quad(let c): route = .obj([("type", .str("quad")), ("control", .pt(c))])
            case .cubic(let c1, let c2): route = .obj([("type", .str("cubic")), ("c1", .pt(c1)), ("c2", .pt(c2))])
            }
            let chipPolicy = (!chipsOn || l.routingProbability == 1.0) ? "never" : "declutter"
            let arrowLen = LinkGeometry.arrowLength(scale: s)
            linkRows.append(.obj([
                ("index", .int(i)),
                ("visible", .bool(true)),
                ("drawOrder", .opt(drawOrder[l.id].map(J.int))),
                ("parallelOffset", .num(Double(l.fromNodeID == l.toNodeID ? 0 : offsetWorld(l) * s))),
                ("selfLoopExtraRadius", .opt(l.fromNodeID == l.toNodeID ? J.num(Double(slot(l) * CanvasScene.bundleSpacing * s)) : nil)),
                ("bulge", .num(Double(editor.routePlan.bulge(for: l.id) * s))),
                ("lineWidth", .num(Double(LinkGeometry.lineWidth(scale: s)))),
                ("arrowLength", .num(Double(arrowLen))),
                ("wingSpread", .num(Double(arrowLen * tan(LinkGeometry.arrowHalfAngle)))),
                ("start", .pt(g.start)),
                ("base", .pt(g.base)),
                ("tip", .pt(g.tip)),
                ("wingLeft", .pt(g.wingLeft)),
                ("wingRight", .pt(g.wingRight)),
                ("route", route),
                ("labelAnchor", .pt(g.labelAnchor)),
                ("chipPolicy", .str(chipPolicy)),
                ("chipText", .opt(l.routingProbability == 1.0 ? nil
                                    : J.str(DS.Number.format(l.routingProbability, significantDigits: 2)))),
                ("chipFontSize", .num(Double(max(9, min(12, DS.Canvas.linkLabelSize * s))))),
                ("polyline", .arr(g.polyline.map(J.pt))),
            ]))
        }
        return .obj([
            ("name", .str(name)),
            ("scale", .num(Double(s))),
            ("pan", .size(t.pan)),
            ("viewportSize", .size(t.viewportSize)),
            ("visibleWorldRect", .rect(t.visibleWorldRect)),
            ("grid", gridRow),
            ("chipsShown", .bool(chipsOn)),
            ("nodes", .arr(nodeRows)),
            ("links", .arr(linkRows)),
        ])
    }
}

// MARK: - --golden-edits

/// Replays one scenario. Each step is one AppKit event: after it, the main run loop is turned
/// until the UndoManager's by-event group has closed (NetworkEditorModel's UndoManager keeps
/// `groupsByEvent = true`, as in the app, so every registration made inside one event lands in one
/// undo group). The view-level gestures the canvas implements privately (a node drag with its
/// smart guides and snap, the marquee, the link-tool drag, a click's double-click memo) are
/// replayed by the copies below, which call the model in the same order the view does.
@MainActor
final class GoldenEditReplay {
    typealias J = GoldenJSON

    struct Failure: Error { let message: String }

    var editor = NetworkEditorModel()
    let out: URL
    let examples: URL
    var viewport = CGSize(width: 1200, height: 800)
    var statusMark = 0
    var notes: [String] = []
    var guides: SmartGuides.Match?
    var marqueeCount: Int?
    // The docked inspector's drafts (InspectorPaneView): they persist across steps, as the pane does.
    let paneNode = NodeParameterDraft()
    let paneLink = LinkParameterDraft()
    var paneNodeID: UUID?
    var paneLinkID: UUID?
    /// View ▸ Panes ▸ Inspector: shown by default (AppSettings.Defaults.inspectorPaneVisible).
    var paneShown = true

    init(out: URL, examples: URL) {
        self.out = out
        self.examples = examples
    }

    static func run(scenario: URL, out: URL, examples: URL) -> Never {
        let replay = GoldenEditReplay(out: out, examples: examples)
        do {
            try replay.play(scenario)
        } catch let f as Failure {
            print("ERROR: \(scenario.lastPathComponent): \(f.message)")
            exit(2)
        } catch {
            print("ERROR: \(scenario.lastPathComponent): \(error.localizedDescription)")
            exit(2)
        }
        print("golden-edits: \(scenario.deletingPathExtension().lastPathComponent)")
        exit(0)
    }

    // MARK: Driver

    func play(_ scenario: URL) throws {
        let data = try Data(contentsOf: scenario)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let steps = root["steps"] as? [[String: Any]] else {
            throw Failure(message: "a scenario is {\"start\": …, \"steps\": [ … ]}")
        }
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        if let v = root["viewport"] as? [Any], v.count == 2 {
            viewport = CGSize(width: try num(v[0]), height: try num(v[1]))
        }
        editor.canvasViewportSize = viewport
        if let shown = root["inspectorPane"] as? NSNumber { paneShown = shown.boolValue }

        // Step 0: the starting document.
        var opening: [String: Any] = ["op": "empty"]
        if let start = root["start"] as? String {
            let url = examples.appendingPathComponent(start + ".bnet")
            try open(url, into: editor)
            opening = ["op": "open", "file": start + ".bnet"]
        }
        syncPane()
        endEvent()
        try record(step: 0, op: opening)

        // Two arrow presses or two inspector commits more than 1.2 s / 2 s apart do not coalesce, so
        // a replay that stalls between steps (a slow disk under the output folder) would record a
        // different undo history. Only a `wait` step may take that long.
        var lastStepEnd = Date()
        for (k, step) in steps.enumerated() {
            if Date().timeIntervalSince(lastStepEnd) > 0.5 {
                throw Failure(message: "step \(k + 1) began \(Date().timeIntervalSince(lastStepEnd)) s after the previous one; the replay must not stall")
            }
            notes = []
            guides = nil
            marqueeCount = nil
            guard let op = step["op"] as? String else { throw Failure(message: "step \(k + 1) has no op") }
            do {
                try perform(op, step)
            } catch let f as Failure {
                throw Failure(message: "step \(k + 1) (\(op)): \(f.message)")
            }
            lastStepEnd = Date()
            // The docked Inspector (shown by default) follows the selection.
            syncPane()
            endEvent()
            try record(step: k + 1, op: step)
        }

        // Reopen the last file in a fresh model and save it again.
        let last = out.appendingPathComponent(String(format: "step-%02d.bnet", steps.count))
        let fresh = NetworkEditorModel()
        try open(last, into: fresh)
        try TabDocumentWriter.write(editor: fresh, to: out.appendingPathComponent("reopened.bnet"))
    }

    /// File ▸ Open into a blank tab (QnetGUIApp.loadNetworkFile): decode, loadNetwork, remember the
    /// URL, and the "Loaded <file>." line. The app then runs Show Network Primitives, which writes
    /// to the Shell and the flag bar, not to the document; it is not replayed.
    func open(_ url: URL, into editor: NetworkEditorModel) throws {
        let doc = try JSONDecoder().decode(NetworkDocument.self, from: Data(contentsOf: url))
        editor.loadNetwork(document: doc)
        editor.currentFileURL = url
        editor.addStatus("Loaded \(url.lastPathComponent).", severity: .success)
    }

    /// Ends the current event: turns the main run loop until the UndoManager's by-event group is
    /// closed. A one-shot timer keeps the run loop from returning at once for want of a source.
    func endEvent() {
        for _ in 0..<200 {
            let timer = Timer(timeInterval: 0.001, repeats: false) { _ in }
            RunLoop.main.add(timer, forMode: .default)
            RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
            if editor.undoManager.groupingLevel == 0 { return }
        }
        print("ERROR: the undo group did not close at the end of an event")
        exit(3)
    }

    // MARK: Recording

    func nodeRef(_ id: UUID?) -> J {
        guard let id, let i = editor.nodes.firstIndex(where: { $0.id == id }) else { return .null }
        return .obj([("index", .int(i)), ("name", .str(editor.nodes[i].name))])
    }

    func linkRef(_ id: UUID?) -> J {
        guard let id, let i = editor.links.firstIndex(where: { $0.id == id }) else { return .null }
        let l = editor.links[i]
        return .obj([("index", .int(i)),
                     ("from", .str(editor.node(with: l.fromNodeID)?.name ?? "?")),
                     ("to", .str(editor.node(with: l.toNodeID)?.name ?? "?")),
                     ("customerClass", .int(l.customerClass))])
    }

    static func echo(_ v: Any) -> J {
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            let d = n.doubleValue
            return d == d.rounded() && abs(d) < 1e15 ? .int(Int(d)) : .num(d)
        }
        if let s = v as? String { return .str(s) }
        if let a = v as? [Any] { return .arr(a.map(echo)) }
        if let o = v as? [String: Any] { return .obj(o.keys.sorted().map { ($0, echo(o[$0]!)) }) }
        return .null
    }

    func record(step: Int, op: [String: Any]) throws {
        let um = editor.undoManager
        let status = editor.statusMessages.dropFirst(statusMark).map { e -> J in
            .obj([("text", .str(e.text)), ("severity", .str(e.severity.rawValue))])
        }
        let dirty = editor.hasUnsavedChanges
        let selected = editor.nodes.enumerated().filter { editor.selectedNodeIDs.contains($0.element.id) }
            .map { J.obj([("index", .int($0.offset)), ("name", .str($0.element.name))]) }
        var rows: [(String, J)] = [
            ("step", .int(step)),
            ("op", Self.echo(op)),
            ("status", .arr(Array(status))),
            ("selectedNodeID", nodeRef(editor.selectedNodeID)),
            ("selectedNodeIDs", .arr(selected)),
            ("selectedLinkID", linkRef(editor.selectedLinkID)),
            ("pendingLinkStartID", nodeRef(editor.pendingLinkStartID)),
            ("activeLinkSourceID", nodeRef(editor.activeLinkSourceID)),
            ("activeCustomerClass", .int(editor.activeCustomerClass)),
            ("selectedTool", .str(editor.selectedTool.rawValue)),
            ("toolBeforeStickyPan", .opt(editor.toolBeforeStickyPan.map { J.str($0.rawValue) })),
            ("canUndo", .bool(um.canUndo)),
            ("canRedo", .bool(um.canRedo)),
            ("undoActionName", .str(um.undoActionName)),
            ("redoActionName", .str(um.redoActionName)),
            ("snapToGrid", .bool(editor.snapToGrid)),
            ("snapSuspended", .bool(editor.snapSuspended)),
            ("classFilter", .opt(editor.classFilter.map(J.int))),
            ("canvasScale", .num(Double(editor.canvasScale))),
            ("canvasPanOffset", .size(editor.canvasPanOffset)),
            ("infiniteBuffers", .bool(editor.infiniteBuffers)),
            ("nodeCount", .int(editor.nodes.count)),
            ("linkCount", .int(editor.links.count)),
            ("numberOfCustomerClasses", .int(editor.numberOfCustomerClasses)),
            ("canPaste", .bool(editor.canPaste)),
            ("hasUnsavedChanges", .bool(dirty)),
            ("multiSelectRect", .opt(editor.multiSelectRect.map(J.rect))),
            ("isDraggingNode", .bool(editor.isDraggingNode)),
            ("parameterEditorTarget", nodeRef(editor.parameterEditorTarget?.id)),
            ("linkParameterEditorTarget", linkRef(editor.linkParameterEditorTarget?.id)),
            ("pendingFitOnAppear", .bool(editor.pendingFitOnAppear)),
        ]
        if let guides {
            rows.append(("alignGuides", .obj([
                ("adjustment", .size(guides.adjustment)),
                ("x", .opt(guides.x.map { J.num(Double($0)) })),
                ("y", .opt(guides.y.map { J.num(Double($0)) })),
                ("anchor", .opt(guides.anchor.map(J.rect))),
                ("xPartner", .opt(guides.xPartner.map(J.rect))),
                ("yPartner", .opt(guides.yPartner.map(J.rect))),
                ("xSpacing", .opt(guides.xSpacing.map { J.arr([.rect($0.first), .rect($0.second)]) })),
                ("ySpacing", .opt(guides.ySpacing.map { J.arr([.rect($0.first), .rect($0.second)]) })),
            ])))
        }
        if let marqueeCount { rows.append(("marqueeNodeCount", .int(marqueeCount))) }
        if !notes.isEmpty { rows.append(("notes", .arr(notes.map(J.str)))) }
        let name = String(format: "step-%02d", step)
        try (J.obj(rows).render() + "\n").write(to: out.appendingPathComponent(name + ".json"),
                                               atomically: true, encoding: .utf8)
        // File ▸ Save. Its own "Saved network to …" line is not part of the step's status.
        try TabDocumentWriter.write(editor: editor, to: out.appendingPathComponent(name + ".bnet"))
        statusMark = editor.statusMessages.count
    }

    // MARK: Argument parsing

    func num(_ v: Any?) throws -> CGFloat {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else {
            throw Failure(message: "expected a number, got \(String(describing: v))")
        }
        return CGFloat(n.doubleValue)
    }

    func int(_ v: Any?) throws -> Int { Int(try num(v)) }

    func bool(_ v: Any?, default d: Bool = false) -> Bool {
        guard let n = v as? NSNumber else { return d }
        return n.boolValue
    }

    func point(_ v: Any?) throws -> CGPoint {
        guard let a = v as? [Any], a.count == 2 else { throw Failure(message: "expected [x, y]") }
        return CGPoint(x: try num(a[0]), y: try num(a[1]))
    }

    func size(_ v: Any?) throws -> CGSize {
        let p = try point(v)
        return CGSize(width: p.x, height: p.y)
    }

    func string(_ v: Any?) throws -> String {
        guard let s = v as? String else { throw Failure(message: "expected a string, got \(String(describing: v))") }
        return s
    }

    /// A node by name (the first in document order with that name), by index into `nodes`, or
    /// as {"name": …} / {"index": …}.
    func node(_ v: Any?) throws -> UUID {
        if let o = v as? [String: Any] {
            if let n = o["name"] { return try node(n) }
            if let i = o["index"] { return try node(i) }
        }
        if let s = v as? String {
            guard let n = editor.nodes.first(where: { $0.name == s }) else { throw Failure(message: "no node named \(s)") }
            return n.id
        }
        if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
            let i = n.intValue
            guard editor.nodes.indices.contains(i) else { throw Failure(message: "no node #\(i)") }
            return editor.nodes[i].id
        }
        throw Failure(message: "bad node reference \(String(describing: v))")
    }

    /// A link by index into `links`, or {"from": node, "to": node, "class": c?} (the first match
    /// in document order), or {"index": …}.
    func link(_ v: Any?) throws -> UUID {
        if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
            let i = n.intValue
            guard editor.links.indices.contains(i) else { throw Failure(message: "no link #\(i)") }
            return editor.links[i].id
        }
        if let o = v as? [String: Any] {
            if let i = o["index"] { return try link(i) }
            let from = try node(o["from"]), to = try node(o["to"])
            let cls = try o["class"].map { try int($0) }
            guard let l = editor.links.first(where: {
                $0.fromNodeID == from && $0.toNodeID == to && (cls == nil || $0.customerClass == cls)
            }) else { throw Failure(message: "no such link \(o)") }
            return l.id
        }
        throw Failure(message: "bad link reference \(String(describing: v))")
    }

    func tool(_ v: Any?) throws -> EditorTool {
        guard let t = EditorTool(rawValue: try string(v)) else { throw Failure(message: "no tool \(String(describing: v))") }
        return t
    }

    func distribution(_ v: Any?) throws -> QueueDistribution {
        guard let d = QueueDistribution(rawValue: try string(v)) else {
            throw Failure(message: "no distribution \(String(describing: v))")
        }
        return d
    }

    var scene: CanvasScene { editor.makeScene() }

    // MARK: Operations

    func perform(_ op: String, _ a: [String: Any]) throws {
        let e = editor
        switch op {
        // Tools and clicks
        case "setTool": e.setTool(try tool(a["tool"]))
        case "canvasClick": try canvasClick(at: try point(a["at"]), extending: bool(a["extending"]))
        case "canvasDoubleClick": try canvasDoubleClick(at: try point(a["at"]))
        case "nodeClick":
            e.lastMouseDownExtendsSelection = bool(a["extending"])
            e.handleNodeTap(nodeID: try node(a["node"]), extendingSelection: bool(a["extending"]))
        case "nodeDoubleClick":
            let id = try node(a["node"])
            e.lastMouseDownExtendsSelection = false
            e.handleNodeTap(nodeID: id)
            if e.selectedTool == .select || e.selectedTool == .multiSelect {
                e.openParameterEditor(for: id)
            } else {
                e.handleNodeTap(nodeID: id)
            }
        case "linkClick":
            guard e.selectedTool == .select else { throw Failure(message: "a link click needs the Pointer tool") }
            e.handleLinkTap(linkID: try link(a["link"]))
        case "linkDoubleClick":
            guard e.selectedTool == .select else { throw Failure(message: "a link click needs the Pointer tool") }
            let id = try link(a["link"])
            e.handleLinkTap(linkID: id)
            e.openLinkParameterEditor(for: id)
        // Drags
        case "dragNode":
            try dragNode(try node(a["node"]), by: try size(a["by"]), extending: bool(a["extending"]),
                         option: bool(a["option"]), control: bool(a["control"]), escape: bool(a["escape"]))
        case "dragConnect":
            try dragConnect(from: try node(a["from"]), to: a["to"] is NSNull || a["to"] == nil ? nil : try node(a["to"]),
                            returned: bool(a["returned"]))
        case "dragLink": try dragLink(try link(a["link"]), by: try size(a["by"]), escape: bool(a["escape"]))
        case "marquee":
            try marquee(from: try point(a["from"]), to: try point(a["to"]), extending: bool(a["extending"]))
        case "panDrag": panDrag(by: try size(a["by"]))
        // Keys on the canvas (CanvasClipView.keyDown / keyUp)
        case "arrowKey": try arrowKey(try string(a["key"]), shift: bool(a["shift"]))
        case "arrowKeyUp": e.endNudgeRun()
        case "tabKey":
            if let target = e.selectAdjacentNode(reverse: bool(a["shift"])) { reveal(target) }
        case "optionTabKey":
            if let l = e.selectAdjacentLink(reverse: bool(a["shift"])) {
                for id in [l.fromNodeID, l.toNodeID] { if let n = e.node(with: id) { reveal(n) } }
            }
        case "escapeKey": e.deselectAll()
        case "deleteKey": e.deleteSelection()
        case "returnKey": e.openParameterEditorForSelection()
        // Model methods called directly (menus, context menus, the AI tools)
        case "addNode":
            guard let kind = NodeKind(rawValue: try string(a["kind"])) else { throw Failure(message: "bad kind") }
            e.addNode(kind: kind, at: try point(a["at"]), name: a["name"] as? String)
        case "addLink":
            e.addLink(fromID: try node(a["from"]), toID: try node(a["to"]),
                      customerClass: try a["class"].map { try int($0) } ?? 0,
                      toCustomerClass: try a["toClass"].map { try int($0) },
                      routingProbability: Double(try a["probability"].map { try num($0) } ?? 1))
        case "moveNode": e.moveNode(id: try node(a["node"]), to: try point(a["to"]), snap: bool(a["snap"], default: true))
        case "moveLink": e.moveLink(id: try link(a["link"]), by: try size(a["by"]))
        case "beginMutation": e.beginMutation(try string(a["name"]))
        case "endMutation": e.endMutation()
        case "deleteNode": e.deleteNode(id: try node(a["node"]))
        case "deleteLink": e.deleteLink(id: try link(a["link"]))
        case "deleteSelection": e.deleteSelection()
        case "copySelection": e.copySelection()
        case "cutSelection": e.cutSelection()
        case "pasteSelection": e.pasteSelection()
        case "duplicateSelection": e.duplicateSelection()
        case "selectAll": e.selectAll()
        case "deselectAll": e.deselectAll()
        case "setNodeSelection":
            guard let list = a["nodes"] as? [Any] else { throw Failure(message: "nodes: [ … ]") }
            e.setNodeSelection(Set(try list.map { try node($0) }))
        case "toggleNodeInSelection": e.toggleNodeInSelection(try node(a["node"]))
        case "selectAdjacentNode": e.selectAdjacentNode(reverse: bool(a["reverse"]))
        case "selectAdjacentLink": e.selectAdjacentLink(reverse: bool(a["reverse"]))
        case "alignSelectedNodesLeft": e.alignSelectedNodesLeft()
        case "alignSelectedNodesRight": e.alignSelectedNodesRight()
        case "alignSelectedNodesTop": e.alignSelectedNodesTop()
        case "alignSelectedNodesBottom": e.alignSelectedNodesBottom()
        case "alignSelectedNodesHorizontalCentres": e.alignSelectedNodesHorizontalCentres()
        case "alignSelectedNodesVerticalCentres": e.alignSelectedNodesVerticalCentres()
        case "distributeSelectedNodesHorizontally": e.distributeSelectedNodesHorizontally()
        case "distributeSelectedNodesVertically": e.distributeSelectedNodesVertically()
        case "nudgeSelection": e.nudgeSelection(by: try size(a["by"]))
        case "endNudgeRun": e.endNudgeRun()
        case "straightenNetwork": e.straightenNetwork()
        case "fitNetworkToWindow": e.fitNetworkToWindow()
        case "setInfiniteBuffers": e.setInfiniteBuffers(bool(a["value"]))
        case "clear": e.clear()
        case "renameNode": e.renameNode(nodeID: try node(a["node"]), name: try string(a["name"]))
        case "updateBufferSize": e.updateBufferSize(nodeID: try node(a["node"]), size: try int(a["size"]))
        case "updateNumberOfServers": e.updateNumberOfServers(nodeID: try node(a["node"]), count: try int(a["count"]))
        case "updateStationPicture":
            guard let p = StationPicture(rawValue: try string(a["picture"])) else { throw Failure(message: "bad picture") }
            e.updateStationPicture(nodeID: try node(a["node"]), picture: p)
        case "updateNodeDistribution":
            e.updateNodeDistribution(nodeID: try node(a["node"]), distribution: try distribution(a["distribution"]),
                                     parameters: try string(a["parameters"]))
        case "updateServiceDistribution":
            e.updateServiceDistribution(nodeID: try node(a["node"]), customerClass: try int(a["class"]),
                                        distribution: try distribution(a["distribution"]),
                                        parameters: try string(a["parameters"]))
        case "updateLinkProbability":
            e.updateLinkProbability(linkID: try link(a["link"]), probability: Double(try num(a["probability"])))
        case "updateLinkCustomerClass":
            e.updateLinkCustomerClass(linkID: try link(a["link"]), customerClass: try int(a["class"]))
        case "updateLinkExitClass":
            e.updateLinkExitClass(linkID: try link(a["link"]),
                                  exitClass: a["class"] is NSNull || a["class"] == nil ? nil : try int(a["class"]))
        case "endParameterRun": e.endParameterRun()
        case "findAndRevealNode": e.findAndRevealNode(named: try string(a["query"]))
        case "insertArchetype": try insertArchetype(a)
        // View
        case "setSnapToGrid": e.snapToGrid = bool(a["value"])
        case "legendClick":
            // NetworkCanvasOverlays' class legend: a tap pins a class, a second tap on it clears.
            let c = try int(a["class"])
            e.classFilter = e.classFilter == c ? nil : c
        case "zoomIn": e.zoomIn()
        case "zoomOut": e.zoomOut()
        case "zoomToFit": e.zoomToFit()
        case "zoomToFitSelection": e.zoomToFitSelection()
        case "resetZoom": e.resetZoom()
        case "setZoom": e.setZoom(try num(a["scale"]))
        case "zoomAbout": e.zoom(to: try num(a["scale"]), about: try point(a["about"]))
        case "pan": e.pan(by: try size(a["by"]))
        // Edit ▸ Undo / Redo (QnetCommands.performUndoRedo with no text field focused)
        case "undo":
            if e.undoManager.canUndo { e.undoManager.undo() } else { notes.append("Undo is disabled: nothing to undo.") }
        case "redo":
            if e.undoManager.canRedo { e.undoManager.redo() } else { notes.append("Redo is disabled: nothing to redo.") }
        // Inspectors
        case "nodeSheet": try nodeSheet(a)
        case "nodePane": try nodePane(a)
        case "linkSheet": try linkSheet(a)
        case "linkPane": try linkPane(a)
        // Time
        case "wait":
            let until = Date(timeIntervalSinceNow: Double(try num(a["seconds"])))
            while Date() < until {
                RunLoop.main.run(mode: .default, before: min(until, Date(timeIntervalSinceNow: 0.05)))
                Thread.sleep(forTimeInterval: 0.01)
            }
        default:
            throw Failure(message: "unknown op \(op)")
        }
    }

    // MARK: Canvas clicks (CanvasContentView.canvasDrag's onEnded, empty canvas)

    func requireEmpty(_ p: CGPoint) throws {
        let s = scene
        if let n = s.hitNode(at: p) { throw Failure(message: "\(p) is on node \(n.name), not empty canvas") }
        if s.hitLink(at: p) != nil { throw Failure(message: "\(p) is on a link, not empty canvas") }
    }

    /// One click on empty canvas outside the double-click window.
    func canvasClick(at p: CGPoint, extending: Bool) throws {
        try requireEmpty(p)
        let e = editor
        e.lastMouseDownExtendsSelection = extending
        let tool = e.selectedTool
        if tool == .pan || e.isSpacePanning { panDrag(by: .zero); return }
        if tool == .multiSelect {
            // Multi-Select opens a zero-area band on press; the release discards it as a click.
            e.beginMultiSelect(at: e.canvasTransform.toLogical(p))
            e.updateMultiSelect(to: e.canvasTransform.toLogical(p))
            e.multiSelectRect = nil
            e.multiSelectOrigin = nil
        }
        if extending, tool == .select || tool == .multiSelect { return }
        let world = e.snapIfNeeded(CanvasMath.clampWorld(e.canvasTransform.toLogical(p)))
        e.handleCanvasTap(at: world)
    }

    /// Two clicks on the same point inside the double-click interval.
    func canvasDoubleClick(at p: CGPoint) throws {
        try canvasClick(at: p, extending: false)
        let e = editor
        switch e.selectedTool {
        case .select, .multiSelect:
            e.enterStickyPan()
        case .addStation, .addBuffer, .addSource, .addSink:
            notes.append("Second click suppressed: it would place a node on the same point.")
        case .addLink:
            let world = e.snapIfNeeded(CanvasMath.clampWorld(e.canvasTransform.toLogical(p)))
            e.handleCanvasTap(at: world)
        case .pan:
            panDrag(by: .zero)
        }
    }

    /// Pan-tool drag (panChanged / panEnded).
    func panDrag(by t: CGSize) {
        let e = editor
        let start = e.canvasPanOffset
        e.isPanningCanvas = true
        e.canvasPanOffset = CGSize(width: start.width + t.width, height: start.height + t.height)
        e.isPanningCanvas = false
        if CanvasMath.length(t) <= 2 { e.exitStickyPan() }
    }

    // MARK: Node drag (CanvasContentView.nodeDrag, Pointer / Multi-Select)

    func dragNode(_ id: UUID, by t: CGSize, extending: Bool, option: Bool, control: Bool, escape: Bool) throws {
        let e = editor
        e.lastMouseDownExtendsSelection = extending
        e.lastMouseDownDuplicates = option
        guard e.selectedTool == .select || e.selectedTool == .multiSelect else {
            throw Failure(message: "dragNode needs the Pointer or Multi-Select tool (use dragConnect for the Link tool)")
        }
        guard CanvasMath.length(t) > 2 else {
            // Below the drag threshold the press is a click.
            e.handleNodeTap(nodeID: id, extendingSelection: extending)
            return
        }
        var group = e.selectionUnion
        if !group.contains(id) {
            if extending { group.insert(id) } else { group = [id] }
            e.setNodeSelection(group)
            e.selectedLinkID = nil
        }
        let noun = group.count > 1 ? "Nodes" : "Node"
        e.beginMutation(option ? "Duplicate and Move \(noun)" : "Move \(noun)")
        var duplicated = false
        if option {
            let copies = e.duplicateSelectionInPlaceForDrag()
            if !copies.isEmpty { group = copies; duplicated = true }
        }
        let starts = Dictionary(uniqueKeysWithValues: e.nodes.filter { group.contains($0.id) }.map { ($0.id, $0.position) })
        e.isDraggingNode = true
        // The anchor is the node under the pointer (dragNodeID). After an ⌥-drag that is the
        // ORIGINAL, which is not among the dragged copies, so no guide and no grid apply.
        guides = moveAnchored(anchorID: id, starts: starts, by: t, scale: e.canvasScale, control: control)
        if escape {
            if duplicated {
                // Not cancellable: the Escape monitor is not installed, so the key reaches the
                // canvas as Deselect All while the drag goes on to its release.
                notes.append("Escape during an ⌥-drag is Deselect All; the drag is not cancelled.")
                e.deselectAll()
            } else {
                for (nid, start) in starts { e.moveNode(id: nid, to: start, snap: false) }
                e.endMutation()
                e.isDraggingNode = false
                if e.snapSuspended { e.snapSuspended = false }
                if !e.activeAlignGuides.isEmpty { e.activeAlignGuides = .none }
                return
            }
        }
        // finishNodeMove
        e.endMutation()
        e.isDraggingNode = false
        if e.snapSuspended { e.snapSuspended = false }
        if !e.activeAlignGuides.isEmpty { e.activeAlignGuides = .none }
    }

    /// CanvasContentView.moveAnchoredNodes, one frame at translation `t`.
    @discardableResult
    func moveAnchored(anchorID: UUID?, starts: [UUID: CGPoint], by t: CGSize, scale s: CGFloat,
                      control: Bool) -> SmartGuides.Match {
        let e = editor
        var delta = CGSize(width: t.width / s, height: t.height / s)
        if e.snapSuspended != control { e.snapSuspended = control }
        var g = SmartGuides.Match.none
        if !control, let anchorID, let anchorNode = e.node(with: anchorID), let start = starts[anchorID] {
            let size = NodeOutline.size(for: anchorNode.kind)
            let centre = CGPoint(x: start.x + delta.width, y: start.y + delta.height)
            let candidate = CGRect(x: centre.x - size.width / 2, y: centre.y - size.height / 2,
                                   width: size.width, height: size.height)
            let others = e.nodes.filter { starts[$0.id] == nil }.map { CanvasScene.nodeWorldRect($0) }
            g = SmartGuides.match(anchor: candidate, others: others, tolerance: SmartGuides.tolerance / max(s, 0.01))
            var adjust = g.adjustment
            if e.snapToGrid {
                let snapped = e.snapIfNeeded(centre)
                let grid = CGSize(width: snapped.x - centre.x, height: snapped.y - centre.y)
                let guideX = g.x != nil || g.xSpacing != nil
                let guideY = g.y != nil || g.ySpacing != nil
                if !guideX || abs(grid.width) <= abs(adjust.width) { adjust.width = grid.width; g.dropX() }
                if !guideY || abs(grid.height) <= abs(adjust.height) { adjust.height = grid.height; g.dropY() }
            }
            if g.isEmpty { g = .none } else { g.anchor = candidate.offsetBy(dx: adjust.width, dy: adjust.height) }
            delta.width += adjust.width
            delta.height += adjust.height
        }
        if e.activeAlignGuides != g { e.activeAlignGuides = g }
        for (id, start) in starts {
            e.moveNode(id: id, to: CanvasMath.clampWorld(CGPoint(x: start.x + delta.width, y: start.y + delta.height)),
                       snap: false)
        }
        return g
    }

    // MARK: Link-tool drag (nodeDrag in the Link tool, then completeLinkDrag)

    func dragConnect(from: UUID, to: UUID?, returned: Bool) throws {
        let e = editor
        guard e.selectedTool == .addLink else { throw Failure(message: "dragConnect needs the Link tool") }
        guard let to else {
            notes.append("Released on empty canvas: the drag is abandoned.")
            return
        }
        if to == from && !returned {
            e.handleNodeTap(nodeID: from)   // never left the node: the click it was
            return
        }
        if e.pendingLinkStartID != from {
            e.pendingLinkStartID = nil
            e.handleNodeTap(nodeID: from)
            guard e.pendingLinkStartID == from else { return }
        }
        e.handleNodeTap(nodeID: to)
    }

    // MARK: Link drag (canvasDrag from a link, Pointer tool)

    func dragLink(_ id: UUID, by t: CGSize, escape: Bool) throws {
        let e = editor
        guard e.selectedTool == .select else { throw Failure(message: "dragLink needs the Pointer tool") }
        guard CanvasMath.length(t) > 3 else { e.handleLinkTap(linkID: id); return }
        guard let l = e.link(with: id), let from = e.node(with: l.fromNodeID), let to = e.node(with: l.toNodeID) else {
            throw Failure(message: "the link has lost an end")
        }
        guard from.id != to.id else {
            // `[from.id: …, to.id: …]` is a dictionary literal with a duplicate key for a self-loop:
            // 0.90.34 traps here. Not replayed.
            throw Failure(message: "dragging a self-loop traps in 0.90.34 (duplicate dictionary-literal key)")
        }
        let starts: [UUID: CGPoint] = [from.id: from.position, to.id: to.position]
        if e.selectedLinkID != id {
            e.selectedLinkID = id
            e.selectedNodeID = nil
            e.selectedNodeIDs = []
        }
        e.beginMutation("Move Link")
        e.isDraggingNode = true
        // The anchor is `dragStartPositions.keys.first`, which depends on the process's hash seed.
        // Check that the answer does not depend on it, then use the from node.
        let before = e.nodes
        moveAnchored(anchorID: to.id, starts: starts, by: t, scale: e.canvasScale, control: false)
        let viaTo = e.nodes
        e.nodes = before
        guides = moveAnchored(anchorID: from.id, starts: starts, by: t, scale: e.canvasScale, control: false)
        if viaTo != e.nodes {
            throw Failure(message: "this link drag lands differently depending on which end anchors it (hash order)")
        }
        if escape {
            for (nid, start) in starts { e.moveNode(id: nid, to: start, snap: false) }
        }
        e.endMutation()
        e.isDraggingNode = false
        if e.snapSuspended { e.snapSuspended = false }
        if !e.activeAlignGuides.isEmpty { e.activeAlignGuides = .none }
    }

    // MARK: Marquee (canvasDrag from empty canvas)

    func marquee(from a: CGPoint, to b: CGPoint, extending: Bool) throws {
        try requireEmpty(a)
        let e = editor
        e.lastMouseDownExtendsSelection = extending
        let tool = e.selectedTool
        let canRubberBand = tool == .multiSelect || (tool == .select && CanvasMath.distance(a, b) > 5)
        if canRubberBand {
            if e.multiSelectOrigin == nil { e.beginMultiSelect(at: e.canvasTransform.toLogical(a)) }
            e.updateMultiSelect(to: e.canvasTransform.toLogical(b))
            marqueeCount = e.marqueeNodeCount
            if let rect = e.multiSelectRect, rect.width > 0 || rect.height > 0 {
                e.finalizeMultiSelect(extending: extending)
                return
            }
            e.multiSelectRect = nil
            e.multiSelectOrigin = nil
        }
        // A band with no area is a click.
        if extending, tool == .select || tool == .multiSelect { return }
        if tool == .pan { panDrag(by: CGSize(width: b.x - a.x, height: b.y - a.y)); return }
        let world = e.snapIfNeeded(CanvasMath.clampWorld(e.canvasTransform.toLogical(b)))
        e.handleCanvasTap(at: world)
    }

    // MARK: Keys (CanvasClipView)

    func arrowKey(_ key: String, shift: Bool) throws {
        let e = editor
        let (dx, dy): (CGFloat, CGFloat)
        switch key {
        case "left": (dx, dy) = (-1, 0)
        case "right": (dx, dy) = (1, 0)
        case "up": (dx, dy) = (0, -1)
        case "down": (dx, dy) = (0, 1)
        default: throw Failure(message: "arrow key left/right/up/down")
        }
        let step = e.nudgeStep(coarse: shift)
        guard e.selectionUnion.isEmpty, e.selectedLinkID == nil else {
            e.nudgeSelection(by: CGSize(width: dx * step, height: dy * step))
            return
        }
        let panStep: CGFloat = 20 * (shift ? 4 : 1)   // CanvasClipView.linePanStep
        e.pan(by: CGSize(width: -dx * panStep, height: -dy * panStep))
    }

    /// CanvasClipView.revealIfOffscreen with the scenario's viewport as the clip view's bounds.
    func reveal(_ node: NetworkNode) {
        var t = editor.canvasTransform
        t.viewportSize = viewport
        let margin: CGFloat = 88
        let p = t.toDisplay(node.position)
        var dx: CGFloat = 0, dy: CGFloat = 0
        if p.x < margin { dx = margin - p.x } else if p.x > viewport.width - margin { dx = viewport.width - margin - p.x }
        if p.y < margin { dy = margin - p.y } else if p.y > viewport.height - margin { dy = viewport.height - margin - p.y }
        guard dx != 0 || dy != 0 else { return }
        editor.pan(by: CGSize(width: dx, height: dy))
    }

    // MARK: Archetype (QnetGUIApp.syncArchetypePanel's onInsert)

    func insertArchetype(_ a: [String: Any]) throws {
        guard let arch = NetworkArchetype(rawValue: try string(a["archetype"])) else { throw Failure(message: "bad archetype") }
        var p = ArchetypeParameters()
        if let o = a["parameters"] as? [String: Any] {
            if let v = o["stations"] { p.stations = try int(v) }
            if let v = o["servers"] { p.servers = try int(v) }
            if let v = o["targetRho"] { p.targetRho = Double(try num(v)) }
            if let v = o["feedbackProbability"] { p.feedbackProbability = Double(try num(v)) }
            if let v = o["infiniteBuffers"] { p.infiniteBuffers = bool(v) }
            if let v = o["bufferCapacity"] { p.bufferCapacity = try int(v) }
            if let v = o["arrivalRate"] { p.arrivalRate = Double(try num(v)) }
        }
        let built = NetworkArchetypeBuilder.build(arch, p)
        editor.insertSubnetwork(nodes: built.nodes, links: built.links, infiniteBuffers: built.infiniteBuffers,
                                at: NetworkArchetypeBuilder.canvasOrigin,
                                actionName: "Insert " + NetworkArchetypeBuilder.blueprint(for: arch).title,
                                detail: NetworkArchetypeBuilder.summary(arch, p))
    }

    // MARK: Inspectors

    /// Writes the scenario's field values into a node draft, the way the form's controls do.
    func fill(_ d: NodeParameterDraft, _ a: [String: Any]) throws {
        if let v = a["name"] { d.nameText = try string(v) }
        if let v = a["servers"] { d.serversText = try string(v) }
        if let v = a["bufferSize"] { d.bufferSizeText = try string(v) }
        if let v = a["infiniteBuffers"] { d.infiniteBuffersDraft = bool(v) }
        if let v = a["picture"] {
            guard let p = StationPicture(rawValue: try string(v)) else { throw Failure(message: "bad picture") }
            d.stationPicture = p
        }
        func law(_ draft: inout DistributionDraft, _ spec: [String: Any], mode: ParameterEntryMode) throws {
            if let f = spec["family"] { draft.changeDistribution(to: try distribution(f), mode: mode) }
            if let ps = spec["params"] as? [String: Any] {
                for k in ps.keys.sorted() { draft.setParam(k, try string(ps[k])) }
            }
            if let m = spec["mean"] { draft.displayMeanText = try string(m) }
            if let s = spec["scv"] { draft.displayScvText = try string(s) }
        }
        if let mode = a["entryMode"] as? String {
            let m: ParameterEntryMode = mode == "moments" ? .moments : .native
            d.draft.syncMode(to: m)
            d.entryMode = m
        }
        if let mode = a["classEntryMode"] as? String {
            let m: ParameterEntryMode = mode == "moments" ? .moments : .native
            for c in d.servedClasses { d.classDrafts[c]?.syncMode(to: m) }
            d.classEntryMode = m
        }
        if let spec = a["distribution"] as? [String: Any] {
            var draft = d.draft
            try law(&draft, spec, mode: d.entryMode)
            d.draft = draft
        }
        if let classes = a["classes"] as? [String: Any] {
            for key in classes.keys.sorted() {
                guard let c = Int(key), let spec = classes[key] as? [String: Any] else { throw Failure(message: "classes: {\"0\": {…}}") }
                guard var draft = d.classDrafts[c] else { throw Failure(message: "class \(c) is not served here") }
                try law(&draft, spec, mode: d.classEntryMode)
                d.classDrafts[c] = draft
            }
        }
        if let v = a["copyToAllClassesFrom"] { d.copyToAllClasses(from: try int(v)) }
    }

    func fill(_ d: LinkParameterDraft, _ a: [String: Any]) throws {
        if let v = a["probability"] { d.probabilityText = try string(v) }
        if let v = a["entryClass"] { d.selectedClass = try int(v) }
        if let v = a["exitClass"] {
            d.exitSelection = (v as? String) == "same" ? LinkParameterDraft.sameAsEntry : try int(v)
        }
        if bool(a["balance"]), let id = d.linkID {
            // LinkInspectorSections.balanceButton: this link takes what its siblings leave over.
            let siblingSum = editor.siblingLinks(of: id).reduce(0.0) { $0 + $1.routingProbability }
            let remainder = 1.0 - siblingSum
            let total = siblingSum + (DS.Number.parse(d.probabilityText) ?? 0)
            if remainder >= 0 && abs(total - 1.0) > 1e-6 {
                d.probabilityText = DS.Number.fieldText(min(max(remainder, 0), 1))
            } else {
                notes.append("Balance to 1 is disabled.")
            }
        }
    }

    /// The modal sheet (⌘I / double-click): open, edit, Save (one undo step), close.
    func nodeSheet(_ a: [String: Any]) throws {
        let e = editor
        let id = try node(a["node"])
        e.openParameterEditor(for: id)
        let d = NodeParameterDraft()
        d.load(from: e, nodeID: id)
        try fill(d, a)
        if bool(a["cancel"]) {
            e.closeParameterEditor()
            return
        }
        guard d.commit(to: e) else {
            notes.append("Save is disabled: " + (d.firstProblem(editor: e) ?? d.pendingNote(editor: e) ?? "invalid"))
            e.closeParameterEditor()
            return
        }
        e.closeParameterEditor()
    }

    func linkSheet(_ a: [String: Any]) throws {
        let e = editor
        let id = try link(a["link"])
        e.openLinkParameterEditor(for: id)
        let d = LinkParameterDraft()
        d.load(from: e, linkID: id)
        try fill(d, a)
        if bool(a["cancel"]) {
            e.closeLinkParameterEditor()
            return
        }
        if !d.commit(to: e) {
            notes.append("Save is disabled: " + (d.firstProblem(editor: e) ?? d.pendingNote ?? "invalid"))
        }
        e.closeLinkParameterEditor()
    }

    /// InspectorPaneView.syncSelection for the current selection, then reloadIfIdle.
    func syncPane() {
        guard paneShown else { return }
        let e = editor
        var target: UUID? = e.selectedNodeID
        if target == nil, e.selectedLinkID == nil, e.selectedNodeIDs.count == 1 { target = e.selectedNodeIDs.first }
        let targetLink = target == nil ? e.selectedLinkID : nil
        if let previous = paneNodeID, previous != target {
            if paneNode.isDirty, !paneNode.commit(to: e, coalescing: true) {
                // InspectorPaneView.logDiscardedNodeEdit
                let name = e.node(with: previous)?.name ?? "node"
                let fields = paneNode.invalidFieldSummaries(editor: e)
                let what = fields.isEmpty
                    ? (paneNode.pendingNote(editor: e) ?? "an incomplete field")
                    : fields.joined(separator: ", ")
                e.addStatus("Discarded invalid edit to \(name): \(what).", severity: .warning)
            }
            e.endParameterRun()
        }
        if let previous = paneLinkID, previous != targetLink {
            if paneLink.isDirty(editor: e), !paneLink.commit(to: e, coalescing: true) {
                // InspectorPaneView.logDiscardedLinkEdit
                let label = e.link(with: previous).map { e.displayLabel(for: $0) } ?? "link"
                let what: String
                if paneLink.probabilityError != nil || paneLink.probabilityIsPending {
                    what = "Probability (\"\(paneLink.probabilityText)\")"
                } else {
                    what = paneLink.firstProblem(editor: e) ?? "an invalid field"
                }
                e.addStatus("Discarded invalid edit to link \(label): \(what).", severity: .warning)
            }
            e.endParameterRun()
        }
        if let id = target, e.node(with: id) != nil {
            if paneNodeID != id {
                e.applyParameterCacheOverlay(to: id)
                paneNode.load(from: e, nodeID: id)
                paneNodeID = id
            } else if !paneNode.isDirty {
                paneNode.refresh(from: e)
            }
            paneLinkID = nil
        } else if let id = targetLink, e.link(with: id) != nil {
            if paneLinkID != id {
                paneLink.load(from: e, linkID: id)
                paneLinkID = id
            } else if !paneLink.isDirty(editor: e) {
                paneLink.load(from: e, linkID: id)
            }
            paneNodeID = nil
        } else {
            paneNodeID = nil
            paneLinkID = nil
        }
    }

    /// The docked pane: type into its fields, then blur (commitNow, coalescing).
    func nodePane(_ a: [String: Any]) throws {
        guard paneShown else { throw Failure(message: "the Inspector pane is hidden in this scenario") }
        syncPane()
        guard paneNodeID != nil else { throw Failure(message: "the pane shows no node (select exactly one)") }
        try fill(paneNode, a)
        if !paneNode.commit(to: editor, coalescing: true) {
            notes.append("Pane commit refused: " + (paneNode.firstProblem(editor: editor) ?? paneNode.pendingNote(editor: editor) ?? "invalid"))
        }
    }

    func linkPane(_ a: [String: Any]) throws {
        guard paneShown else { throw Failure(message: "the Inspector pane is hidden in this scenario") }
        syncPane()
        guard paneLinkID != nil else { throw Failure(message: "the pane shows no link (select one link)") }
        try fill(paneLink, a)
        if !paneLink.commit(to: editor, coalescing: true) {
            notes.append("Pane commit refused: " + (paneLink.firstProblem(editor: editor) ?? paneLink.pendingNote ?? "invalid"))
        }
    }
}
