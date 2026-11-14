// The sentences of 0.90.34's Help that are untrue of Qnet 2.0, and what docs/help/ says instead.
// `from` is 0.90.34's plain text exactly as in the Swift literal (line breaks included); `to`
// replaces it before the text is typeset. scripts/help-extract.mjs stops if a `from` is not found.
// Each entry is a Changed note in docs/PARITY.md (§14.2, the topic's row).
export const CORRECTIONS = [
  {
    topic: "general",
    from: "These preferences are persisted via macOS UserDefaults.",
    to: "These preferences are persisted in Qnet's settings file (settings.json\nin the app's data folder).",
    why: "SET-216: UserDefaults became settings.json.",
  },
  {
    topic: "interactiveShell",
    from: "Any font family installed on the machine.",
    to: "Any of the fixed-width font families that ship with macOS.",
    why: "SET-141: a web view can't list the installed families, so the menu offers the fixed-pitch families macOS ships.",
  },
  {
    topic: "solverInputs",
    from: "The GUI's own headless mode writes the whole set:\n\n    Qnet --export-cmp network.bnet /path/to/folder",
    to: "The command-line tool qnet-cli writes the whole set:\n\n    qnet-cli export-all network.bnet /path/to/folder",
    why: "CLI-011: 0.90.34's `Qnet --export-cmp` is `qnet-cli export-all` in 2.0 (the app's own binary has no headless mode).",
  },
  {
    topic: "solverInputs",
    from: "The paths are relative to the Qnet source tree; inside Qnet.app\nthe binaries live under Contents/Resources/bin.",
    to: "The paths are relative to the folder that holds the solver programs;\ninside Qnet.app that is Contents/Resources/bin.",
    why: "INV-030: 2.0's source tree holds solver sources only (solvers/); the binaries are built outside it and bundled under Contents/Resources/bin.",
  },
  {
    topic: "keyboardShortcuts",
    from: "Launch Qnet with QNET_MENU_AUDIT=1 in the environment to print this\nmap to standard error and exit non-zero if two items share a key.\nA debug build runs the same check shortly after launch.",
    to: "Qnet's own tests fail if two menu items share a key, and a debug\nbuild prints any shared key to standard error when it builds the menu bar.",
    why: "MENU-199: 2.0 has no QNET_MENU_AUDIT flag; the menu description is checked by a test and by debug builds (menu.rs duplicate_accels).",
  },
  {
    topic: "connectAnthropic",
    from: "\"anthropic\" — not in UserDefaults,",
    to: "\"anthropic\" — not in settings.json,",
    why: "SET-216: there is no UserDefaults in 2.0; the settings file is settings.json.",
  },
  {
    topic: "connectLMStudio",
    from: "SHORTCUT: click the arrow.clockwise\n                             button next to the Model field to",
    to: "SHORTCUT: click the \"Refresh model list\"\n                             button next to the Model field to",
    why: "SF Symbols became lucide icons (HELP-004's reason): `arrow.clockwise` names nothing in 2.0; the button's label is \"Refresh model list\" (SET-155).",
  },
  // The owner's wording pass (P9): text that was already out of date in 0.90.34, or that names
  // something of 0.90.34's that 2.0 does not have. Each was checked against menuSpec.ts, the
  // Settings registry and words, src/panes/ai/tools.ts or the solver it describes.
  {
    topic: "analyticalTractability",
    from: "In those cases, BNET sidesteps",
    to: "In those cases, Qnet sidesteps",
    why: "The product is Qnet; \"BNET\" was its earlier name (out of date in 0.90.34).",
  },
  {
    topic: "analyticalTractability",
    from: "BNET reports the corresponding means",
    to: "Qnet reports the corresponding means",
    why: "The product is Qnet, not BNET (out of date in 0.90.34).",
  },
  {
    topic: "feedbackNetworks",
    from: "BNET supports queueing networks",
    to: "Qnet supports queueing networks",
    why: "The product is Qnet, not BNET (out of date in 0.90.34).",
  },
  {
    topic: "feedbackNetworks",
    from: "to the sink. BNET checks this",
    to: "to the sink. Qnet checks this",
    why: "The product is Qnet, not BNET (out of date in 0.90.34).",
  },
  {
    topic: "feedbackNetworks",
    from: "HOW TO EXERCISE FEEDBACK IN BNET\n--------------------------------",
    to: "HOW TO EXERCISE FEEDBACK IN QNET\n--------------------------------",
    why: "The product is Qnet, not BNET (out of date in 0.90.34).",
  },
  {
    topic: "connectAnthropic",
    from: "can drive BNET\nvia natural language",
    to: "can drive Qnet\nvia natural language",
    why: "The product is Qnet, not BNET (out of date in 0.90.34).",
  },
  {
    topic: "connectAnthropic",
    from: "BNET  →  Settings…",
    to: "Qnet  →  Settings…",
    why: "MENU-002: Settings… is in the Qnet menu (menuSpec.ts); the menu was never called BNET in 0.90.34 either.",
  },
  {
    topic: "connectAnthropic",
    from: "\"Test Connection\". BNET sends",
    to: "\"Test Connection\". Qnet sends",
    why: "The product is Qnet, not BNET (out of date in 0.90.34).",
  },
  {
    topic: "connectAnthropic",
    from: "Click \"Show\" to confirm",
    to: "Click the eye button to confirm",
    why: "SET-160: the key field's reveal control is an eye button labelled \"Reveal the API key\"; there is no \"Show\" button (out of date in 0.90.34).",
  },
  {
    topic: "connectAnthropic",
    from: "Press Enter or click the paper\nairplane icon (⌘↵) to send.",
    to: "Press Enter or click the Send\nbutton (the up arrow) to send.",
    why: "AI pane composer (AIPane.tsx, aiWords.sendHelp \"Send (↩)\"): Return sends, ⌘↵ does not, and the button is an up arrow (different in 2.0).",
  },
  {
    topic: "connectAnthropic",
    from: "Tool-call status lines in the transcript start with \"▶\" and show\nwhich tool the AI invoked and with what arguments.",
    to: "Each tool call is a row in the transcript that names the tool the\nAI invoked and its arguments; click it to see the input and result.",
    why: "AIPane.tsx ToolRow: a tool call is a disclosure row (tool name, argument summary, Input / Result when opened); no \"▶\" line exists in 0.90.34's AIPaneView.swift either (out of date in 0.90.34).",
  },
  {
    topic: "connectAnthropic",
    from: "each ▶ status line in the transcript",
    to: "each tool-call row in the transcript",
    why: "As above: tool calls are rows, not \"▶\" lines (out of date in 0.90.34).",
  },
  {
    topic: "connectLMStudio",
    from: "Qnet sends the eight-tool catalog using the OpenAI Chat",
    to: "Qnet sends the full tool catalog using the OpenAI Chat",
    why: "0.90.34 said eight when it had nine; 2.1 adds the explaining tools beside them (src/panes/ai/explain/tools.ts). The sentence names no number, so it cannot go out of date again.",
  },
  {
    topic: "connectLMStudio",
    from: "\"From server\" (live probe)",
    to: "\"From Server\" (live probe)",
    why: "SET-155: the menu section is titled \"From Server\" (settings words.ts ai.fromServer).",
  },
  {
    topic: "connectLMStudio",
    from: "the AI can drive every\n    menu command (run_command), add/delete nodes, edit\n    parameters, etc. Review the ▶ tool-call status lines in the\n    AI transcript",
    to: "the AI can run the solver\n    and analysis commands (run_command), add/delete nodes, edit\n    parameters, etc. Review the tool-call rows in the\n    AI transcript",
    why: "tools.ts AI_COMMANDS: run_command drives twelve named commands (ten solvers, Network Primitives, Analyze Network), not every menu command; tool calls are rows, not \"▶\" lines (both out of date in 0.90.34).",
  },
  {
    topic: "connectOllama",
    from: "all eight Qnet tools (get_network_summary,\nadd_node, delete_node, add_link, delete_link, update_node,\nupdate_link, run_command) are available",
    to: "all nine Qnet tools (get_network_summary,\nadd_node, delete_node, add_link, delete_link, update_node,\nupdate_link, run_command, read_status) are available",
    why: "src/panes/ai/tools.ts SPECS has nine tools; read_status was missing from the list (out of date in 0.90.34).",
  },
  {
    topic: "connectOllama",
    from: "Qnet sends the eight-tool catalog using Ollama's native",
    to: "Qnet sends the full tool catalog using Ollama's native",
    why: "As for LM Studio: no number, so it cannot go out of date again.",
  },
  {
    topic: "connectOllama",
    from: "— output streams to the\n       Interactive Shell.",
    to: "— output streams to the\n       Shell pane.",
    why: "The pane is titled Shell (shell words.ts; View ▸ Panes ▸ Shell); \"Interactive Shell\" was its earlier name (out of date in 0.90.34).",
  },
  {
    topic: "connectOllama",
    from: "the model can drive every menu\n    command (run_command), add/delete nodes, edit parameters,\n    etc. Review the ▶ tool-call status lines in the AI\n    transcript",
    to: "the model can run the solver and\n    analysis commands (run_command), add/delete nodes, edit parameters,\n    etc. Review the tool-call rows in the AI\n    transcript",
    why: "tools.ts AI_COMMANDS: run_command drives twelve named commands, not every menu command; tool calls are rows, not \"▶\" lines (both out of date in 0.90.34).",
  },
  {
    topic: "testSets",
    from: "Run ▸ Run Infinite Test Set …",
    to: "Test ▸ Run Infinite Test Set …",
    why: "MENU-137/138: both test-set items are in the Test menu (menuSpec.ts); out of date in 0.90.34.",
  },
  {
    topic: "spectralInfinite",
    from: "(Help ▸ Analytical Tractability)",
    to: "(Help ▸ Method Reference ▸ Analytical Tractability)",
    why: "MENU-164…: the topic is under Help ▸ Method Reference (menuSpec.ts METHOD_REFERENCE); out of date in 0.90.34.",
  },
  {
    topic: "spectralInfinite",
    from: "Or Exact\n    Simulation (MLMC) when",
    to: "Or SRBM\n    MLMC when",
    why: "MENU-124: the method is named SRBM MLMC in the Run menu and in Help; \"Exact Simulation\" was its earlier name (out of date in 0.90.34).",
  },
  {
    topic: "qna",
    from: "(Help ▸ Feedback Networks)",
    to: "(Help ▸ Method Reference ▸ Feedback Networks)",
    why: "The topic is under Help ▸ Method Reference (menuSpec.ts METHOD_REFERENCE); out of date in 0.90.34.",
  },
  {
    topic: "solverInputs",
    from: "network.bnet  Linear Program, Exact   srbm_lp, rbm_mlmc\n                  Simulation, Multi-Class (read the .bnet directly)",
    to: "network.bnet  Linear Program, SRBM    srbm_lp, rbm_mlmc\n                  MLMC, Multi-Class       (read the .bnet directly)",
    why: "The method is named SRBM MLMC (menuSpec.ts run:mlmc); \"Exact Simulation\" was its earlier name (out of date in 0.90.34).",
  },
  {
    topic: "solverInputs",
    from: "holds exactly what the script\nwould have produced.",
    to: "holds exactly what qnet-cli\nwould have produced.",
    why: "CLI-011: --loss-fix / --bas-fix are options of `qnet-cli export-all` (cli/src/main.rs); there is no export script in 2.0.",
  },
  {
    topic: "general",
    from: "Ask whether to restore tabs  — default.",
    to: "Ask                          — default.",
    why: "SET-050: the On quit choices are titled Ask / Always restore / Never restore (settings words.ts); out of date in 0.90.34.",
  },
  {
    topic: "general",
    from: "Always restore tabs          — reopen",
    to: "Always restore               — reopen",
    why: "SET-050, as above.",
  },
  {
    topic: "general",
    from: "Never restore tabs           — start",
    to: "Never restore                — start",
    why: "SET-050, as above.",
  },
  {
    topic: "general",
    from: "Remember choice (skip popup):\n    When OFF (default), every \"Run Comparison\" invocation pops up a\n    dialog asking which buffer-blocking regime the simulation should\n    use for the comparison run.  When ON, that dialog is skipped\n    and the \"Default choice\" below is used silently.  The dialog\n    itself has a \"Remember choice\" checkbox that flips this flag.\n\n  Default choice (blocking regime):\n    The preselected buffer-blocking regime, used whenever\n    \"Remember choice\" is on *or* when the user just presses\n    Enter on the dialog.\n      Loss Network           — arrivals",
    to: "Remember blocking choice:\n    When OFF (default), every \"Run Comparison\" invocation pops up a\n    dialog asking which buffer-blocking regime the simulation should\n    use for the comparison run.  When ON, that dialog is skipped\n    and the \"Default blocking regime\" below is used silently.  The\n    dialog itself has a \"Skip this dialog from now on\" checkbox\n    that turns this on.\n\n  Default blocking regime:\n    The preselected buffer-blocking regime, used whenever\n    \"Remember blocking choice\" is on *or* when the user just presses\n    Enter on the dialog.  It is shown here and set in Settings ▸\n    Discrete-Event Simulation ▸ Blocking mode (\"Change…\" opens it).\n      Loss                   — arrivals",
    why: "SET-051 and the Run Comparison sheet (specs.ts): the rows are \"Remember blocking choice\" and \"Default blocking regime\" (read-only here, set by Discrete-Event Simulation ▸ Blocking mode), the sheet's checkbox is \"Skip this dialog from now on\", and the regime is titled Loss; out of date in 0.90.34.",
  },
  {
    topic: "general",
    from: "BAS + External Loss    — same as BAS",
    to: "BAS + external loss    — same as BAS",
    why: "`sim.blocking`: the choice is titled \"BAS + external loss\" (settings words.ts); out of date in 0.90.34.",
  },
  {
    topic: "general",
    from: "\"Restore Defaults\" resets only",
    to: "\"Reset to Defaults\" resets only",
    why: "SET-031: the button is \"Reset to Defaults\" (settings words.ts bar.reset); out of date in 0.90.34.",
  },
  {
    topic: "interactiveShell",
    from: "SETTINGS (Settings ▸ Interactive Shell Window)\n----------------------------------------------",
    to: "SETTINGS (Settings ▸ Panes)\n---------------------------",
    why: "SET-014: the pane's title is Panes (registry.ts; \"Interactive Shell Window\" is only its stored id); out of date in 0.90.34.",
  },
  {
    topic: "interactiveShell",
    from: "Proportional fonts are\n    allowed but table output won't line up.",
    to: "Proportional fonts are\n    not offered: table output wouldn't line up.",
    why: "SET-141: the Shell Font menu lists fixed-pitch families only (row caption \"Fixed-pitch families only\"); out of date in 0.90.34.",
  },
  {
    topic: "finiteElement",
    from: "(Settings ▸ Finite\n    Element → Solver Method = CBC)",
    to: "(Settings ▸ Finite\n    Element ▸ Quadrature method = CBC quasi-Monte Carlo)",
    why: "`fem.solver`: the row is \"Quadrature method\" and the choice \"CBC quasi-Monte Carlo\" (settings words.ts); out of date in 0.90.34.",
  },
  {
    topic: "linearProgramInfinite",
    from: "tick \"Ask before\neach run\" there",
    to: "tick \"Ask for parameters before\neach run\" there",
    why: "`lp.askBeforeRun`: the row is \"Ask for parameters before each run\" (settings words.ts); out of date in 0.90.34.",
  },
  {
    topic: "rqna",
    from: "• Convergence: if the per-class IDC fixed point looks slow,\n    check Settings ▸ RQNA (if exposed) for damping factor;\n    a damping of 0.7 is more robust than the default 1.0.",
    to: "• Convergence: the per-class IDC fixed point has nothing to\n    tune. Qnet has no RQNA settings pane and bna_rqna takes no\n    damping factor.",
    why: "registry.ts PANES has no RQNA pane and solvers/infinite/BNArqna/bna_rqna.c takes only <input> [-c]: the damping factor the text sent the reader to look for does not exist (out of date in 0.90.34).",
  },
  {
    topic: "simulationFinite",
    from: "set \"Remember choice\" to\n    skip the dialog on subsequent runs.",
    to: "tick \"Skip this dialog from\n    now on\" to reuse it on subsequent runs.",
    why: "The Run Comparison sheet's checkbox is \"Skip this dialog from now on\" (src/runs/ui/specs.ts); out of date in 0.90.34.",
  },
  {
    topic: "exactSimulation",
    from: "0 means one per physical core.",
    to: "0 means one per logical core.",
    why: "`mlmc.threads` (\"one thread per logical core\") and rbm_mlmc.c (omp_get_max_threads / _SC_NPROCESSORS_ONLN): logical cores, not physical (out of date in 0.90.34).",
  },
  {
    topic: "testSets",
    from: "Each case prints one line in the Interactive Shell:",
    to: "Each case prints one line in the Shell pane:",
    why: "The pane is titled Shell; \"Interactive Shell\" was its earlier name (out of date in 0.90.34).",
  },
  {
    topic: "testSets",
    from: "• The simulation reference uses the BAS+ext-loss blocking regime\n  for finite cases, matching the SRBM convention.  This is the\n  recommended default in Run Comparison as well.",
    to: "• The simulation reference for finite cases uses the Blocking mode\n  of Settings ▸ Discrete-Event Simulation.  Its default, BAS +\n  external loss, matches the SRBM convention and is the\n  recommended default in Run Comparison as well.",
    why: "TEST-009: a finite test set simulates under the `sim.blocking` setting (fBNAsim -l / -e / neither), not always BAS + external loss; out of date in 0.90.34.",
  },
  {
    topic: "testSets",
    from: "generated fresh on every run — no seed\n  input.  Re-running the same sweep parameters will give a\n  different sample",
    to: "generated fresh on every run unless\n  \"Fixed random seed\" is on in the popup.  With it off, re-running\n  the same sweep parameters will give a\n  different sample",
    why: "TEST-005: the sheet has a \"Fixed random seed\" switch and Seed field; out of date in 0.90.34.",
  },
  {
    topic: "testSets",
    from: "BAS / BAS+ExtLoss is left uncorrected — capturing BAS back-\npressure in SRBM requires reflection-matrix surgery (coupling\neach station's upper reflection to downstream occupancy), which\nis a research-level change. The residual ~10% gap on tandems at\nρ = 0.9, buffer 10 is the accepted model limit.",
    to: "BAS correction (applied automatically for BAS and BAS+ExtLoss):\nthe SRBM exporter iteratively shrinks the effective service rate\nof each upstream station by its estimated blocking probability,\nwhich introduces the back-pressure the raw SRBM lacks. Typical\neffect on tandem networks at ρ ≈ 0.9 with buffer 10: average error\nvs the BAS simulator drops from ~8% to ~3%.",
    why: "TEST-009 / core/src/traffic.rs: the BAS correction exists and is applied whenever the regime is not Loss, as the SRBM in a Hypercube topic already says (its figures are used); out of date in 0.90.34.",
  },
  {
    topic: "testSets",
    from: "• Choose \"Loss\" in the Run Comparison popup whenever you can.",
    to: "• Choose the regime that matches your real system; the matching\n    correction is applied automatically.",
    why: "Followed from the BAS paragraph: both regimes are corrected, so Loss is no longer the one to prefer (the SRBM in a Hypercube topic's own advice); out of date in 0.90.34.",
  },
  {
    topic: "srbmHypercube",
    from: "SRBMExporter.computeData ships two iterative corrections, picked",
    to: "The SRBM exporter ships two iterative corrections, picked",
    why: "`SRBMExporter.computeData` was 0.90.34's Swift function; 2.0's is core/src/traffic.rs (different in 2.0).",
  },
  {
    topic: "spectralFinite",
    from: "are pre-corrected by SRBMExporter.",
    to: "are pre-corrected by the SRBM exporter.",
    why: "`SRBMExporter` was 0.90.34's Swift type (different in 2.0).",
  },
  {
    topic: "finiteElement",
    from: "applied by SRBMExporter if relevant",
    to: "applied by the SRBM exporter if relevant",
    why: "`SRBMExporter` was 0.90.34's Swift type (different in 2.0).",
  },
  {
    topic: "finiteElement",
    from: "auto-limits mesh by dimension via\n    the fmMeshCap policy. To override,",
    to: "auto-limits mesh by dimension.\n    To override,",
    why: "`fmMeshCap` was a 0.90.34 Swift name; 2.0 has no such identifier (different in 2.0).",
  },
];

