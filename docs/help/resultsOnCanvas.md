# RESULTS ON THE CANVAS

After a run, Qnet writes each station's result beside the station on the canvas, so you can see where the network is busy without reading a table.

## WHAT IS DRAWN

- A badge above each station with the value and its unit. When the method gives an interval, the badge shows it as ± after the value.
- A ring around each station. Its colour and its width both follow the value, so the picture does not depend on colour alone.
- A bottleneck marker on the badge of the station with the highest utilization in the run. When several stations share the highest utilization, each of them carries the marker and its tooltip reads "Equally loaded" with the names of the others: no single station is the bottleneck.
- A legend chip in the top-left corner of the canvas that names the quantity, the method and the kind of method (exact, simulation, approximation, diffusion model or bound).

Hover over a badge for the full number and, when the run reports them, the values per customer class.

## TURNING IT ON AND OFF

View ▸ Results on Canvas ▸ Show Results on Canvas, or ⌥⌘R, shows and hides the results. They are shown by default. The same submenu chooses the quantity:

- Utilization
- Mean number in system
- Mean sojourn time
- Mean queue length
- Throughput

Choosing a quantity also shows the results. Color Stations turns the coloured rings on and off. Clicking the legend chip opens the same choices.

## WHICH RUN IS SHOWN

The canvas shows one run. If you select a run in the Results pane, the canvas shows that one, and the legend chip offers Show the Best Current Run. Otherwise it shows the best current run of the network as it is now that reports the chosen quantity. Best means the best kind of method first (exact, then simulation, then approximation, then diffusion model, then bound) and, among equals, the newest.

If the run does not report the chosen quantity per station, the legend says so. Choose another quantity or run another method.

## THE COLOUR SCALE

Utilization uses a fixed scale from 0 to 1. Up to 0.85 the ring moves from a quiet tint to the full accent colour; from there to 1 it turns toward the critical colour, so a station close to saturation looks different in kind. Every other quantity is scaled against the largest station in the run.

## WHEN THE NETWORK HAS CHANGED

If you edit the network after a run, the values no longer belong to it. They are dimmed, and the legend says "Network changed since this run". Run a method again to update them.

## ZOOMING OUT

When the canvas is zoomed far out, the badges' text is dropped and only the rings and the bottleneck marker stay. A little before that, the ± part is dropped from the badge; it stays in the tooltip.

## TRY IT

[Example network: five stations in a line (5stationtandem.inf)](qnet-example:5stationtandem.inf?run=run:qna)

All five stations carry the same load here, so the rings look alike and every station carries the marker as equally loaded: there is no single bottleneck. Switch the quantity to Mean number in system and watch the badges change value and unit.
