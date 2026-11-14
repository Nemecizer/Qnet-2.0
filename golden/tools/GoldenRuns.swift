// Golden run dump for Qnet 0.90.34. NOT part of Qnet: scripts/make-golden-runs.sh appends this
// file (after GoldenDump.swift) to a throwaway copy of 2_QNET's QnetGUIApp.swift and makes five
// small edits to that copy, each inert unless GoldenRunHook.active is true:
//
//   TerminalModel.beginRun        skips the one-run-at-a-time refusal and the 500 ms poller, and
//                                 records the run's handle (its coordination file paths)
//   TerminalModel.sendCommand     hands the typed command (`bash "<wrapper>"`) to the dump, which
//                                 runs it to completion instead of typing it into a shell
//   QnetGUIApp.presentRunParameters  answers the parameter sheet with its initial values, as if
//                                 Run were pressed at once
//   QnetGUIApp.showAlert          records the alert instead of showing it
//   QnetGUIApp.init               calls runGoldenRunsIfRequested()
//
// Everything else is 0.90.34's own code path: the Run menu action, its pre-checks, its exporter,
// the generated bash wrapper with its awk tables and perl display filter, the solver, and then
// ResultOutputParser and the ResultsStore record, exactly as finalizeStructuredResult files them.
//
//   Qnet --golden-runs <file.bnet> <outdir> [method ...]
//   Qnet --golden-testsets <outdir>
//
// For each Run-menu method of the network's buffer mode it writes <outdir>/<method>/:
//   status.txt       every Status-log line the action wrote ("<severity>\t<text>"); for a method
//                    that refuses the network this is the whole golden
//   script.sh        the generated wrapper (paths are pid- and uuid-stamped)
//   archive.txt      the tee'd full-precision output: what the parser read
//   display.txt      what the Shell showed (after the display-precision filter)
//   stderr.txt       the wrapper's own stderr (normally empty: the wrapper merges 2>&1)
//   status-inbox.txt the run's stderr inbox (records separated by <<<END>>>)
//   exit.txt         the wrapper's exit code, from its done file
//   summary.txt      TerminalRunSummary.text (its duration varies run to run)
//   record.json      the ResultsStore record after finalizing (ids and dates vary)
//   notes.txt        alerts that would have been shown, and a TIMEOUT line if the run was cut
import Foundation

enum GoldenRunHook {
    nonisolated(unsafe) static var active = false
    nonisolated(unsafe) static var lastHandle: TerminalModel.RunHandle?
    nonisolated(unsafe) static var lastLabel = ""
    nonisolated(unsafe) static var execute: ((String) -> Bool)?
    nonisolated(unsafe) static var notes: [String] = []
    nonisolated(unsafe) static var timeoutSeconds: Double = 900
}

extension QnetGUIApp {
    /// File › Open names the tab after the file (QnetGUIApp.openNetwork); runs read that title (an
    /// exporter's document name, the record's networkTitle). Called from init before the dump,
    /// because the tab list is @State and can only be replaced there.
    @MainActor
    mutating func goldenRetitleIfRequested() {
        let args = CommandLine.arguments
        guard args.count >= 4, args[1] == "--golden-runs" else { return }
        let name = URL(fileURLWithPath: args[2]).lastPathComponent
        let active = activeTabID
        _tabs = State(initialValue: tabs.map { tab in
            var tab = tab
            if tab.id == active { tab.title = name }
            return tab
        })
    }

