// The Help content (docs/help/: manifest.json and one Markdown file per topic, carried from
// 0.90.34's AlgorithmHelp.swift by scripts/help-extract.mjs) under the Help lint: the same checks
// as `node scripts/help-lint.mjs`, the Help menu's ids against the manifest, and each rule shown
// to bite. Ledger §14.2 (HELP-021…052), §14.3 (HELP-053…087) and INV-043.
import { describe, expect, it } from "vitest";
import manifestJson from "../../docs/help/manifest.json";
import { lintHelp, lintRepository, readRepository, type HelpManifestEntry } from "../../scripts/help-lint.mjs";
import { AI_PROVIDER_TOPICS, METHOD_REFERENCE, specCommandIds } from "../lib/menuSpec";

const manifest = manifestJson as HelpManifestEntry[];
// The topic files, loaded the way the Help window loads them.
const raw = import.meta.glob("../../docs/help/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const files = Object.fromEntries(Object.entries(raw).map(([path, text]) => [path.split("/").pop()!, text]));
const text = (id: string) => files[`${id}.md`];
// What the scripting article is checked against (gap FIX-104).
const sources = import.meta.glob(["../../scripts/stage-python.sh", "../../python/qnet/_cli.py", "../../python/README.md", "../../python/pyproject.toml"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const source = (name: string) => Object.entries(sources).find(([path]) => path.endsWith(name))![1];

describe("the Help lint", () => {
  it("finds nothing wrong with docs/help, the Help menu and every help command id under src/", () => {
    expect(lintRepository()).toEqual([]);
  });

  it("passes on the files as the Help window loads them", () => {
    expect(Object.keys(files)).toHaveLength(manifest.length);
    expect(lintHelp({ manifest, files })).toEqual([]);
  });
});

describe("the Help topics (ledger §14.2)", () => {
  it("are 2.1's articles under Start Here and Results, then 0.90.34's in the sidebar's order under its five groups (HELP-021…051)", () => {
    expect(manifest).toHaveLength(59);
    const added = manifest.filter((t) => t.section === "Start Here" || t.section === "Results");
    expect(added.map((t) => [t.section, t.id])).toEqual([
      ["Start Here", "startHere"], ["Start Here", "solve"], ["Start Here", "agreementView"], ["Start Here", "whatQnetNeeds"],
      ["Start Here", "welcomeView"], ["Start Here", "guidedTour"], ["Start Here", "problemsOnCanvas"], ["Start Here", "keyboardAndVoiceOver"],
      ["Results", "resultsOnCanvas"], ["Results", "liveResults"], ["Results", "animate"], ["Results", "charts"], ["Results", "whatIfSweeps"], ["Results", "sensitivity"], ["Results", "uncertainty"], ["Results", "capacity"], ["Results", "scenarios"], ["Results", "transient"], ["Results", "closedNetworks"], ["Results", "replicatedSimulation"], ["Results", "priorityQueues"], ["Results", "batchArrivals"], ["Results", "timeVaryingRates"], ["Results", "fitFromData"], ["Results", "runFailures"], ["Results", "explainAssistant"], ["Results", "scriptingPython"],
    ]);
    expect(manifest.slice(0, added.length)).toEqual(added);
    expect(manifest.slice(added.length).map((t) => t.id)).toEqual([...METHOD_REFERENCE.flatMap((s) => s.topics.map(([id]) => id)), ...AI_PROVIDER_TOPICS.map(([id]) => id)]);
    expect([...new Set(manifest.map((t) => t.section))]).toEqual(["Start Here", "Results", "Concepts", "Infinite-Buffer Methods", "Finite-Buffer Methods", "Workflows", "AI Providers"]);
    for (const { section, topics } of METHOD_REFERENCE) {
      expect(manifest.filter((t) => t.section === section).map((t) => [t.id, t.title])).toEqual(topics);
    }
    expect(manifest.filter((t) => t.section === "AI Providers").map((t) => [t.id, t.title])).toEqual(AI_PROVIDER_TOPICS);
    expect(manifest[0].id).toBe("startHere"); // the default topic (2.1; 0.90.34's was srbmOrthant, HELP-021)
    expect(manifest[added.length].id).toBe("srbmOrthant");
  });

  it("carry 0.90.34's titles, window titles, captions and shell labels", () => {
    const row = (id: string) => {
      const t = manifest.find((x) => x.id === id)!;
      return [t.title, t.windowTitle, t.subtitle, t.label, t.kind];
    };
    expect(row("spectralInfinite")).toEqual(["Spectral Method", "Spectral Method (Infinite Buffers)", "BNAsm · bnet", "help_alg_sm_inf", "method"]);
    expect(row("rqna")).toEqual(["RQNA", "RQNA — Robust QNA", "BNArqna · bna_rqna", "help_alg_rqna", "method"]);
    expect(row("exactSimulation")).toEqual(["SRBM MLMC", "SRBM MLMC", "BNAmc · rbm_mlmc", "help_alg_exact_sim", "guide"]);
    expect(row("finiteLP")).toEqual(["Finite-Buffer LP", "Finite-Buffer LP", "fBNAlp · fBNAlp_solver", "help_alg_lp", "method"]);
    expect(row("inspector")).toEqual(["Editing Parameters", "Inspector Pane and Parameter Sheets", "View ▸ Panes ▸ Inspector · Edit ▸ Edit Parameters…", "help_inspector", "topic"]);
    expect(row("general")).toEqual(["General", "General Preferences", undefined, "help_general", "topic"]);
    expect(row("connectOllama")).toEqual(["Ollama", "Connecting to Ollama", undefined, "help_ollama", "topic"]);
    // Changed (CLI-011): 0.90.34's caption named `Qnet --export-cmp`.
    expect(row("solverInputs")).toEqual(["Solver Input Files", "Solver Input Files", "File ▸ Export · qnet-cli export-all", "help_solver_inputs", "topic"]);
    expect(manifest.filter((t) => t.subtitle && t.section !== "Start Here" && t.section !== "Results").length).toBe(20);
  });

  it("exist for every Help command the menu bar names", () => {
    const ids = specCommandIds().filter((id) => /^help:(topic|ref):/.test(id));
    // Keyboard Shortcuts, the MLMC guide and Scripting with Python; the Method Reference; the four providers (OpenAI's new in 2.1).
    expect(ids).toHaveLength(3 + 28 + 4);
    expect(ids).toContain("help:topic:scriptingPython");
    const known = new Set(manifest.map((t) => t.id));
    expect(ids.filter((id) => !known.has(id.replace(/^help:(topic|ref):/, "")))).toEqual([]);
  });
});

describe("Scripting with Python says which Python, and each sentence is what the code does (FIX-104)", () => {
  it("names Qnet's own Python as not for scripts, PYTHONPATH as ignored by design, and qnet-cli as the tool looked for", () => {
    const article = text("scriptingPython");
    const readme = source("python/README.md").replace(/\s+/g, " ");
    expect(article).toContain("Use your own Python, 3.9 or later");
    expect(article).toContain("Do not run your scripts with the Python inside Qnet.app (Qnet.app/Contents/Resources/python/bin/python3). That Python is Qnet's own");
    expect(article).toContain("By design it ignores PYTHONPATH");
    expect(article).toContain("/Applications/Qnet.app/Contents/MacOS/qnet-cli, and that is the file the package looks for");
    expect(readme).toContain("Use your own Python 3.9 or later");
    expect(readme).toContain("Do not run scripts with the Python inside the app (`Qnet.app/Contents/Resources/python/bin/python3`)");
    expect(readme).toContain("By design it ignores `PYTHONPATH`");
    expect(readme).toContain("`/Applications/Qnet.app/Contents/MacOS/qnet-cli` is the file it looks for");

    // The launcher: PYTHONPATH unset, the environment and the user's site-packages ignored, at
    // Resources/python/bin/python3, with NumPy the one package added.
    const launcher = source("stage-python.sh");
    expect(launcher).toMatch(/^unset PYTHONPATH PYTHONHOME /m);
    expect(launcher).toMatch(/^exec "\\\$here\/python\$PY_SERIES" -E -s -B "\\\$@"$/m);
    expect(launcher).toContain("Qnet.app/Contents/Resources/python/");
    expect(launcher).toContain("one pinned NumPy wheel");
    // The package: 3.9 or later, and where it looks.
    expect(source("pyproject.toml")).toContain('requires-python = ">=3.9"');
    const cli = source("_cli.py");
    expect(cli).toContain('APP_CLI = "Contents/MacOS/qnet-cli"');
    expect(cli).toContain('out.append(("/Applications/Qnet.app", Path("/Applications/Qnet.app") / APP_CLI))');
  });
});

describe("the Help texts (ledger §14.3)", () => {
  it("open with 0.90.34's headings (HELP-053…083)", () => {
    const heading = (id: string) => text(id).split("\n")[0];
    expect(heading("srbmOrthant")).toBe("# ABOUT SRBM IN AN ORTHANT");
    expect(heading("srbmHypercube")).toBe("# ABOUT FINITE-DIMENSIONAL SRBM IN A HYPERCUBE");
    expect(heading("testSets")).toBe("# HELP — Run Test Set (Infinite / Finite)");
    expect(heading("general")).toBe("# HELP — General Preferences");
    expect(heading("inspector")).toBe("# HELP — Inspector Pane and Parameter Sheets");
    expect(heading("interactiveShell")).toBe("# HELP — Shell Pane");
    expect(heading("feedbackNetworks")).toBe("# HELP — Feedback Networks");
    expect(heading("analyticalTractability")).toBe("# HELP — Analytical Tractability");
    expect(heading("spectralInfinite")).toBe("# SPECTRAL METHOD — INFINITE BUFFERS (BNAsm / `bnet`)");
    expect(heading("qna")).toBe("# QNA — QUEUEING NETWORK ANALYZER (BNAqna)");
    expect(heading("rqna")).toBe("# RQNA — REFINED QUEUEING NETWORK ANALYZER (BNArqna)");
    expect(heading("sbd")).toBe("# SBD — SEQUENTIAL BOTTLENECK DECOMPOSITION (BNAsbd)");
    expect(heading("simulationInfinite")).toBe("# SIMULATION (INFINITE BUFFERS) — jackson\\_sim (BNAsim)");
    expect(heading("spectralFinite")).toBe("# SPECTRAL METHOD — FINITE BUFFERS (fBNAsm / `srbm_solver`)");
    expect(heading("finiteElement")).toBe("# FINITE ELEMENT METHOD — fBNAfm");
    expect(heading("finiteLP")).toBe("# FINITE-BUFFER LP — fBNAlp");
    expect(heading("adaptiveTruncatedCTMC")).toBe("# ADAPTIVE TRUNCATED CTMC — INFINITE MARKOV CHAIN");
    expect(heading("regenerativeSimulation")).toBe("# REGENERATIVE MONTE CARLO — QUEUEING PROCESS");
    expect(heading("adaptiveLowRankBAR")).toBe("# ADAPTIVE LOW-RANK BAR — ORTHANT SRBM");
    expect(heading("barMomentBounds")).toBe("# BAR STEADY-STATE MOMENT BOUNDS — ORTHANT SRBM");
    expect(heading("ctmc")).toBe("# EXACT SPARSE CTMC — FINITE MARKOV CHAIN");
    expect(heading("finiteDecomposition")).toBe("# FINITE-BUFFER DECOMPOSITION — fBNAdecomp");
    expect(heading("simulationFinite")).toBe("# SIMULATION (FINITE BUFFERS) — fBNAsim");
    expect(heading("connectAnthropic")).toBe("# HOW TO — Connect the AI Assistant to Anthropic (Claude API)");
    expect(heading("connectOpenAI")).toBe("# HOW TO — Connect the AI Assistant to OpenAI");
    expect(heading("connectLMStudio")).toBe("# HOW TO — Connect the AI Assistant to LM Studio (local inference)");
    expect(heading("connectOllama")).toBe("# HOW TO — Connect the AI Assistant to Ollama (local inference)");
    expect(heading("linearProgramInfinite")).toBe("# LINEAR PROGRAM — INFINITE BUFFERS (BNAlp / `srbm_lp`)");
    expect(heading("multiClassSRBM")).toBe("# MULTI-CLASS SRBM — EXPERIMENTAL (`mc_solver`)");
    expect(heading("solverInputs")).toBe("# SOLVER INPUT FILES");
    expect(heading("exactSimulation")).toBe("# SRBM MULTILEVEL MONTE CARLO");
    expect(heading("keyboardShortcuts")).toBe("# KEYBOARD SHORTCUTS");
  });

  it("keep formulas and aligned tables monospaced, as written", () => {
    expect(text("srbmOrthant")).toContain("```\ndW_t = θ dt + σ dB_t + R dL_t                        (*)\n```");
    expect(text("qna")).toContain("   ```\n    E[W_q] = ρ / (1 − ρ) · (c_a² + c_s²) / 2 · (1/μ)\n   ```");
    expect(text("solverInputs")).toContain("qna.qna       QNA, RQNA, SBD          bna_qna, bna_rqna, bna_sbd\n");
    expect(text("exactSimulation")).toContain("```\nSRBM MLMC (Blanchet-Chen-Glynn-Si)\n==================================\n# Dimension: 5\n");
  });

  it("leave the shortcut tables to the Help window, where the marker stands (HELP-043)", () => {
    const t = text("keyboardShortcuts");
    expect(t.match(/<!-- generated: shortcuts -->/g)).toHaveLength(1);
    expect(t.indexOf("## CONVENTIONS")).toBeLessThan(t.indexOf("<!-- generated: shortcuts -->"));
    expect(t.indexOf("<!-- generated: shortcuts -->")).toBeLessThan(t.indexOf("## KEYS NOT PRINTED IN A MENU"));
  });

  it("say what 2.0 does where 0.90.34's sentence no longer holds", () => {
    const all = Object.values(files).join("\n");
    for (const gone of ["UserDefaults", "--export-cmp", "QNET_MENU_AUDIT", "arrow.clockwise", "Qnet source tree"]) expect(all).not.toContain(gone);
    expect(text("general")).toContain("persisted in Qnet's settings file (settings.json in the app's data folder).");
    expect(text("solverInputs")).toContain("qnet-cli export-all network.bnet /path/to/folder");
    expect(text("interactiveShell")).toContain("Any of the fixed-width font families that ship with macOS.");
  });

  it("say what was already out of date in 0.90.34 the way 2.0 has it (the owner's wording pass)", () => {
    const all = Object.values(files).join("\n");
    // The product's old name survives only in the default system prompt, quoted as it is stored.
    expect(all.match(/\bBNET\b/g)).toHaveLength(1);
    expect(text("connectAnthropic")).toContain('embedded in BNET...")');
    for (const gone of ["eight-tool", "all eight", "▶", "paper airplane", "Interactive Shell", "Exact Simulation", "SRBMExporter", "fmMeshCap", "Remember choice", "Restore Defaults", "Settings ▸ RQNA", "no seed input"]) expect(all).not.toContain(gone);
    expect(text("testSets")).toContain("Test ▸ Run Infinite Test Set …");
    expect(text("connectOllama")).toContain("all nine Qnet tools (get\\_network\\_summary, add\\_node, delete\\_node, add\\_link, delete\\_link, update\\_node, update\\_link, run\\_command, read\\_status)");
    // The catalog is 0.90.34's nine tools and 2.1's explaining tools: the sentence names no number that can rot.
    expect(text("connectLMStudio")).toContain("Qnet sends the full tool catalog");
    expect(text("connectOllama")).toContain("Qnet sends the full tool catalog");
    expect(all).not.toMatch(/\b(?:nine|\d+)-tool catalog\b/);
    expect(text("interactiveShell")).toContain("## SETTINGS (Settings ▸ Panes)");
    expect(text("general")).toContain("Remember blocking choice:");
    expect(text("general")).toContain('"Reset to Defaults" resets only the fields in this pane');
    expect(text("spectralInfinite")).toContain("(Help ▸ Method Reference ▸ Analytical Tractability)");
    expect(text("testSets")).toContain("BAS correction (applied automatically for BAS and BAS+ExtLoss)");
  });
});

describe("each rule of the lint", () => {
  const good = { manifest, files };
  const withFile = (id: string, change: (t: string) => string) => ({ manifest, files: { ...files, [`${id}.md`]: change(text(id)) } });
  const rules = (problems: string[]) => [...new Set(problems.map((p) => p.split(":")[0]))];

  it("manifest: fields, kinds and ids", () => {
    expect(lintHelp({ manifest: {}, files })).toEqual(["manifest: manifest.json: not an array"]);
    const broken = manifest.map((t, i) => (i === 0 ? { ...t, kind: "page", keywords: "srbm" } : i === 1 ? { ...t, title: "" } : t));
    const problems = lintHelp({ manifest: broken, files });
    expect(problems).toContain('manifest: manifest.json[0]: "kind" is "page", not one of topic, method, guide');
    expect(problems).toContain('manifest: manifest.json[0]: "keywords" is not an array of non-empty strings');
    expect(problems).toContain('manifest: manifest.json[1]: "title" is missing or empty');
  });

  it("unique and order", () => {
    expect(lintHelp({ manifest: [...manifest, manifest[0]], files })).toContain('unique: startHere: id "startHere" is used twice');
    const moved = [...manifest.slice(1), manifest[0]];
    expect(lintHelp({ manifest: moved, files })).toContain('order: startHere: section "Start Here" is split in two');
  });

  it("files: both ways", () => {
    const { ["qna.md"]: _dropped, ...rest } = files;
    expect(lintHelp({ manifest, files: rest })).toEqual(["files: qna: qna.md does not exist"]);
    expect(lintHelp({ manifest, files: { ...files, "stray.md": "# Stray\n\ntext\n" } })).toEqual(["files: stray.md: is in docs/help but not in the manifest"]);
  });

  it("empty and structure", () => {
    expect(rules(lintHelp(withFile("qna", () => "# QNA\n")))).toEqual(["empty"]);
    expect(rules(lintHelp(withFile("qna", (t) => t.replace(/^# /, ""))))).toContain("empty");
    expect(rules(lintHelp(withFile("qna", (t) => t + "\n### Deeper\n")))).toEqual(["structure"]);
    expect(rules(lintHelp(withFile("qna", (t) => t + "\nWHAT IT IS\n----------\n")))).toEqual(["structure"]);
    expect(rules(lintHelp(withFile("qna", (t) => t + "\n```\nnever closed\n")))).toEqual(["structure"]);
  });

  it("swift leftovers", () => {
    expect(rules(lintHelp(withFile("qna", (t) => t + "\nServers: \\(count)\n")))).toEqual(["swift"]);
    expect(rules(lintHelp(withFile("qna", (t) => t + '\nstatic let algQNA = """\n')))).toEqual(["swift"]);
    expect(rules(lintHelp(withFile("qna", (t) => t + '\nA \\"quoted\\" word\n')))).toEqual(["swift"]);
  });

  it("html and the generated-block marker", () => {
    expect(rules(lintHelp(withFile("qna", (t) => t + "\n<b>bold</b>\n")))).toEqual(["html"]);
    expect(rules(lintHelp(withFile("qna", (t) => t + "\n<!-- generated: shortcuts -->\n")))).toEqual(["html"]);
    expect(rules(lintHelp(withFile("keyboardShortcuts", (t) => t.replace("<!-- generated: shortcuts -->", ""))))).toEqual(["html"]);
    expect(lintHelp(withFile("qna", (t) => t + "\nρ \\< 1 and `a <b> c`\n"))).toEqual([]);
  });

  it("links", () => {
    expect(lintHelp(withFile("qna", (t) => t + "\nSee [RQNA](help:rqna) and [the paper](https://example.org/).\n"))).toEqual([]);
    expect(lintHelp(withFile("qna", (t) => t + "\nSee [RQNA](help:rqnaa).\n"))[0]).toMatch(/^links: qna\.md:\d+: help:rqnaa is not a topic$/);
    expect(rules(lintHelp(withFile("qna", (t) => t + "\nSee [the file](../PARITY.md).\n")))).toEqual(["links"]);
  });

  it("commands: ids written under src/ and the Help menu's tables", () => {
    const src = (code: string) => lintHelp({ ...good, sources: { "src/x.ts": code } });
    expect(src('runCommand("help:topic:qna"); runCommand("help:ref:testSets"); const s = { helpTopic: "srbmHypercube" };')).toEqual([]);
    expect(src('runCommand("help:topic:qnaa");')).toEqual(["commands: src/x.ts:1: help:topic:qnaa names no topic"]);
    expect(src('\nrunCommand("help:ref:nope");')).toEqual(["commands: src/x.ts:2: help:ref:nope names no topic"]);
    expect(src('<Footer helpTopic="testSet" />')).toEqual(['commands: src/x.ts:1: helpTopic "testSet" names no topic']);
    expect(src('export const AI_PROVIDER_TOPICS: [string, string][] = [["connectAnthropic", "Anthropic"], ["connectGemini", "Gemini"]];\n')).toEqual([
      'commands: src/x.ts:1: AI_PROVIDER_TOPICS names "connectGemini", which is no topic',
    ]);
    expect(src('export const METHOD_REFERENCE = [\n  { section: "Concepts", topics: [["qna", "Whitt QNA"]] },\n];\n')).toEqual([
      'commands: src/x.ts:2: METHOD_REFERENCE labels qna "Whitt QNA", but its title is "QNA"',
    ]);
  });

  it("0.90.34's design lint: ▸ in menu paths, ⌃⌥⇧⌘ order, ⌘digit for the tabs", () => {
    expect(rules(lintHelp(withFile("qna", (t) => t + "\nSee Settings → Simulation.\n")))).toEqual(["menu-arrows"]);
    expect(rules(lintHelp(withFile("qna", (t) => t + "\nPress ⌘⇧W.\n")))).toEqual(["modifier-order"]);
    expect(rules(lintHelp(withFile("qna", (t) => t + "\nPress ⌘1 to fit.\n")))).toEqual(["cmd-digit"]);
    expect(lintHelp(withFile("qna", (t) => t + "\nPress ⌥⌘1, ⌃⌘5 or ⇧⌘0; ⌘1–⌘9 show tabs.\n"))).toEqual([]);
  });

  it("0.90.34's source check and the result-claim vocabulary (INV-043)", () => {
    expect(rules(lintHelp(withFile("rqna", (t) => t.replace("REFINED", "ROBUST"))))).toEqual(["anchor"]);
    expect(rules(lintHelp(withFile("qna", (t) => t + "\nThis result is certified.\n")))).toEqual(["claims"]);
    expect(lintHelp(withFile("barMomentBounds", (t) => t + "\nlabeled certified\n"))).toEqual([]);
  });

  it("product-name: BNET is the file format and a binary, not the product", () => {
    expect(lintHelp(withFile("qna", (t) => t + "\nBNET reports the means.\n"))[0]).toMatch(/^product-name: qna\.md:\d+: the product is Qnet, not BNET: BNET reports the means\.$/);
    expect(lintHelp(withFile("qna", (t) => t + '\nOpen network.bnet, run `bnet`, keep BNET_testset; the default prompt says "embedded in BNET...".\n'))).toEqual([]);
  });

  it("menu-path and tool-count: menus, Settings panes and the AI tools, as the sources have them", () => {
    const { sources } = readRepository();
    const real = (id: string, add: string) => lintHelp({ ...withFile(id, (t) => t + `\n${add}\n`), sources });
    expect(real("qna", "Run ▸ Run Infinite Test Set … starts a sweep.")[0]).toMatch(/^menu-path: qna\.md:\d+: "Run ▸ Run Infinite Test Set … starts a sweep\." is not in the Run menu; it is in Test$/);
    expect(real("qna", "Edit ▸ Zoom to Fit")[0]).toMatch(/is not in the Edit menu; it is in View$/);
    expect(real("qna", "Settings ▸ Interactive Shell Window")[0]).toMatch(/^menu-path: qna\.md:\d+: "Settings ▸ Interactive Shell Window" names no Settings pane \(General, /);
    expect(real("qna", "Test ▸ Run Finite Test Set…, Run ▸ Run SRBM MLMC (⌥⌘E), View ▸ Panes ▸ Inspector, File ▸ Export writes, Window ▸ Focus Shell.")).toEqual([]);
    expect(real("qna", "Settings ▸ Discrete-Event Simulation ▸ Blocking mode; Settings ▸ Panes; set in Settings ▸\nTest Sets.")).toEqual([]);
    expect(real("qna", "Qnet sends the eight-tool catalog.")[0]).toMatch(/^tool-count: qna\.md:\d+: "eight-tool catalog", but src\/panes\/ai\/tools\.ts has 9 tools$/);
    expect(real("qna", "all 8 Qnet tools")[0]).toMatch(/^tool-count: /);
    expect(real("qna", "the nine-tool catalog; all nine Qnet tools")).toEqual([]);
    // Without the sources (the Help window's own load) these two rules have nothing to read.
    expect(lintHelp(withFile("qna", (t) => t + "\nRun ▸ Run Infinite Test Set; the eight-tool catalog.\n"))).toEqual([]);
    // A source that no longer reads is a problem, not a silent pass.
    expect(lintHelp({ ...good, sources: { "src/panes/ai/tools.ts": "export const TOOLS = [];" } })).toEqual(["tool-count: src/panes/ai/tools.ts: SPECS' tools could not be counted"]);
  });
});
