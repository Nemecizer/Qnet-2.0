# HOW SURE IS THE ANSWER? THE AGREEMENT VIEW

Every method in Qnet answers the same question in a different way. When independent methods give the same number, you can trust it. When they do not, you should know. The Agreement view of the Results pane puts the methods side by side and says which of the two it is.

## THE FIVE KINDS OF METHOD

Each run is labelled with how much its number is worth as evidence, best first:

- Exact. The method computes the true steady-state value for this network. Nothing arbitrates above it.
- Simulation (95 % interval). The method imitates the network with random numbers. Its value comes with an interval; a longer run gives a narrower one.
- Approximation. A formula-based estimate, such as QNA. Fast, with no interval.
- Diffusion model. The method replaces the network by a Brownian model that is most accurate when stations are heavily loaded.
- Bound. The method gives a limit that the true value cannot cross, not an estimate of it.

## THE REFERENCE

For each quantity (a station, a customer class, a metric and its unit), one value is the reference and every other method is measured against it:

- the exact value, when an exact method has run;
- otherwise the simulation, and when several simulations have run, the one with the narrowest interval;
- otherwise there is no reference, and the methods are compared with each other: their spread is taken against their mean.

Only like is compared with like. Two numbers are the same quantity only when the station, class, metric and unit all match.

## THE TWO THRESHOLDS

A method's deviation is its value minus the reference, divided by the reference.

- Agree: every method is within 2 % of the reference, or inside the simulation's interval.
- Close: every method is within 10 % of the reference.
- Disagree: at least one method is more than 10 % away.
- Exact: an exact method gives this value and nothing else was compared with it.
- One method: only one method reports this quantity, so there is nothing to compare.

The banner at the top gives the verdict for the whole network: the worst verdict among the quantities that more than one method reports.

Being inside the simulation's interval counts as agreement whatever the percentage, because a small mean can differ by a large percentage and still be the same within the noise. This applies only when the interval is tight enough to mean something: if its half-width is more than 10 % of the value, the view says the interval is too wide to judge and asks you to run the simulation longer.

When the reference is exactly zero there is no percentage to give. The view then says "reference is zero" and reports whether the other values are zero too.

## PARTIAL AND BOUND

- Partial marks a run that ended early. Its values are shown, but a partial run is never the reference and is never called exact.
- Bound marks a value from a bounding method. It is shown, but it is not scored against the reference, because a bound is not supposed to equal the true value.

## READING THE TABLE

There is one row per quantity. The row shows the reference value, then a small axis from −10 % to +10 % on which every other method is a mark at its deviation, then the largest gap and the verdict. A mark beyond the axis is drawn at its edge and labelled as beyond it. With the keyboard, the arrow keys move between the marks of a row.

You can sort by station or by largest disagreement first, filter by station and by metric, and choose to list the quantities that only one method reports.

The view also lists each method that was read, with a short explanation: what it is, when to trust it, and, where a disagreement was found, a likely reason for it.

## WHEN THERE IS LITTLE TO SEE

- No runs yet: the view says to press Solve.
- One method only: the view says that a second method would show how sure to be, and offers Check with Another Method.
- The network changed: earlier runs are set aside, and the view offers Run Them Again.

## TRY IT

[Example network: three stations in a line (3dtandem.inf)](qnet-example:3dtandem.inf)

Open it and choose Run ▸ Run Recommended Methods. Read the banner first, then find the row with the largest gap and see which method is furthest from the reference.
