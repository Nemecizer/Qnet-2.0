# Interactive Shell — complete functional specification

A drop-in specification of the Qnet Interactive Shell: a real login shell
embedded in a SwiftUI pane, used both as a terminal the user types into *and* as
the launch surface for the application's own long-running jobs — with a live run
indicator, a Stop that actually stops the work, structured diagnostics routed
back into the app, and a scrollback that survives quit.

This document is written to be **self-contained**: every constant, escape
sequence, shell wrapper, race and edge case needed to rebuild the same behaviour
is here. It describes a queueing-network solver GUI, but the shell machinery is
domain-independent — substitute your own jobs and the rest transfers unchanged.

Platform assumed: macOS 14+, SwiftUI + AppKit, with [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)
vendored as the terminal emulator. Notes for porting appear where a behaviour
depends on AppKit or on SwiftTerm specifics.

---

## 0. File map

| File | Lines | Contents |
|---|---|---|
| `TerminalModel.swift` | 1640 | `PendingByteBuffer`, `TerminalLineWidthMeter`, `TerminalRunSummary`, `ShellCommandBlocker`, and `TerminalModel` — the whole non-view surface: run lifecycle, cancellation, clipboard, find, fonts, transcript persistence. |
| `TerminalConsoleView.swift` | 963 | `ScrollForwardingTerminalView` (SwiftTerm subclass), `TerminalHostView` (AppKit container: overlay scrollers, theme, layout, find bar, context menu), `SwiftTermView` (the SwiftUI bridge). |
| `ContentView.swift` (excerpt) | ~170 | `TerminalPaneView` — the pane header and its controls; the status bar's run segment. |
| `QnetGUIApp.swift` (excerpt) | ~400 | The command builders: `runScript`, `silentScript`, `commandWithCleanup`, `runWithStderrOnFailure`, `withProgress`, `outputPrecisionFilter`. |
| `WorkspaceCommands.swift` (excerpt) | ~60 | Window ▸ Shell submenu, Focus Shell, restart confirmation. |
| `PaneDetachment.swift` (excerpt) | ~40 | The Shell in a window of its own — the same view, re-parented. |
| `MenuKeyAliases.swift` | 80 | The ⌃` second key equivalent for Focus Shell. |
| `validation/gui_runtime_contracts.sh` | 260 | Source-text contracts **and** a live cancellation gate that starts a real solver and asserts it dies inside the deadline. |

---

## 1. Core principles

Seven invariants explain nearly every decision below.

1. **It is the user's shell, not a command runner.** Every job is *literally
   typed into* an interactive login shell. That buys the user a real prompt,
   their own rc files, `cd`, history and any tool they like — and it costs a
   whole category of interference the app has to defend against (§7).
2. **The view can be destroyed; the shell cannot.** The terminal `NSView` is
   cached on the model and re-parented. Collapsing the pane, toggling a sibling,
   maximizing another pane or moving the Shell into its own window never restarts
   the process or loses the scrollback. Only `restart()` builds a new one.
3. **One run at a time, owned by the tab that started it.** All jobs share one
   shell, so a second launch is refused rather than allowed to trample the
   first's poller and coordination files. Every message goes to the tab that
   launched the run, not the tab that happens to be frontmost.
4. **Stop must reach the work, not just the wrapper.** The wrapper dies on the
   first SIGINT; the job it backgrounded ignores SIGINT and survives. So the
   process *group* is recorded while the wrapper is alive, the escalation targets
   the group, and the completion file is not believed while the group still has
   members (§6.4). There is a live test for this.
5. **Nothing fails silently.** A refused launch, a solver's stderr, a non-zero
   exit and a cancellation each land as words in the originating tab's status
   log. A registered run that can never complete is retired explicitly.
6. **Measure the stream, not the buffer.** Line widths are measured off the raw
   pty bytes, never off the terminal's reflowed buffer — otherwise widening the
   view lengthens the lines you measure and you have built a layout loop.
7. **Persist bytes, not text.** The scrollback is saved as the exact byte stream
   the child emitted, so colour, cursor motion and interactive output all
   round-trip on replay.

---

## 2. Architecture

```
                       ┌─────────────────────────────────────────┐
  SwiftUI              │ TerminalPaneView   (header + controls)  │
                       │   └── SwiftTermView (NSViewRepresentable)│
                       └───────────────┬─────────────────────────┘
                                       │ re-parents (never rebuilds)
                       ┌───────────────▼─────────────────────────┐
  AppKit               │ TerminalHostView                        │
                       │   clipView ── ScrollForwardingTerminalView│
                       │   vScroller / hScroller (overlay style)  │
                       │   theme · layout · find bar · ctx menu   │
                       └───────────────┬─────────────────────────┘
                                       │ delegate + callbacks
                       ┌───────────────▼─────────────────────────┐
  Model (@MainActor)   │ TerminalModel                           │
                       │   run lifecycle · cancel · clipboard     │
                       │   find · fonts · transcript              │
                       │   ├ PendingByteBuffer     (lock, nonisolated)
                       │   └ TerminalLineWidthMeter(lock, nonisolated)
                       └───────────────┬─────────────────────────┘
                                       │ sendCommand("bash /tmp/…sh")
                       ┌───────────────▼─────────────────────────┐
  Child process        │ login shell (pty)                        │
                       │   └── wrapper script                     │
                       │        └── solver (background job)       │
                       └─────────────────────────────────────────┘
```

Two objects live **outside** the model's `@MainActor` isolation because
SwiftTerm's pty reader delivers bytes on a background thread and both must be
written synchronously there:

* `PendingByteBuffer` — a lock-protected `[UInt8]`. The reader appends without an
  actor hop, so the very last bytes printed before quit cannot be stranded behind
  an unprocessed `Task { @MainActor }`.
* `TerminalLineWidthMeter` — the escape-aware column counter (§4).

---

## 3. Terminal construction

### 3.1 Starting the shell

```swift
static func userShell() -> String {          // the user's LOGIN shell, not /bin/sh
    let bufsize = sysconf(_SC_GETPW_R_SIZE_MAX)
    guard bufsize != -1 else { return "/bin/zsh" }
    var pwd = passwd(); var result: UnsafeMutablePointer<passwd>?
    let buffer = UnsafeMutablePointer<Int8>.allocate(capacity: bufsize)
    defer { buffer.deallocate() }
    if getpwuid_r(getuid(), &pwd, buffer, bufsize, &result) != 0 { return "/bin/zsh" }
    return String(cString: pwd.pw_shell)
}
```

Launched as a **login shell** by passing `execName = "-" + lastPathComponent`
(the leading dash is the convention that makes zsh/bash read the login files).

Environment, on top of the process environment:

| Variable | Value | Why |
|---|---|---|
| `TERM` | `xterm-256color` | what SwiftTerm implements |
| `CLICOLOR` / `CLICOLOR_FORCE` | `1` | `ls` colour even though stdout is a pty behind a GUI |
| `LSCOLORS` | `ExfxcxdxDxegedabagacad` | readable on both grounds |
| `TERM_PROGRAM` | `Apple_Terminal` | **load-bearing**: macOS's `/etc/zshrc_Apple_Terminal` only installs its `update_terminal_cwd` precmd hook when this matches, and that hook is what emits OSC 7 on every prompt — which is what keeps the pane header's directory honest after `cd` |
| `SHELL_SESSIONS_DISABLE` | `1` | the app keeps its own transcript; the feature also needs `TERM_SESSION_ID` |
| `TERM_SESSION_ID` | *removed* | ditto |

Terminal setup: cursor style `.blinkBlock`; **scrollback raised from SwiftTerm's
default 500 lines to 5000** (the persisted transcript is read out of this buffer,
so a small scrollback silently throws away restorable history).

Accessibility: SwiftTerm's view is a bare `NSView`, so set it explicitly —
element `true`, role `.textArea`, label `"Shell"`, plus a help string. The host
view is a `.group` labelled `"Shell pane"`; the clip view is not an element.

SwiftTerm installs its own right-edge `NSScroller`. Hide it (`isHidden = true`
over `tv.subviews where subview is NSScroller`), **deferred one runloop turn** so
it has finished adding it, because the container manages scrolling from outside.

### 3.2 The SwiftTerm subclass

```swift
final class ScrollForwardingTerminalView: LocalProcessTerminalView {
    @MainActor var onScrollPositionChanged: ((Double) -> Void)?
    var onBytesReceived: ((ArraySlice<UInt8>) -> Void)?   // ANY thread
    @MainActor var onSelectionChanged: (() -> Void)?
    @MainActor var contextMenuProvider: (() -> NSMenu?)?