    @MainActor
    func runGoldenRunsIfRequested() {
        let args = CommandLine.arguments
        if args.count >= 3, args[1] == "--golden-testsets" {
            runGoldenTestSets(to: URL(fileURLWithPath: args[2]))
        }
        guard args.count >= 4, args[1] == "--golden-runs" else { return }
        let input = URL(fileURLWithPath: args[2])
        let out = URL(fileURLWithPath: args[3])
        let only = Set(args.dropFirst(4))
        guard let data = try? Data(contentsOf: input),
              let doc = try? JSONDecoder().decode(NetworkDocument.self, from: data) else {
            print("ERROR: could not read or decode \(input.path)")
            exit(1)
        }
        goldenPrepareSettings()
        let editor = activeEditor
        editor.loadNetwork(document: doc)
        // File › Open also remembers the file's URL (the record's sourceFileURL); the tab's title
        // was set by goldenRetitleIfRequested.
        editor.currentFileURL = input
        // Opening a file in the app runs the silent analysis before anything else can happen; it
        // sets the tractability flags that a run reads (the "──  <detail>  ──" line above a table
        // and the comparison's exact column).
        analyzeActiveTabIfNeeded()

        // The Run menu of each buffer mode (QnetCommands.swift), in menu order. Multi-class SRBM
        // is the experimental item at the end of the infinite list.
        let infinite: [(String, () -> Void)] = [
            ("inf_cmp", { runComparisonInfinite() }),
            ("inf_sim", { runSimulationInfinite() }),
            ("product_form", { runOpenProductForm() }),
            ("qbd", { runQBD() }),
            ("truncated_ctmc", { runTruncatedCTMC() }),
            ("regenerative_mc", { runRegenerativeMonteCarlo() }),
            ("inf_sm", { runSpectralMethodInfinite() }),
            ("qna", { runQNA() }),
            ("rqna", { runRQNA() }),
            ("sbd", { runSBD() }),
            ("mlmc", { runExactSim() }),
            ("lp", { runLinearProgram() }),
            ("adaptive_bar", { runAdaptiveLowRankBAR() }),
            ("bar_bounds", { runBARMomentBounds() }),
            ("mc", { runMultiClassSRBM() }),
        ]
        let finite: [(String, () -> Void)] = [
            ("cmp", { runComparison() }),
            ("sim", { runSimulation() }),
            ("regenerative_mc", { runRegenerativeMonteCarlo() }),
            ("generic_ctmc", { runGenericCTMC() }),
            ("fb_decomp", { runFiniteDecomposition() }),
            ("sm", { runSpectralMethod() }),
            ("fm", { runFiniteElement() }),
            ("flp", { runFiniteLP() }),
        ]
        for (name, action) in (editor.infiniteBuffers ? infinite : finite)
        where only.isEmpty || only.contains(name) {
            goldenRunOne(name: name, into: out.appendingPathComponent(name), action)
        }
        print("golden-runs: \(input.deletingPathExtension().lastPathComponent)")
        exit(0)
    }

    /// Fixed seeds and short simulations, so a simulation's output is a function of its inputs and
    /// the corpus takes minutes, not hours. Everything else stays at AppSettings.Defaults.
    @MainActor
    func goldenPrepareSettings() {
        let d = UserDefaults.standard
        d.set(true, forKey: "sim.seedFixed")
        d.set(8, forKey: "sim.replications")
        d.set(10_000, forKey: "sim.warmup")
        d.set(200_000, forKey: "sim.time")
        d.set(2, forKey: "sim.parallel")          // sequential: no thread-count dependence
        d.set(true, forKey: "mlmc.seedFixed")
        d.set(true, forKey: "runCompare.remember")
        GoldenRunHook.active = true
    }

    @MainActor
    func goldenRunOne(name: String, into dir: URL, _ action: () -> Void) {
        let fm = FileManager.default
        try? fm.removeItem(at: dir)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let editor = activeEditor
        let before = editor.statusMessages.count
        GoldenRunHook.notes = []
        GoldenRunHook.lastHandle = nil
        GoldenRunHook.execute = { command in
            goldenExecute(command, into: dir)
        }
        action()
        var status = ""
        for entry in editor.statusMessages.dropFirst(before) {
            status += "\(entry.severity)\t\(entry.text)\n"
        }
        goldenWrite(dir, "status.txt", status)
        if !GoldenRunHook.notes.isEmpty {
            goldenWrite(dir, "notes.txt", GoldenRunHook.notes.joined(separator: "\n") + "\n")
        }
        GoldenRunHook.execute = nil
    }

    func goldenWrite(_ dir: URL, _ file: String, _ text: String) {
        try? text.write(to: dir.appendingPathComponent(file), atomically: true, encoding: .utf8)
    }

