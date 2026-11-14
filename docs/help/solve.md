# GETTING AN ANSWER: SOLVE

Solve is the one button to press when you want numbers and do not want to choose a method first. It is the first item of the Run menu, and its key is ⌘↩.

## WHAT SOLVE DOES

Solve runs one method: the best one for the network as it is now. Then it opens the Agreement view of the Results pane, where the answer is shown with a sentence about how far to trust it.

If that method has already run on this network and the network has not changed since, Solve does not run it again. It shows the result that is already there and says so in the Status pane.

Solve needs a network on the canvas. While another run is in progress Solve is unavailable: wait for that run to finish, or stop it.

## HOW THE METHOD IS CHOSEN

Qnet asks the Method Chooser, which looks at the network (finite or infinite buffers, the routing, the distributions, the number of customer classes) and ranks every method that can run on it. Solve walks that ranking in this order:

1. An exact method, if one applies to this network. An exact method computes the true steady-state values, so nothing better exists.
2. Otherwise a simulation. No exact method applies, so a simulation is the reference the others are measured against.
3. Otherwise the best-ranked approximation that can run.

The tooltip of the Solve button in the Agreement view names the method it will run and gives the reason. Run ▸ Choose a Method… opens the Method Chooser with the reasoning for every method.

## CHECK WITH ANOTHER METHOD

One method gives one answer. A second method shows how sure to be. Run ▸ Check with Another Method runs the most informative method that has not yet been tried on this network:

- an exact method, if one applies and has not run;
- otherwise a simulation, if none has run, because a simulation settles disagreements between the others;
- otherwise the best-ranked approximation that is left;
- a second simulation last.

A method that failed, or that cannot run on this network, counts as tried, so it is not offered twice. When every method that applies has run, the Status pane says so.

## RUN RECOMMENDED METHODS

Run ▸ Run Recommended Methods runs a small set, one after another: the exact method if one applies, one simulation, and two approximations, taking first the best-ranked of those that report a headline quantity (mean number in system, mean sojourn time, utilization, throughput). Methods that have already run on this network are skipped.

While the set runs, the Agreement view shows which method is running and which are waiting. Stop ends the current run and leaves the rest unrun.

## WHEN THE NETWORK CHANGES

A result belongs to the network it was computed for. After you change a rate, a buffer size or the routing, earlier runs are marked as belonging to the network as it was, and the Agreement view offers Run Them Again. Moving nodes around on the canvas does not count as a change.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf)

Open it and press ⌘↩. An exact method applies to this network, so that is what Solve should run; then choose Run ▸ Check with Another Method and watch the second method land beside the exact value.
