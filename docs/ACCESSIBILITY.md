# Accessibility in Qnet 2.1

What Qnet does for people who use the keyboard, a screen reader, larger text, more contrast or less
motion; how that was checked; and what is still missing. The target is WCAG 2.2 level AA and the
conventions of macOS. The user's version of this page is the Help article "Using Qnet with the
Keyboard and VoiceOver" (`docs/help/keyboardAndVoiceOver.md`).

**VoiceOver itself has not been run against this build.** Everything said here about a screen
reader was verified through the accessibility tree: Testing Library's role and name queries, the
checker in `src/test/a11y/check.ts`, and the browser preview's accessibility tree. That shows what
is exposed, not what VoiceOver says or how WKWebView relays it. The ten-step script at the end is
for a person to run.

## 1. Keyboard

### The window

| Keys | What they do |
| --- | --- |
| Tab, ⇧Tab | Next and previous control. One visible ring (`:focus-visible`, 2 px, 3 px under Increase Contrast). |
| ⌃⌘1…6, ⌃⌘0 | Keyboard into Tools, Status, Shell, AI Assistant, Inspector, Results; 0 is the canvas. |
| ⇧⌘K | Command Palette: every command by name, with the reason when one is unavailable. |
| Esc | Closes the topmost thing only: menu, popover, sheet, palette, outline. |
| ← → ↑ ↓, Home, End on a segmented control | Move and choose (`src/lib/radiogroups.ts`). One Tab stop per control. |
| ← → ↑ ↓, Home, End on a chart | Move between marks; each is read out. Esc leaves the marks. |
| ← → on the Agreement view's axis, ↑ ↓ | Between methods' marks; between quantities. |
| ↑ ↓ ← → in the Welcome gallery | Between example cards (one Tab stop). |
| ⌥⌘] / ⌥⌘[ | Next and previous problem; the sentence is announced. |

Sheets and dialogs hold the keyboard while open and give it back to where it was. The Welcome view
makes the workspace under it `inert`. Tool letters and the canvas keys never fire in a text field,
the Shell, a sheet or another window.

### The canvas

The canvas is `role="application"` named "Network canvas", with a description that lists its keys.

| Keys | What they do |
| --- | --- |
| Tab, ⇧Tab | Select the next or previous node in reading order (top to bottom, then left to right), scrolling it into view. **At the last node Tab leaves the canvas; ⇧Tab leaves at the first.** 0.90.34 and 2.0 wrapped round, which made the canvas a keyboard trap (WCAG 2.1.2). |
| ⌥Tab, ⌥⇧Tab | The links of the selected node, outgoing first. |
| ← ↑ → ↓ (⇧ for four cells) | Move the selection; with nothing selected, scroll. |
| Return | Edit Parameters… for the selection. |
| Delete | Delete the selection. Esc: select nothing. |
| V M H · S B O X · L | Tools. |
| Return with a node tool | Place the node one pitch (112 pt) to the right of the selected node, or of the rightmost node, stepping right to a free spot. New in 2.1. |
| Return with the Link tool | The Link tool's click on the selected node: the first starts a link, the next finishes it, with the tool's own rules and Status lines. New in 2.1. |

### The Canvas Outline (new in 2.1)

View ▸ Canvas Outline, ⌥⌘O (`src/canvas/outline/`). The accessible alternative to the diagram: a
non-modal dialog with a table of nodes (name, kind, parameters, result, problems) and a table of
links (route, class, probability, problems). Each row is one button that selects it on the canvas;
↑ ↓ Home End move between rows, so each table is one Tab stop. Under the tables, the selection's
actions: Edit Parameters…, Go to Inspector, Delete, Move Left/Right/Up/Down, Link to (a menu of
nodes and Add Link), and the selection's problems with their fix buttons. Four buttons add a
Source, Buffer, Station or Sink. Every action is the editor's own mutation: one undo step, the same
Status line. Tab stays inside; Esc closes and returns to the canvas.

## 2. Screen reader

- **Names, roles, states.** Every button, link, field, menu, tab, option and slider has an
  accessible name; icon-only buttons are named; decorative SVG is `aria-hidden`; every dialog is
  labelled; panes are named regions (Tools, Canvas, Inspector, Status, Results, Shell, AI
  Assistant). `src/test/a11y-sweep.test.tsx` holds this for each major view.
- **Canvas nodes** are `role="button"` with a label: kind, name, parameters, utilisation. When the
  keyboard moves the selection the app announces the node or link with its parameters, the value
  the canvas shows for it, and its problems (`CanvasSpeech`). The Outline gives the same as a table.
- **Live regions.** One polite and one assertive announcer for the whole app
  (`src/lib/announce.ts`). Announced: a run starting and how it ended; the problems count when it
  changes; Next/Previous Problem; each tour step; toasts; palette result counts; the update sheet;
  an add, a move or a link made from the Outline. Views with their own progress or error text use
  `role="status"` or `role="alert"` on that text.
  A toast used to be announced twice (the announcer and a `role="status"` on the card): the card is
  now a named group.
- **Charts** (`src/charts/ChartShell.tsx`: bar, dot-and-interval, line, histogram, elasticity,
  transient, fit, scenario comparison) are `role="img"` with a title, described by a caption
  sentence and a data table of the same numbers. The sweep checks each chart it meets.
- **Headings.** One `h1` on the Welcome page; `h2` for a pane's or dialog's title; `h3` below.
- **Language.** `index.html` and `mock.html` declare `lang="en"`.

## 3. Not colour alone

| What | Second cue |
| --- | --- |
| A method's tier (exact, simulation, approximation, diffusion, bound) | A shape each (circle, diamond, square, triangle, cross) and the word. |
| A verdict in the Agreement view | An icon and a sentence. |
| A problem's severity | Filled octagon, outlined triangle, outlined circle; the word Error, Warning or Note. |
| Series in a chart | A hatch on every second series, a legend, and the table. Never more than eight. |
| Customer classes in Animate | Eight shapes with the colour: circle, square, triangle, diamond, plus, wedge, ring, bar (see Known gaps for a ninth class). |
| A value a scenario overrides | The text "Baseline: …" and a Reset button beside the dot. |
| Live results that are not exact | A dashed border and the word in the chip. |
| A selected row in the Outline | A check mark as well as the fill. |

## 4. Contrast and themes

Light and Dark, each with Increase Contrast; all four follow macOS or are set in View ▸ Appearance.
`src/test/contrast.test.ts` reads the stylesheets themselves and holds, in all four:

- the designed pairs (text 7:1, secondary text and status inks 4.5:1, borders and the focus ring 3:1);
- **every rule in every stylesheet that paints text on its own background** at 4.5:1;
- the pairs the 2.1 views add: inks on `--surface-2`, `--surface-3`, `--hover` and the selection;
  tier and series marks on the chrome; the focus ring on the surfaces, the chrome and the desk;
- that no rule paints a background with a text token, and that a search box which hides its
  input's ring draws one itself.

`src/charts/tokens.test.ts` holds the tier and series marks at 3:1 on the surfaces and on white.

Fixed in this pass: four places painted a row's background with `--sel-muted`, a text token (about
1.9:1 under the row's text); the Results filter field had no focus ring; `--accent-text` and the dark
`--crit-text` were under 4.5:1 on a hovered row; the focus ring was under 3:1 on the window's desk;
under Increase Contrast the accent and status inks were 2.8–3.5:1 on the darker hover (they now
step to `-more` values); the snap indicator and the error glyph were under 3:1 in some themes; a
selected run's secondary text was 3.5–4.5:1.

## 5. Motion and time

Reduce Motion (macOS, or View ▸ Appearance) sets every duration token to zero and ends every CSS
animation and transition at once. JavaScript motion asks the same question: the canvas camera and
route easing, Animate (which then steps instead of gliding), the tour ring, and the Settings
window's scroll to a found row. Nothing flashes. Nothing has a time limit; a toast waits while the
pointer or the keyboard is on it. Animate has Play/Pause (Space) and a speed control. The live
chip's dot pulses slowly and stops under Reduce Motion.

## 6. Target size and text size

Controls are 24 px or more, or pass WCAG 2.5.8 by spacing (the dense bars' 20–22 px controls: a
24 px circle on each reaches no neighbour). The few that were smaller in both directions — the tab
bar's buttons, the status bar's window button, the problem badge, a filter's clear button, a
toast's close button, the Inspector's glossary button — answer over a 24 px square.

View ▸ Appearance has five text sizes (0.92, 1, 1.12, 1.25, 1.5): every font size is a token
multiplied by the scale, and charts read it. The Status, Shell and AI Assistant panes have their
own text size; the canvas zooms to 400 %. The new views were looked at in the preview at 1.25 with
Increase Contrast: nothing clipped or overlapping; long labels in pills end in an ellipsis with the
full text as the tooltip. Largest Text (1.5) was added afterwards and looked at in the preview at
1400 × 900 in the dark theme: the Welcome view, the canvas with its legend chip, the eight Results
views after a Solve, and Animate's control bar. No text was cut off (the Results table's settings
line is two lines by design); the Tools pane's longer names and the canvas status bar's last
segments end in an ellipsis. See Known gaps for what 1.5 costs in a short canvas.

