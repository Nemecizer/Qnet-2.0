# TRANSIENT ANALYSIS

Most of Qnet answers "what happens in the long run?". The Transient view answers two questions about time: how long does the network take to settle, and what happens after a surge of arrivals? It draws the mean number of customers at each station against time.

## OPENING IT

Choose Run ▸ Transient…, or switch the Results pane to Transient. The network must be open (it has a source) and have infinite buffers. The view computes a first set of curves at once, from an empty network.

The set-up has four parts:

- Start: Empty, In steady state, or Given numbers (type the number of customers at each station at time 0).
- Time horizon: the curves run from time 0 to this time. Leave it empty to use the suggested horizon.
- Settled within: a station counts as settled from the time its mean stays within this percentage of its long-run average. The default is 5 %.
- Surge of arrivals: multiply every external arrival rate by a factor between two times, then return to normal. A factor of 2 doubles the arrivals; 0 stops them.

Press Compute after changing the set-up. Times are in the network's own time unit, the one its rates are written in.

## READING THE CHART

Each station has one colour. The kind of line tells you the method:

- A solid line is the exact mean number at the station.
- A dashed line is the fluid approximation.
- A dotted horizontal line is the station's long-run average.
- A diamond marks the time from which the exact mean stays inside the settling band. With a surge, it is looked for after the surge ends.
- The shaded band is the surge.

The sentence above the chart reads the slowest station in words, for example "From empty, S2 takes about 47 time units to come within 5 % of its long-run average of 2.33 customers." Show as Table lists the same numbers, with the probability that each station is empty and the distance to the steady state. The table under the chart gives, for each station, its utilisation, long-run average, relaxation time, settling time and highest mean.

The settling time is checked only up to the time horizon. If the view says a station has not settled, lengthen the horizon.

## EXACT

The exact curves apply to an open Jackson network: Poisson arrivals, exponential service times, any number of servers at a station, infinite buffers and one customer class at each station. The numbers at the stations then form a Markov chain. Qnet builds that chain and computes its distribution at each time by uniformisation (Jensen's method), which adds only non-negative terms.

Two things are cut off, and both are measured:

- Each queue length is cut off at a level chosen from the steady-state distribution, so that the probability beyond it is negligible. During a surge the level is raised.
- The series is stopped when the remaining terms are below a tolerance.

The line "error in the distribution at most …" is the probability that the computed distribution does not account for. It bounds the whole error of the distribution from both causes. Hover over the line for the cut-off levels and the number of steps.

The means are a different matter. The probability that is lost belongs to the longest queues, so each computed mean is a lower bound, and the lost probability alone does not say how far below. Qnet bounds the gap with a second fact: a network that starts empty or in its steady state, and is never overloaded, never holds more (in the stochastic order) than the steady state of its busiest period. The mean of that steady state beyond the cut-off is known in closed form. The same line then says "each mean is a lower bound, too low by at most … customers", and the cut-off levels are chosen to make that figure negligible. From given starting numbers the bound is larger by a known factor.

When a surge overloads the network there is no steady state to compare with. From the start of the surge the view then says that the means are lower bounds with no bound on their error, and it states no settling time. A settling time is stated only when the mean and its error bound are both inside the band.

The exact calculation needs one state for every combination of queue lengths, so it is limited to 200 000 states. A network with many stations, or with stations close to saturation, exceeds this. The view then says so and shows the fluid approximation alone. Long calculations show their progress and can be stopped.

The exact curves need a steady state to compare with, so they are not offered for a network that is overloaded as drawn.

## FLUID APPROXIMATION

The fluid model replaces customers by a continuous flow that moves at the average rates and ignores randomness. Station i has capacity κᵢ = cᵢμᵢ (servers times service rate). While it holds fluid it works at rate Dᵢ = κᵢ. While it is empty it passes on what it receives: Dᵢ = min(κᵢ, γᵢ + Σⱼ pⱼᵢDⱼ). The level then moves as

dQᵢ/dt = γᵢ + Σⱼ pⱼᵢDⱼ − Dᵢ

where γᵢ is the external arrival rate at station i and pⱼᵢ is the probability that a customer leaving station j goes to station i. Between events (a station running empty, the start or end of a surge) the levels move in straight lines, so Qnet follows them from event to event without a step-size error.

For one queue with arrival rate λ and service rate μ this gives two rules of thumb:

- If λ > μ, the backlog grows at λ − μ customers per time unit.
- A backlog of Q₀ with λ < μ drains in Q₀/(μ − λ) time units.

The fluid model applies to any open network with infinite buffers in which each station serves at one rate, whatever the distributions and however large the network. It is a large-scale limit: it is good when queues are long, as during an overload. At a station with spare capacity it shows no queue at all, although the true mean settles at the long-run average. Starting "in steady state", the fluid curves start empty for the same reason. Never read a fluid curve as exact.

## HOW LONG UNTIL IT SETTLES

For one M/M/1 queue the distance to the steady state shrinks like e^(−t/τ), where τ = 1/(√μ − √λ)² is the relaxation time. With μ = 1:

- at λ = 0.5, τ is about 12 time units;
- at λ = 0.8, τ is about 90;
- at λ = 0.9, τ is about 380.

A busier queue takes much longer to settle: going from 80 % to 90 % utilisation multiplies the time by four. From empty, the mean of an M/M/1 queue comes within 5 % of its long-run average after a little more than one relaxation time (about 15, 100 and 420 time units in the three cases above). The suggested horizon is twice the longest relaxation time among the stations. For a station with several servers Qnet uses cμ in place of μ, which is a rough scale only.

This matters for simulation too: a run that is short compared with the relaxation time has not yet reached the steady state that it is meant to estimate.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf)

Open it and choose Run ▸ Transient…. Both stations run at 70 % utilisation and have a long-run average of 2.33 customers. From empty, S1 settles after about 31 time units and S2, which is fed by S1, after about 47. Then choose Start: In steady state, set the time horizon to 200, switch on Surge of arrivals with factor 1.5 from time 20 until 60, and press Compute. During the surge S1 is overloaded: its exact mean climbs to about 10 customers, while the fluid curve rises in a straight line to about 2.9 and is empty again at time 67. The exact means come back within 5 % much later: S1 at about time 158 and S2 at about time 188.
