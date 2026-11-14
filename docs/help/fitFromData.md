# FITTING A DISTRIBUTION FROM DATA

A model is only as good as the service and arrival times you give it. If you have measured them, Qnet can turn the measurements into the distribution a source or a station uses, and show you how well it fits.

## OPENING THE PANEL

Select a source or a station. In the Inspector pane, or in the parameter sheet (Edit ▸ Edit Parameters…), press Fit from Data… under the distribution's fields. For a station that serves several customer classes, the button fits the class in hand.

## GIVING IT THE DATA

- Paste the numbers: one per line, or separated by commas, tabs, semicolons or spaces. A table copied from a spreadsheet works.
- Choose File… reads a CSV or plain-text file. You can also drop a file on the box.
- If the data have several columns, choose the column that holds the times. A heading in the first row is recognised.
- Use Example Data fills in 60 made-up service times, to try the panel.

Event times. If the numbers are clock times at which things happened (arrivals at a counter, say) rather than durations, tick "These are event times". Qnet sorts them and fits the gaps between them: 41 times give 40 gaps.

Decimal commas. "1,5" is read as one and a half only where nothing else can be meant, for example when semicolons separate the cells. Where it cannot be told, Qnet reads commas as separators and says so; tick "Commas are decimal marks" to change that.

What is left out or refused:

- Cells that are not numbers are left out, and the panel lists them.
- A negative value stops the fit: a time cannot be negative.
- Zeros can be left out with one tick. Most families cannot produce an exact zero.
- Fewer than 10 values are refused. Fewer than 30 are fitted with a warning, because the variability is then very uncertain.

Units. Qnet has no time units of its own. Every time is in the unit of your data and every rate is per that unit. Use one unit for the whole network.

## THE SAMPLE

The panel shows the number of observations, the mean, the standard deviation, the smallest and largest value, the median and the quartiles, and the SCV.

The SCV is the squared coefficient of variation: the variance divided by the square of the mean. It is 0 for a constant time, 1 for an exponential one and larger for burstier data.

The mean and the SCV each carry a 95 % interval. Up to 5,000 observations it is a bootstrap interval (2,000 resamples; the same data always give the same interval). Above that it is the large-sample approximation. Read the SCV's interval before trusting a family: with a small sample it is wide.

## THE CANDIDATES

Qnet fits every family a network can hold: exponential (a Poisson process, for a source), Erlang, gamma, Weibull, lognormal, uniform, Pareto and deterministic. A family that cannot describe the data is listed last with the reason. Examples: Erlang when the SCV is above 1, Pareto when the fitted shape is 2 or less, deterministic when the values differ.

Fit by offers two ways to choose the parameters.

- Maximum likelihood finds the parameters under which the data are most probable. It uses the whole shape of the data. Prefer it for simulation and for the Markov-chain methods, which use the whole distribution.
- Mean and SCV makes the distribution's mean and SCV equal the sample's. QNA, RQNA, the diffusion (SRBM) methods and the bounds read only those two numbers from a distribution, so this gives them exactly what the data say. A family with a fixed SCV (exponential, deterministic) matches the mean only, and Erlang takes the nearest SCV of the form 1/k; the table says so.

The table ranks the candidates, best first, and shows for each:

- the fitted parameters, and the mean and SCV they give;
- AIC, which is 2 × the number of parameters − 2 × the log-likelihood. Lower is better. A difference under 2 is not worth acting on;
- the KS distance, the largest gap between the data's distribution function and the fitted one. Smaller is better;
- the KS p-value. It is approximate, and optimistic because the parameters were fitted to these same data. A small value is strong evidence against a family; a large one is not proof of it.

Qnet recommends one family and gives the reason in a sentence. It takes the lowest AIC, but prefers the exponential when the data cannot tell it from the best fit, because exponential times keep the exact product-form methods available. It prefers Erlang to a gamma that fits no better.

## THE TWO CHARTS

- Histogram and fitted density: the data as bars, the chosen family as a line. Two other families are dashed for comparison.
- Distribution function: the fraction of observations at or below each time, as steps, against the fitted curve. The largest vertical gap is the KS distance.

Point at a bar or a step, or move with the arrow keys, to read the numbers.

## USING THE RESULT

Choose a row and press Use This Distribution. Qnet sets the family and its parameters on the source or station. In the Inspector pane this is one undo step; in the parameter sheet it takes effect when you save.

## TRY IT

[Example network: two stations in tandem (2dtandem)](qnet-example:2dtandem)

Open it, select station S1, press Fit from Data… and then Use Example Data. The data's SCV is about 0.31, so an exponential service time would be far too variable for them. Use the recommended Erlang, then press Solve and see how the queue at S1 changes.