/** A topic's sidebar caption (HelpTopic.subtitle) where 0.90.34's is untrue of 2.0. */
export const SUBTITLES = {
  solverInputs: { from: "File ▸ Export · Qnet --export-cmp", to: "File ▸ Export · qnet-cli export-all", why: "CLI-011: `Qnet --export-cmp` is `qnet-cli export-all` in 2.0." },
};

/**
 * Places where 0.90.34's typesetter misread its own text, mended by moving a line break (white
 * space only; the script refuses anything else).
 */
export const LAYOUT = [
  // "10) are practical." began a line and was typeset as list item 10.
  { topic: "exactSimulation", from: "(d much greater than\n10) are practical.", to: "(d much greater\nthan 10) are practical." },
  // A list item's second line, set far to the right under the item's own wording, was cut out of
  // the item as a one-line monospaced block. Brought back under the item's text.
  { topic: "srbmHypercube", from: "Physical meaning: the\n                            server idles" , to: "Physical meaning: the\n    server idles" },
  { topic: "analyticalTractability", from: "(e.g. every Jackson-style SRBM\n                  with R = I − Pᵀ)", to: "(e.g. every Jackson-style SRBM\n    with R = I − Pᵀ)" },
  { topic: "analyticalTractability", from: "(feed-forward / tandem\n                  with station numbering respected)", to: "(feed-forward / tandem\n    with station numbering respected)" },
  // Step 3's sub-steps a, b, c: their first lines were run into the step's sentence and their
  // second lines cut out as monospaced scraps. Indented as one block, they keep their layout.
  {
    topic: "sbd",
    from: "   a. Aggregate inbound flow from already-solved upstream\n      stations into a single GI/G/1 arrival process.\n   b. Solve the 1-D SRBM stationary distribution for station k.\n   c. Compute the departure-process moments of station k and\n      propagate them to downstream successors per the routing\n      matrix.",
    to: "      a. Aggregate inbound flow from already-solved upstream\n         stations into a single GI/G/1 arrival process.\n      b. Solve the 1-D SRBM stationary distribution for station k.\n      c. Compute the departure-process moments of station k and\n         propagate them to downstream successors per the routing\n         matrix.",
  },
  // Step 2's three blocking modes, likewise: one aligned block instead of a sentence and scraps.
  {
    topic: "simulationFinite",
    from: "     Loss mode:  customer is dropped (recorded as a loss).\n     BAS mode:   server idles; the customer stays in the\n                 server slot and the upstream pipe back-\n                 pressures.\n     BAS+ExtLoss: same as BAS internally but external\n                 arrivals to a full first buffer drop.",
    to: "      Loss mode:  customer is dropped (recorded as a loss).\n      BAS mode:   server idles; the customer stays in the\n                  server slot and the upstream pipe back-\n                  pressures.\n      BAS+ExtLoss: same as BAS internally but external\n                  arrivals to a full first buffer drop.",
  },
];

/** Search keywords of a topic (0.90.34 matched the title, window title, subtitle and body; these are the first three, as words). */
export function KEYWORDS(t) {
  const words = new Set();
  for (const s of [t.windowTitle, t.subtitle ?? ""]) for (const w of s.split(/[\s·▸()—/,…]+/)) if (w && w.toLowerCase() !== t.title.toLowerCase() && !/^(a|an|and|in|the|to|of)$/i.test(w)) words.add(w);
  return [...words];
}