    override func scrolled(source: TerminalView, position: Double) {
        super.scrolled(source: source, position: position)
        Task { @MainActor in onScrollPositionChanged?(position) }
    }
    override func dataReceived(slice: ArraySlice<UInt8>) {
        onBytesReceived?(slice)          // BEFORE SwiftTerm parses them
        super.dataReceived(slice: slice)
    }
    override func selectionChanged(source: Terminal) {
        super.selectionChanged(source: source)
        onSelectionChanged?()
    }
    override func menu(for event: NSEvent) -> NSMenu? {
        // A program that turned mouse reporting on (htop, vim, a pager with -R)
        // wants the raw button-3 event, not a context menu of ours.
        if getTerminal().mouseMode != .off { return nil }
        return contextMenuProvider?()
    }
}
```

`dataReceived` is intercepted *before* parsing, so the capture is exactly what
the child emitted — escape sequences and all.

### 3.3 The byte-received callback

One callback does three things, and where each happens matters:

```swift
tv.onBytesReceived = { [weak model] slice in
    guard let model else { return }
    model.pendingBytes.append(slice)                 // lock, no actor hop
    if let widest = model.lineMeter.scan(slice) {    // allocates nothing
        Task { @MainActor [weak model] in            // rare: only when the peak GROWS
            model?.reportLongestLineChars(widest)
        }
    }
}
```

The measurement must happen on the reader, not in the main-actor drain: the drain
runs on a 10 s backstop, and a table that only becomes scrollable ten seconds
after it was printed has already been read and mis-read. `scan` returns non-nil
only when the widest line has actually grown — a handful of times per run — so
the hop is rare, not per-chunk.

### 3.4 The SwiftUI bridge

```swift
struct SwiftTermView: NSViewRepresentable {
    let workingDirectory: URL
    let classicTheme: Bool
    @EnvironmentObject private var model: TerminalModel

    func makeNSView(context: Context) -> NSView { let w = NSView(); attachHost(to: w); return w }

    func updateNSView(_ nsView: NSView, context: Context) {
        attachHost(to: nsView)
        guard let host = model.hostView as? TerminalHostView else { return }
        host.desiredMinWidth = model.minTerminalWidth
        host.applyThemeIfNeeded(classic: classicTheme)   // only on a real change
        let desired = model.resolvedFont()               // font sync
        let tv = host.terminalView!
        if abs(tv.font.pointSize - desired.pointSize) >= 0.1 || tv.font.familyName != desired.familyName {
            tv.font = desired      // SwiftTerm re-renders its buffer and fires sizeChanged
        }
        host.layoutTerminal()
    }

