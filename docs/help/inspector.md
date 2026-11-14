# HELP — Inspector Pane and Parameter Sheets

## WHAT THIS IS

Every node and link has parameters: a name, the number of servers and the buffer size, the service or inter-arrival law (a distribution family and its parameters, or a mean and SCV that are solved into them), a picture, and for a link the routing probability and the customer class it carries.  Qnet edits them in two hosts that show the SAME grouped form, bound to the same draft:

```
The Inspector pane      View ▸ Panes ▸ Inspector   (⌥⌘5)
                        Focus it with ⌃⌘5.
The parameter sheet     Edit ▸ Edit Parameters…    (⌘I), or the
                        "Edit in Sheet" button in the pane header.
```

Neither host has a field the other lacks.  They differ only in geometry and in WHEN a change is written to the network.

## THE INSPECTOR PANE (docked, follows the selection)

The pane sits in the right column above the Status pane and shows whatever is selected on the canvas: a node, a link, or the one node of a one-node marquee selection.  While S3 is being edited the canvas still shows S3 and its neighbours; click S2 and the pane moves with you.

```
Commit rule:   a text field is written when you LEAVE it (Tab,
               Return, or a click elsewhere).  Pickers, steppers
               and the picture choice are written as soon as the
               draft settles (a fraction of a second).
Undo:          every commit is one undoable step, named for the
               node ("Edit S1 Parameters").  A RUN of commits to
               the same field - a stepper held down, a value
               retyped and re-blurred - folds into ONE step, so a
               single ⌘Z takes back the whole run.  Undo keeps
               the selection: the pane shows the restored value
               in the same field.
Invalid input: a field that does not pass validation shows its
               message in red and is NEVER written.  Fix it,
               press Escape to put the whole draft back to the
               last committed values, or move the selection - in
               which case the invalid edit is discarded and one
               warning line in the Status log says which field
               and which text were dropped.
Per class:     a station serving several classes shows a Class
               picker over one set of distribution fields.  A
               commit never moves that picker or the entry mode.
               The classes listed are the ones that reach the
               station: a link that changes class delivers its
               exit class, so the class it carried in is not
               listed at the station after it.
Reload:        when the network changes elsewhere (undo, the AI
               assistant, the sheet's Save) the pane re-reads the
               node - unless you are typing in it, in which case
               your edit wins and is committed on blur as usual.
```

## THE PARAMETER SHEET (modal, review and save)

⌘I opens the same sections in a sheet with room for the per-class service TABLE (one row per class: distribution, parameters, and the live lambda / mean / SCV / mu readouts).

```
Save:          writes every change as ONE undo step and closes.
Cancel / Esc:  closes; asks Save / Don't Save / Cancel first when
               the draft differs from what is stored.
Previous/Next: ⌥↑ / ⌥↓ step through the nodes of
               the same kind without closing the sheet (the same
               prompt appears if the draft is dirty).  The sheet
               opens at one size for the whole walk.
Up / Down:     move between class rows in the table when no text
               field is being edited; inside a field the keys
               belong to the field.  Tab visits fields only, one
               stop per control - rows are not Tab stops.
Bulk actions:  "Copy Class 1 to N other classes" and "Exponential
               (rate 1) for all classes" say their scope in the
               title and offer a one-click Undo in the footer.
```

## WHILE A NUMBER IS HALF-TYPED

"1e-" or "0." is not a mistake yet.  Nothing turns red; the footer (sheet) says "Still typing ..." and Save stays disabled until the number is complete.  The pane simply does not commit until the field is left with a complete value.

## THE LOAD ROW

A station's Capacity section shows lambda (the station's total arrival rate from the traffic equations), c\*mu (servers times the effective service rate) and rho = lambda / (c\*mu), recomputed from the values being typed before they are saved.  rho >= 0.95 warns (heavy traffic); rho >= 1 is called unstable.  Neither blocks a save - an unstable station is a legal network, just a bad one.

## SHORTCUTS

```
⌥⌘5               show / hide the Inspector pane
⌃⌘5               focus the Inspector (caret in the first field)
⌘I                open the parameter sheet for the selection
⌥↑ / ⌥↓           previous / next node of the same kind (sheet)
Escape            pane: revert the uncommitted draft;
                  sheet: close (asks if the draft is dirty)
Return            commit the field (pane) / Save (sheet)
```