## 7. How it was tested

| Check | Where |
| --- | --- |
| The checker: names, duplicate ids, ARIA references, dialogs, bare SVG, roles in the right container, required states, focusable inside `aria-hidden`, nested controls, table headers, doubled live regions, `lang` | `src/test/a11y/check.ts`, with a test per rule in `src/test/a11y-sweep.test.tsx` |
| The sweep: Welcome; the canvas with a network, the Inspector, problem badges, a popover, the Problems list, the Outline; the Results pane in all eight views; the palette; Animate; a toast; the update sheet; the tour; the assistant after Explain; scenarios; Compare Scenarios, Fit from Data and a failure report in their own windows | `src/test/a11y-sweep.test.tsx` |
| The canvas keys, the announcements, the Outline | `src/canvas/outline/outline.test.tsx` |
| Segmented controls | `src/lib/radiogroups.test.tsx` |
| Appearance commands | `src/lib/appearanceCommands.test.ts` |
| Contrast | `src/test/contrast.test.ts`, `src/charts/tokens.test.ts`, `src/canvas/tokens.test.ts` |
| By hand, keyboard only, in the browser preview (`npm run dev:mock`, `/mock.html`) | Welcome → tandem line → Solve → the Results views → the canvas walk → the Outline; light, dark, Increase Contrast, text 1.25; computed-style contrast of every visible text node and the size and spacing of every target |

