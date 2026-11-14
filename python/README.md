# qnet — Qnet from Python

Build a queueing network, solve it and sweep it from a script or a notebook. The package is a
thin layer over Qnet's command-line tool, `qnet-cli`: every number comes from the code the app
runs, and a network saved from Python opens in the app.

- Plain Python, 3.9 or later, standard library only. NumPy, pandas and matplotlib are used when
  they are installed and never required.
- No network access and no telemetry. The package starts `qnet-cli` and reads what it prints;
  it does nothing else.
- Not on PyPI. It ships inside Qnet.app and in this folder of the source.

## Install

The package is in the app at `/Applications/Qnet.app/Contents/Resources/scripting`. Copy it out
and point Python at the copy, or install the copy:

```sh
cp -R "/Applications/Qnet.app/Contents/Resources/scripting" ~/qnet-python
export PYTHONPATH=~/qnet-python        # or: pip install ~/qnet-python
```

Copy first: Python writes bytecode (`__pycache__`) and `pip` writes build files beside what they
load, and the app's own folder must stay exactly as it was signed. To use the package where it is,
tell Python to write nothing there:

```sh
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="/Applications/Qnet.app/Contents/Resources/scripting"
```

As a guard, the package itself sets `sys.dont_write_bytecode` when it is imported from inside an
`.app` bundle and removes the one file Python wrote before it could (`__init__`'s own bytecode);
a copy or an installed package keeps its bytecode as usual.

From a source checkout: `pip install ./python`, or `PYTHONPATH=python`.

**Which Python.** Use your own Python 3.9 or later (python.org, Homebrew, conda, a virtual
environment). Do not run scripts with the Python inside the app
(`Qnet.app/Contents/Resources/python/bin/python3`): that one is Qnet's own, there so that Qnet's
Python solvers run on a Mac with no Python installed. By design it ignores `PYTHONPATH` and every
other `PYTHON…` variable and the user's site-packages (its launcher unsets them and starts the
interpreter with `-E -s -B`), and it carries only NumPy, so a script started with it does not
find a package through `PYTHONPATH`, this one included, and has no pandas or matplotlib.

What this package starts is `qnet-cli`, not that Python: with Qnet in Applications,
`/Applications/Qnet.app/Contents/MacOS/qnet-cli` is the file it looks for.

`qnet-cli` is looked for in this order: `qnet.set_cli(path)`; the environment variable
`QNET_CLI`; the Qnet.app the package sits in; `/Applications/Qnet.app`; `~/Applications/Qnet.app`;
`PATH`. `qnet.find_cli()` says which one will be used.

## Five minutes

### 1. Build a tandem line

```python
import qnet

net = qnet.Network.tandem(stations=2, arrival_rate=0.8, service_rates=[1.0, 1.6])
print(net)
# <qnet.Network 'tandem': 1 source, 2 buffers, 2 stations, 1 sink, 5 links; infinite buffers>
```

A network has the app's four kinds of node: a source creates jobs, a buffer holds them, a
station serves them, a sink removes them. A station takes its jobs from the buffer in front of
it. The builder above is short for:

```python
net = qnet.Network()
net.add_source("Src1", rate=0.8)            # Poisson arrivals
net.add_buffer("B1")
net.add_station("S1", rate=1.0)             # exponential service, one server
net.add_buffer("B2")
net.add_station("S2", rate=1.6)
net.add_sink("Sink")
net.link("Src1", "B1").link("B1", "S1").link("S1", "B2").link("B2", "S2").link("S2", "Sink")
```

Other laws and several servers: `net.add_station("M", distribution="erlang", k=3, rate=2.0, servers=2)`.
Branching: `net.link("S1", "B2", probability=0.3)`. Finite buffers: `qnet.Network(buffers="finite")`
and `net.add_buffer("B1", size=10)`. A closed network: `qnet.Network.closed_cycle(population=8, service_rates=[1.0, 2.0])`.

### 2. Solve it

```python
result = net.solve()
print(result)
```

```
Solve · Exact Open Product Form · tier: exact
station  metric                 value  unit              tier
-------  ---------------------  -----  ----------------  -----
S1       Mean number in system      4  customers         exact
S1       Throughput               0.8  customers / time  exact
S1       Server utilization       0.8  ratio             exact
S1       Stability margin         0.2  ratio             exact
S2       Mean number in system      1  customers         exact
…
```

`solve()` runs the method the app's Solve button would: an exact method if one applies,
otherwise a simulation, otherwise the best-ranked approximation. `net.methods()` lists every
method with whether it applies and why; `net.solve("qna")` runs one by its label.

Every result carries its **tier** — exact, simulation, approximation, diffusion or bound, the
app's own words for how far a number can be trusted — and every value its **unit** and, where
the method gives one, its **interval**:

```python
result.value("Mean number in system", "S1")   # 4.0
result.tier                                   # 'exact'
result.table()                                # a list of dicts
result.to_pandas()                            # a DataFrame, when pandas is installed
result.raw                                    # the whole JSON document qnet-cli printed
```

### 3. Sweep ρ

With service rate 1 at both stations the arrival rate *is* the utilisation ρ:

```python
net = qnet.Network.tandem(stations=2, arrival_rate=0.5, service_rates=1.0)
rhos = [0.1, 0.3, 0.5, 0.7, 0.9, 0.95]
sweep = net.sweep("Src1.rate", rhos, method="live")
rho, delay = sweep.series("Mean sojourn time", "Network")
```

`method="live"` is the exact closed form Qnet shows as you draw (an open Jackson network, or a
closed network with exponential service), computed at once. Leave `method` out and each point is
run by the solver Solve chooses at the first point. `net.parameters()` lists what can be swept:
`"Src1.rate"`, `"S1.rate"`, `"S1.servers"`, `"B1.size"`, `"S1->B2.probability"`, `"population"`.
A point that cannot be solved (ρ ≥ 1, say) is left as a gap, with the reason in `sweep.errors`.