    private func attachHost(to wrapper: NSView) {
        let host: NSView
        if let cached = model.hostView, model.hostViewID == model.terminalViewID {
            host = cached                       // ← the whole point
        } else {
            model.hostView?.removeFromSuperview()
            let fresh = TerminalHostView(model: model, workingDirectory: …, classicTheme: …)
            model.hostView = fresh; model.hostViewID = model.terminalViewID; host = fresh
        }
        guard host.superview !== wrapper else { return }
        host.removeFromSuperview()
        // pin to the wrapper's four edges
    }
}
```

`hostView` / `hostViewID` on the model are the cache; `terminalViewID` (a UUID
bumped only by `restart()`) is its key. This is what lets SwiftUI freely drop and
re-create the representable — pane collapse, AI-pane toggle, split restructuring,
detaching into a separate window — with the shell PID and scrollback untouched.

---

## 4. The line-width meter

**The problem.** The terminal view is widened past the pane (engaging a
horizontal scroller) based on the longest line printed. Measuring SwiftTerm's
reflowed buffer would be circular: a wider view produces longer unwrapped lines,
which widens the view. Measuring the **stream** is safe — the stream carries the
line the child actually printed, independent of how many columns the view has.

**The scanner.** A byte-at-a-time state machine, lock-guarded, allocating nothing
after init:

```swift
private enum State { case text, escape, csi, string, stringEscape }
static let maxMeasuredColumns = 240
```

`maxMeasuredColumns` is a hard ceiling: SwiftTerm allocates every scrollback line
at the current column count (5,000 lines here), so an unbounded peak — one runaway
`printf` with no newline, or a binary dumped to the terminal — becomes a hundred
megabytes of cells and a scroller with no bottom. 240 is twice the widest table
the app prints.

**Why CSI and string sequences need different terminators.** macOS's shell
integration emits `ESC ] 7 ; file:///long/path BEL` before *every* prompt. A
naive CSI-shaped scan stops at the `f` of `file` (a valid CSI final byte) and then
counts the whole path as printed columns. So OSC / DCS / SOS / PM / APC
(`ESC ]`, `ESC P`, `ESC X`, `ESC ^`, `ESC _`) enter `.string`, terminated by BEL
(0x07) or ST (`ESC \`).

**Text bytes**

| Byte | Effect |
|---|---|
| `0x1B` ESC | → `.escape` |
| `0x0A/0B/0C` LF/VT/FF | `endLine()` |
| `0x0D` CR | `endLine()` — progress bars redraw over themselves |
| `0x08` BS | `column = max(0, column-1)`; **paints nothing, erases nothing** |
| `0x09` HT | `column = (column/8 + 1) * 8`, then `noteColumn()` |
| other C0, `0x7F` | ignored |
| default | one column per **UTF-8 lead byte** (`byte & 0xC0 != 0x80`), then `noteColumn()` |

**High-water, not cursor position.** `lineHighWater` tracks the furthest column
the line ever painted, and that is what `endLine()` promotes to the peak.
Recording `column` at the line break under-measured every renderer that erases by
backing up — and under-measuring is what leaves a wide table wrapped with no
scroller offered.

**CSI handling**

* `?h` / `?l` with parameter 47, 1047 or 1049 → set/clear the **alt-screen latch**.
  Full-screen programs paint absolute cursor positions rather than lines;
  measuring them reports nonsense, and they need no horizontal scroller because
  they draw to fit. The latch is also read by `commandBlocker` (§7) — it is set on
  the reader the instant the bytes land, *ahead of SwiftTerm having parsed them*.
* `K` (EL, erase in line) — the counterpart to the high-water mark: `ESC[0K`
  clears rightward so `lineHighWater = min(lineHighWater, column)`; `ESC[2K`
  clears the row so `lineHighWater = 0`; `ESC[1K` clears leftward and leaves the
  right-hand cells, so the line is no narrower.
* Any cursor motion (`A B C D E F G H \` d f`) → `endLine()`. Without this a
  full-screen repaint that never emits a newline accumulates every row of the
  screen into one enormous "line".
* A C0 byte inside a sequence aborts it, as in a real terminal.

**Known limitation, deliberately open.** Double-width glyphs (CJK, fullwidth
forms, most emoji) occupy two cells but are counted as one. The meter therefore
*under*-counts and never over-counts; the only consequence is that the horizontal
scroller is not offered for such a line — no text is truncated, SwiftTerm still
wraps. Closing it properly needs an East-Asian-Width table; the cheap 90 % version
is decoding the scalar and adding 2 for the wide blocks (U+1100–115F, U+2E80–A4CF,
U+AC00–D7A3, U+F900–FAFF, U+FE30–FE6F, U+FF00–FF60, U+FFE0–FFE6, U+1F300+). Both
cost a multi-byte accumulator in a per-byte path on the pty reader that today
allocates nothing.

**Also exposed**

```swift
var isAlternateScreen: Bool          // read by commandBlocker
var secondsSinceLastOutput: TimeInterval    // .greatestFiniteMagnitude before any byte
func clearScrollback()   // peak, reportedPeak, column, highWater — NOT the alt latch
func reset()             // everything, alt latch included (new pty, new program)
```

`clearScrollback` deliberately preserves the alt-screen latch: clearing the screen
does not quit the program that owns it. `reset` drops it: the program that set it
died with the old pty.

**Width from characters:**

```swift
func recomputeMinTerminalWidth() {
    guard longestLineChars > 0 else { minTerminalWidth = 0; return }
    let sample = NSString(string: "MMMMMMMMMM").size(withAttributes: [.font: resolvedFont()]).width / 10
    let charWidth = sample > 0 ? sample : fontSize * 0.62
    minTerminalWidth = CGFloat(longestLineChars) * charWidth + 40   // + padding & scroller
}
```

`longestLineChars` is a monotonic peak, reset only by clear/restart; the pixel
width is rebuilt on every font size or family change, so shrinking the font can
retract the scroller.

---

## 5. Host view: layout, scrollers, theme, find bar

### 5.1 Insets

```swift
static let terminalBottomInset: CGFloat = 10   // clear the window's rounded bottom corner
static let terminalLeadingInset: CGFloat = 6   // a gutter so the prompt isn't flush to the border

private var leadingInset: CGFloat { min(6, max(0, clipView.bounds.width - 1)) }
private var usableWidth: CGFloat  { max(0, clipView.bounds.width - leadingInset) }
```

The leading inset is deliberately smaller than the standard small spacing token:
a terminal column is a unit of layout, and stealing a whole one from a wide table
costs more than the margin is worth. The bottom inset exists because macOS rounds
the window's corners and the Shell sits on the bottom edge, so a terminal flush to
y = 0 has its final line — usually the live prompt — sliced by the arc.

**`usableWidth` is read by every horizontal calculation**: the target width, the
scroll range, the knob proportion, the page step, and the find bar's anchors.
They were four separate copies of `clipView.bounds.width` before the margin
existed, and four places is four chances to apply the inset in three of them.

### 5.2 Layout

```swift
func layoutTerminal() {
    let visibleHeight = clipView.bounds.height
    let drawableWidth = usableWidth
    guard drawableWidth > 0, visibleHeight > 0 else { return }

    let targetWidth = max(desiredMinWidth, drawableWidth)
    let maxOffset = max(0, targetWidth - drawableWidth)
    if hOffset > maxOffset { hOffset = maxOffset }

    let bottomInset = min(10, max(0, visibleHeight - 1))
    terminalView.frame = NSRect(x: leadingInset - hOffset,    // inset ADDED ON TOP of the pan
                                y: bottomInset,               // clip view is unflipped
                                width: targetWidth,
                                height: visibleHeight - bottomInset)

    let overflow = targetWidth > drawableWidth + 0.5
    hScroller.isEnabled = overflow
    hScroller.knobProportion = overflow ? drawableWidth / targetWidth : 1.0
    hScroller.doubleValue = maxOffset > 0 ? Double(hOffset / maxOffset) : 0
    if !overflow { hScroller.alphaValue = 0 }

    syncVerticalScroller()
    positionFindBar()
}
```

Shrinking the frame by the insets (rather than clipping) is what keeps SwiftTerm's
row and column counts in step with the area it can actually draw in.

```swift
func syncVerticalScroller() {
    vScroller.isEnabled      = terminalView.canScroll
    vScroller.knobProportion = terminalView.scrollThumbsize
    vScroller.doubleValue    = terminalView.scrollPosition
    if !terminalView.canScroll { vScroller.alphaValue = 0 }
}
```

`layoutTerminal()` is called from: the clip view's `frameDidChange` notification,
SwiftTerm's `sizeChanged` delegate callback, every scroller action, every
horizontal pan, `updateNSView`, and the model's `onAfterClear` hook.

### 5.3 Overlay scrollers

Both are `.overlay` style, `alphaValue = 0`, floating over the content edges —
vertical pinned to top/trailing/bottom−w, horizontal to leading/trailing−w/bottom,
so they never overlap in the corner.

* `revealScrollers()` — cancel the pending hide, fade the *enabled* scrollers to 1
  over the "quick" duration, reschedule the hide.
* Hide after `scrollerHideDelay = 1.0 s` of idle, fading over the "standard"
  duration, **unless the pointer is over a scroller** (tracking areas with
  `.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect` set
  `scrollerHovered`).
* Both durations are design-system tokens that return 0 under Reduce Motion, so
  the shell's chrome stops animating with the rest of the window.

Reveal is triggered by: SwiftTerm's `scrolled` callback, either scroller's action,
a horizontal pan, and pointer entry.

**Vertical scroller actions** map onto SwiftTerm's own API — `pageUp()`,
`pageDown()`, `scroll(toPosition:)`, `scrollUp(lines: 1)`, `scrollDown(lines: 1)`
— then re-read `scrollPosition` / `scrollThumbsize` back into the scroller,
because the terminal is the authority.

**Horizontal scroller actions** move `hOffset` by `usableWidth * 0.9` per page,
40 pt per line, or `maxOffset * doubleValue` for the knob, then `layoutTerminal()`.

### 5.4 Horizontal wheel panning

SwiftTerm's `scrollWheel` is not overridable and only scrolls vertically, so a
**local event monitor** turns predominantly-horizontal deltas over the terminal
into panning:

```swift
wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
    let dx = event.hasPreciseScrollingDeltas ? event.scrollingDeltaX : event.deltaX * 10
    let dy = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.deltaY
    guard abs(dx) > abs(dy), dx != 0 else { return event }
    let handled = MainActor.assumeIsolated {
        guard let self, let window = self.window,
              window.windowNumber == event.windowNumber,
              self.desiredMinWidth > self.usableWidth else { return false }
        let local = self.clipView.convert(event.locationInWindow, from: nil)
        guard self.clipView.bounds.contains(local) else { return false }
        self.panHorizontally(by: -dx)
        return true
    }
    return handled ? nil : event      // swallow only when we acted
}
```

The overflow test uses `usableWidth`, not the clip view's width: with the margin
taken out, content overflows a little sooner, and a wheel gesture that will not
pan while the scroller says it can is a worse bug than the margin fixes. Removed
in `deinit`.

### 5.5 Theme

Two grounds, applied through `effectiveAppearance.performAsCurrentDrawingAppearance`
because SwiftTerm resolves dynamic `NSColor`s at assignment time — and re-applied
from `viewDidChangeEffectiveAppearance()`:

* **semantic** (default) — `.textColor` / `.textBackgroundColor`,
  `.controlAccentColor` caret, `.selectedTextBackgroundColor`;
* **classic** — green `sRGB(0.30, 0.90, 0.40)` on black, caret green, selection
  green at 35 %.

Plus a **16-colour ANSI palette** installed to match the ground, because
SwiftTerm's default xterm set loses bright yellow, green and cyan on a light
ground — which is exactly what `ls` (CLICOLOR) and the solver banners print.
`shellPaletteLight` is a darkened set for white; `shellPaletteDark` is the
VS Code-ish set, used for both dark mode and the classic theme. Conversion to
SwiftTerm's 16-bit channels:

```swift
let c = color.usingColorSpace(.sRGB) ?? color
func channel(_ v: CGFloat) -> UInt16 { UInt16((max(0, min(1, v)) * 65535).rounded()) }
```

`applyThemeIfNeeded(classic:)` re-applies only on a real change, so
`updateNSView` can call it every pass.

### 5.6 Adopting SwiftTerm's find bar

SwiftTerm pins its find bar 8 pt inside the **terminal view's** trailing edge —
and the terminal view is not the pane. The moment wide output pushes
`desiredMinWidth` past the visible width, the terminal view runs off to the right
and the clip view masks everything past the pane edge: the bar's close button and
its three option toggles are the first things cut off, its rounded right end goes
with them, and what is left reads as something spilling out of the pane. Panning
horizontally does the same thing transiently, even on narrow output.

`adoptFindBar()` (called by `showFind()` right after the action that creates the
bar; a no-op on every later ⌘F):

1. **Find the bar by shape, not by name** — its type is `internal` to SwiftTerm:
   the terminal's one `NSVisualEffectView` subview that contains an
   `NSSearchField` (recursive search). The progress overlay and the hidden
   scroller are neither.
2. **Deactivate the vendored pins** — every constraint on the terminal view
   referencing the bar. The bar's own `width <= 520` lives on the bar and
   deliberately survives, so it still stops growing in a wide pane.
3. **Demote the search field's `width >= 200`** from required to `.defaultHigh`.
   In a narrow pane that required constraint cannot be honoured alongside the two
   insets, and AppKit resolves the impossible layout by dropping whichever
   constraint it likes — most often the trailing inset, i.e. exactly the clipped
   bar this method exists to prevent. The field already has low horizontal
   compression resistance, so it shrinks and the buttons stay reachable.
4. **Install substitutes** expressed against the terminal view's *leading* edge:
   `top == terminalView.top + s`, `trailing == terminalView.leading` (constant
   filled in below), `leading >= terminalView.leading` (an **inequality**, so the
   bar keeps its natural width until the pane is too narrow).
5. Give it the pane's corner-radius token — it is pane chrome now.

```swift
private func positionFindBar() {
    // In the terminal view's own coordinates the pane shows [hOffset, hOffset + usableWidth)
    let newTrailing = hOffset + usableWidth - DS.Spacing.s
    let newLeading  = hOffset + DS.Spacing.s
    if trailing.constant != newTrailing { trailing.constant = newTrailing }
    if leading.constant  != newLeading  { leading.constant  = newLeading  }
}
```

**Write only on a real change.** `layoutTerminal()` is reachable from a layout
pass (SwiftTerm's `sizeChanged` lands there), and re-assigning a constraint
constant invalidates the engine whether or not the value moved — an unconditional
write is a self-sustaining layout loop on every resize.

**Re-parenting the bar onto the host would be tidier and is deliberately not
done**: `removeFromSuperview()` resigns first responder, and SwiftTerm has already
put the keyboard into the search field by the time this runs. Moving it would open
the find bar with the caret nowhere.

### 5.7 Context menu

Built fresh per click (enablement depends on selection, clipboard and scrollback,
all of which move), with `autoenablesItems = false` — letting AppKit auto-validate
would send `copy:` and friends up the responder chain and grey them out on their
own terms.

| Item | Key | Enabled when |
|---|---|---|
| Copy | ⌘C | `model.hasShellSelection` (refreshed from SwiftTerm first) |
| Paste | ⌘V | pasteboard can read `NSString` |
| Select All | ⌘A | always |
| — | | |
| Find in Shell… | ⌘F | always |
| Scroll to Bottom | — | `tv.canScroll` |
| — | | |
| Clear Shell | ⌘K | always |

Titles are the ones the same actions carry in the pane header and the Window ▸
Shell submenu, because a command that answers to two names reads as two commands.
Key equivalents match the real bindings so the menu teaches them. Copy here is
**selection-only**, matching its own enablement — it must never fall back to
copying the whole scrollback behind the user.

---

## 6. The run lifecycle

### 6.1 What a run is

```swift
struct RunHandle {
    let id: UUID
    let donePath: String      // wrapper's exit code, written from an EXIT trap
    let pidPath: String       // wrapper's own pid, written on its first line
    let statusPath: String    // append-only diagnostics inbox
    let outputPath: String    // tee'd stdout, for structured parsing
}
```

Every path embeds both the app's pid and the run's UUID
(`BNET_run_done_<pid>_<uuid>.txt` etc. in `NSTemporaryDirectory`), so a late write
from an earlier wrapper can never complete, cancel or add diagnostics to a newer
run.

```swift
func beginRun(label:ownerID:ownerTitle:report:) -> RunHandle?
```

Refuses outright when `activeRun != nil` — one job at a time, because all jobs
share the shell — reporting *which* run and *which tab* owns it. Otherwise it
allocates the id and paths, captures the **originating tab's** reporter closure,
resets the whole cancel/progress state, takes ownership of any progress files
registered while the command was being composed, and starts the poller.

The reporter is stored twice:

* `activeRunReporter` — cleared by `finishRun`; the destination for this run's
  diagnostics and Stop messages, so a tab switch mid-run does not redirect them.
* `lastStatusReporter` — **not** cleared; the shell outlives every run and is
  shared by every tab, so a problem reported *between* runs still has a log to
  land in. The tab that most recently used the shell is the best available guess;
  the alternative is a beep with no words.

### 6.2 The poller

A `Task { @MainActor }` on a **500 ms** tick, guarded on `activeRunID == id` at
every step:

```
drainActiveStatusInbox(runID:)
if donePath exists:
    code = Int32(contents) ?? -1
    if cancelSurvivorsOutstanding() { tickRun(); continue }   // ← see §6.4
    finishRun(runID:label:exitCode: code); return
if !isShellRunning { finishRun(exitCode: -1); return }        // the shell died
tickRun(runID:)
```

`tickRun` updates the elapsed clock, flips `canCancelRun` once the pid appears,
**captures the process group** (§6.4), runs the cancel escalation, and refreshes
the determinate progress fraction.

### 6.3 Progress

Solvers that support it are given `-P <file>` and write `<total>\n` followed by
one `.` byte per completed unit. The **same file** feeds two indicators — the
shell's ASCII bar (§8.3) and the status bar's `ProgressView` — so they can never
disagree:

```swift
private static func progressFraction(in paths: [String]) -> Double? {
    for path in paths {
        // read up to 24 bytes, parse the integer header before the first newline
        guard let total = Int(headerText), total > 0 else { continue }
        let size = fileSize(path)
        let done = max(0, size - (headerText.utf8.count + 1))
        return min(1, Double(done) / Double(total))
    }
    return nil       // caller keeps the INDETERMINATE spinner rather than lying
}
```

`registerProgressFile(_:)` is called by the command builders as they compose
(a comparison run registers one per sub-solver); the list is bounded at 8 so an
abandoned composition cannot leak.

### 6.4 Cancellation — the hard part

**The trap.** The wrapper launches the solver as a background job (`{ … } &`), so
the solver is a *grandchild* in the wrapper's process group — and a background job
inherits `SIG_IGN` for SIGINT. The SIGINT that kills the wrapper therefore leaves
the solver running with every core pinned. Worse, the wrapper's EXIT trap writes
the completion file as it dies, so the naive poller reports the run *finished*
while the work continues. Deriving the group later with `getpgid(pid)` is useless:
the wrapper is gone, the call fails, and SIGTERM/SIGKILL fall back to a dead pid.

**The fix.** Record the group *while the wrapper is alive* (from `tickRun`, long
before Stop can be pressed), and refuse two groups outright:

```swift
private func captureActiveRunGroup() -> pid_t? {
    if let activeRunGroup { return activeRunGroup }
    guard let pid = activeRunPID else { return nil }
    let group = getpgid(pid)
    guard group > 1, group != getpgrp() else { return nil }        // that is US
    if let shell = terminalView?.process?.shellPid, shell > 1 {
        guard group != shell, group != getpgid(shell) else { return nil }  // that is EVERY future run
    }
    activeRunGroup = group
    return group
}
```

An interactive bash/zsh puts each foreground job in a group of its own, so the
wrapper's group is neither of those.

**The escalation** (`tickRun`, from `cancelRequestedAt`):

| Elapsed | Action |
|---|---|
| 0 | SIGINT to `-group` (falls back to the bare pid when no usable group) |
| `cancelEscalateAfter = 1.5 s` | SIGTERM, once |
| `cancelDeadline = 3 s` | if `processExists(pid) \|\| activeRunGroupIsAlive()` → SIGKILL, once; else retire the run as cancelled |
| `cancelAbandonAfter = 10 s` | retire regardless — SIGKILL is the last thing there is to send; a group that outlives it is stuck in uninterruptible I/O and nothing the app does will change that, so stop owning the single-flight slot |

```swift
private func cancelSurvivorsOutstanding() -> Bool {
    guard let requested = cancelRequestedAt,
          Date().timeIntervalSince(requested) < Self.cancelAbandonAfter else { return false }
    return activeRunGroupIsAlive()      // kill(-group, 0) == 0 || errno == EPERM
}
```

This is why the poller **does not believe the completion file** while survivors
remain. Judging by the wrapper alone retires the run — and cancels the escalation
— with the solver still pinning every core.

**Stop before the pid exists.** Stop is enabled the instant a run starts, but the
wrapper needs a few hundred ms to write its pid. Rather than doing nothing,
`cancelActiveRun` retries every 100 ms for up to a second and signals as soon as
the pid appears; after a second with no pid it reports *"Nothing to interrupt yet
— <label> has not started in the Shell."* and lets the deadline retire the
indicator. Either way the click is answered in words.

**Was it cancelled?** Never by exit-code whitelist — the escalation means the
wrapper reports whichever signal won (130 SIGINT, 143 SIGTERM, 129 after a lost
controlling terminal, 137 after the kill), so a whitelist makes the user-visible
outcome depend on a race.

```swift
var cancelled: Bool {
    guard exitCode != 0 else { return false }   // Stop in the same instant a solver
    return userStopped                          // finished must NOT discard a result
        || exitCode == 130 || exitCode == 143   // ^C typed in the shell / external SIGTERM
}
```

`userStopped` is recorded by `finishRun` from `cancelRequestedAt != nil`.

### 6.5 The diagnostics inbox

The wrapper appends records to `statusPath`, each terminated by `<<<END>>>`. The
poller drains it incrementally:

* keep a byte cursor (`runStatusConsumedBytes`) — never truncate a file the shell
  still has open;
* if the new bytes do not decode as UTF-8, **leave the cursor unchanged** and
  retry once more arrive (the read may have landed mid-scalar);
* split on the sentinel; emit every *complete* record, one status line per text
  line, severity inferred from the wording;
* hold whatever follows the last sentinel in `runStatusRemainder` — a brace group
  appends a record with several writes, so polling must not consume a record the
  shell is still producing;
* `finishRun` drains once more with `includePartialRecord: true`, because a record
  can land between the poller's last drain and its completion-file read.

### 6.6 Finishing

`finishRun(runID:label:exitCode:)` — guarded on `activeRunID == runID` — reads
the tee'd output into `lastRunOutput`, publishes a `TerminalRunSummary`, cancels
the poller and every retry task, clears all run state, and **removes every
coordination artifact**: done, output, pid and status files, plus any progress
files (the wrapper removes its own on a normal exit; a run interrupted mid-bar
leaves one behind).

```swift
struct TerminalRunSummary: Equatable {
    let id: UUID; let label: String
    let ownerID: UUID; let ownerTitle: String
    let exitCode: Int32; let elapsed: TimeInterval; let finishedAt: Date
    let userStopped: Bool
    var succeeded: Bool { exitCode == 0 }
    var text: String    // "<label> finished in 3.2 s" / "cancelled after 42 s" / "failed (exit 2) after 1:12"

    static func duration(_ s: TimeInterval) -> String   // tenths <10 s, whole <60 s, m:ss beyond
    static func clock(_ s: TimeInterval) -> String      // "0:07", "12:41" — live elapsed
}
```

`failRunToLaunch(_:message:)` retires a run whose wrapper could not even be
written — without it the indicator would wait forever for a completion file no
process can create.

Downstream of the summary: a non-zero, non-cancelled exit is written to the
**originating tab's** status log (it was previously only on the record and in the
status bar, so a run that died read as one still in progress); a cancelled run's
structured record is **deleted** rather than filed as a zero-measurement result,
because stopping a run is not a result.

---

## 7. Typing into someone else's shell

Because jobs are typed into the user's interactive shell, whatever the shell is
doing becomes part of the launch. Two failures need two different answers.

**A half-typed line** would be concatenated — `echo hel` + `bash /tmp/BNET_run_….sh`.
Fixed outright rather than refused, by prefixing every scripted command with:

```swift
private static let killLine: [UInt8] = [0x05, 0x15]    // ⌃E (end of line), ⌃U (discard line)
```

Both readline (emacs *and* vi insert keymaps) and zle bind ⌃U to kill-the-line. At
an empty prompt the pair is a no-op.

**A program that owns the shell** (vim, less, `cat`, a script's `read`) would
receive the command as *input* — text inserted into a file, or a mangled line the
wrapper's own `printf '\033[A\033[2K'` then erases a line of the user's output
with. Nothing recovers from that, so it is refused:

```swift
enum ShellCommandBlocker { case shellUnavailable, shellNotRunning, fullScreenProgram, busy }
```

Each carries an **actionable** message, not a description ("The Shell has not been
opened yet — show it with Window ▸ Focus Shell, then run again.").

```swift
var commandBlocker: ShellCommandBlocker? {
    guard let tv = terminalView else { return .shellUnavailable }   // pane never shown this launch
    guard isShellRunning else { return .shellNotRunning }

    let terminal = tv.getTerminal()
    // (a) alt-screen or mouse reporting: vim, less, htop, a TUI.
    if terminal.isCurrentBufferAlternate || lineMeter.isAlternateScreen { return .fullScreenProgram }
    if terminal.mouseMode != .off { return .fullScreenProgram }

    // (b) bytes still arriving — something is printing, or the user is mid-keystroke.
    if lineMeter.secondsSinceLastOutput < 0.15 { return .busy }

    // (c) no prompt on the cursor row. A shell prompt always leaves at least one
    // visible glyph left of the cursor; a program reading stdin leaves the cursor
    // in column 0 of a blank row. Only trustworthy while the viewport is at the
    // bottom — getCharData indexes VISIBLE rows, and the cursor row is off screen
    // when the user has scrolled up, in which case say nothing and let the run go.
    if !tv.canScroll || tv.scrollPosition > 0.999 {
        let row = terminal.buffer.y, cursorColumn = terminal.buffer.x
        var sawGlyph = false
        for column in 0..<max(0, cursorColumn) {
            guard let cell = terminal.getCharData(col: column, row: row) else { continue }
            let ch = cell.getCharacter()
            if ch != " " && ch != "\0" { sawGlyph = true; break }
        }
        if !sawGlyph { return .busy }
    }
    return nil
}
```

**Deliberately biased toward launching.** Every signal must be *positive evidence*
that something else owns the shell, because a false positive blocks a legitimate
run and the user has no way to argue with it. Two independent alt-screen signals
are read because SwiftTerm's flag is the display truth while the meter's latch is
set the instant the bytes land.

**A refusal cannot be silent** — `beginRun` has already registered the run and
started a poller waiting for a completion file no process will now write, so the
status bar would tick "Running…" for the rest of the session:

```swift
func sendCommand(_ command: String) -> Bool {
    if let blocker = commandBlocker { refuseCommand(blocker); return false }
    guard let tv = terminalView else { return false }
    var bytes = Self.killLine
    bytes.append(contentsOf: Array((command + "\n").utf8))
    tv.send(source: tv, data: bytes[...])
    return true
}

private func refuseCommand(_ blocker: ShellCommandBlocker) {
    NSSound.beep()
    guard let runID = activeRunID, let label = activeRun else {
        lastStatusReporter?("The command was not sent to the Shell. \(blocker.message)", .error)
        return
    }
    activeRunReporter?("\(label) was not started. \(blocker.message)", .error)
    finishRun(runID: runID, label: label, exitCode: -1)
}
```

Note the ordering: **the blocker is asked before `terminalView` is unwrapped.**
`.shellUnavailable` *is* the nil-view case. Unwrapping first returned false with
no report at all, and the user saw nothing until the poller retired the run half a
second later as "failed (exit -1)" with no cause.

---

## 8. Command construction

Four composable wrappers, applied inside-out.

### 8.1 The outer wrapper (`runScript`)

```bash
printf '\033[A\033[2K'                          # erase the echoed bash command line
printf '%s\n' "$$" > "<pidPath>"                # report our pid on the FIRST line
trap 'printf "%s\n" "${_rc:-130}" > "<donePath>" ; rm -f "<filterProgram>"' EXIT
_t0=$(perl -MTime::HiRes=time -e 'print time')
{
  <command>
  _command_rc=$?
  perl -MTime::HiRes=time -e 'printf("Elapsed time: %.3fs\n\n", time - '"$_t0"')'
  exit $_command_rc
} 2>&1 | tee "<outputPath>" | <displayFilter>
_rc=${PIPESTATUS[0]}
exit $_rc
```

Written to `/tmp/BNET_run_<uuid>.sh` and launched with `sendCommand("bash \"…\"")`.

* **The completion file comes from an EXIT trap, not the last line.** SIGINT kills
  the wrapper before a trailing line runs, and the status bar used to tick
  "Running…" for the rest of the session. The trap fires on every exit path and
  reports 130 when the command never set `_rc`.
* **`tee` before the display filter**, as a separate pipeline stage, so the
  archived output keeps the solver's own digits and `${PIPESTATUS[0]}` still names
  the solver rather than the filter.
* `silentScript` is the same wrapper minus the elapsed-time line, returning the
  command string instead of typing it (for callers that compose further).

### 8.2 Cancellation-safe input cleanup

```bash
(
  cleanup_qnet_solver_inputs() { rm -f <quoted paths>; }
  trap cleanup_qnet_solver_inputs EXIT
  trap 'exit 130' INT TERM
  <command>
)
```

The signal traps matter because Stop escalates to the whole process group; a
trailing `rm` alone is skipped when that happens. The contract script pins the
number of runners using this **and** exercises the pattern for real: it runs a
probe, sends TERM, and asserts both `exit 130` and that the temp file is gone.

### 8.3 Progress bar and stderr capture

`withProgress(prefix:command:progressFile:barWidth: 15)` wraps a solver already
configured with `-P <file>`:

1. truncate the progress file; print a placeholder so prefix + empty bar appear
   immediately;
2. background the command, remember `$!`;
3. a second background subshell polls every **200 ms**: read the integer header
   for the total, then redraw `\r\033[K<prefix>[bar]  k/N  (p%)  elapsed` as the
   byte count grows;
4. at 100 % with the binary still alive (opaque post-assembly phases — Cholesky,
   an LP solve), animate a 4-frame spinner `|/-\` appended to the full bar so the
   user can see the process is alive;
5. `wait` the binary, kill the poller, print the final 100 % line with elapsed
   time, remove the progress file, and propagate the exit code via `( exit $_rc )`
   so callers can still chain with `&&`.

**The bar is ANSI reverse-video, not Unicode blocks**: each cell is
`\e[7m \e[27m ` (inverse space + plain space), which renders as a solid block on
any ground. Embedded terminals can render multibyte block characters as
zero-width, which makes the bar appear to *collapse* as it fills. Layout is
fixed-column (`[bar32] 2sp ratio(11) 2sp pct(6) 2sp time(7)`) so columns align
across the rows of a multi-solver comparison.

`runWithStderrOnFailure(_:stdoutTo:label:)` splits streams so stderr can be
triaged rather than discarded:

* **on failure** — print `⚠ <label> failed (exit N):` plus the captured stderr to
  the terminal, append the same to the run's inbox with a `<<<END>>>` sentinel,
  remove the temp file, propagate the code;
* **on success with non-empty stderr** — awk-filter for warning-like lines
  (`warn|unstable|bramson|vande[ -]?vate|kumar[ -]?seidman|diverg|caution`,
  case-insensitive) and append only those to the inbox. The rest (progress
  chatter) is discarded so it does not drown the results.

This exists because a solver can print a genuine stability warning to stderr and
still exit 0; before the hook, that warning never reached the user.

The inbox path is not known when commands are assembled (the run UUID does not
exist yet), so the builders emit the literal marker
`__QNET_ACTIVE_RUN_STATUS_INBOX__` and `runScript` / `silentScript` substitute
`handle.statusPath` before writing the wrapper.

### 8.4 Display-precision filter

The last pipeline stage normalises numeric output to the user's chosen decimals,
so different solvers' tables agree with each other. Implemented as a perl program
written to one per-process temp file and invoked with `exec` in both arms:

```
{ if [ -r "<program>" ]; then exec perl "<program>" <d>; else exec cat; fi; }
```

`exec` in both arms is required: without it the subshell survives the chosen stage
and a fallback could re-read a stream the first arm already consumed, duplicating
output. The program is removed by each wrapper's EXIT trap — the one artefact of
this pipeline that used to outlive the run. It is disabled (`cat`) for advisory
prose: a recommended band written "ideally 0.85–0.99" is a band, not a
measurement, and restating it at nine decimals makes advice look like a result.

---

## 9. Clipboard, find, scroll, fonts

### 9.1 Copy is two different commands

```swift
func copySelection() -> String?          // ⌘C, the context menu — selection or NOTHING
func copyEntireScrollback() -> String?   // an explicit, named choice
func copySelectionOrAll() -> String?     // ONLY the pane header's Copy button
```

No terminal on the Mac copies its whole scrollback on an empty-selection ⌘C, and
doing so silently replaces the clipboard with five thousand lines nobody asked
for. `copySelectionOrAll` exists only for the header button, whose tooltip
announces both halves and whose status line then says which one happened. One
private `put(_:)` writes the pasteboard so the two paths cannot drift in how they
clear it.

Scrollback text comes from `tv.getTerminal().getBufferAsData()` with NUL bytes
stripped.

**Selection state for menu enablement.** SwiftTerm's view is an `NSView`, not an
`NSText`, so the responder-chain test other clipboard items use cannot see a shell
selection. Instead, SwiftTerm's `selectionChanged` delegate callback drives:

```swift
private static let copySelectorProbe = NSMenuItem(title: "", action: #selector(NSText.copy(_:)), keyEquivalent: "")

func noteSelectionChanged() {
    let active = terminalView?.validateUserInterfaceItem(Self.copySelectorProbe) ?? false
    if hasShellSelection != active { hasShellSelection = active }   // publish only on a TRANSITION
}
```

`validateUserInterfaceItem` answering `copy:` is the only public route to
SwiftTerm's `selection.active`, and it is the cheap one — `getSelection()`
materialises the whole selected text, which is not something to do on every
mouse-moved callback. Publishing only on a transition keeps a drag from
re-evaluating the menu bar per event.

### 9.2 Find

SwiftTerm implements the standard text-finder actions and nothing else:

```swift
func showFind() {
    let item = NSMenuItem(); item.tag = NSTextFinder.Action.showFindInterface.rawValue
    tv.window?.makeFirstResponder(tv)
    tv.performTextFinderAction(item)
    (hostView as? TerminalHostView)?.adoptFindBar()   // §5.6
}
func findNext(_ delta: Int) {
    let item = NSMenuItem()
    item.tag = (delta < 0 ? NSTextFinder.Action.previousMatch : .nextMatch).rawValue
    tv.performTextFinderAction(item)      // deliberately does NOT take first responder
}
```

`findNext` must not steal focus: ⌘G is usually pressed while the find bar's own
search field has the keyboard, and taking it back would close the field the user
is still typing in.

`hasFindTerm` reads the system **find pasteboard** (SwiftTerm's bar writes there
on every keystroke). It drives the menu item's *tooltip*, not its enablement:
SwiftTerm's find bar is private, so there is no event to re-evaluate the menu on
while the user types, and a stale tooltip is a much smaller failure than a dead
⌘G.

### 9.3 Clear vs. restart

```swift
func clearTerminal() {
    tv.feed(text: "\u{1B}[3J\u{1B}[2J\u{1B}[H")   // erase scrollback, erase viewport, home
    tv.scroll(toPosition: 0); tv.needsDisplay = true
    tv.send(source: tv, data: [0x0C][...])        // ⌃L → the shell reprints its prompt
    longestLineChars = 0; minTerminalWidth = 0
    capturedBytes.removeAll(keepingCapacity: true); pendingBytes.clear()
    lineMeter.clearScrollback()                   // keeps the alt-screen latch
    hasShellSelection = false
    onAfterClear?()                               // → host.layoutTerminal(): scrollers retract
}
```

Feeding the three standard sequences (rather than poking SwiftTerm's buffer)
routes through its parser, so its active `buffer` reference, the display and
`yBase`/`yDisp` all stay consistent. `ESC[3J` is the xterm scrollback-erase
extension — SwiftTerm trims `buffer.lines` so `canScroll` becomes false. The ⌃L
matters because a completely blank screen with no prompt reads as a hung shell.

```swift
func restart() {
    terminalView?.process?.terminate()
    hostView?.removeFromSuperview(); hostView = nil; hostViewID = nil
    terminalView = nil
    terminalViewID = UUID()          // invalidates the host cache → a fresh view next pass
    longestLineChars = 0; minTerminalWidth = 0
    capturedBytes.removeAll(keepingCapacity: true); pendingBytes.clear()
    lineMeter.reset()                // alt latch included — that program died with the pty
    hasShellSelection = false; isShellRunning = false
}
```

Restart is behind a destructive confirmation naming the cheaper alternative:
*"The running shell process will be terminated and the saved transcript will not
be restored on the next launch. To only empty the screen, use Clear Shell (⌘K)
instead."* — and it also calls `clearSavedTranscript()`.

### 9.4 Fonts

`minFontSize = 8`, `maxFontSize = 28`, default 12; family `""` means the system
monospaced face. Both persist to `UserDefaults` (`shell.fontSize`,
`shell.fontName`) and both call `recomputeMinTerminalWidth()` so the horizontal
scroller re-engages or retracts at the new advance width.

```swift
func resolvedFont() -> NSFont {
    if !fontName.isEmpty {
        if let f = NSFont(descriptor: NSFontDescriptor(fontAttributes: [.family: fontName]), size: fontSize) { return f }
        if let f = NSFont(name: fontName, size: fontSize) { return f }   // family lookup failed
    }
    return NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
}
```

The fallback matters: a user can pick a font and then uninstall it.

Settings and the pane header edit the *same* stored values; the settings pane's
family row is restricted to fixed-pitch families because the pane needs equal-width
cells.

---

## 10. Transcript persistence

**Raw bytes, not rendered text.** The previous text-based approach read
SwiftTerm's rendered buffer and lost colour, cursor motion and the output of
interactive commands. Capturing `dataReceived` preserves everything.

```swift
static let savedRawBytesKey = "shell.savedRawBytes"
static let savedTranscriptKey = "shell.savedTranscript"   // legacy, one-shot migration only
static let maxCapturedBytes = 1_048_576                   // 1 MiB
```

`appendCapturedBytes` lets the in-memory buffer grow to **2×** the cap before
trimming back to it, amortising the trim.

```swift
func saveTranscript() {
    drainPendingBytes()                       // pull in what the reader staged
    guard !capturedBytes.isEmpty else { return }   // never wipe last session's blob
    let bytes = capturedBytes.count > cap ? Array(capturedBytes.suffix(cap)) : capturedBytes
    UserDefaults.standard.set(Data(bytes), forKey: savedRawBytesKey)
    UserDefaults.standard.removeObject(forKey: savedTranscriptKey)   // drop legacy on first raw save
    UserDefaults.standard.synchronize()       // the runloop may tear down before the buffered write
}
```

The empty guard is load-bearing: a fresh launch immediately followed by ⌘Q must
not overwrite the previous session's transcript with nothing.

Called from two places: a **10 s periodic backstop** (`.task` loop) covering
crash / force-quit / SIGKILL, and unconditionally from
`applicationShouldTerminate` for a clean quit.

**Replay on launch** — two things must be right or the restored history is
destroyed:

1. **Pre-size the terminal** to 120×30 before feeding. SwiftUI has not laid out
   yet, so bounds are zero and SwiftTerm clamps to `MINIMUM_COLS = 2`; feeding
   into a 2-cell-wide buffer wraps every line every 2 characters, producing an
   unrecoverable vertical stripe. SwiftUI's first real layout calls
   `terminal.resize()` afterwards and SwiftTerm's reflow preserves content.
2. **Land the cursor on the bottom row of an empty line** before the shell starts.
   zsh's `PROMPT_SP` (on by default) emits `ESC[J` right before its first prompt,
   erasing from the cursor to the end of the *visible* viewport. With the cursor on
   the bottom row, that erase wipes only that row. Hence the trailing `\r\n\r\n`.

```
feed(savedBytes)
feed("\u{1B}[?1049l\u{1B}[?2004l\u{1B}[?25h\u{1B}[0m")   // leave alt-screen, leave bracketed
                                                          // paste, show cursor, reset attrs
feed("\r\n\r\n" + "\u{1B}[2m──── previous session above — new session <date> ────\u{1B}[0m" + "\r\n\r\n")
```

The reset codes exist because the captured stream may have ended mid-state — the
prior session force-killed inside vim, never sending the matching `ESC[?1049l`.

Everything replayed is **seeded back into `capturedBytes`**, or a ⌘Q immediately
after launch would overwrite the blob with only the new shell's startup output,
dropping all earlier history. The replayed stream is also scanned by the meter
(trailer second, so its `ESC[?1049l` leaves the alt-screen latch matching the
screen) so a wide table from the previous session is still horizontally scrollable
in this one.

---

## 11. Pane chrome and integration

### 11.1 Header

`DSSectionHeader("Shell", isFocused:)` with:

* **leading** — a running/exited status dot (success/danger), the working
  directory abbreviated with `~` (middle-truncated, full path in the tooltip),
  and — only when the shell has exited — a **Restart** button that fades in
  rather than snapping the path label sideways;
* **trailing**, in the order shared by every pane
  (`[pane-specific] … Find · Copy · font family · text size · destructive · window`):
  Scroll to Bottom, Find in Shell, Copy, [font family menu + size stepper],
  Clear Shell (destructive), Restart Shell (destructive), and the maximize
  control. Maximize sits **past** the destructive pair, at the header's edge,
  because it acts on the window rather than the session — which also means an
  edge-of-header click is no longer a destructive one.

Below `headerCondenseWidthWide = 560` the font family menu and size stepper fold
into a single overflow menu rather than squeezing the title and directory to
nothing.

The working directory is kept honest by the OSC 7 delegate callback, which accepts
either a `file://host/path` URL (what `update_terminal_cwd` emits) or a bare path,
and percent-decodes either into a plain filesystem path.

**Copy is never silent**: the status log says how much was copied and whether it
was the selection or the whole scrollback, and the button glyph flips to a
checkmark for one second.

### 11.2 Status bar run segment

Three states in the window's trailing status segment:

* **running, determinate** — a linear `ProgressView`, `"47% · 1:23"`, and a Stop
  button;
* **running, opaque** — an indeterminate spinner,
  `"Running <label> for <tab>… 1:23"`, and Stop;
* **idle** — the last summary with a success/warning/failure glyph and the owning
  tab's name, or `"Idle"`.

Stop is **enabled from the first millisecond** (`activeRun != nil`), never on
`canCancelRun` — the model waits for the pid itself, so ⌘. is never a dimmed
button beside a bar that says "running". `canCancelRun` only changes the *tooltip*
("…as soon as it reports its process id").

### 11.3 Menus and focus

| Command | Key | Location |
|---|---|---|
| Clear Shell | ⌘K | Window ▸ Shell |
| Find in Shell… | — (⌘F routes here when the Shell has focus) | Window ▸ Shell |
| Restart Shell… | — | Window ▸ Shell |
| Focus Shell | ⌃⌘3, plus ⌃` | Window |
| Show/hide Shell pane | ⌥⌘3 | View ▸ Panes |
| Stop Run | ⌘. | Run |
| Increase/decrease text size | ⌘= / ⌘− while focused | routed by pane |

A pane-focus router lets the Shell register handlers for focus, zoom (± font
size), find, and find-step, so the generic ⌘F / ⌘G / ⌘= / ⌘− commands act on
whichever pane has focus. The find-step handler registers **without** a
`canStep` predicate, for the same reason `hasFindTerm` drives only the tooltip.

⌃` is a **second key equivalent**, which `NSMenuItem` cannot express — SwiftUI
exposes no alternate-item API — so it is a local `keyDown` monitor matching key
code 50 (or the character `` ` ``, for layouts where ⌃` produces a control
character) with exactly `.control`, and only in the main content window: ⌃` means
nothing in Help or Settings, so the keystroke is passed on there rather than
eaten.

**Bare-letter hotkeys elsewhere in the app must not steal keystrokes from the
shell.** AppKit dispatches menu key equivalents *before* the first responder's
`keyDown`, so a monitor intercepts single unmodified letters bound to tools and,
when the first responder is a text view, a text field, or the terminal, delivers
the event straight to the window with `window.sendEvent(event)`, bypassing menu
matching.

### 11.4 Detaching into its own window

The Shell can live in a window of its own; the detached root builds **the same
`TerminalPaneView`** with the same environment objects. Because the host view is
cached on the model and merely re-parented, the shell process, its scrollback and
any running job survive the move in both directions. The pane keeps its own header
(it is the only place the directory and the reattach control live, and it draws
the focus rule); the window is titled `<document> — Shell` rather than `Shell`, so
the title bar and the first line inside say different things and the Window menu's
entry cannot be confused with the "Shell" actions submenu next to it.

---

## 12. Threading and isolation

| Thing | Isolation | Why |
|---|---|---|
| `TerminalModel` | `@MainActor` | publishes to SwiftUI |
| `PendingByteBuffer` | `@unchecked Sendable`, `NSLock` | the pty reader appends synchronously; a queued main-actor task would not run before quit |
| `TerminalLineWidthMeter` | `@unchecked Sendable`, `NSLock` | scanned on the reader thread; touches no main-actor state, returns a value and lets the caller hop |
| `onBytesReceived` | any thread | documented; the closure hops itself if needed |
| `scrolled` / `selectionChanged` | hop to `@MainActor` | they touch published state |
| local event monitors | main thread by contract | `MainActor.assumeIsolated` is the honest spelling |
| the poller | `Task { @MainActor }` | 500 ms tick, weak self, re-checks `activeRunID` after every await |

---

## 13. Constants

```swift
// Fonts
minFontSize = 8 ; maxFontSize = 28 ; default 12
// Scrollback / capture
SwiftTerm history = 5000 lines
maxCapturedBytes = 1_048_576        // in-memory trims at 2×
transcript save backstop = 10 s
replay pre-size = 120 × 30
// Line meter
maxMeasuredColumns = 240
tab stop = 8
// Layout
terminalLeadingInset = 6 ; terminalBottomInset = 10
scrollerHideDelay = 1.0 s
horizontal page step = usableWidth * 0.9 ; line step = 40 pt
non-precise wheel dx multiplier = 10
minTerminalWidth margin = 40 pt
headerCondenseWidthWide = 560
// Runs
poll interval = 500 ms
idleOutputWindow = 0.15 s
cancelEscalateAfter = 1.5 s ; cancelDeadline = 3 s ; cancelAbandonAfter = 10 s
cancel pid retry = 10 × 100 ms
progress poll (in-shell) = 200 ms ; barWidth = 15 (30 visible columns)
progress header read = 24 bytes
pendingProgressFiles cap = 8
killLine = [0x05, 0x15]             // ⌃E ⌃U
inbox sentinel = "<<<END>>>"
inbox placeholder = "__QNET_ACTIVE_RUN_STATUS_INBOX__"
```

---

## 14. Implementation order

1. Embed SwiftTerm in an `NSViewRepresentable`; start the user's login shell with
   the environment of §3.1. Confirm a prompt, typing and `ls` colour.
2. Cache the host view on the model keyed by `terminalViewID`; verify that
   collapsing and re-showing the pane does not restart the shell.
3. Host container: clip view, insets, `layoutTerminal`, overlay scrollers, the
   `frameDidChange` and `sizeChanged` wiring.
4. Theme (both grounds + ANSI palettes) and fonts.
5. Byte capture → `PendingByteBuffer` → transcript save/replay. Test the two
   replay hazards (2-column wrap, `PROMPT_SP` erase) explicitly.
6. The line-width meter; wire it to `desiredMinWidth` and the horizontal scroller.
   Test with a 200-column table and with `vim`.
7. Clipboard, find (+ `adoptFindBar`), context menu, scroll-to-bottom.
8. The run lifecycle: `beginRun`, the poller, `finishRun`, the status-bar segment.
9. The wrappers: EXIT trap, pid file, tee, cleanup traps, stderr triage, progress
   bar.
10. Cancellation: group capture, escalation, `cancelSurvivorsOutstanding`. **Add
    the live cancellation gate at the same time** — source-text contracts cannot
    see this regression.
11. `commandBlocker` and the refusal path.
12. Menus, focus routing, ⌃` alias, detached window.

---

## 15. Acceptance checklist

Behaviours that are easy to lose and expensive to rediscover.

**Lifetime**
- [ ] Collapsing and re-showing the pane, toggling a sibling pane, maximizing another pane, and detaching the Shell into its own window all leave the shell PID and scrollback untouched.
- [ ] Only Restart Shell creates a new process, and it is behind a confirmation naming Clear Shell as the cheaper alternative.
- [ ] The shell is a **login** shell (`-zsh`), so the user's rc files run.
- [ ] `cd` updates the header's directory (OSC 7 arrives because `TERM_PROGRAM=Apple_Terminal`).

**Transcript**
- [ ] Quitting and relaunching restores the scrollback *with colour*, under a dated separator.
- [ ] A relaunch followed immediately by ⌘Q does not wipe the previous transcript.
- [ ] A force-quit loses at most 10 s of output.
- [ ] Replay does not produce a 2-column vertical stripe, and the first prompt does not erase the restored history.
- [ ] A session force-killed inside `vim` still replays into a sane, non-alt-screen state.

**Width and scrolling**
- [ ] A 200-column table engages the horizontal scroller instead of hard-wrapping.
- [ ] Widening the pane never lengthens the measured lines (no layout loop).
- [ ] `ESC[2K` on the widest line lets the scroller retract; Clear Shell retracts both.
- [ ] `vim` / `less` / `htop` never engage the horizontal scroller.
- [ ] `printf 'abcd\b\b'` still measures 4 columns.
- [ ] A shell-integration prompt (`ESC]7;file://…BEL`) does not count the path as printed columns.
- [ ] Two-finger horizontal swipe pans; overlay scrollers fade in on activity, stay while hovered, fade after 1 s, and do not animate under Reduce Motion.
- [ ] The prompt is not flush against the pane border, and the last row is not sliced by the window's rounded corner.

**Find, clipboard**
- [ ] ⌘F opens the find bar fully inside the pane, even with wide output and after panning.
- [ ] The find bar stays usable in a narrow pane (its buttons are not clipped).
- [ ] ⌘G does not steal focus from the search field.
- [ ] ⌘C with no selection copies **nothing**; only the header button falls back to the whole scrollback, and it says so.
- [ ] Edit ▸ Copy enables and disables as a shell selection appears and vanishes.
- [ ] Right-click over `htop` produces no menu of ours.

**Runs**
- [ ] A second launch while one run is active is refused, naming the running job and its tab.
- [ ] Switching tabs mid-run leaves every message going to the tab that started it.
- [ ] A half-typed command at the prompt is discarded, not concatenated.
- [ ] Launching while `vim` / `less` / `cat` owns the shell is refused **in words**, and the registered run is retired rather than left ticking forever.
- [ ] Launching with the Shell pane never opened this launch reports the actionable message, not a bare "exit -1".
- [ ] A solver that exits non-zero prints its stderr to the terminal *and* files it in the originating tab's log.
- [ ] A solver that exits 0 with a warning on stderr still surfaces the warning.
- [ ] The status-bar bar and the in-shell ASCII bar agree, because they read the same file.
- [ ] Elapsed time and progress survive a tab switch.
- [ ] Every run removes its done / pid / status / output / progress files.
- [ ] An exported temp input is removed even when the run is cancelled (EXIT + INT/TERM traps).

**Cancellation** — the section with the most ways to be subtly wrong
- [ ] ⌘. is live from the first millisecond, before the pid file exists.
- [ ] Stop pressed before the wrapper reports a pid still signals within a second, or says why not.
- [ ] Stop actually kills the **solver**, not just the wrapper: SIGINT → 1.5 s → SIGTERM → 3 s → SIGKILL, all to the recorded process group.
- [ ] The completion file is not believed while the run's group still has members.
- [ ] A run stuck past 10 s is retired anyway, so it cannot own the single-flight slot forever.
- [ ] The escalation never signals the app's own group or the interactive shell's group.
- [ ] A run stopped in the same instant it succeeded is reported as **finished**, not cancelled.
- [ ] A cancelled run is never filed as a failed result, and never as a zero-measurement one.
- [ ] There is an automated test that starts a real long job and asserts it is gone inside the deadline.
