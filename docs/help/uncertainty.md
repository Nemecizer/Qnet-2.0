# UNCERTAINTY IN THE INPUTS

The Uncertainty view answers "how sure is the answer when I am not sure of the rates?". A measured arrival rate is 0.8 give or take 10 %; a service rate comes from a handful of timings. The view carries that uncertainty through the network and shows how far the answer can move, how likely the network is to be overloaded, and which rate is worth measuring better.

## OPENING IT

Choose Run ▸ Uncertainty…, or switch the Results pane to Uncertainty. The network needs a source, a station and a sink, and it must have a steady state as drawn. Pick the measure in the menu at the top: the mean number in the network, the mean delay through it, or one station's mean number, queue length, sojourn time or utilisation.

## SAYING WHAT IS UNCERTAIN

Every arrival rate and every service rate can be uncertain. "All rates ±" sets one percentage for all of them; 10 % is the starting value, and 0 means known exactly. Each rate has a row where it can say otherwise: its own percentage, an interval with two ends, or Known exactly.

Read ± as chooses what the percentage means.

- Standard deviation: the rate is its value give or take that much. Qnet uses a lognormal law with the rate as its mean and the percentage as its coefficient of variation, because a rate is never negative. An interval is read as a 95 % interval: the rate lies inside it 19 times in 20.
- Range (uniform): the rate is anywhere within that percentage of its value, every value equally likely. A range must stay under ±100 %. An interval is read as the range itself.

The last column of each row shows how the rate was read, with its 95 % interval.

The inputs are taken to be independent of one another: learning that one rate is high says nothing about the others. With two or more sources you can switch on "Arrival rates move together". One cause, such as a busy day, then raises or lowers every arrival rate at once, and the answer is usually less certain than with independent rates.

If a rate was set by Fit from Data, type the fit's 95 % interval as an Interval for that rate. The fit reports an interval for the mean time; the interval for the rate runs from 1/upper to 1/lower. Qnet does not keep the fit once it is applied, so it cannot fill this in for you.

## WHAT THE VIEW SHOWS

The chance of overload comes first, for example "In 3.1 % of plausible cases the network is overloaded". In those cases some station's utilisation reaches 1, its queue grows without bound and the measure has no value. Every other number is over the cases that do have a steady state, and the view says so.

One sentence gives the reading: the measure's median, and the interval that holds it in 95 % of the cases, beside its value as drawn.

The first chart is the measure's distribution. The shaded band is the middle 95 %, the solid line the median and the dashed line the value as drawn. The bracket above the bars is the linear approximation's 95 % interval, for comparison. A long tail to the right is cut off so that the rest stays readable, and the caption says how many cases were left off.

The second chart shows whose uncertainty matters: the share of the measure's variance that is due to each input. A sentence names the leader, for example "Measure the Src1 arrival rate better: it explains 72 % of the uncertainty in the average delay through the network."

Show as Table lists every number with its standard error, and the linear approximation beside it.

## HOW SURE THE NUMBERS ARE

The line above the results always says where they come from.

Exact solutions of sampled cases. If the network is an open Jackson network (Poisson arrivals, exponential service times, infinite buffers and one customer class at each station), Qnet draws the uncertain rates 20 000 times and solves the network by its exact formula for every draw. Nothing is simulated: the only error is that of taking a sample, and it is shown after each number as ± one standard error. The draws use a fixed seed, so the same question gives the same numbers every time.

- The interval ends are quantiles of the sample. For one queue with one uncertain rate they are exact in a simple way: the measure rises with the arrival rate, so its 97.5 % point is the measure at the arrival rate's 97.5 % point.
- The shares are Sobol′ indices, estimated by a pick-freeze design (Saltelli and others, 2010). The first-order share is what knowing that input exactly would remove. The total share, in the table, also counts its interactions with other inputs.

Linear approximation. Qnet also carries the uncertainty through the derivatives alone: the measure's variance is about the sum over the inputs of (derivative × standard deviation)². This is the delta method. It is instant, and it is good while the uncertainties are small and no station is near overload. For one M/M/1 queue the mean number is L = ρ/(1 − ρ), which bends upwards more and more as ρ nears 1; a straight line cannot follow it, and it cannot see overload at all. When the two answers differ by more than 10 %, the view says so and by how much. Trust the sampled answer.

When the model allows overload, there is no mean. Near overload the measure grows like 1/(1 − ρ), and the average of 1/(1 − ρ) over any spread of rates that reaches ρ = 1 is infinite: a standard deviation always reaches it, and a range does when its end does. Qnet decides this from the uncertainties themselves, not from the sample. It then shows "no finite mean (the model allows overload)" in place of a mean and a standard deviation, and leads with the median, the 95 % interval and the chance of overload. The shares and the input to measure better then come from the linear approximation, which describes the network close to how it is drawn, and are labelled so. A utilisation never exceeds 1, so it always has a mean.

## NETWORKS WITH NO CLOSED FORMULA

For any other open network Qnet offers the linear approximation alone. Press Estimate: Qnet differentiates the measure in every rate by solving the network again with the rate a little lower and a little higher, using the method Solve would choose, as the Sensitivity view does. The view says how many solver runs this needs before it starts; the status bar shows the work as Sensitivity, and Run ▸ Stop ends it. Changing an uncertainty afterwards needs no new runs.

This route gives an approximate interval and the shares, but not the distribution and not the chance of overload. It is marked Experimental. Sampling is not offered here, because it would take thousands of solver runs. To see how a measure really moves over a wide range of one rate, use a what-if sweep.

A closed network, where a fixed number of customers circulate, is not covered.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf)

Open it and choose Run ▸ Uncertainty…. Both stations run at 70 % utilisation. With every rate uncertain by 10 % the delay's interval is wide and lopsided, a few cases overload, and the view says the delay has no finite mean. Set "All rates ±" to 2 and the two 95 % intervals agree. Then set Read ± as to Range (uniform): no rate can now reach overload, and the mean, the standard deviation and the sampled shares appear.
