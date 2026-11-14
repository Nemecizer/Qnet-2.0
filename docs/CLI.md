# `qnet-cli`: Qnet without a window

`qnet-cli` is in the app at `Qnet.app/Contents/MacOS/qnet-cli` (from source:
`cargo build -p qnet-cli`). It calls the same core the app does. This file describes its
**machine interface**, new in 2.1: the subcommands that print one JSON document, which the Python
package `qnet` (`python/`, in the app at `Contents/Resources/scripting`) is written over.
`qnet-cli` with no arguments prints every command, including the text reports and exporters that
2.0 already had (`dump-rho`, `analyze`, `primitives`, `resave`, `export`, `export-all`,
`gen-random`, `run`); those are unchanged.

The code is `cli/src/api.rs` (the documents), `cli/src/methods.rs` (the Method Chooser's rules)
and `core/src/build.rs` (the description format). The tests are `cli/tests/cli_json.rs`, which
compare each document's numbers with the core functions called directly.

## Conventions

- **stdout** is one JSON document and nothing else. **stderr** is for people: a sentence when
  something is refused; for `run` and `solve`, the Status lines (`<severity>\t<text>`) and the
  tool's own notes (`qnet-cli: …`).
- **Exit status**: 0 when the command answered; 1 when it refused (a file it cannot read,
  options that make no sense, a run that was refused or failed — a solver's own status is passed
  through); 2 for a usage error; 130 for a run that was stopped.
- An analysis that does not cover the network **answers**: `"available": false`, a `reason`
  code and a `sentence`, exit 0. That is a result, not an error.
- Every document starts with the **envelope**:

  | key | |
  |---|---|
  | `schema` | `1`. Raised when a key is removed or renamed, or a unit or a meaning changes. Keys may be added without raising it: ignore keys you do not know. |
  | `command` | the subcommand (`"run"` for `solve` too) |
  | `qnetVersion` | the tool's version |
  | `fingerprint` | the lowercase-hex SHA-256 the app gives the network (nodes, links, positions, buffer regime, population). The same in every document about the same file, and in the app's run records. |
  | `network` | `title` (the file name), `buffers` (`"infinite"` or `"finite"`), `population` (a closed network's, else null) |

  | `scenario` | only for a file that holds scenarios (see below): `active` (the scenario the file was saved showing, or null for the baseline), `names` (every scenario's name, in the file's order) and `shown` (the scenario whose values this document's numbers are, or null for the baseline) |

- **Scenarios.** A `.bnet` file may hold scenarios: named variants of the network with other
  parameter values (Scenarios in the app). The file's network is the variant it was **saved
  showing**, which need not be the baseline. So:
  - `--scenario <name>` with any command that reads a file (`describe`, `methods`, `run`,
    `solve`, the analyses, and `dump-rho`, `analyze`, `primitives`, `export`, `export-all`) reads
    that scenario; `--scenario baseline` reads the network's own values. A scenario is named by
    its name or its id. A name the file does not have is refused (exit 1) with the names it has.
  - Without `--scenario` the file is read as saved. When that is a scenario, every JSON document
    carries, first in `warnings`, the sentence “This file was saved showing the scenario “Peak
    hour”; these numbers are that scenario's.” (a document with no `warnings` of its own gets
    the list for it), and the text commands print it on stderr as `qnet-cli: …`.
  - `resave <file> [out]` writes the file with its scenarios, as the app saves it; with
    `--scenario` it is saved showing that variant, the others kept beside it.
  - `build` from a description with `basedOn` keeps that file's scenarios: a changed value
    becomes the shown scenario's override (or the baseline's own value when the baseline was
    read; `"basedOnScenario"` says which variant the description was read as), exactly as an
    edit in the app does. When the nodes, links or buffer regime differ from the file's, the
    scenarios cannot be kept and `build` refuses (exit 1) rather than drop them; `"scenarios":
    "drop"` in the description writes the network alone.
  The rules are the app's (`src/scenarios/model.ts`), mirrored in `core/src/scenarios.rs` and
  held to the same fixture files by tests on both sides.
- **Numbers** are JSON numbers in full double precision. Where there is no number to give (not
  defined, not finite) the value is `null`; JSON has no NaN.
- **Units** are named in each document: `customers`, `time` (the model's own time unit: the one
  the rates are per), `customers / time`, `ratio`, `probability`.
- **Tier** says how far a number can be trusted, in the app's words: `exact`, `simulation`,
  `approximation`, `diffusion`, `bound` (and `mixed` for a comparison record). Live results add
  `utilisation` and `none`.
- **Nodes** are named in options by name, or by id where two nodes share a name.
- **Options** are the last argument: a JSON object, `@file` to read one from a file, or `-` to
  read it from standard input. Left out, they are `{}`.

## `build <description.json|-> [out.bnet]`

Builds a network from a description and writes it as the app saves it. Without `out.bnet` the
file's text goes to stdout; with it, the document is the envelope plus `"wrote"`.

```json
{ "schema": 1, "buffers": "infinite", "population": null,
  "nodes": [ { "kind": "source",  "name": "Src1", "distribution": "poisson", "parameters": { "lambda": 0.8 } },
             { "kind": "buffer",  "name": "B1", "size": 10 },
             { "kind": "station", "name": "S1", "distribution": "exponential", "parameters": { "rate": 1 }, "servers": 1 },
             { "kind": "sink",    "name": "Out" } ],
  "links": [ { "from": "Src1", "to": "B1" }, { "from": "B1", "to": "S1" }, { "from": "S1", "to": "Out", "probability": 1 } ] }
```

| key | |
|---|---|
| `buffers` | `"infinite"` (the default) or `"finite"`, for the whole network |
| `population` | a closed network's number of customers (no source, no sink), else null |
| `nodes[].kind`, `name` | required. Kinds: `source`, `buffer`, `station`, `sink`. Names must differ. |
| `nodes[].distribution` | `exponential` (`rate`), `poisson` (`lambda`; sources only), `gamma` (`shape`, `scale`), `uniform` (`min`, `max`), `constant` (`value`), `weibull` (`shape`, `scale`), `erlang` (`k`, `rate`), `lognormal` (`mu`, `sigma`), `pareto` (`shape`, `scale`). Default: `poisson` for a source, else `exponential`. |
| `nodes[].parameters` | the law's parameters by name; those left out take the app's defaults |
| `nodes[].servers` | a station's number of servers (1) |
| `nodes[].size` | a buffer's waiting places (1); matters only with finite buffers |
| `nodes[].serviceByClass` | `{"1": {"distribution": …, "parameters": …}}`: a station's law for one class (0 is the first) |
| `nodes[].serviceDiscipline`, `priorityOrder` | a station's order of service (new in 2.1): `"priorityNonPreemptive"` or `"priorityPreemptiveResume"` (left out, or `"fcfs"`: first come, first served), with the class indices from the highest priority down, e.g. `[1, 0]`. Every class served at the station needs a place in the order. |
| `nodes[].batchSize` | a source's batch-size law (new in 2.1); the inter-arrival law then applies to batches: `{"kind": "constant", "size": 2}`, `{"kind": "geometric", "mean": 2.5}` (P(X = n) = (1 − α)αⁿ⁻¹ with mean 1/(1 − α)), or `{"kind": "pmf", "probabilities": [0.5, 0.3, 0.2]}` for the sizes 1, 2, 3 (they must sum to 1) |
| `nodes[].rateProfile` | a Poisson source's rate over time (new in 2.1): `{"periodic": true, "segments": [{"until": 8, "multiplier": 0.5}, {"until": 24, "multiplier": 1.5}]}`. From time 0 the source's rate is multiplied by each segment's multiplier until its time; a periodic profile then starts again (its period is the last `until`), another returns to the source's own rate. |
| `nodes[].picture` | a station's picture, by the file format's name |
| `links[].from`, `to` | required: node names (or ids) |
| `links[].probability` | 1 by default |
| `links[].class`, `toClass` | the class the link carries (0), and the class the job leaves as, when the link changes it |
| `id`, `position`, `parameterText`, `canvasScale`, `basedOn` | what `describe` adds so that a described file builds back byte for byte: ids, canvas positions, the file's own parameter text (used while it still says what `parameters` says), and with `basedOn` the path of the file the description was read from (its canvas scale is kept). A description written by hand leaves them out. A built file holds the network as described and no scenarios: a file's scenarios are not carried through `describe` and `build`. |

The three keys new in 2.1 are the `.bnet` file's own, in its own shapes, and are written only
for a node that uses the feature. `build` refuses one on the wrong kind of node, and a batch law
or profile that is not valid, with the sentence the app's Problems list shows ("The batch-size
probabilities sum to 0.7, not 1.").

Ids are derived from the names and positions are laid out in columns from the sources, so the
same description always builds the same file, with the same fingerprint.

## `describe <file.bnet>`

| key | |
|---|---|
| `spec` | the description above, complete: `build` gives the same file back |
| `counts` | `sources`, `buffers`, `stations`, `sinks`, `links` |
| `drawnAs` | `"open"`, `"closed"`, or `"closedNoPopulation"` |
| `parameters` | what `sensitivity` and `uncertainty` can be asked about: `{id, kind, node, nodeId}` |
| `stations` | in export order: `id`, `name`, `servers`, `throughput` (α from the traffic equations), `serviceRate` (per server), `capacity`, `utilisation` (ρ = α / capacity), `throughputByClass` |
| `classes`, `externalArrivals`, `routing`, `routingCycles` | the number of classes, each class's external arrival rate, the station-to-station routing matrix, whether it has cycles |
| `warnings` | the app's warning list for the network |
| `closedForm` | the tractability assessment: `kind`, `exact`, `title`, `detail`, `means`, `meansLabel`; null for a network that uses a feature below, since those closed forms are for first-come-first-served stations and plain sources |
| `features` | the model features new in 2.1 that the network uses: `[{"feature": "priorities" \| "batchArrivals" \| "timeVaryingRates", "nodes": [names]}]`; empty for any other network. With batch arrivals or a periodic rate profile, `stations` is at the sources' long-run customer rates (batch rate × mean batch size × the profile's time average). |
| `featureProblems` | sentences for settings of those features that cannot be modelled as written (a priority order missing a class, probabilities that do not sum to 1, a segment with no length, a profile on a source that is not Poisson) |
| `srbm` | the diffusion model's existence verdict: `existence`, `statement`, `recurrence`, `recurrenceStatement`; null for a network that uses a feature above, as `closedForm` is |
| `modelError` | the sentence saying why there is no station model (then `stations` is empty), else null |
| `units` | of the station quantities |

