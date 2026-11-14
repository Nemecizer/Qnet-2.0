# KEYBOARD SHORTCUTS

Every key equivalent in the menu bar, read from the live menus as this page is opened — so it always matches what the menus show. A key that appears here only once belongs to the item that is enabled for the current network: the Run pairs share their key between the infinite- and finite-buffer variants.

## CONVENTIONS

- ⌘↩ is Solve: it runs the best method for the network and shows how sure to be. See [Getting an answer: Solve](help:solve).
- ⌥⌘ + letter runs a method (Run menu): ⌥⌘M Monte Carlo, ⌥⌘S Spectral Method, ⌥⌘Q QNA, ⌥⌘B SBD, ⌥⌘E SRBM MLMC, ⌥⌘F Finite Element, ⌥⌘L Linear Program. ⌘R runs the comparison and ⌘. stops whatever is running. Check with Another Method, Run Recommended Methods and What-If Sweep… have no key of their own; they are in the Run menu and in the Command Palette (⇧⌘K).
- ⌘ + digit shows that document tab (⌘1–⌘9, in tab-bar order); ⌥⌘ + digit shows or hides a pane; ⌃⌘ + digit moves keyboard focus into that pane. The digits agree — 1 Tools, 2 Status, 3 Shell, 4 AI Assistant, 5 Inspector, 6 Results — and ⌃⌘0 focuses the canvas, which has no pane to show or hide.
- ⌘W closes the front tab (asking to save first) and ⇧⌘T reopens the last tab closed this session.
- Bare letters (V M H · S B O X · L) pick a canvas tool, matching the badges in the Tools pane. They never fire inside a text field, the Shell, a sheet or an auxiliary window.
- ⌘= / ⌘− zoom whatever has focus — the canvas, or the text of the Status, Shell or AI Assistant pane. ⌘0 is actual size, ⇧⌘0 fits the network and ⌥⇧⌘0 fits the selection (the Keynote keys).
- ⌥⌘R shows or hides the results on the canvas (View ▸ Results on Canvas). ⌥⌘N starts a new network from an archetype.
- ⌘F finds in whatever is in front: a node, the Shell scrollback, the Status log, the AI transcript, Help or Settings.
- ⌥⌘O opens the Canvas Outline, the network as a list. See [Using Qnet with the Keyboard and VoiceOver](help:keyboardAndVoiceOver).

<!-- generated: shortcuts -->

## KEYS NOT PRINTED IN A MENU

```
⌃`                           Focus Shell (second key for Window ▸ Focus Shell)
⌃⇥ / ⌃⇧⇥                     Show Next / Previous Tab (second keys for Window ▸ Show Next / Previous Tab)
Esc                          Deselect all on the canvas; close a sheet, a popover or an auxiliary window
Esc (mid-drag)               Put the drag back: the nodes return to where they started and no undo step is left behind
⇥ / ⇧⇥                       Walk the nodes in reading order, scrolling the target into view; at the last node (⇧⇥: the first) the key moves on to the next control
↩                            Edit Parameters… for the selection; with a node tool, place the node beside the selection; with the Link tool, start or finish a link at the selected node
⌥⇥ / ⌥⇧⇥                     Walk the links attached to the selected node
← ↑ → ↓                      Nudge the selection one grid cell (1 pt with Snap to Grid off); ⇧ = four cells (10 pt)
← ↑ → ↓ (nothing selected)   Scroll the canvas one wheel line; ⇧ = four lines
⇧- or ⌘-click                Add a node to the selection or remove it
⌥-drag                       Duplicate the selection and move the copies, as one undo step
⌃-drag                       Place freely: suspends Snap to Grid and the alignment guides
Space (held)                 Pan the canvas with any tool; the middle mouse button does the same
Double-click                 Edit Parameters… for the node or link under the pointer
Double-click (empty canvas)  Sticky pan: the hand takes the canvas over; one click anywhere restores the previous tool
Drag node → node             Link tool: draws the link, with a dashed preview following the pointer
Drag out and back            Link tool: a self-loop on the station the drag started from
← → (Agreement view)         Move between the methods' marks on a quantity's deviation axis; ↑ ↓ change the quantity
← ↑ → ↓ (a chart)            Move between the marks of a chart; Home and End jump to the first and the last
← → (a row of choices)       Move along a segmented control, such as the Results views, choosing as it goes; Home and End jump to the ends
↑ ↓ (Canvas Outline)         Move between the rows of the nodes or links table; ↩ selects the row on the canvas
```

## CHECKING THE MAP

Qnet's own tests fail if two menu items share a key, and a debug build prints any shared key to standard error when it builds the menu bar.
