// Golden-corpus dump for Qnet 0.90.34. NOT part of Qnet: scripts/make-golden.sh appends this file
// to a throwaway copy of 2_QNET's QnetGUIApp.swift (commit dc066f0, extracted outside Dropbox),
// and adds one call at the end of QnetGUIApp.init. Being in the same file as QnetGUIApp gives it
// the app's private report formatters (Analyze Network, Show Network Primitives).
//
//   Qnet --golden <file.bnet> <outdir>
//
// For one network it writes what 0.90.34 produces with default settings:
//   resave.bnet                 the document opened and saved again (TabDocumentWriter.write)
//   <export>.<ext>              each exporter's text, or <export>.error.txt with the sentence
//                               the app would show when the exporter refuses
//   analysis.txt, primitives.txt the two Network-menu reports (or .error.txt)
// Exporter parameters are the ones a run uses with fresh settings (AppSettings.Defaults):
// spectral degree 8, finite-element mesh 10, LP grids auto, fBNAlp uniform grid with HiGHS.
//
//   Qnet --golden-generators <outdir>
//
// Writes what the two network generators build (see runGeneratorGoldenDump below).
import Foundation

extension QnetGUIApp {
    @MainActor
    func runGoldenDumpIfRequested() {
        let args = CommandLine.arguments
        if args.count >= 3, args[1] == "--golden-generators" {
            runGeneratorGoldenDump(to: URL(fileURLWithPath: args[2]))
        }
        guard args.count >= 4, args[1] == "--golden" else { return }
        let input = URL(fileURLWithPath: args[2])
        let out = URL(fileURLWithPath: args[3])
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        guard let data = try? Data(contentsOf: input),
              let doc = try? JSONDecoder().decode(NetworkDocument.self, from: data) else {
            print("ERROR: could not read or decode \(input.path)")
            exit(1)
        }
        let name = input.deletingPathExtension().lastPathComponent
        // The app's own active tab, not a fresh editor: formatNetworkPrimitives (its θ legend) and
        // formatNetworkAnalysis (its link-structure rules) read `activeEditor`, as they do in the
        // app, where it holds the network being analysed.
        let editor = activeEditor
        editor.loadNetwork(document: doc)
        let nodes = editor.nodes, links = editor.links, inf = editor.infiniteBuffers

        func put(_ file: String, _ text: String) {
            try? text.write(to: out.appendingPathComponent(file), atomically: true, encoding: .utf8)
        }
        func emit<E: Error>(_ file: String, _ result: Result<String, E>) {
            switch result {
            case .success(let s): put(file, s)
            case .failure(let e): put(file + ".error.txt", e.localizedDescription + "\n")
            }
        }

        // Open → Save, through the app's own writer.
        do {
            try TabDocumentWriter.write(editor: editor, to: out.appendingPathComponent("resave.bnet"))
        } catch {
            put("resave.bnet.error.txt", error.localizedDescription + "\n")
        }

        // Finite-buffer SRBM inputs (fBNAsm, fBNAfm, fBNAlp) and the finite simulator.
        emit("fbnasm.in", SRBMExporter.exportForSpectral(nodes: nodes, links: links, infiniteBuffers: inf, degree: 8))
        emit("fbnafm.in", SRBMExporter.exportForFiniteElement(nodes: nodes, links: links, infiniteBuffers: inf, meshSize: 10))
        emit("fbnalp.in", SRBMExporter.exportForFiniteLP(nodes: nodes, links: links, gridN: 0, basisM: 0, gridType: "uniform",
                                                         solver: "highs", outputPrefix: "OUTPUT_PREFIX", basisNormalize: false))
        emit("fbnasim.txt", NetworkExporter.export(nodes: nodes, links: links))

        // Orthant SRBM inputs (BNAsm, BNAmc, BNAlp, BNAalr, BNAbb).
        emit("bnasm.in", BNASRBMExporter.exportForSpectral(nodes: nodes, links: links, degree: 8))
        switch BNASRBMExporter.computeData(nodes: nodes, links: links) {
        case .success(let d):
            put("bnamc.in", BNASRBMExporter.formatBNAmcInput(data: d))
            put("bnalp.in", BNASRBMExporter.formatBNAlpInput(data: d))
        case .failure(let e):
            put("bnamc.in.error.txt", e.localizedDescription + "\n")
            put("bnalp.in.error.txt", e.localizedDescription + "\n")
        }
        emit("adaptive-bar.json", BNASRBMExporter.exportForAdaptiveBAR(nodes: nodes, links: links, name: name))
        emit("bar-bounds.json", BNASRBMExporter.exportForBARBounds(nodes: nodes, links: links, name: name))

        // QNA family, the infinite simulator, and the JSON documents.
        emit("qna.qna", QNAExporter.export(nodes: nodes, links: links))
        emit("jackson.sim", BNANetworkExporter.export(nodes: nodes, links: links))
        emit("regenerative.json", RegenerativeExporter.export(editor: editor, name: name))
        emit("product-form.json", ProductFormExporter.export(editor: editor, name: name))
        emit("qbd.json", QBDExporter.export(editor: editor, name: name))
        emit("truncated-ctmc.json", FiniteMarkovExporter.truncatedInfiniteCTMC(editor: editor, name: name))
        emit("generic-ctmc.json", FiniteMarkovExporter.genericCTMC(editor: editor, name: name))
        emit("decomp-loss.json", FiniteMarkovExporter.decomposition(editor: editor, name: name, blocking: "loss"))
        emit("decomp-bas.json", FiniteMarkovExporter.decomposition(editor: editor, name: name, blocking: "bas"))
        emit("decomp-bas-external-loss.json", FiniteMarkovExporter.decomposition(editor: editor, name: name, blocking: "bas_external_loss"))

        // Network › Analyze Network and Network › Show Network Primitives.
        switch SRBMExporter.computeData(nodes: nodes, links: links, infiniteBuffers: inf) {
        case .success(let d):
            put("analysis.txt", formatNetworkAnalysis(d, infiniteBuffers: inf))
            var warnings = networkWarnings(for: d, infiniteBuffers: inf)
            warnings += Self.validateLinkStructure(nodes: nodes, links: links, infiniteBuffers: inf)
            put("primitives.txt", formatNetworkPrimitives(d, warnings: warnings))

            // The flag bar's state, as the analysis that runs on every edit sets it
            // (applyTractability, non-quiet so its Status lines are recorded too).
            let before = editor.statusMessages.count
            applyTractability(to: editor, data: d, quiet: false)
            var flags = ""
            flags += "isAnalyticallyTractable=\(editor.isAnalyticallyTractable)\n"
            flags += "tractabilityIsExact=\(editor.tractabilityIsExact)\n"
            flags += "tractabilityTitle=\(editor.tractabilityTitle)\n"
            flags += "tractabilityDetail=\(editor.tractabilityDetail)\n"
            flags += "tractabilityMeansLabel=\(editor.tractabilityMeansLabel)\n"
            flags += "tractabilityMeans=" + editor.tractabilityMeans.map { String(format: "%.17g", $0) }.joined(separator: " ") + "\n"
            flags += "hasFeedback=\(editor.hasFeedback)\n"
            flags += "feedbackQuality=\(editor.feedbackQuality)\n"
            for c in editor.feedbackCriteria {
                flags += "criterion=\(c.label) | ok=\(c.ok) | \(c.detail)\n"
            }
            flags += "feedbackDescription:\n\(editor.feedbackDescription)\n"
            flags += "tractabilityExplanation:\n\(editor.tractabilityExplanation)\n"
            flags += "status:\n"
            for entry in editor.statusMessages.dropFirst(before) {
                flags += "\(entry.text)\n"
            }
            put("flags.txt", flags)
        case .failure(let e):
            put("analysis.txt.error.txt", "Analyze network aborted: \(e.localizedDescription)\n")
            put("primitives.txt.error.txt", "Network primitives aborted: \(e.localizedDescription)\n")
        }
        print("golden: \(name)")
        exit(0)
    }
}