## 8. Known gaps

- **VoiceOver was not run** (above). In particular unverified: whether WKWebView relays
  `aria-description` on the canvas, how it reads SVG `role="button"` nodes inside an
  `application`, and whether the announcer's timing suits VoiceOver's speech queue.
- **Native parts are outside these tests:** the menu bar, the file dialogs and the title bar are
  AppKit's and are accessible as AppKit makes them; the Shell is xterm.js, whose screen-reader
  mode is not switched on, so Shell output is not read as it arrives (the Status log carries every
  run's outcome).
- **Panels in their own windows** (Parameters, Fit from Data, Compare Scenarios, Settings, Help)
  are separate windows: Tab does not cross between windows, the system's window keys do.
- **The canvas cannot be drawn freehand by keyboard:** Return places a node at a computed spot and
  the arrows move it; there is no keyboard marquee and no keyboard equivalent of dragging a link's
  ends. Reading order is by position, so a network laid out right to left is walked in that order.
- **Tab no longer wraps on the canvas.** With the last node selected, Tab into the canvas passes
  straight through; press Esc first.
- **Animate with more than eight classes:** there are eight shapes (circle, square, triangle,
  diamond, plus, wedge, ring, bar), as many as class colours, so the first eight classes differ
  by shape alone; shape and colour repeat together from class 9, which is then drawn as class 1
  is. The run's text read-out names classes.
- **Animation tokens are drawn on a `<canvas>`**: the picture has no per-token alternative, only
  the summary text and the strip chart.
- **Target size:** segmented controls and status-bar segments are 20–22 px tall and rely on the
  spacing exception; where a list starts directly under a filter bar the gap is under 2 px.
- **Text size stops at 1.5.** There is no 200 % setting; the window has a minimum size, and from
  1.25 up in a small window pane headers scroll or truncate. At 1.5 Animate's control bar is about
  240 px tall: with the Results pane docked under a canvas of 270 px it covers most of the
  network (hide a pane, or View ▸ Zoom to Fit, which now frames the network in what the bar
  leaves free, up to half the canvas). 1.5 was looked at in one window size and one theme only.
- **Help example rows** and the Help window were covered by code reading and the checker's rules
  in their own tests, not driven by hand in this pass.

## 9. Localisation readiness (audit only)

Ready: every string in the views added in 2.1 is in a `words.ts` beside its code (40 such files,
re-exported by `src/lib/vocabulary.ts`); the strays in the shell's components (toasts, the palette,
the alert sheet) were moved to `src/components/words.ts` in this pass. Sentences with values are
functions of the values, not fragments joined at the call site.

