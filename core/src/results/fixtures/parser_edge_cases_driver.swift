// Runs 0.90.34's own ResultOutputParser on every case in parser_edge_cases.jsonl and prints the
// result in the form parser.rs's edge-case test prints its own; the output is
// parser_edge_cases.expected. Built outside 2_QNET (which is read-only), with the parser harness's
// stubs:
//
//   Q=<path to 2_QNET>
//   swiftc -parse-as-library -module-cache-path /tmp/mc $Q/validation/result_output_parser/stubs.swift \
//       $Q/Sources/Qnet/ResultOutputParser.swift parser_edge_cases_driver.swift -o /tmp/edge
//   /tmp/edge parser_edge_cases.jsonl > parser_edge_cases.expected
//
// The stubs' DS.Number.format is "%.*g" rather than the app's grouped number style, so no case
// has an effective cycle count of 1,000 or more. Measured with Swift 6.4.2 on macOS 27.2.

import Foundation

func g(_ v: Double?) -> String { v.map { String(format: "%.17g", $0) } ?? "-" }

@main
struct EdgeDriver {
    static func main() throws {
        let checkout = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
        let disk = UUID(uuidString: "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
        let nodes = [
            NetworkNode(id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!, kind: .buffer, name: "Waiting Room"),
            NetworkNode(id: checkout, kind: .station, name: "Checkout"),
            NetworkNode(id: disk, kind: .station, name: "Disk"),
        ]
        let text = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        var out = ""
        for (n, line) in text.split(separator: "\n").enumerated() {
            let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            let method = obj["method"] as! String
            let export = obj["export"] as! Bool
            let raw = obj["raw"] as! String
            let run = ResultRunRecord(
                method: ResultMethodMetadata(identifier: method),
                provenance: ResultProvenance(networkSnapshot: ResultNetworkSnapshot(nodes: nodes), exportStationIDs: export ? [checkout] : nil)
            )
            let p = ResultOutputParser.parse(raw, for: run)
            out += "case \(n + 1) \(method)\n"
            switch p.disposition {
            case .completed: out += "disposition: completed\n"
            case .partial(let m): out += "disposition: partial: \(m)\n"
            case .failed(let m): out += "disposition: failed: \(m)\n"
            }
            for m in p.measurements {
                let u = m.uncertainty.map { "\(g($0.standardError)),\(g($0.lowerBound)),\(g($0.upperBound)),\(g($0.confidenceLevel)),\($0.sampleSize.map(String.init) ?? "-")" } ?? "-"
                out += "m: \(m.stationName)|\(m.stationID?.uuidString ?? "-")|\(m.customerClass.map(String.init) ?? "-")|\(m.metric)|\(g(m.estimate))|\(m.unit)|u=\(u)|note=\(m.note ?? "-")\n"
            }
            if let e = p.evidence {
                out += "e: residual=\(g(e.residual))|disc=\(e.discretization ?? "-")|delta=\(g(e.refinementDelta))|note=\(e.convergenceNote ?? "-")\n"
            } else {
                out += "e: -\n"
            }
            for w in p.warnings { out += "w: \(w)\n" }
        }
        print(out, terminator: "")
    }
}