// ── Qnet --golden-generators <outdir> ───────────────────────────────────────────────────────────
//
// Every file is saved through TabDocumentWriter.write, from an editor holding the network the way
// the app's own commands put it there:
//
//   archetype-<id>-<setting>-d<stations>-c<servers>-rho<ρ>-p<p>-<inf|finite<cap>>-lambda<λ>.bnet
//       Network ▸ Insert Archetype… on an empty canvas: NetworkArchetypeBuilder.build, then
//       NetworkEditorModel.insertSubnetwork at canvasOrigin (renamed copies, fresh ids, the block's
//       top-left moved to the origin, the buffer regime adopted). The numbers in the name are the
//       parameters handed to the builder, before its clamping, so the out-of-range settings show
//       the clamp.
//   built-<id>-default-….bnet
//       NetworkArchetypeBuilder.build's own output at the defaults, put straight into an editor.
//   random-<ff|jfb|gp|reent>-d<d>-k<K>-rho<ρ>-seed<seed>-<inf|finite>.bnet
//       Network ▸ Generate Random Network…: RandomNetworkGenerator.generate with a seed, its nodes,
//       links and regime assigned to a fresh editor as createRandomNetworkTab does. d, K and ρ are
//       inside the sheet's ranges (1–20, 1–8, 0.10–0.99), as the sheet clamps them.
//   archetype-summaries.txt   <file>\t<NetworkArchetypeBuilder.summary> for every archetype file
//   archetype-catalogue.txt   the gallery's groups, then id | group | title | subtitle | knobs
//   swift-random.txt          the seeded generator's raw words and the Swift standard library's
//                             Int.random / Double.random draws from it, for checking the RNG port
extension QnetGUIApp {
    @MainActor
    func runGeneratorGoldenDump(to out: URL) -> Never {
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        var count = 0
        func save(_ editor: NetworkEditorModel, _ file: String) {
            do {
                try TabDocumentWriter.write(editor: editor, to: out.appendingPathComponent(file))
                count += 1
            } catch {
                print("ERROR: \(file): \(error.localizedDescription)")
                exit(1)
            }
        }
        func put(_ file: String, _ text: String) {
            try? text.write(to: out.appendingPathComponent(file), atomically: true, encoding: .utf8)
        }

        // Archetypes. Every knob is set in every setting (the gallery always hands over a whole
        // ArchetypeParameters); a blueprint simply ignores the ones it doesn't use.
        func knobs(_ stations: Int, _ servers: Int, _ rho: Double, _ p: Double,
                   _ infinite: Bool, _ capacity: Int, _ lambda: Double) -> ArchetypeParameters {
            var a = ArchetypeParameters()
            a.stations = stations
            a.servers = servers
            a.targetRho = rho
            a.feedbackProbability = p
            a.infiniteBuffers = infinite
            a.bufferCapacity = capacity
            a.arrivalRate = lambda
            return a
        }
        let settings: [(String, ArchetypeParameters)] = [
            ("default", ArchetypeParameters()),
            ("low", knobs(1, 1, 0.05, 0.0, false, 1, 0.001)),
            ("lowInf", knobs(1, 1, 0.05, 0.0, true, 1, 0.001)),
            ("high", knobs(12, 16, 0.99, 0.9, false, 500, 1000.0)),
            ("highInf", knobs(12, 16, 0.99, 0.9, true, 500, 1000.0)),
            ("mid", knobs(5, 3, 0.75, 0.45, false, 25, 2.5)),
            ("below", knobs(0, 0, 0.01, -0.2, false, 0, 0.0)),
            ("above", knobs(40, 64, 1.2, 0.95, true, 1000, 5000.0)),
        ]
        func tag(_ a: ArchetypeParameters) -> String {
            "d\(a.stations)-c\(a.servers)-rho\(a.targetRho)-p\(a.feedbackProbability)-"
                + (a.infiniteBuffers ? "inf" : "finite\(a.bufferCapacity)") + "-lambda\(a.arrivalRate)"
        }
        var summaries = ""
        for archetype in NetworkArchetype.allCases {
            for (label, params) in settings {
                let file = "archetype-\(archetype.rawValue)-\(label)-\(tag(params)).bnet"
                let built = NetworkArchetypeBuilder.build(archetype, params)
                let editor = NetworkEditorModel()
                editor.insertSubnetwork(
                    nodes: built.nodes,
                    links: built.links,
                    infiniteBuffers: built.infiniteBuffers,
                    at: NetworkArchetypeBuilder.canvasOrigin,
                    actionName: "Insert " + NetworkArchetypeBuilder.blueprint(for: archetype).title,
                    detail: NetworkArchetypeBuilder.summary(archetype, params)
                )
                save(editor, file)
                summaries += file + "\t" + NetworkArchetypeBuilder.summary(archetype, params) + "\n"
            }
            let params = ArchetypeParameters()
            let built = NetworkArchetypeBuilder.build(archetype, params)
            let editor = NetworkEditorModel()
            editor.nodes = built.nodes
            editor.links = built.links
            editor.infiniteBuffers = built.infiniteBuffers
            save(editor, "built-\(archetype.rawValue)-default-\(tag(params)).bnet")
        }
        put("archetype-summaries.txt", summaries)

        var catalogue = "groups: " + NetworkArchetypeBuilder.groups.joined(separator: " | ") + "\n"
        for b in NetworkArchetypeBuilder.blueprints {
            catalogue += [b.id.rawValue, b.group, b.title, b.subtitle,
                          b.knobs.map(\.rawValue).joined(separator: ",")].joined(separator: " | ") + "\n"
        }
        put("archetype-catalogue.txt", catalogue)

        // Random networks: every topology, at the sheet's range ends and in between.
        let topologies: [(String, RandomNetworkGenerator.Topology)] = [
            ("ff", .feedForward), ("jfb", .jacksonFeedback), ("gp", .generalPMatrix), ("reent", .reentrantFeedback),
        ]
        let shapes: [(Int, Int, Double, UInt64, Bool)] = [
            (4, 3, 0.9, 1, true),                       // the sheet's defaults
            (1, 1, 0.1, 0, true),                       // smallest; seed 0 is replaced by 0xdeadbeef
            (20, 8, 0.99, UInt64.max, true),            // largest
            (2, 2, 0.5, 42, false),
            (3, 1, 0.9, 7, true),
            (5, 2, 0.95, 123456789, false),
            (6, 4, 0.75, 20260904, true),
            (3, 3, 0.8, 2, true),
            (3, 3, 0.8, 3, true),
            (8, 5, 0.6, 99, false),
        ]
        for (name, topology) in topologies {
            for (d, k, rho, seed, infinite) in shapes {
                let result = RandomNetworkGenerator.generate(.init(
                    stations: d, classes: k, infiniteBuffers: infinite,
                    targetRho: rho, topology: topology, seed: seed))
                let editor = NetworkEditorModel()
                editor.nodes = result.nodes
                editor.links = result.links
                editor.infiniteBuffers = result.infiniteBuffers
                save(editor, "random-\(name)-d\(d)-k\(k)-rho\(rho)-seed\(seed)-\(infinite ? "inf" : "finite").bnet")
            }
        }

        // The RNG layer on its own: SplitMix64 words, then the stdlib draws the generator makes.
        var text = ""
        for seed: UInt64 in [0, 1, 42, UInt64.max] {
            var raw = SeededRNG(seed: seed)
            text += "next seed=\(seed):" + (0..<8).map { _ in " \(raw.next())" }.joined() + "\n"
        }
        var g: any RandomNumberGenerator = SeededRNG(seed: 20260904)
        let closed: [(Double, Double)] = [(0.55, 0.85), (0.2, 1.0), (0.45, 0.75), (0.05, 0.20), (0.30, 0.60),
                                          (0.1, 1.0), (0.8, 1.4), (0.9, 1.2), (1.0, 2.5), (0.85, 1.15),
                                          (0.1, 0.3), (1.4, 2.0), (0, 1), (0.10, 0.20)]
        for i in 0..<4000 {
            switch i % 4 {
            case 0:
                let (lo, hi) = closed[(i / 4) % closed.count]
                let v = Double.random(in: lo...hi, using: &g)
                text += "double \(lo) \(hi) \(String(v.bitPattern, radix: 16))\n"
            case 1:
                let hi = 1 + (i / 4) % 19
                text += "int 0..<\(hi) \(Int.random(in: 0..<hi, using: &g))\n"
            case 2:
                let lo = (i / 4) % 3, hi = lo + 1 + (i / 4) % 4
                text += "int \(lo)...\(hi) \(Int.random(in: lo...hi, using: &g))\n"
            default:
                let hi = 2 + (i / 4) % 19
                text += "int 1..<\(hi) \(Int.random(in: 1..<hi, using: &g))\n"
            }
        }
        put("swift-random.txt", text)

        print("golden-generators: \(count) networks")
        exit(0)
    }
}
