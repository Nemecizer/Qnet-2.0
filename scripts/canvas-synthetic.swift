// Synthetic reference scenes from Qnet 0.90.34's own canvas geometry, for the cases the shipped
// examples never reach (self-loops, solved bows, the body-clear and least-bad tiers, a class
// filter, hit tests, smart guides, the grid at many zooms) and the 0.90.34 side of the canvas bench.
// Output: src/canvas/geometry/fixtures/synthetic-0.90.34.json, read by synthetic.test.ts.
//
// Compile OUTSIDE 2_QNET, against unmodified copies of its CanvasGeometry.swift and
// validation/canvas_perf/model_stubs.swift (nothing is written to 2_QNET):
//
//   d=$(mktemp -d); cp ../2_QNET/Sources/Qnet/CanvasGeometry.swift \
//     ../2_QNET/validation/canvas_perf/model_stubs.swift "$d"/
//   cp scripts/canvas-synthetic.swift "$d"/main.swift     # top-level code must be in main.swift
//   swiftc -O "$d"/model_stubs.swift "$d"/CanvasGeometry.swift "$d"/main.swift -o "$d"/ref
//   "$d"/ref src/canvas/geometry/fixtures/synthetic-0.90.34.json   # the reference scenes
//   "$d"/ref bench                                                 # 0.90.34's timings on this Mac
//
// (paths relative to 6_QNET20/qnet; ../2_QNET means 0_CLAUDE/2_QNET.) The networks are generated
// with a fixed xorshift32 seed; scripts/canvas-bench.ts builds the same bench network in TypeScript.
import Foundation
import CoreGraphics

struct XorShift { var x: UInt32
  mutating func next() -> UInt32 { x ^= x << 13; x ^= x >> 17; x ^= x << 5; return x }
  mutating func int(_ n: Int) -> Int { Int(next() % UInt32(n)) }
}

func uuid(_ prefix: Int, _ i: Int) -> UUID {
  UUID(uuidString: String(format: "%08d-0000-0000-0000-%012d", prefix, i))!
}

func benchNetwork(seed: UInt32, nodeCount: Int, linkCount: Int) -> ([NetworkNode], [NetworkLink]) {
  var rng = XorShift(x: seed)
  var nodes: [NetworkNode] = []
  let cols = Int(Double(nodeCount).squareRoot().rounded(.up))
  for i in 0..<nodeCount {
    let kind: NodeKind
    switch i % 8 { case 0: kind = .source; case 7: kind = .sink; case 3: kind = .buffer; default: kind = .station }
    nodes.append(NetworkNode(id: uuid(1, i), kind: kind, position: CGPoint(x: CGFloat(i % cols) * 140 + 60, y: CGFloat(i / cols) * 120 + 60)))
  }
  var links: [NetworkLink] = []
  for k in 0..<linkCount {
    let a = rng.int(nodeCount)
    var b = (a + 1 + (k % 5)) % nodeCount
    if b == a { b = (a + 1) % nodeCount }
    links.append(NetworkLink(id: uuid(2, k), fromNodeID: nodes[a].id, toNodeID: nodes[b].id, customerClass: k % 2))
  }
  return (nodes, links)
}

let kinds: [NodeKind] = [.station, .buffer, .source, .sink]
func randomNetwork(seed: UInt32, nodeCount: Int, linkCount: Int, selfLoops: Bool) -> ([NetworkNode], [NetworkLink]) {
  var rng = XorShift(x: seed)
  var nodes: [NetworkNode] = []
  for i in 0..<nodeCount {
    let x = CGFloat(rng.int(90000)) / 100, y = CGFloat(rng.int(60000)) / 100
    nodes.append(NetworkNode(id: uuid(3, i), kind: kinds[rng.int(4)], position: CGPoint(x: x, y: y)))
  }
  var links: [NetworkLink] = []
  for k in 0..<linkCount {
    let a = rng.int(nodeCount)
    var b = rng.int(nodeCount)
    if !selfLoops && b == a { b = (a + 1) % nodeCount }
    if selfLoops && rng.int(4) == 0 { b = a }
    links.append(NetworkLink(id: uuid(4, k), fromNodeID: nodes[a].id, toNodeID: nodes[b].id, customerClass: rng.int(3)))
  }
  return (nodes, links)
}

