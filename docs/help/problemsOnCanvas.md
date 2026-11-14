# PROBLEMS ON THE CANVAS

Qnet checks the network as you draw it. When something is wrong, it marks the place on the canvas and says what the matter is in one sentence, usually with a button that repairs it.

## THE MARKS

A small badge sits at the top-left corner of a node, or on a link, that has a problem. Shape as well as colour tells the three kinds apart:

- Error, a filled octagon. The network has no answer as it stands: a station without a buffer, routing probabilities that add up to more than 1, or a station where work arrives faster than it can be served. With such a station no steady state exists; some methods will refuse to run, and a simulation will not settle.
- Warning, an outlined triangle. A run is possible, but part of the network does nothing or the answer needs care: a station no source reaches, a link that is never used, a link out of a sink (it is ignored), a station that is busy almost all the time, routing probabilities that pass 1 only when the link into a sink is counted.
- Note, an outlined circle. Something worth knowing, such as a sink nothing leads to.

Hover over a badge, move the keyboard to it or click it to read the sentence. A click keeps it open; Esc closes it.

## THE FIXES

Most problems offer a fix: Add a server, Raise the service rate, Connect to a sink, Add a buffer in front, Delete this link. A fix is an ordinary edit and one step of Undo. Open in Inspector takes you to the node or link instead, where you can change it yourself.

For routing probabilities that add up to more than 1, the button names the numbers the links will get. It is offered only when the scaled network still lets customers leave; a link from the station to a sink keeps its probability.

A station's links can also add up to more than 1 only because of its link into a sink: 0.6 back to a buffer and 0.7 to the sink, say. Most methods never read the number on a sink link: what the other links leave under 1 (here 0.4) leaves the network. Regenerative Monte Carlo, Product Form, QBD, the CTMC methods and Finite-Buffer Decomposition count it and refuse the network. This is a warning, and its fix sets the sink link to what leaves (0.4), which every method then agrees on and which changes no result.

## THE LIST AND THE KEYS

The status bar of the canvas counts the errors and warnings. Click the count for the Problems list of the whole network; a row there selects its node or link.

- ⌥⌘] is View ▸ Next Problem and ⌥⌘[ is View ▸ Previous Problem. They step through the marked nodes and links and open each one's sentence.
- View ▸ Show Problems on Canvas hides and shows the badges. The count and the list stay.

The marks are never part of an exported diagram.

## WHEN A RUN IS REFUSED

If a run does not start and the network has errors, the Status pane points to the Problems list. An error is the likely reason, but not every error stops every method.
