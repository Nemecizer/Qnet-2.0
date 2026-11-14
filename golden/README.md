# Golden corpus

What Qnet 0.90.34 produces for each of the 50 shipped examples (`../examples/`), so the Rust port can be checked against it (PLAN.md §5). Made by `scripts/make-golden.sh`; never edit a file here by hand. `PROVENANCE.json` names the commit, the toolchain, every change made to the throwaway copy that produced it (the dump itself, and, only on a Mac without Xcode's Metal toolchain, SwiftTerm's shader left out), and a SHA-256 for every file.

Two further subsets have their own script and README: `canvas/` (0.90.34's scene for every example: routes, bundles, label rows, chips, grid and hit geometry at seven zooms) and `edits/` (24 scripted edit sessions replayed through 0.90.34's own editor, with the document and the editor's state after every step), both made by `scripts/make-golden-canvas.sh`.

One folder per example, named after the file without its last `.bnet`:

| File | What it is | 0.90.34 code |
|---|---|---|
| `resave.bnet` | The document opened and saved again | `JSONDecoder` → `NetworkEditorModel.loadNetwork` → `TabDocumentWriter.write` |
| `dump-rho.txt` | Traffic equations, utilisation, aggregated routing, SRBM existence and recurrence, tractability | `Qnet --dump-rho` |
| `analysis.txt` | Network › Analyze Network | `QnetGUIApp.formatNetworkAnalysis` |
| `primitives.txt` | Network › Show Network Primitives | `formatNetworkPrimitives`, with `networkWarnings` and `validateLinkStructure` |
| `flags.txt` | The flag bar's state after an analysis: tractability (with the re-entrant and finite-buffer suppression), feedback description, the four diffusion criteria and quality, and the Status lines it wrote | `applyTractability`, `describeFeedback`, `diffusionFriendlinessAssessment` |
| `fbnasm.in` | Finite spectral input, degree 8 | `SRBMExporter.exportForSpectral` |
| `fbnafm.in` | Finite-element input, mesh 10 | `SRBMExporter.exportForFiniteElement` |
| `fbnalp.in` | Finite LP keyword file (uniform grid, HiGHS, grids auto) | `SRBMExporter.exportForFiniteLP`; `output_prefix` is the placeholder `OUTPUT_PREFIX` where a run writes a temporary path |
| `fbnasim.txt` | Finite simulator input | `NetworkExporter.export`; its `# Generated:` line holds the time it was made |
| `bnasm.in` | Orthant spectral input, degree 8 | `BNASRBMExporter.exportForSpectral` |
| `bnamc.in` | SRBM MLMC input | `BNASRBMExporter.formatBNAmcInput` |
| `bnalp.in` | Orthant LP keyword file (grids auto, exponential) | `BNASRBMExporter.formatBNAlpInput` |
| `adaptive-bar.json`, `bar-bounds.json` | BAR solver documents | `BNASRBMExporter.exportForAdaptiveBAR`, `.exportForBARBounds` |
| `qna.qna` | QNA, RQNA and SBD input | `QNAExporter.export` |
| `jackson.sim` | Infinite simulator input | `BNANetworkExporter.export` |
| `regenerative.json` | Regenerative Monte Carlo document (seed 20260904, stream 0) | `RegenerativeExporter.export` |
| `product-form.json`, `qbd.json` | Product form and QBD documents | `ProductFormExporter.export`, `QBDExporter.export` |
| `truncated-ctmc.json`, `generic-ctmc.json`, `decomp-*.json` | Finite and truncated Markov documents | `FiniteMarkovExporter` |
| `export-all/` | File › Export › All Solver Inputs to Folder | `Qnet --export-cmp` |
| `export-all-loss/`, `export-all-bas/` | The same with Run Comparison's loss or BAS correction (finite-buffer examples only; it changes `sm.in`, `fm.in` and `lp.in`) | `Qnet --export-cmp --loss-fix`, `--bas-fix` |
| `<file>.error.txt` | The sentence 0.90.34 shows when that exporter refuses the network | the exporter's error `localizedDescription` |

Every exporter is run on every example, so a refusal is golden too: the port must refuse the same networks with the same sentence. Some outputs are for networks the Run menu would never send to that solver (a finite network's orthant inputs, say); they are still what the exporter does.

## `generators/`

What 0.90.34's two network generators build, from `Qnet --golden-generators` (the second mode of `tools/GoldenDump.swift`). `scripts/make-golden.sh --generators-only` rebuilds the copy and rewrites only this folder and `PROVENANCE.json`; a full run writes it too. `core/tests/golden_generators.rs` builds each network again from the parameters in its file name and compares the saved text, ids aside.

| File | What it is | 0.90.34 code |
|---|---|---|
| `archetype-<id>-<setting>-d…-c…-rho…-p…-<inf\|finite<cap>>-lambda….bnet` | Insert Archetype on an empty canvas, for each of the five archetypes at eight settings: the defaults, every knob at its low end (finite and infinite buffers), at its high end (both), a middle setting, and below and above every range (to show the clamp). The name holds the parameters as handed to the builder, before clamping. | `NetworkArchetypeBuilder.build`, then `NetworkEditorModel.insertSubnetwork` at `canvasOrigin`, then `TabDocumentWriter.write` |
| `built-<id>-default-….bnet` | The builder's own output at the defaults, before the insert moves it (only the Fork and Merge differs) | `NetworkArchetypeBuilder.build` |
| `random-<ff\|jfb\|gp\|reent>-d<d>-k<K>-rho<ρ>-seed<seed>-<inf\|finite>.bnet` | Generate Random Network with a seed: ten shapes for each topology, from d = 1, K = 1, ρ = 0.1 (seed 0) to d = 20, K = 8, ρ = 0.99 (seed 2⁶⁴ − 1), with finite and infinite buffers | `RandomNetworkGenerator.generate`, assigned to an editor as `createRandomNetworkTab` does |
| `archetype-summaries.txt` | Each archetype file's gallery summary line | `NetworkArchetypeBuilder.summary` |
| `archetype-catalogue.txt` | The gallery's sections and each blueprint's id, section, title, route line and knobs | `NetworkArchetypeBuilder.groups`, `.blueprints` |
| `swift-random.txt` | SplitMix64 words for four seeds, and 4,000 `Double.random(in:)` / `Int.random(in:)` draws from seed 20260904 (doubles as bit patterns) | `SeededRNG` and the Swift standard library |

## `runs/`

What 0.90.34's Run menu does with each example, from `scripts/make-golden-runs.sh`. That script builds its own copy of 0.90.34 with `tools/GoldenDump.swift` and `tools/GoldenRuns.swift` added and five small hooks, each inert unless the dump is running (`GoldenRuns.swift` lists them). The dump then runs 0.90.34's own code path for every Run-menu method of the example's buffer mode: the menu action, its pre-checks, its exporter, the generated bash wrapper with its awk tables and perl display filter, the solver, and finally `ResultOutputParser` and the `ResultsStore` record. Before the runs, the dump opens the example as File › Open does: the tab takes the file's name, the editor remembers its URL, and the open-time analysis sets the tractability flags. The only differences from a click in the app are these: the wrapper runs to completion instead of being typed into a shell, a parameter sheet is answered with its initial values, and an alert is written down instead of shown. The solvers are the staged ones (`scripts/stage-solvers.sh`), reached through `QNET_SOLVER_ROOT`, so 0.90.34 and 2.0 run the same binaries.

Settings are 0.90.34's defaults, except that seeds are fixed and simulations are shortened (8 replications, warm-up 10,000, run length 200,000, run sequentially), and Run Comparison uses the stored blocking regime instead of asking. `runs/PROVENANCE.json` records this and a SHA-256 for every file.

`runs/<example>/<method>/`, where `<method>` is 0.90.34's run label (`qna`, `inf_cmp`, `sm`, …):

| File | What it is |
|---|---|
| `status.txt` | Every Status-log line the action wrote, as `<severity>\t<text>`. For a method that refuses the network, this is the whole golden. |
| `script.sh` | The generated wrapper. Its paths are pid- and uuid-stamped. |
| `archive.txt` | The tee'd full-precision output, which is what the parser read. |
| `display.txt` | What the Shell showed: the archive after the display-precision filter, behind the wrapper's erase-line sequence. |
| `stderr.txt`, `status-inbox.txt` | The wrapper's own stderr (normally empty), and the run's stderr inbox (records separated by `<<<END>>>`). |
| `exit.txt`, `summary.txt` | The wrapper's exit code; `TerminalRunSummary.text`, whose duration varies from run to run. |
| `record.json` | The Results record after finishing (JSONEncoder, pretty, sorted keys, ISO-8601 dates). Its ids, dates and elapsed times vary from run to run. |
| `notes.txt` | Alerts that would have been shown, and a `TIMEOUT` line if a run was cut off at 15 minutes. |

The solver output files each run leaves in the temporary folder (what the wrapper's awk stages read) are kept outside the repository, in `~/Library/Caches/qnet/legacy-0.90.34-runs/tmp/<example>/<method>/`.

`runs/_testsets/` holds three small seeded runs of Run › Test Set (infinite and finite) and Run › Spectral Convergence, in the same layout.

Elapsed times, ids and dates differ on every run; deterministic methods otherwise reproduce exactly, and simulations reproduce for their fixed seeds.