func n(_ d: CGFloat) -> String { String(format: "%.17g", Double(d)) }
func p(_ q: CGPoint) -> String { "[\(n(q.x)),\(n(q.y))]" }
func r(_ q: CGRect?) -> String { guard let q else { return "null" }; return "[\(n(q.minX)),\(n(q.minY)),\(n(q.width)),\(n(q.height))]" }

func contentRect(nodes: [NetworkNode], links: [NetworkLink], routePlan: LinkRoutePlan) -> CGRect? {
  guard !nodes.isEmpty else { return nil }
  let unit = CanvasTransform(scale: 1, pan: .zero, viewportSize: .zero)
  let scene = CanvasScene(nodes: nodes, links: links, transform: unit, classFilter: nil, routePlan: routePlan)
  var rect = CanvasScene.nodeWorldRect(nodes[0])
  for n in nodes { rect = rect.union(CanvasScene.nodeWorldRect(n)); rect = rect.union(CanvasScene.nodeLabelRect(n)) }
  for item in scene.links { for p in item.geometry.polyline { rect = rect.union(CGRect(x: p.x, y: p.y, width: 0, height: 0)) } }
  return rect.insetBy(dx: -16, dy: -16)
}

func dumpNetwork(_ name: String, _ nodes: [NetworkNode], _ links: [NetworkLink], polylines: Bool, hits: Bool) -> String {
  let plan = LinkRoutePlan.build(nodes: nodes, links: links)
  var s = "{\"name\":\"\(name)\",\"nodes\":["
  s += nodes.map { "[\"\($0.id.uuidString)\",\"\($0.kind.rawValue)\",\(n($0.position.x)),\(n($0.position.y))]" }.joined(separator: ",")
  s += "],\"links\":["
  s += links.map { "[\"\($0.id.uuidString)\",\"\($0.fromNodeID.uuidString)\",\"\($0.toNodeID.uuidString)\",\($0.customerClass)]" }.joined(separator: ",")
  s += "],\"bulges\":[" + links.map { n(plan.bulge(for: $0.id)) }.joined(separator: ",") + "]"
  s += ",\"contentRect\":" + r(contentRect(nodes: nodes, links: links, routePlan: plan))
  var views: [String] = []
  for (scale, pan, filter) in [(CGFloat(1), CGSize.zero, Int?.none), (CGFloat(0.7), CGSize(width: 31.5, height: -12.25), Int?.none), (CGFloat(2.5), CGSize(width: -400, height: -333.3), Int?(1))] {
    let t = CanvasTransform(scale: scale, pan: pan, viewportSize: CGSize(width: 1600, height: 1000))
    let scene = CanvasScene(nodes: nodes, links: links, transform: t, classFilter: filter, routePlan: plan)
    var v = "{\"scale\":\(n(scale)),\"pan\":[\(n(pan.width)),\(n(pan.height))],\"filter\":\(filter.map(String.init) ?? "null"),\"links\":["
    v += scene.links.map { item in
      let g = item.geometry
      var route = "null"
      switch g.route { case .straight: route = "[]"; case .quad(let c): route = "[\(p(c))]"; case .cubic(let c1, let c2): route = "[\(p(c1)),\(p(c2))]" }
      let poly = polylines && scale != 0.7 ? g.polyline.map(p).joined(separator: ",") : ""
      return "[\"\(item.id.uuidString)\",\(p(g.start)),\(p(g.base)),\(p(g.tip)),\(p(g.wingLeft)),\(p(g.wingRight)),\(p(g.labelAnchor)),\(route),[\(poly)]]"
    }.joined(separator: ",")
    v += "]"
    if hits {
      var rng = XorShift(x: 977)
      var hs: [String] = []
      for _ in 0..<300 {
        let q = CGPoint(x: CGFloat(rng.int(160000)) / 100, y: CGFloat(rng.int(100000)) / 100)
        let hn = scene.hitNode(at: q).map { "\"\($0.id.uuidString)\"" } ?? "null"
        let hl = scene.hitLink(at: q).map { "\"\($0.id.uuidString)\"" } ?? "null"
        hs.append("[\(p(q)),\(hn),\(hl)]")
      }
      v += ",\"hits\":[" + hs.joined(separator: ",") + "]"
    }
    v += "}"
    views.append(v)
  }
  s += ",\"views\":[" + views.joined(separator: ",") + "]}"
  return s
}