What would block a second language:

1. **Plurals are English**: about 45 inline `n === 1 ? "x" : "xs"` choices inside the words files.
   They are in one place each, but a language with more plural forms needs `Intl.PluralRules`.
2. **Numbers go through several doors**: `displayFixed`/`formatSig` (the scientific values, fixed
   by parity with 0.90.34), 32 direct `toFixed` calls, and `toLocaleString("en-US")` in Fit,
   Capacity and Transient. Dates and times use `Intl.DateTimeFormat(undefined, …)` and do follow
   the system. Decimal points are therefore always ".".
3. **The menu bar's labels** are in `src/lib/menuSpec.ts`, and command titles are literals in each
   area's `commands.ts`.
4. **Text that Rust writes**: Status lines, analysis sentences, run summaries, failure reports and
   everything `core/` reproduces from 0.90.34 are English by construction (the golden corpus pins
   them).
5. **Help** is 54 Markdown articles in English, and `help-lint` checks English menu paths.
6. **Text measurement** for canvas labels and charts assumes Latin metrics; **layout** has no
   right-to-left pass; **keyboard letters** for tools (V M H S B O X L) are English mnemonics.
7. **Word order in composed labels**: a few accessible names join parts with ", " or ". "
   (`nodeDescription`, `linkDescription`, the Outline's spoken sentence), which reads as a list
   rather than a sentence and translates part by part, not as a whole.

## 10. A VoiceOver script for the owner (about ten minutes)

Turn VoiceOver on (⌘F5) with a built candidate, and note anything that is silent, said twice or
wrong.

1. Launch. VoiceOver should land in "Welcome to Qnet" on "Start with a Tandem Line". Press VO-U
   and check the Headings rotor lists Welcome to Qnet, Start, Recent, Examples.
2. Press Return on "Start with a Tandem Line". Focus should be on "Network canvas, application",
   followed by the description of its keys.
3. Press Tab four times. Each press should speak "Selected: …" with the node's kind, name and
   parameters; a station also gives its utilisation.
4. Press Tab until past Sink1. Focus should leave the canvas for the zoom controls: no trap.
5. Press ⌘↩ (Solve). You should hear "Running … for Untitled." and, once, "Run finished: …".
6. Press ⌃⌘6. In the Results pane, Tab to the view switcher: it should be announced as a radio
   group, "Agreement, selected, 2 of 8" or similar. Press → to Charts and check the view changes.
7. In Charts, Tab to the chart. It should read the title, then the caption. Press → three times:
   each mark's values are read. With VO, move past the chart: a table with the same numbers follows.
8. Press ⌥⌘O. "Canvas Outline, dialog". Tab to the Nodes table, ↓ to S1, Return. Tab to "Add
   Sink" (⇧Tab back to the top), press it: "Added sink Sink2." Select S1 again, choose Sink2 in
   "Link to", press Add Link: the link is read. Press Esc: focus returns to the canvas.
9. On the canvas select S1 (Tab), press Return, and in the Inspector or the panel set the service
   rate to 0.5. Within a second you should hear "Problems: 1 error." Press ⌥⌘]: the problem's
   sentence is read and focus is on its badge; Tab reaches its fix buttons; Esc closes it.
10. Press ⇧⌘K, type "contrast", Return (Increase Contrast), then ⇧⌘K "largest text", Return. Check
    the window is still usable, then Help ▸ Guided Tour: the step is read on arrival, Show Me does
    it, and Esc ends the tour with "tour ended" or similar.
