# SCRIPTING WITH PYTHON

Qnet can be driven from a Python script or a notebook: build a network, solve it, sweep a parameter, and keep the numbers in your own tables and plots. The Python package is called qnet. It is a thin layer over Qnet's command-line tool, qnet-cli, so every number comes from the same code the app runs, and a network saved from Python opens in the app.

The package is plain Python (3.9 or later) and needs nothing beyond Python itself. NumPy, pandas and matplotlib are used when you have them. It contacts nothing: no network access, no telemetry. It is not published on any package index; it ships inside the app.

## WHERE IT IS

Both parts are inside Qnet.app:

- the package, in Qnet.app/Contents/Resources/scripting
- the command-line tool, at Qnet.app/Contents/MacOS/qnet-cli

The simplest way to use the package is to copy it out of the app and point Python at the copy:

```
cp -R "/Applications/Qnet.app/Contents/Resources/scripting" ~/qnet-python
export PYTHONPATH=~/qnet-python
```

Or install the copy into a Python environment:

```
pip install ~/qnet-python
```

Copy first in both cases. Python and pip write files beside what they load, and the app's own folder must stay exactly as it was signed, or macOS may refuse to open Qnet.

The package can also be used where it is, without a copy, as long as Python is told to write nothing there:

```
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="/Applications/Qnet.app/Contents/Resources/scripting"
```

The package guards against a forgotten first line: imported from inside an app, it turns Python's bytecode files off for the rest of that session and removes the one file Python had already written.

## WHICH PYTHON

Use your own Python, 3.9 or later: the one from python.org, Homebrew, conda or a virtual environment.

Do not run your scripts with the Python inside Qnet.app (Qnet.app/Contents/Resources/python/bin/python3). That Python is Qnet's own: it is there so that Qnet's solvers run on a Mac with no Python installed. By design it ignores PYTHONPATH and the other PYTHON… settings, does not see the packages you have installed for yourself, and has only NumPy added. A script started with it does not find a package through PYTHONPATH, including a copy of qnet made as above, and there is no pandas or matplotlib.

The tool the package starts is qnet-cli, not that Python. With Qnet installed in Applications it is /Applications/Qnet.app/Contents/MacOS/qnet-cli, and that is the file the package looks for.

The package looks for qnet-cli in this order: the path given to qnet.set_cli(…); the environment variable QNET_CLI; the Qnet.app the package sits in; /Applications/Qnet.app; ~/Applications/Qnet.app; then PATH. qnet.find_cli() says which one it will use. If none is found, the error says where it looked and what to do.

## A FIRST SCRIPT

```
import qnet

net = qnet.Network.tandem(stations=2, arrival_rate=0.8, service_rates=[1.0, 1.6])
result = net.solve()
print(result)
print(result.value("Mean number in system", "S1"), result.tier)
net.save("tandem.bnet")
```

solve() runs the method Run ▸ Solve would choose: an exact method if one applies, otherwise a simulation, otherwise the best-ranked approximation. net.methods() lists every method with whether it applies and why, as Run ▸ Choose a Method… does; net.solve("qna") runs one by its label.

Printing a result shows a table. Every result carries its tier (exact, simulation, approximation, diffusion or bound: the words of the Agreement view), and every value its unit and, where the method gives one, its interval. result.table() gives the rows as plain dictionaries; result.to_pandas() gives a DataFrame when pandas is installed; result.raw is the whole document the tool printed.

## BUILDING A NETWORK

A network in Python has the four kinds of node you draw in the app. A source creates jobs, a buffer holds them, a station serves them, a sink removes them. A station takes its jobs from the buffer in front of it.

```
net = qnet.Network()
net.add_source("Src1", rate=0.8)
net.add_buffer("B1")
net.add_station("S1", rate=1.0, servers=2)
net.add_sink("Out")
net.link("Src1", "B1").link("B1", "S1").link("S1", "Out")
```

- Another service or inter-arrival law: add_station("M", distribution="erlang", k=3, rate=2.0). The laws and their parameters are the Inspector's.
- Branching: link("S1", "B2", probability=0.3).
- Finite buffers: qnet.Network(buffers="finite") and add_buffer("B1", size=10).
- A closed network: qnet.Network.closed_cycle(population=8, service_rates=[1.0, 2.0]).
- An existing file: qnet.Network.open("my.bnet"), then set("S1.servers", 3) and save(…).
- A file with scenarios: qnet.Network.open("my.bnet", scenario="Peak hour"), or scenario="baseline" for the network's own values. net.scenarios lists the names.

A file with scenarios holds the network as it was last shown, which may be a scenario and not the baseline. Opened without scenario=…, the file is read that way, and Python warns when the values are a scenario's. save(…) keeps the file's scenarios: a value changed in Python becomes the shown scenario's, as an edit in the app does. After a node or link is added or removed the scenarios no longer fit, and save refuses rather than lose them; save(path, scenarios="drop") writes the network alone.

Nodes are placed in columns from the sources, so a network built in Python looks tidy when the app opens it. The same description always builds the same file.

## SWEEPING A PARAMETER

```
rhos = [0.1, 0.3, 0.5, 0.7, 0.9]
sweep = net.sweep("Src1.rate", rhos, method="live")
x, y = sweep.series("Mean sojourn time", "Network")
```

net.parameters() lists what can be swept: a source's rate, a station's rate or number of servers, a buffer's size, a link's probability, a closed network's population. method="live" uses the closed form Qnet shows as you draw, which is immediate; without it, every point is run by the method Solve chooses at the first point. A point that cannot be solved is left as a gap, and sweep.errors says why.

With matplotlib installed, plt.plot(x, y) draws the curve.

## THE OTHER ANALYSES

Each of these is computed by Qnet itself, as in the app, for the networks that analysis covers there:

- net.live(): the exact closed form of an open Jackson network or a closed network.
- net.sensitivity(…): derivatives, elasticities, and what each parameter would have to be to reach a target.
- net.capacity(sojourn=3.0): the cheapest numbers of servers, or service rates, that meet a target.
- net.uncertainty({"Src1.rate": 0.1}): the answer's range when a rate is known only roughly. The seed is fixed, so the same call gives the same numbers.
- net.transient(…): the mean number at each station over time.

An analysis that does not cover the network raises an error whose message is Qnet's own sentence saying why.

## WITHOUT PYTHON

qnet-cli can be used on its own from a shell or from any language. Its commands build, describe, methods, solve, run, live, sensitivity, capacity, uncertainty and transient each print one JSON document that starts with a schema number, the Qnet version and the network's fingerprint. Run qnet-cli with no arguments for the list. The documents are described in CLI.md, in the scripting folder beside the package. The README there has a five-minute tutorial, and the examples folder has scripts to run.