func dumpGuides() -> String {
  var rng = XorShift(x: 4242)
  var out: [String] = []
  func rr() -> CGRect {
    let w = CGFloat([44, 46, 48, 52][rng.int(4)]), h = CGFloat([44, 46, 48][rng.int(3)])
    return CGRect(x: CGFloat(rng.int(12)) * 28 + CGFloat(rng.int(7)) - 3, y: CGFloat(rng.int(6)) * 28 + CGFloat(rng.int(7)) - 3, width: w, height: h)
  }
  for k in 0..<600 {
    if k >= 400 {
      // Rows (k even) and columns (k odd) off the grid, so the spacing guides get exercised.
      let horizontal = k % 2 == 0
      let base = CGFloat(rng.int(40000)) / 100
      func at(_ along: CGFloat) -> CGRect {
        let jitter = CGFloat(rng.int(1000)) / 100 - 5
        return horizontal ? CGRect(x: along, y: base + jitter, width: 48, height: 48) : CGRect(x: base + jitter, y: along, width: 48, height: 48)
      }
      var along: CGFloat = CGFloat(rng.int(10000)) / 100
      var others: [CGRect] = []
      let count = 2 + rng.int(4)
      let gap = CGFloat(20 + rng.int(6000) / 100)
      for _ in 0..<count { others.append(at(along)); along += 48 + gap + CGFloat(rng.int(300)) / 100 - 1.5 }
      let slot = rng.int(count + 1)
      let a0 = horizontal ? others[0].minX : others[0].minY
      let pos = a0 + CGFloat(slot) * (48 + gap) + CGFloat(rng.int(800)) / 100 - 4 - (slot < count ? (48 + gap) / 2 : 0)
      let anchor = horizontal ? CGRect(x: pos, y: base + 1.3, width: 48, height: 48) : CGRect(x: base + 1.3, y: pos, width: 48, height: 48)
      let tol = CGFloat([4, 6, 8][rng.int(3)])
      emit(anchor, others, tol)
      continue
    }
    let anchor = rr()
    let others = (0..<(2 + rng.int(7))).map { _ in rr() }
    let tol = CGFloat([4, 2, 8, 13.333][rng.int(4)])
    emit(anchor, others, tol)
  }
  func emit(_ anchor: CGRect, _ others: [CGRect], _ tol: CGFloat) {
    let m = SmartGuides.match(anchor: anchor, others: others, tolerance: tol)
    func sp(_ g: SmartGuides.SpacingGuide?) -> String { guard let g else { return "null" }; return "[\(r(g.first)),\(r(g.second))]" }
    out.append("{\"anchor\":\(r(anchor)),\"others\":[\(others.map { r($0) }.joined(separator: ","))],\"tol\":\(n(tol)),\"adj\":[\(n(m.adjustment.width)),\(n(m.adjustment.height))],\"x\":\(m.x.map(n) ?? "null"),\"y\":\(m.y.map(n) ?? "null"),\"a\":\(r(m.anchor)),\"xp\":\(r(m.xPartner)),\"yp\":\(r(m.yPartner)),\"xs\":\(sp(m.xSpacing)),\"ys\":\(sp(m.ySpacing))}")
  }
  return "[" + out.joined(separator: ",") + "]"
}