    /// Runs one typed command (`bash "<wrapper>"`) to completion and files its result the way
    /// finalizeStructuredResult does, reading the archive that TerminalModel.lastRunOutput would
    /// have held.
    @MainActor
    func goldenExecute(_ command: String, into dir: URL) -> Bool {
        guard let handle = GoldenRunHook.lastHandle else {
            GoldenRunHook.notes.append("NO HANDLE for command: \(command)")
            return false
        }
        let fm = FileManager.default
        if let open = command.range(of: "bash \""), command.hasSuffix("\"") {
            let path = String(command[open.upperBound..<command.index(before: command.endIndex)])
            if let script = try? String(contentsOfFile: path, encoding: .utf8) {
                goldenWrite(dir, "script.sh", script)
            }
        } else {
            goldenWrite(dir, "script.sh", command + "\n")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = fm.homeDirectoryForCurrentUser
        let displayURL = dir.appendingPathComponent("display.txt")
        let stderrURL = dir.appendingPathComponent("stderr.txt")
        fm.createFile(atPath: displayURL.path, contents: nil)
        fm.createFile(atPath: stderrURL.path, contents: nil)
        guard let displayHandle = try? FileHandle(forWritingTo: displayURL),
              let stderrHandle = try? FileHandle(forWritingTo: stderrURL) else { return false }
        process.standardOutput = displayHandle
        process.standardError = stderrHandle
        process.standardInput = FileHandle.nullDevice
        let started = Date()
        do { try process.run() } catch {
            GoldenRunHook.notes.append("LAUNCH FAILED: \(error.localizedDescription)")
            return false
        }
        var timedOut = false
        while process.isRunning {
            if Date().timeIntervalSince(started) > GoldenRunHook.timeoutSeconds {
                timedOut = true
                // The wrapper wrote its pid; its children share its process group only in an
                // interactive shell, so signal the wrapper's children by name pattern instead.
                kill(process.processIdentifier, SIGINT)
                Thread.sleep(forTimeInterval: 1.5)
                if process.isRunning { process.terminate() }
                Thread.sleep(forTimeInterval: 1.5)
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                break
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        process.waitUntilExit()
        try? displayHandle.close()
        try? stderrHandle.close()
        let elapsed = Date().timeIntervalSince(started)
        if timedOut {
            GoldenRunHook.notes.append("TIMEOUT after \(Int(GoldenRunHook.timeoutSeconds)) s")
        }

        let doneText = (try? String(contentsOfFile: handle.donePath, encoding: .utf8)) ?? ""
        let exitCode = Int32(doneText.trimmingCharacters(in: .whitespacesAndNewlines))
            ?? Int32(process.terminationStatus)
        goldenWrite(dir, "exit.txt", "\(exitCode)\n")
        let raw = try? String(contentsOfFile: handle.outputPath, encoding: .utf8)
        goldenWrite(dir, "archive.txt", raw ?? "")
        if let inbox = try? String(contentsOfFile: handle.statusPath, encoding: .utf8) {
            goldenWrite(dir, "status-inbox.txt", inbox)
        }
        for path in [handle.donePath, handle.pidPath, handle.statusPath, handle.outputPath] {
            try? fm.removeItem(atPath: path)
        }
        // The solver outputs the wrapper's awk stages read (BNET_*_<pid>…) stay in the temporary
        // folder after a run, as in the app. With GOLDEN_KEEP_TMP set they are moved to
        // <GOLDEN_KEEP_TMP>/<method>/ instead (outside the repository), for test fixtures.
        if let keep = ProcessInfo.processInfo.environment["GOLDEN_KEEP_TMP"] {
            let dest = URL(fileURLWithPath: keep).appendingPathComponent(dir.lastPathComponent)
            try? fm.createDirectory(at: dest, withIntermediateDirectories: true)
            let tmp = fm.temporaryDirectory
            let pid = "\(ProcessInfo.processInfo.processIdentifier)"
            for name in (try? fm.contentsOfDirectory(atPath: tmp.path)) ?? []
            where name.hasPrefix("BNET_") && name.contains(pid) {
                try? fm.moveItem(at: tmp.appendingPathComponent(name), to: dest.appendingPathComponent(name))
            }
        }

        // finalizeStructuredResult, with `raw` in place of terminalModel.lastRunOutput.
        let summary = TerminalRunSummary(
            id: handle.id,
            label: TerminalModel.displayLabel(forRunLabel: GoldenRunHook.lastLabel),
            ownerID: activeTabID,
            ownerTitle: activeTabTitle,
            exitCode: exitCode,
            elapsed: elapsed,
            finishedAt: Date(),
            userStopped: timedOut
        )
        goldenWrite(dir, "summary.txt", summary.text + "\n")
        if !summary.succeeded, !summary.cancelled {
            activeEditor.addStatus(summary.text, severity: .error)
        }
        let store = ResultsStore.shared
        if store.record(id: summary.id) != nil {
            if summary.cancelled {
                store.delete(summary.id)
            } else if !summary.succeeded {
                store.failRun(
                    summary.id,
                    message: "\(summary.label) exited with status \(summary.exitCode). See the originating tab's Status pane and retained output.",
                    rawOutput: raw,
                    completedAt: summary.finishedAt
                )
            } else if let record = store.record(id: summary.id) {
                let parsed = ResultOutputParser.parse(raw, for: record)
                switch parsed.disposition {
                case .completed:
                    store.completeRun(summary.id, measurements: parsed.measurements, evidence: parsed.evidence,
                                      warnings: parsed.warnings, rawOutput: raw, completedAt: summary.finishedAt)
                case .partial(let message):
                    store.partialRun(summary.id, message: message, measurements: parsed.measurements,
                                     evidence: parsed.evidence, warnings: parsed.warnings, rawOutput: raw,
                                     completedAt: summary.finishedAt)
                case .failed(let message):
                    store.failRun(summary.id, message: message, rawOutput: raw, completedAt: summary.finishedAt)
                }
            }
            if let record = store.record(id: summary.id) {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                encoder.dateEncodingStrategy = .iso8601
                if let data = try? encoder.encode(record), let text = String(data: data, encoding: .utf8) {
                    goldenWrite(dir, "record.json", text + "\n")
                }
            } else {
                goldenWrite(dir, "record.json", "null\n")
            }
        }
        return true
    }

    /// Run ▸ Test Set and Run ▸ Spectral Convergence, small and seeded, for both buffer modes.
    /// Their runners are async and hop to the main actor, so the main run loop is spun while they
    /// work.
    @MainActor
    func runGoldenTestSets(to out: URL) {
        goldenPrepareSettings()
        GoldenRunHook.timeoutSeconds = 1800
        final class Flag: @unchecked Sendable { var done = false }
        func wait(_ body: @escaping @MainActor () async -> Void) {
            let flag = Flag()
            Task { @MainActor in await body(); flag.done = true }
            while !flag.done {
                RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            }
        }
        var inf = TestSetParameters()
        inf.stationsLower = 2; inf.stationsUpper = 3
        inf.classesLower = 1; inf.classesUpper = 2
        inf.numTestCases = 3
        inf.seed = 20261110
        var fin = inf
        fin.seed = 20261111
        var spc = SpectralConvergenceParameters()
        spc.stationsLower = 2; spc.stationsUpper = 3
        spc.classesLower = 1; spc.classesUpper = 1
        spc.rhoStart = 0.5; spc.rhoEnd = 0.7; spc.rhoStep = 0.1
        spc.numTestCases = 2
        spc.seed = 20261112
        let cases: [(String, Bool, @MainActor () async -> Void)] = [
            ("testset-infinite", true, { await self.executeTestSet(params: inf, infinite: true) }),
            ("testset-finite", false, { await self.executeTestSet(params: fin, infinite: false) }),
            ("spc", true, { await self.executeSpectralConvergence(params: spc) }),
        ]
        for (name, infinite, body) in cases {
            activeEditor.infiniteBuffers = infinite
            activeEditor.hasBeenAnalyzed = false
            analyzeActiveTabIfNeeded()
            goldenRunOne(name: name, into: out.appendingPathComponent(name)) { wait(body) }
        }
        print("golden-testsets")
        exit(0)
    }
}