For a network that uses one of those features `analyze`, `primitives` and `dump-rho` print the sentence that says so and the station model at the long-run customer rates, in place of the diffusion and closed-form report; `export` and `export-all` refuse with that sentence (exit 1), because every solver input describes first-come-first-served stations and plain sources.

## `methods <file.bnet> [--assume-installed]`

The app's Method Chooser for the network. `--assume-installed` answers for the network alone, as
if every solver were installed; without it, a method whose solver is missing here is
unavailable and says so.

| key | |
|---|---|
| `methods[]` | best first: `id` (the Chooser's), `name`, `label` (what `run` takes; null for the analytical row, which has no run), `identifier` (the record's method id), `tier`, `fidelity`, `kind` (`exact`, `simulation` or `approximation`: the pass of Solve's walk), `layer`, `suitability` (`recommended`, `applicable`, `caution`, `experimental`, `unavailable`), `applicable`, `reason` (what the method does here, or why it cannot be used) |
| `solve` | the method Solve would run — the first exact one that applies, else the first simulation, else the best-ranked approximation: `label`, `name`, `why`, `reason`; null when none can run |
| `domain` | the facts the rows are decided from (class count, warnings, feedback, Markov tests, the exporters' refusals) |

For a network with priorities, batch arrivals or a rate profile (new in 2.1), `domain.extended`
holds `features`, `others` (the one sentence every method that does not model the feature
refuses with) and `exact` (`id`, `name`, `ready`, `refusal`). The rows are then: Exact Priority
Queue (`priority-exact`, label `priority_exact`) or Exact Batch-Arrival Queue (`batch-exact`,
label `batch_exact`) where the network is one station fed directly by Poisson sources;
Replicated Simulation (`sim_inproc`), which models priorities and batches and refuses a rate
profile because such a network has no single steady state; and every other method unavailable
with the `others` sentence. With a rate profile `solve` is null: use `transient`.

## `run <method> <file.bnet> --json` and `solve <file.bnet> --json`

Runs a method's solver as the app's Run menu does. `solve` picks the method `methods` names
under `solve`. `--set key=value` changes a run setting by its stored key (`sim.replications`,
`sm.degree`, …); `--store results.json` also files the record in a results store. Without
`--json` the solver's text is printed, as in 2.0.

Four methods are computed inside `qnet-cli` and need no solver: `closed_pf`, `sim_inproc`, and,
new with the model features of 2.1, `priority_exact` (one station with priority service fed by
Poisson sources: Cobham's formula and the preemptive-resume formula for one server with any
service law; several servers with exponential service at one rate) and `batch_exact` (one
single-server station with batch Poisson arrivals, M^X/G/1). Both are tier `exact` and give the
station's throughput, mean number, mean queue, utilisation, waiting and sojourn time;
`priority_exact` prints each class's own in its text (`QNET_CLASS_V1` rows). Each refuses any
other network with a sentence in `statusLines`, as every older method refuses a network that
uses a feature it does not model.

| key | |
|---|---|
| `method` | `label`, `identifier`, `name`, `shortName`, `tier`, `fidelity`, `implementation` |
| `status` | `completed`, `partial`, `failed`, `cancelled`, or `refused` (the method does not apply, or its solver is missing) |
| `exitCode`, `elapsedSeconds`, `seed`, `parameters` | the run's exit status, wall time, base seed (as a number; null when the method has none) and the parameters the record files |
| `values[]` | `station`, `stationId`, `class` (null: all classes), `metric`, `value`, `unit`, `standardError`, `interval` (`low`, `high`, `level`; null when the method gives none), `sampleSize`, `note` |
| `warnings` | the record's warnings |

Paths in `parameters` (a record's `runtime` is the solver's path), `failure`, `warnings`, notes and `statusLines` do not spell out this Mac's folders: the home folder is written `~`, the temporary folder `$TMPDIR`, and the app's bundle `<Qnet.app>`, as in the app's failure reports.
| `failure` | why a run that is not `completed` ended as it did |
| `statusLines` | the Status log's lines: `severity`, `text` |

`interval` is the record's stated bounds, or the estimate ± z standard errors at the stated
level, for the levels 90 %, 95 % (also when none is stated) and 99 % (z = 1.645, 1.96, 2.576);
a standard error stated with any other level gives `null`, since ±1.96 standard errors would be
a 95 % interval under another label (`standardError` is still given): the rule the app's
Agreement view reads records with. The metric names and units are the solvers' own
("Mean number in system", "Utilization", …) and differ between methods.

## `live <file.bnet>`

The closed form the app shows as you draw: an open Jackson network (traffic equations, M/M/c at
each station) or a closed network with exponential service (convolution, MVA).

| key | |
|---|---|
| `tier` | `exact`; `utilisation` when only ρ is known; `none` |
| `reason`, `reasonDetail` | why it stops short: `finiteBuffers`, `notExponential`, `sharedStation`, `unstable`, `noTraffic`, `notCertified`, `noModel`, `closed`, `closedNoPopulation` |
| `utilisationExact` | false with finite buffers, where ρ is the offered load before blocking |
| `stations[]` | `id`, `name`, `servers`, `throughput`, `serviceRate`, `utilisation`, `meanInSystem`, `meanWaiting` (number waiting), `meanSojourn`, `meanWait` (time before service); null where not known |
| `totals` | `throughput`, `meanNumber`, `meanDelay` (a closed network: the cycle time N/X); null unless exact |
| `bottlenecks` | the most loaded station(s), by name |
| `closed` | for a closed network: `population`, `referenceStation` |
| `method`, `units` | |

## `sensitivity <file.bnet> [options]`

Open Jackson networks: derivatives by closed formula.

Options: `measure` — `"networkSojourn"` (the default), `"networkNumber"`, or
`{"kind": "stationNumber" | "stationQueue" | "stationSojourn" | "stationUtilisation" | "stationThroughput", "station": "S1"}`;
`parameters` — a list of `{"kind": "load"}`, `{"kind": "arrival", "node": "Src1"}`,
`{"kind": "service", "node": "S1", "class": 0}`, `{"kind": "servers", "node": "S1"}`,
`{"kind": "routing", "link": "<id>", "complement": "<id>"}` (two links leaving one node; the
second takes the rest), each optionally with its own `id` (default: every arrival rate, service
rate and server count); `targetChange` — a fraction (−0.1: cut the measure by 10 %).

| key | |
|---|---|
| `available`, `reason`, `sentence` | false with `network`, `unstable`, `notJackson`, `closed` or `closedNoPopulation` when no closed form applies |
| `value`, `unit`, `measure`, `target` | the measure now; the value `targetChange` asks for |
| `parameters[]` | `id`, `kind`, `node`, `current`, `integer`, `derivative` (∂measure/∂parameter), `elasticity`, `oneMore` (a count: the measure with one more), `whatItTakes` (`achieved` with `value` and `measure`, or not with `why`: `noEffect`, `rangeEnds`, `levels`, `overload`, and `limitValue`, `limitMeasure`), `note` (why a parameter has no analysis) |
| `stations`, `bottlenecks` | each station's utilisation; the most loaded, by name |

## `capacity <file.bnet> <options>`

Open Jackson networks: the cheapest servers (marginal allocation, certified by an exact search)
or service rates (Kleinrock's square-root rule) that meet targets.

Options: `constraints` (required) — a list of `{"kind": "networkSojourn" | "networkNumber" | "utilisation", "target": x}`
or `{"kind": "stationWait", "station": "S1", "target": x}`; `decision` — `"servers"` (the
default) or `"rates"`; `stations` — `{"station": "S1", "free": true, "cost": 1, "rateCost": 1, "lower": 1, "upper": null}`
(a station not listed is free, at cost 1).

| key | |
|---|---|
| `feasible`, `infeasible` | when no plan meets the targets: `why` (`badTarget`, `badStation`, `fixedOverloaded`, `limitOverloaded`, `stationLimit`, `floor`, `serviceFloor`, `tooMany`, `ratesTarget`, `severalServers`, `nothingFree`, `fixedTooFull`), `constraint` (its index), `station`, `value` (the least the constraint can reach) |
| `proof` | `marginal` (optimal by theorem), `search` (certified by the exact search), `closedForm`, or `none` (good, not proven best) |
| `search` | `searched`, `nodes`, `limit`, `improved` |
| `costNow`, `cost` | |
| `stations[]` | `name`, `free`, `load` (α/μ), `serversNow`, `servers`, `rateNow`, `rate`, `unitCost`, `costNow`, `cost`, `utilisationNow`, `utilisation` |
| `constraints[]` | `kind`, `station`, `target`, `unit`, `now`, `proposed` |
| `meanDelayNow`, `meanDelay`, `meanNumberNow`, `meanNumber` | the network as drawn and as proposed (solved again by the closed form) |
| `delayFloor`, `totalArrivals` | the delay no number of servers shortens (Σ aᵢ/Λ); Λ |
| `path[]` | servers only: the greedy path — `cost`, `meanNumber`, `meanDelay`, `added`, `feasible` |

## `uncertainty <file.bnet> <options>`

Open Jackson networks: the distribution of one measure when rates are uncertain.

Options: `inputs` (required) — a list of `{"kind": "arrival" | "service", "node": …, "spread": …}`
with `spread` one of `{"kind": "relativeSd", "value": 0.1}`, `{"kind": "relativeRange", "value": 0.1}`,
`{"kind": "interval95", "low": a, "high": b}`, `{"kind": "intervalRange", "low": a, "high": b}`;
`measure` as for `sensitivity`; `samples` (20 000; kept within 1 000 … 200 000); `seed` (2021);
`arrivalsTogether` (all arrival rates vary as one).

| key | |
|---|---|
| `value`, `unit` | the measure at the nominal inputs |
| `inputs[]` | `id`, `law` (`lognormal`, `uniform`, `fixed`), `mean`, `sd`, `low`, `high`, `derivative` |
| `sampling` | tier `simulation` over the inputs, each draw solved exactly: `samples`, `seed`, `unstable`, `probabilityUnstable`, `meanExists`, `mean`, `median`, `q025`, `q975` (each `{value, standardError}`), `sd`, `min`, `max`, `histogram` (`low`, `high`, `counts`, `above`), `shareRows`, `evaluations` |
| `linear` | tier `approximation`, the delta method: `sd`, `low`, `high`, `level` |
| `shares[]` | per uncertain input or group: `inputs`, `linear`, and Sobol' `first` and `total` (`{value, standardError}`; null when the mean does not exist) |
| `disagreement`, `disagreementThreshold` | how far the two routes are apart, and from where it matters |

The seed is fixed: the same options give the same document.

## `transient <file.bnet> [options]`

Open networks with infinite buffers: mean number at each station over time.

Options: `horizon` (default: `suggestedHorizon`), `intervals` (200), `initial` — `"empty"`,
`"steady"` or a list with the number at each station; `surge` — `{"factor": 1.5, "from": 2, "until": 6}`
(arrival rates multiplied meanwhile); `settleFraction` (0.05).

A network whose sources carry a `rateProfile` (new in 2.1) is followed through it: every
breakpoint is a grid point, the exact tier restarts there with the new rates, and no surge can
be added on top. The default horizon then shows the whole profile (two periods of a periodic
one). Priorities and batch arrivals are not modelled here, and `available` is false with the
sentence.

| key | |
|---|---|
| `available` | false when neither tier applies; `exactReason` and `fluidReason` say why |
| `times` | the time grid |
| `stations[]` | `name`, `servers`, `utilisation`, `stationary` (the mean the curve approaches), `relaxation` |
| `exact` | tier `exact`, uniformisation of the Markov chain (open Jackson, small enough): `mean[i][k]` (station i at `times[k]`; a lower bound), `shortfall[i]` (a proven bound on how far below; null where none holds), `uncertified[i]`, `empty[i][k]` (P(station empty)), `distance[k]`, `stationary[i]`, `settling[i]`, `settleFrom`, and the computation's size and error bounds (`levels`, `states`, `uniformisationRate`, `products`, `poissonBound`, `missingMass`, `stationaryTail`) |
| `exactReason` | why there is no exact answer, else null |
| `fluid` | tier `approximation`, the fluid model: `level[i][k]`, `emptied[]` (`station`, `time`) |
| `profile` | the stored rate profiles as the analysis used them: `breaks` (the times inside the horizon at which a rate changes), `periodic`, `rates[j][i]` (the external rate into station i on piece j); null without one |
| `psa` | tier `approximation`, the pointwise stationary approximation, when the rates change in time (a profile or a surge) and the exact tier's model applies: `mean[i][k]`, the steady-state mean of the network with its rates frozen at `times[k]`, null where that network is overloaded. It ignores the time the queue takes to follow the rate; compare it with `exact`. Null otherwise. |
| `horizon`, `suggestedHorizon`, `settleFraction`, `units` | |

With a rate profile `exact.shortfall[i]` is null from the first piece on that overloads the
network of the largest rates so far (no stationary law is left to bound with), and
`exact.settling` is null for a periodic profile, which never settles.

## Kept in step with the app

`methods` and `solve` repeat rules that the app holds in its interface. One fixture,
`cli/tests/fixtures/methods.json`, is checked from three sides — the built tool, the app's own
network analysis, and the interface's Method Chooser and Solve — so a rule changed in one place
fails the others' tests. `QNET_WRITE_FIXTURES=1 cargo test -p qnet-cli --test cli_json` writes
the fixture again after a deliberate change.