### 4. Plot it

```python
import matplotlib.pyplot as plt

plt.plot(rho, delay, marker="o")
plt.xlabel("utilisation ρ")
plt.ylabel("mean time in the network")
plt.title(f"Two-station tandem · {sweep.tier}")
plt.show()
```

### 5. Keep it

```python
net.save("tandem.bnet")                 # opens in the app
again = qnet.Network.open("tandem.bnet")
again.set("S1.servers", 2).save("tandem-2.bnet")
```

A file may hold **scenarios**, the app's named variants of one network. The file's network is
the variant it was saved showing, so say which one you mean:

```python
net = qnet.Network.open("plant.bnet", scenario="baseline")   # the network's own values
peak = qnet.Network.open("plant.bnet", scenario="Peak hour")
net.scenarios        # ['Peak hour', 'Add a server at S2']
peak.scenario        # 'Peak hour'  (None for the baseline)
```

Without `scenario=` the file is read as saved, and a `UserWarning` says so when that is a
scenario rather than the baseline. `save` keeps the file's scenarios: a value changed in Python
is recorded as the shown scenario's (or the baseline's), as an edit in the app is. After a node
or link was added or removed the scenarios no longer fit, and `save` raises `QnetError` rather
than lose them; `save(path, scenarios="drop")` writes the network alone.

## The other analyses

All computed in process by Qnet's core, for open Jackson networks unless said otherwise. One
that does not cover the network raises `qnet.NotApplicable` with the reason in a sentence.

```python
net.live()                                         # the exact closed form (also closed networks)
net.sensitivity(measure="sojourn", target_change=-0.1)   # derivatives, elasticities, what it would take
net.capacity(sojourn=3.0)                          # the cheapest servers that meet a target
net.capacity(sojourn=3.0, decision="rates")        # … or service rates (square-root rule)
net.uncertainty({"Src1.rate": 0.1, "S1.rate": (0.9, 1.1)})   # 10 % s.d.; a 95 % interval
net.transient(horizon=50, initial="empty", surge={"factor": 1.5, "from": 10, "until": 20})
net.describe()                                     # the station model, warnings, the closed form if any
```

## Priorities, batches and rates that change in time

New in 2.1. Each is an argument of the node it belongs to, and each has an exact method where
one exists; every older method refuses such a network with a sentence rather than answer for a
different one.

```python
# Priority service: class 0 (the first source) before class 1, interrupting it.
desk = qnet.Network(name="desk")
desk.add_source("Src1", rate=0.3)
desk.add_source("Src2", rate=0.2)
desk.add_buffer("B1")
desk.add_station("S1", by_class={0: {"rate": 1.0}, 1: {"distribution": "erlang", "k": 2, "rate": 1.0}},
                 discipline="priorityPreemptiveResume", priority_order=[0, 1])
desk.add_sink("Sink1")
desk.link("Src1", "B1", customer_class=0).link("Src2", "B1", customer_class=1).link("B1", "S1")
desk.link("S1", "Sink1", customer_class=0).link("S1", "Sink1", customer_class=1)
desk.solve().label                        # 'priority_exact': exact, one station fed by Poisson sources
desk.solve(method="sim_inproc")           # the simulator's second opinion, with intervals

# Batch arrivals: 0.24 batches per time unit, geometric with mean 2.5 customers.
batches = qnet.Network()
batches.link(batches.add_source(rate=0.24, batch=("geometric", 2.5)), batches.add_buffer())
batches.link("B1", batches.add_station(rate=1.0)).link("S1", batches.add_sink())
batches.solve().value("Mean number in system", "S1")     # 3.75, by 'batch_exact'
# batch=2 is always two; batch=[0.5, 0.3, 0.2] gives the probabilities of 1, 2 and 3.

# A daily rate profile: the rate is 0.3, 1.5 then 0.8 times the source's, and repeats.
rush = qnet.Network()
rush.link(rush.add_source(rate=1.0, rate_profile=[(6, 0.3), (10, 1.5), (24, 0.8)], periodic=True), rush.add_buffer())
rush.link("B1", rush.add_station(rate=0.8, servers=2)).link("S1", rush.add_sink())
t = rush.transient(horizon=48)            # no steady state to solve for: the means over time
t.exact["S1"], t.psa["S1"]                # exact, and the pointwise stationary approximation beside it
```

`priority_exact` and `batch_exact` cover one station fed directly by Poisson sources
(`batch_exact`: one server); for anything larger with these features `sim_inproc` is the
method. `net.describe()["features"]` says which features a network uses, and
`["featureProblems"]` what is wrong with their settings.

## When something goes wrong

Everything Qnet refuses arrives as a `qnet.QnetError` whose message is Qnet's own sentence:

```python
try:
    qnet.Network.single(0.8, 1.0, buffer_size=5).sensitivity()
except qnet.NotApplicable as e:
    print(e)          # why there is no closed form for this network
    print(e.reason)   # 'notJackson'
```

`qnet.RunFailed` is a method that was refused, failed or was stopped (its `document` holds what
`qnet-cli` printed); `qnet.CliNotFound` says where the tool was looked for and what to do.

## Examples and tests

`examples/` has three scripts and a notebook-style file (`# %%` cells, which VS Code, PyCharm,
Spyder and Jupytext open as a notebook). The tests run against a built `qnet-cli`:

```sh
cargo build -p qnet-cli
python3 -m unittest discover -s python/tests -t python
```

The JSON documents behind every call are described in `CLI.md` (in the app, beside this file; in the
source, `docs/CLI.md`).