func dumpGrid() -> String {
  var out: [String] = []
  for (scale, pan) in [(CGFloat(0.1), CGSize(width: 3, height: 4)), (0.3, CGSize(width: 40, height: -25)), (0.57, CGSize(width: -13.7, height: 101.1)), (0.86, CGSize(width: 37, height: -21)), (1, CGSize(width: 0.5, height: -0.5)), (2, CGSize(width: -300, height: -150.75)), (4, CGSize(width: 1234.5, height: -987.25))] {
    let t = CanvasTransform(scale: scale, pan: pan, viewportSize: CGSize(width: 1600, height: 1000))
    let g = GridPath.build(transform: t, size: CGSize(width: 1600, height: 1000), gridSpacing: 28)
    var dots: [String] = []
    g.minorDots?.forEach { if case .move(let q) = $0 { dots.append(p(q)) } }
    var lines: [String] = []
    g.majorLines?.forEach { if case .move(let q) = $0 { lines.append(p(q)) } }
    out.append("{\"scale\":\(n(scale)),\"pan\":[\(n(pan.width)),\(n(pan.height))],\"minorAlpha\":\(n(g.minorAlpha)),\"majorAlpha\":\(n(g.majorAlpha)),\"dots\":[\(dots.joined(separator: ","))],\"lines\":[\(lines.joined(separator: ","))]}")
  }
  return "[" + out.joined(separator: ",") + "]"
}

func time(_ reps: Int, _ body: () -> Void) -> Double {
  body()
  let t0 = CFAbsoluteTimeGetCurrent()
  for _ in 0..<reps { body() }
  return (CFAbsoluteTimeGetCurrent() - t0) / Double(reps) * 1000
}

let args = CommandLine.arguments
if args.count > 1 && args[1] == "bench" {
  let (nodes, links) = benchNetwork(seed: 20261111, nodeCount: 200, linkCount: 400)
  let viewport = CGSize(width: 1600, height: 1000)
  let planMs = time(20) { _ = LinkRoutePlan.build(nodes: nodes, links: links) }
  let plan = LinkRoutePlan.build(nodes: nodes, links: links)
  print(String(format: "swift: route plan %.3f ms (bowed %d)", planMs, plan.bowedCount))
  for scale in [0.5, 0.86, 1.0, 2.0, 4.0] as [CGFloat] {
    let t = CanvasTransform(scale: scale, pan: CGSize(width: 37, height: -21), viewportSize: viewport)
    let sceneMs = time(60) { _ = CanvasScene(nodes: nodes, links: links, transform: t, classFilter: nil, routePlan: plan) }
    let gridMs = time(200) { _ = GridPath.build(transform: t, size: viewport, gridSpacing: 28) }
    let scene = CanvasScene(nodes: nodes, links: links, transform: t, classFilter: nil, routePlan: plan)
    let hitMs = time(500) { _ = scene.hitNode(at: CGPoint(x: 803, y: 517)); _ = scene.hitLink(at: CGPoint(x: 803, y: 517)) }
    print(String(format: "swift: scale %.0f%%: scene %.3f ms | grid %.3f ms | hit %.3f ms", Double(scale) * 100, sceneMs, gridMs, hitMs))
  }
  exit(0)
}

let (bn, bl) = benchNetwork(seed: 20261111, nodeCount: 200, linkCount: 400)
var nets: [String] = [dumpNetwork("bench", bn, bl, polylines: false, hits: true)]
for seed in [11, 23, 37, 51] as [UInt32] {
  let (nn, ll) = randomNetwork(seed: seed, nodeCount: 30, linkCount: 90, selfLoops: seed == 37 || seed == 51)
  nets.append(dumpNetwork("random\(seed)", nn, ll, polylines: true, hits: seed == 11))
}
let json = "{\"networks\":[" + nets.joined(separator: ",") + "],\"guides\":" + dumpGuides() + ",\"grid\":" + dumpGrid() + "}\n"
try! json.write(toFile: args[1], atomically: true, encoding: .utf8)
print("wrote \(args[1])")
