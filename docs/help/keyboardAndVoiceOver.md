# USING QNET WITH THE KEYBOARD AND VOICEOVER

Everything in Qnet can be done without the pointer, and everything it draws is also there as text. This page is the map. [Keyboard Shortcuts](help:keyboardShortcuts) lists every menu key.

## MOVING ABOUT THE WINDOW

- Tab and ⇧Tab move between controls. A ring shows where the keyboard is.
- ⌃⌘ and a digit moves the keyboard into a pane: 1 Tools, 2 Status, 3 Shell, 4 AI Assistant, 5 Inspector, 6 Results, and 0 the canvas. The Window menu lists them.
- ⇧⌘K opens the Command Palette. Type a few letters of any command and press Return.
- Esc closes the thing in front: a menu, a popover, a sheet, the palette. It closes one thing at a time.
- A row of choices that works as one control, such as the Results views (Table, Agreement, Charts and the rest), is one Tab stop. The arrow keys move along it and choose as they go; Home and End jump to the ends.

## THE CANVAS

The canvas is a drawing, so it has keys of its own while the keyboard is in it.

```
⇥ / ⇧⇥                       Select the next or previous node, in reading order
⌥⇥ / ⌥⇧⇥                     Select the next or previous link of the selected node
← ↑ → ↓                      Move the selection one grid cell; with ⇧, four cells
↩                            Edit Parameters… for the selection
⌫                            Delete the selection
Esc                          Select nothing
V M H · S B O X · L          Choose a tool
↩ (a node tool)              Place the node beside the selected node, on a free spot
↩ (the Link tool)            Start a link at the selected node; select the target and press ↩ again
```

At the last node Tab leaves the canvas for the next control, and ⇧Tab leaves at the first, so the keyboard is never held there. Press Esc first to start the walk again from the first node.

To draw a line of two stations with the keyboard: press O then ↩ for a source, B then ↩ for a buffer, S then ↩ for a station, X then ↩ for a sink. Then press L, select the source with ⇧Tab, press ↩, and walk forward with Tab, pressing ↩ on each node in turn.

## THE CANVAS OUTLINE

View ▸ Canvas Outline (⌥⌘O) shows the network as a list instead of a picture. It has a table of the nodes, with each one's kind, parameters, result and problems, and a table of the links, with class and routing probability.

- ↑ and ↓ move between the rows of a table. Return selects the row; the canvas selects the same node or link.
- Under the tables, Selection has the things that can be done to the selected row: Edit Parameters…, Go to Inspector, Delete, Move Left, Right, Up and Down, and Link to, which adds a link from the selected node to the node you choose. A node's problems are listed there with their fixes.
- Add a node has four buttons: Source, Buffer, Station and Sink.
- Esc closes the outline and returns to the canvas.

Every edit made from the outline is an ordinary edit and one step of Undo.

## WHAT VOICEOVER HEARS

- A node is read as its kind and name, its parameters, its result when the canvas shows one, and its problems: "Station S1, Exponential, service rate μ = 1.25 jobs per time unit per server. Utilization 80.0 %." It is read when Tab selects it.
- A run is announced when it starts and when it ends, with its outcome.
- The Problems count is announced when it changes. ⌥⌘] and ⌥⌘[ read the next and the previous problem.
- A step of the guided tour is read when it appears. Show Me does the step for you.
- Notices at the bottom of the window are read once.
- Every chart has a sentence that says what it shows and a table of its numbers. With the keyboard on a chart, the arrow keys move between its marks and each is read out.
- In Animate, the state of the run is read as text; Space plays and pauses.

## SEEING

- View ▸ Appearance has Match System, Light and Dark; Increase Contrast; Reduce Motion; and five text sizes, from Small Text to Largest Text (half as large again as the default). Left alone, Qnet follows the appearance, Increase Contrast and Reduce Motion settings of macOS.
- The Status, Shell and AI Assistant panes have a text size of their own in their headers, and View ▸ Zoom In enlarges the canvas.
- Nothing is told by colour alone. A method's tier has a shape as well as a colour, a problem's kind has a shape and a word, the classes in an animation have shapes, and a value changed by a scenario says what the baseline is.
- With Reduce Motion on, nothing moves by itself: spinners stand still and the canvas does not glide.
