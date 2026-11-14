# LIVE RESULTS

Qnet computes what it can while you draw. Change an arrival rate, a service rate, a number of servers or a routing probability, and the values on the canvas follow at once, before any run. It works like a spreadsheet for a queueing network: change a number and watch the bottleneck move.

## WHAT YOU SEE

Live results use the same badges, rings and bottleneck marker as Results on the Canvas. Stations that share the highest utilisation are all marked, as equally loaded. The legend chip in the top-left corner of the canvas tells you where the values come from:

- Live · exact. Every value is exact.
- Live · utilisation only. Only utilisation is shown; hover over the chip to read why.
- Live · offered load only. Buffers are finite, so ρ is the offered load, before blocking or loss. It can be 100 % or more.
- Live · no steady state. Buffers are infinite and some station has ρ of 1 or more.

A recorded run has no such chip. Its legend names the method and the kind of method in words, for example "Utilization · Product Form · Exact".

Select one station and the status bar of the canvas reads out its values: ρ, the utilisation; L, the mean number of customers at the station, waiting and in service; and W, the mean time a customer spends there per visit, in time units. Hover over the read-out for the totals of the whole network.

## WHEN THE VALUES ARE EXACT

The values are exact for an open Jackson network: every source is Poisson, every station has exponential service, buffers are infinite, and no station serves more than one customer class. Then each station behaves as an M/M/c queue whose arrival rate comes from the traffic equations, and the mean number in system, the mean number waiting and the mean time at the station all have formulas. This is the same test that Network ▸ Analyze Network reports as "Open Jackson network", and the same numbers that the Product Form method computes.

For the whole network, the mean number of customers is the sum over the stations, and the mean time from arrival to departure is that sum divided by the total arrival rate (Little's law).

## WHEN ONLY UTILISATION IS SHOWN

For any other network no formula gives the queue lengths, and Qnet does not guess. It shows utilisation and says why:

- A source or a station is not exponential.
- More than one class is served at a station.
- Nothing reaches a station.
- Buffers are finite.

With infinite buffers the utilisation ρ is still exact, whatever the distributions: it is the arrival rate divided by the service capacity. With finite buffers work can be blocked or lost, so ρ is only the offered load and the chip says so. Press Solve for queue lengths.

## WHEN THERE IS NO STEADY STATE

With infinite buffers, if work arrives at a station as fast as it can be served, or faster, the queue grows without limit. Live results then show ρ, which is 100 % or more, and no queue length for any station. The Problems badge on the station says the same and offers a fix.

## LIVE VALUES AND RECORDED RUNS

A recorded run of the network as it is now always takes precedence, and so does a run you select in the Results pane. Live values are shown when the tab has no run yet, and again as soon as you change the network after a run. Undo the change and the run is shown again. Moving a node changes nothing.

Live values are never part of an exported diagram and are not stored in the Results pane. Press Solve to record a run.

## TURNING IT ON AND OFF

View ▸ Live Results turns live results on and off. They are on by default. View ▸ Results on Canvas chooses the quantity, as for a run; a quantity that is not available live falls back to utilisation.
