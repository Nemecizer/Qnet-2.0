# ARRIVAL RATES THAT CHANGE OVER TIME

Few real systems have the same arrival rate all day. A source with a rate profile has a rate that changes at set times: a morning peak, a quiet afternoon, a night with almost no arrivals.

## SETTING IT

Select a source. The Inspector has the section Rate Over Time. Set Arrival rate to Changes over time and fill in the table:

- each row is a segment: it lasts until the time in the first column, and during it the source's own rate is multiplied by the number in the second column;
- time starts at 0, and each segment must end later than the one before;
- Add Segment adds a row, and the button at the end of a row removes it;
- Repeat starts the profile again when its last segment ends, which makes a daily pattern. Without Repeat the source's own rate applies after the last segment.

A small step chart under the table shows the multiplier over time, with a dashed line at 1.

The source must be a Poisson source. Its arrivals are then a Poisson process whose rate changes in time. On the canvas the source carries a small mark "λ(t)" at its bottom-left corner, and its tooltip and the Canvas Outline say so in words. The profile is saved in the file. Qnet 2.0 and 0.90.34 ignore it and read a constant rate.

## THERE IS NO SINGLE STEADY STATE

A network whose arrival rate keeps changing does not settle to one long-run state, so the methods that compute a steady state have nothing to compute. Solve and the Method Chooser say this and point to the Transient view. Replicated Simulation, which estimates long-run averages, refuses for the same reason.

The utilisation shown on the canvas is at the long-run average rate of a repeating profile. If the peak of the profile overloads a station that the average does not, Problems says so: the queue grows through the peak and drains afterwards.

## THE TRANSIENT VIEW

Run ▸ Transient… computes the mean number at each station as it moves in time. With a rate profile in the file the view follows it, and says so; a surge cannot be added on top. The suggested horizon covers two periods of a repeating profile.

- Exact: for a network with Poisson sources and exponential service, the mean is computed exactly from the network's Markov chain, restarting at every change of rate. Each source keeps its own profile. The stated bound on the error holds as long as no segment so far has overloaded the network; from the first overloading segment on, Qnet states no bound, as for a surge. See [Transient Analysis](help:transient).
- Fluid: the average flows without randomness. It shows where a backlog builds and how fast it drains.
- Pointwise stationary approximation (PSA): at each moment, the steady state the network would have if that moment's rates lasted for ever.

The chart marks each change of rate with a faint vertical line. A repeating profile never settles, so no settling time is given; the reading names the highest mean within the time shown.

[Example network: two servers with a daily rush-hour profile (RushHour.mt-m-2.daily)](qnet-example:extended/RushHour.mt-m-2.daily)

The example is a two-server station with a daily profile of five segments. It is also in the Welcome view's gallery, and File ▸ Open Example… has it in the folder "extended".

## WHERE THE STATIONARY APPROXIMATION FAILS

PSA is a standard teaching approximation and is labelled as an approximation. It is drawn beside the exact curve so that its errors can be seen.

- It jumps the instant a rate changes. The true mean needs time to follow, roughly the relaxation time the view reports.
- It puts the worst congestion at the peak of the rate. The true peak comes later, when the rate is already falling.
- It can be many times too high during a short busy segment, because a steady state at that load would take far longer to build up than the segment lasts. In the example it says more than 15 customers where the true mean never passes 3. Where it leaves the chart, the legend says how high it goes.
- It has no value at all while a segment overloads the network, however short the segment.

PSA is good only where the rates change slowly compared with the time the queue takes to settle.

## SIMULATION AND ANIMATION

Run ▸ Animate plays the network with the changing rate: the queue builds in the busy segments and drains in the quiet ones. The simulator draws the arrivals by thinning: it generates candidate arrivals at the peak rate and keeps each with the probability the profile gives for that moment. Qnet's tests hold the simulated mean number at chosen times to the exact transient mean.

## WHAT IS NOT COVERED

- The profile is piecewise constant, with at most 48 segments. A smoothly varying rate is approximated by steps.
- The exact transient calculation needs a Jackson network (Poisson sources, exponential service, one class per station). Otherwise the fluid model is shown alone.
- A rate profile together with priority service or batch arrivals is simulated and animated, but the Transient view does not cover those two features.
- Sensitivity, Uncertainty, Capacity planning and every steady-state method refuse a network with a rate profile and say why.
- A scenario cannot change the profile yet: it is the same in every scenario of a file.

## PROBLEMS QNET POINTS OUT

- A segment with no length: one that does not end later than the one before it.
- A negative multiplier, or a repeating profile that is zero all the time.
- A rate profile on a source that is not Poisson.
- A station that the peak of the profile overloads while the average does not (a warning, not an error).
