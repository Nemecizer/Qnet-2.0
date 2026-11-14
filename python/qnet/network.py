"""`Network`: a queueing network as Qnet models it, built in Python and solved by `qnet-cli`.

A network is drawn from four kinds of node, the same four as in the app: a **source** creates
jobs, a **buffer** holds them, a **station** serves them, a **sink** removes them. Links route
jobs between nodes with a probability. A station takes its jobs from the buffer in front of it,
so the usual chain is source → buffer → station → (buffer → station →)… sink.

This class only assembles a description (a plain dict, `Network.spec`). `qnet-cli build` turns
it into a `.bnet` file — the app's own writer, so the file opens in the app — and every analysis
is a `qnet-cli` subcommand run on that file.
"""

import copy
import json
import os
import shutil
import tempfile
import warnings
import weakref
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import _cli
from ._cli import NotApplicable, QnetError, RunFailed
from .results import CapacityResult, LiveResult, SensitivityResult, SolveResult, SweepResult, TransientResult, UncertaintyResult

#: The parameter names of each distribution (the app's own: core/src/model.rs).
DISTRIBUTIONS = {
    "exponential": ("rate",),
    "poisson": ("lambda",),
    "gamma": ("shape", "scale"),
    "uniform": ("min", "max"),
    "constant": ("value",),
    "weibull": ("shape", "scale"),
    "erlang": ("k", "rate"),
    "lognormal": ("mu", "sigma"),
    "pareto": ("shape", "scale"),
}

#: The orders of service at a station (the app's own names: core/src/model.rs).
DISCIPLINES = ("fcfs", "priorityNonPreemptive", "priorityPreemptiveResume")

_PREFIX = {"source": "Src", "buffer": "B", "station": "S", "sink": "Sink"}

_MEASURES = {
    "number": "networkNumber",
    "sojourn": "networkSojourn",
    "delay": "networkSojourn",
}
_STATION_MEASURES = {
    "number": "stationNumber",
    "queue": "stationQueue",
    "sojourn": "stationSojourn",
    "utilisation": "stationUtilisation",
    "utilization": "stationUtilisation",
    "throughput": "stationThroughput",
}


@dataclass(frozen=True)
class Method:
    """One method as the app's Method Chooser lists it for a network."""

    #: The label `solve(method=…)` takes ("qna", "product_form", "inf_sim", …); None for the
    #: analytical row, which has no run of its own.
    label: Optional[str]
    name: str
    #: "exact", "simulation", "approximation", "diffusion" or "bound".
    tier: Optional[str]
    #: "recommended", "applicable", "caution", "experimental" or "unavailable".
    suitability: str
    applicable: bool
    #: What the method does here, or why it cannot be used, in the Chooser's sentence.
    reason: str
    #: True for the method `solve()` runs when none is named.
    chosen: bool = False


class Network:
    """A queueing network. See the module text for the four kinds of node.

    `buffers` is "infinite" or "finite" for the whole network, as in the app; `population` makes
    a network with no source and no sink a closed one, with that many customers circulating.
    """

    def __init__(self, buffers="infinite", population=None, name="network"):
        if buffers not in ("infinite", "finite"):
            raise QnetError(f"buffers must be \"infinite\" or \"finite\", not {buffers!r}.")
        self._spec = {"schema": _cli.SCHEMA, "buffers": buffers, "population": population, "nodes": [], "links": []}
        #: The file name analyses are filed under (the title a record carries).
        self.name = name
        self._tmp = None
        self._built = None
        self._scenarios = []
        self._scenario = None

    # ── making one ──────────────────────────────────────────────────────────────────────────

    @classmethod
    def open(cls, path, scenario=None):
        """The network in a `.bnet` file, as Qnet reads it.

        A file may hold scenarios: named variants of the network with other parameter values
        (Scenarios in the app). `scenario` chooses which one to read, by name, or "baseline" for
        the network's own values. Without it the file is read as the app shows it when it opens
        the file, which is the scenario it was saved showing; when that is not the baseline a
        `UserWarning` says so, because the numbers are then that scenario's. `net.scenarios`
        lists the names and `net.scenario` says which one this network holds (None: the baseline).

        The scenarios stay with the file: `save` writes them back, with a value changed here
        recorded as the shown scenario's (or the baseline's) as an edit in the app is.
        """
        path = os.fspath(path)
        args = ["describe", path]
        if scenario is not None:
            args += ["--scenario", str(scenario)]
        doc = _cli.json_command(args)
        net = cls.from_spec(doc["spec"], name=Path(path).stem)
        # What a description does not hold (anything else the file carries) is kept from the file.
        net._spec["basedOn"] = os.path.abspath(path)
        told = doc.get("scenario")
        if told:
            net._scenarios = list(told.get("names") or [])
            net._scenario = told.get("shown")
            net._spec["basedOnScenario"] = net._scenario if net._scenario is not None else "baseline"
            if scenario is None and net._scenario is not None:
                warnings.warn(
                    f"{Path(path).name} was saved showing the scenario “{net._scenario}”; this network holds that scenario's "
                    f"values. Network.open(path, scenario=\"baseline\") reads the network's own; net.scenarios lists the names.",
                    UserWarning,
                    stacklevel=2,
                )
        return net

    @property
    def scenarios(self):
        """The names of the scenarios in the file this network was opened from ([] when it has none)."""
        return list(self._scenarios)

    @property
    def scenario(self):
        """The scenario whose values this network holds; None for the baseline (or no scenarios)."""
        return self._scenario

    @classmethod
    def from_spec(cls, spec, name="network"):
        """A network from a description dict (the format of `qnet-cli build`, docs/CLI.md)."""
        net = cls(name=name)
        net._spec = copy.deepcopy(dict(spec))
        net._spec.setdefault("schema", _cli.SCHEMA)
        net._spec.setdefault("buffers", "infinite")
        net._spec.setdefault("population", None)
        net._spec.setdefault("nodes", [])
        net._spec.setdefault("links", [])
        return net

    @classmethod
    def tandem(cls, stations=2, arrival_rate=1.0, service_rates=1.0, servers=1, buffer_size=None, name="tandem"):
        """Stations in a row: Src1 → B1 → S1 → B2 → S2 → … → Sink.

        `service_rates` and `servers` are one number for every station or a list with one per
        station. Poisson arrivals, exponential service. With `buffer_size` the buffers are finite
        (one number or a list); without it they are infinite.
        """
        rates = _per_station(service_rates, stations, "service_rates")
        counts = _per_station(servers, stations, "servers")
        sizes = _per_station(buffer_size, stations, "buffer_size") if buffer_size is not None else [None] * stations
        net = cls(buffers="finite" if buffer_size is not None else "infinite", name=name)
        last = net.add_source("Src1", rate=arrival_rate)
        for i in range(stations):
            b = net.add_buffer(f"B{i + 1}", size=sizes[i] if sizes[i] is not None else 1)
            s = net.add_station(f"S{i + 1}", rate=rates[i], servers=counts[i])
            net.link(last, b)
            net.link(b, s)
            last = s
        net.link(last, net.add_sink("Sink"))
        return net

    @classmethod
    def single(cls, arrival_rate=1.0, service_rate=1.0, servers=1, buffer_size=None, name="single"):
        """One station: M/M/c, or M/M/c/K with `buffer_size` waiting places."""
        return cls.tandem(1, arrival_rate, service_rate, servers, buffer_size, name=name)

    @classmethod
    def closed_cycle(cls, population, service_rates, servers=1, name="cycle"):
        """A closed network: `population` customers going round B1 → S1 → B2 → S2 → … → B1.

        No source and no sink; exponential service. `service_rates` is a list, one per station.
        Each station has its buffer in front of it, as every station in Qnet does.
        """
        rates = list(service_rates)
        if len(rates) < 2:
            raise QnetError("A closed cycle needs at least two stations: give service_rates as a list.")
        counts = _per_station(servers, len(rates), "servers")
        net = cls(population=population, name=name)
        for i, (r, c) in enumerate(zip(rates, counts)):
            net.link(net.add_buffer(f"B{i + 1}"), net.add_station(f"S{i + 1}", rate=r, servers=c))
        for i in range(len(rates)):
            net.link(f"S{i + 1}", f"B{(i + 1) % len(rates) + 1}")
        return net

    def copy(self):
        """An independent copy."""
        other = Network.from_spec(self._spec, name=self.name)
        other._scenarios, other._scenario = list(self._scenarios), self._scenario
        return other

    # ── nodes and links ─────────────────────────────────────────────────────────────────────

    def _changed(self):
        self._built = None

    def _new_name(self, kind, name):
        taken = {n["name"] for n in self._spec["nodes"]}
        if name is None:
            i = 1
            while f"{_PREFIX[kind]}{i}" in taken:
                i += 1
            return f"{_PREFIX[kind]}{i}"
        name = str(name)
        if name in taken:
            raise QnetError(f"There is already a node called “{name}”. Give each node its own name.")
        return name

    def add_source(self, name=None, rate=1.0, distribution="poisson", batch=None, rate_profile=None, periodic=False, **parameters):
        """A source: jobs arrive from outside. By default a Poisson process of `rate` jobs per
        unit time. For another inter-arrival law name it and give its parameters, e.g.
        `add_source("In", distribution="gamma", shape=2.0, scale=0.5)`. Returns the node's name.

        Customer classes have no table of their own: class k is the k-th source in name order.

        `batch` makes customers arrive together, the inter-arrival law then applying to batches:
        a whole number k (always k), `("geometric", mean)`, or a list of probabilities for the
        sizes 1, 2, … (`[0.5, 0.3, 0.2]`). `rate_profile` makes a Poisson source's rate vary in
        time: a list of `(until, multiplier)` segments from time 0, each multiplying `rate` until
        its time; with `periodic=True` the profile repeats (its period is the last `until`),
        otherwise the rate is `rate` again after the last segment.
        """
        fields = _law("source", distribution, rate, parameters)
        if batch is not None:
            fields["batchSize"] = _batch(batch)
        if rate_profile is not None:
            fields["rateProfile"] = _profile(rate_profile, periodic)
        elif periodic:
            raise QnetError("periodic=True needs a rate_profile to repeat.")
        return self._add("source", name, fields)

    def add_station(self, name=None, rate=1.0, servers=1, distribution="exponential", by_class=None, discipline="fcfs", priority_order=None, **parameters):
        """A station: `servers` identical servers, exponential service at `rate` per server by
        default. Another service law: `add_station("M", distribution="erlang", k=3, rate=2.0)`.
        `by_class` gives classes their own law: `{1: {"distribution": "exponential", "rate": 2.0}}`
        (class 0 is the first). Returns the node's name.

        `discipline` is the order of service: "fcfs" (first come, first served, the default),
        "priorityNonPreemptive" or "priorityPreemptiveResume", with `priority_order` the class
        indices from the highest priority down (`[1, 0]`: class 1 before class 0).
        """
        if int(servers) != servers or servers < 1:
            raise QnetError(f"A station has a whole number of servers, at least 1; not {servers!r}.")
        if discipline not in DISCIPLINES:
            raise QnetError(f"There is no service discipline called {discipline!r}. Qnet knows {', '.join(DISCIPLINES)}.")
        fields = _law("station", distribution, rate, parameters)
        if discipline != "fcfs":
            order = [] if priority_order is None else list(priority_order)
            if any(int(c) != c or c < 0 for c in order) or len(set(order)) != len(order):
                raise QnetError(f"priority_order lists each class index once, the highest priority first (0 is the first class); not {priority_order!r}.")
            fields["serviceDiscipline"] = discipline
            fields["priorityOrder"] = [int(c) for c in order]
        elif priority_order is not None:
            raise QnetError("priority_order needs a priority discipline: \"priorityNonPreemptive\" or \"priorityPreemptiveResume\".")
        fields["servers"] = int(servers)
        if by_class:
            fields["serviceByClass"] = {}
            for k, law in by_class.items():
                law = dict(law)
                d = law.pop("distribution", "exponential")
                fields["serviceByClass"][str(int(k))] = _law("station", d, law.pop("rate", 1.0), law)
        return self._add("station", name, fields)

    def add_buffer(self, name=None, size=1):
        """A buffer: where jobs wait for the station it feeds. `size` is its number of waiting
        places, and matters only when the network's buffers are finite. Returns the node's name."""
        if int(size) != size or size < 0:
            raise QnetError(f"A buffer's size is a whole number of waiting places; not {size!r}.")
        return self._add("buffer", name, {"size": int(size)})

    def add_sink(self, name=None):
        """A sink: where jobs leave. Returns the node's name."""
        return self._add("sink", name, {})

    def _add(self, kind, name, fields):
        node = {"kind": kind, "name": self._new_name(kind, name)}
        node.update(fields)
        self._spec["nodes"].append(node)
        self._changed()
        return node["name"]

    def link(self, source, target, probability=1.0, customer_class=0, to_class=None):
        """A link: jobs leaving `source` go to `target` with this probability. `customer_class` is
        the class the link carries (0 is the first); `to_class` changes the job's class on the way
        (re-entrant lines)."""
        names = {n["name"] for n in self._spec["nodes"]}
        for end in (source, target):
            if end not in names:
                raise QnetError(f"There is no node called “{end}”. The nodes are: {', '.join(sorted(names)) or 'none yet'}.")
        if not 0.0 <= probability <= 1.0:
            raise QnetError(f"A routing probability lies between 0 and 1, and this one is {probability}.")
        link = {"from": source, "to": target, "probability": float(probability), "class": int(customer_class)}
        if to_class is not None:
            link["toClass"] = int(to_class)
        self._spec["links"].append(link)
        self._changed()
        return self

    # ── reading and changing parameters ─────────────────────────────────────────────────────

    @property
    def spec(self):
        """The description `qnet-cli build` reads, as a dict (a copy: change the network with
        `set`, `add_…` and `link`)."""
        return copy.deepcopy(self._spec)

    @property
    def nodes(self):
        """The nodes' names, in the order they were added."""
        return [n["name"] for n in self._spec["nodes"]]

    def _node(self, name):
        for n in self._spec["nodes"]:
            if n["name"] == name:
                return n
        raise QnetError(f"There is no node called “{name}”. The nodes are: {', '.join(self.nodes) or 'none yet'}.")

    def _locate(self, parameter):
        """(dict, key, kind of number) for a parameter name."""
        if parameter == "population":
            return self._spec, "population", "count"
        node_name, dot, key = str(parameter).rpartition(".")
        if not dot:
            raise QnetError(f"“{parameter}” is not a parameter. Write node.parameter, for example \"Src1.rate\", \"S1.servers\", \"B1.size\" or \"S1->B2.probability\"; or \"population\". parameters() lists them.")
        if "->" in node_name:
            a, b = (x.strip() for x in node_name.split("->", 1))
            found = [l for l in self._spec["links"] if l["from"] == a and l["to"] == b]
            if key != "probability":
                raise QnetError(f"A link has one parameter, its probability: \"{a}->{b}.probability\".")
            if len(found) != 1:
                raise QnetError(f"There {'is no link' if not found else 'are several links'} from “{a}” to “{b}”.")
            return found[0], "probability", "probability"
        node = self._node(node_name)
        if key == "servers" and node["kind"] == "station":
            return node, "servers", "count"
        if key == "size" and node["kind"] == "buffer":
            return node, "size", "count"
        if node["kind"] in ("source", "station"):
            values = node.setdefault("parameters", {})
            keys = DISTRIBUTIONS[node.get("distribution", "poisson" if node["kind"] == "source" else "exponential")]
            # "rate" is what a Poisson source's λ is, too.
            if key == "rate" and "lambda" in keys:
                key = "lambda"
            if key in keys:
                return values, key, "number"
            raise QnetError(f"“{node_name}” has no parameter “{key}”: it is {node.get('distribution')}, with {' and '.join(keys)}" + (", and servers." if node["kind"] == "station" else "."))
        raise QnetError(f"“{node_name}” is a {node['kind']}, which has no parameter “{key}”.")

    def parameters(self):
        """The names `set`, `get` and `sweep` take, with their values now."""
        out = {}
        for n in self._spec["nodes"]:
            if n["kind"] in ("source", "station"):
                keys = DISTRIBUTIONS[n.get("distribution", "poisson" if n["kind"] == "source" else "exponential")]
                for k in keys:
                    out[f"{n['name']}.{'rate' if k == 'lambda' else k}"] = n.get("parameters", {}).get(k)
            if n["kind"] == "station":
                out[f"{n['name']}.servers"] = n.get("servers", 1)
            if n["kind"] == "buffer":
                out[f"{n['name']}.size"] = n.get("size", 1)
        for l in self._spec["links"]:
            out[f"{l['from']}->{l['to']}.probability"] = l.get("probability", 1.0)
        if self._spec.get("population") is not None:
            out["population"] = self._spec["population"]
        return out

    def get(self, parameter):
        """The value of a parameter (`parameters()` lists the names)."""
        where, key, _ = self._locate(parameter)
        return where.get(key)

    def set(self, parameter, value):
        """Changes one parameter: `net.set("Src1.rate", 0.9)`, `net.set("S1.servers", 2)`,
        `net.set("B1.size", 10)`, `net.set("S1->B2.probability", 0.3)`, `net.set("population", 12)`.
        Returns the network, so calls chain."""
        where, key, kind = self._locate(parameter)
        if kind == "count":
            if int(value) != value:
                raise QnetError(f"{parameter} is a whole number; not {value!r}.")
            value = int(value)
        else:
            value = float(value)
        where[key] = value
        self._changed()
        return self

    # ── files ───────────────────────────────────────────────────────────────────────────────

    def save(self, path, scenarios="keep"):
        """Writes the network as a `.bnet` file the app opens. Returns the path.

        A network opened from a file with scenarios is saved with them (`scenarios="keep"`): a
        value changed here is the shown scenario's, or the baseline's when the baseline was read.
        That needs the same nodes, links and buffer regime as the file; after a node or link was
        added or removed the save is refused with a `QnetError` rather than losing the scenarios
        silently. `scenarios="drop"` writes the network alone.
        """
        if scenarios not in ("keep", "drop"):
            raise QnetError(f"scenarios must be \"keep\" or \"drop\", not {scenarios!r}.")
        path = os.fspath(path)
        _cli.json_command(["build", "-", path], stdin=json.dumps({**self._spec, "scenarios": scenarios}))
        return path

    def _file(self):
        """The network as a file for `qnet-cli`, built once per change."""
        if self._built is None:
            if self._tmp is None:
                # Removed when the network is collected, or at exit.
                self._tmp = tempfile.mkdtemp(prefix="qnet-")
                weakref.finalize(self, shutil.rmtree, self._tmp, True)
            name = "".join(c if c.isalnum() or c in "-_." else "_" for c in str(self.name)) or "network"
            # The analyses read one plain network: this one, whatever scenarios its file holds.
            self._built = self.save(os.path.join(self._tmp, f"{name}.bnet"), scenarios="drop")
        return self._built

    def _run(self, command, options=None, timeout=None):
        args = [command, self._file()]
        if options is not None:
            args.append("-")
        doc = _cli.json_command(args, stdin=json.dumps(options) if options is not None else None, timeout=timeout)
        if doc.get("available") is False:
            raise NotApplicable(doc.get("sentence") or doc.get("exactReason") or f"{command} does not cover this network.", doc.get("reason"), doc)
        return doc

    # ── what Qnet says about it ─────────────────────────────────────────────────────────────

    @property
    def fingerprint(self):
        """The SHA-256 Qnet gives this network; every result carries the one it was computed for."""
        return self.describe()["fingerprint"]

    def describe(self):
        """Qnet's reading of the network, as a dict: the station model from the traffic equations
        (`stations`: throughput, service rate, utilisation), `warnings`, whether it is drawn open
        or closed (`drawnAs`), the closed form it has if any (`closedForm`)."""
        return _cli.json_command(["describe", self._file()])

    def methods(self):
        """Every method the app's Method Chooser lists for this network, best first, each with
        whether it applies and why. The one with `chosen=True` is what `solve()` runs."""
        doc = _cli.json_command(["methods", self._file()])
        chosen = (doc.get("solve") or {}).get("label")
        return [Method(m.get("label"), m["name"], m.get("tier"), m["suitability"], bool(m["applicable"]), m["reason"], m.get("label") is not None and m.get("label") == chosen) for m in doc["methods"]]

    def solve(self, method=None, settings=None, timeout=None):
        """Runs one method and returns its result.

        `method=None` runs the one the app's Solve button would: an exact method if one applies,
        otherwise a simulation, otherwise the best-ranked approximation. Otherwise a label from
        `methods()` ("qna", "product_form", "inf_sim", …), or "live" for the in-process closed form
        (the same as `live()`). `settings` are run settings by their stored keys, e.g.
        `{"sim.replications": 20}`. A method that is refused or fails raises `RunFailed` with what
        Qnet's Status log says.
        """
        if method == "live":
            return self.live()
        args = ["solve", self._file(), "--json"] if method is None else ["run", str(method), self._file(), "--json"]
        for key, value in (settings or {}).items():
            args += ["--set", f"{key}={value}"]
        code, out, err = _cli.call(args, timeout=timeout)
        said = _cli.plain(err)
        if not out.strip():
            if code == 2 and method is not None and "no method called" in said:
                said = said.split("\n")[0] + " methods() lists the labels."
            raise RunFailed(said or f"qnet-cli {args[0]} failed with exit status {code}.")
        doc = _cli.document(out, args[0])
        if doc.get("status") not in ("completed", "partial"):
            raise RunFailed(doc.get("failure") or said or f"The run ended {doc.get('status')}.", doc)
        return SolveResult(doc)

    def live(self):
        """The exact closed form, computed in process: an open Jackson network (Poisson arrivals,
        exponential service, infinite buffers) or a closed network with exponential service. For
        any other network the result's `tier` is "utilisation" or "none" and `reason` says why."""
        return LiveResult(self._run("live"))

    def sensitivity(self, measure="sojourn", station=None, parameters=None, target_change=None):
        """How a measure responds to each parameter, by closed formula (open Jackson networks).

        `measure`: "sojourn" or "number" for the whole network; with `station`, "number", "queue",
        "sojourn", "utilisation" or "throughput" there. `parameters`: None for every arrival rate,
        service rate and number of servers, or a list such as
        `[{"kind": "service", "node": "S1"}, {"kind": "servers", "node": "S2"}]`.
        `target_change=-0.1` also asks what each parameter alone would have to be to cut the
        measure by 10 %.
        """
        options = {"measure": _measure(measure, station)}
        if parameters is not None:
            options["parameters"] = [self._parameter(p) for p in parameters]
        if target_change is not None:
            options["targetChange"] = float(target_change)
        return SensitivityResult(self._run("sensitivity", options))

    def _parameter(self, p):
        """A parameter request: a dict as docs/CLI.md gives it, or "load", "Src1.rate", "S1.rate", "S1.servers"."""
        if isinstance(p, dict):
            return dict(p)
        if p == "load":
            return {"kind": "load"}
        name, _, key = str(p).rpartition(".")
        if name and key == "servers":
            return {"kind": "servers", "node": name}
        if name and key in ("rate", "lambda"):
            return {"kind": "arrival" if self._node(name)["kind"] == "source" else "service", "node": name}
        raise QnetError(f"“{p}” is not a parameter sensitivity knows. Write \"load\", \"Src1.rate\", \"S1.rate\", \"S1.servers\", or a dict such as {{\"kind\": \"service\", \"node\": \"S1\"}}.")

    def capacity(self, target=None, *, sojourn=None, number=None, utilisation=None, wait=None, decision="servers", stations=None):
        """The cheapest numbers of servers (or service rates) that meet targets (open Jackson networks).

        Targets, any of: `sojourn` (mean time in the network at most this), `number` (mean number
        in the network), `utilisation` (every station at most this), `wait` (`{"S1": 0.5}`: mean
        wait before service at a station). `target` alone is short for `sojourn`.
        `decision="rates"` plans service rates by Kleinrock's square-root rule instead.
        `stations` says what may change and what it costs:
        `[{"station": "S1", "free": False}, {"station": "S2", "cost": 3, "upper": 5}]`.
        """
        constraints = []
        if target is not None:
            if isinstance(target, dict):
                constraints.append(dict(target))
            else:
                constraints.append({"kind": "networkSojourn", "target": float(target)})
        if sojourn is not None:
            constraints.append({"kind": "networkSojourn", "target": float(sojourn)})
        if number is not None:
            constraints.append({"kind": "networkNumber", "target": float(number)})
        if utilisation is not None:
            constraints.append({"kind": "utilisation", "target": float(utilisation)})
        for name, w in (wait or {}).items():
            constraints.append({"kind": "stationWait", "station": name, "target": float(w)})
        if not constraints:
            raise QnetError("capacity() needs a target: for example capacity(sojourn=4.0) or capacity(utilisation=0.8).")
        options = {"decision": decision, "constraints": constraints}
        if stations:
            options["stations"] = [dict(s) for s in stations]
        return CapacityResult(self._run("capacity", options))

    def uncertainty(self, inputs, measure="sojourn", station=None, samples=None, seed=None, arrivals_together=False):
        """The distribution of a measure when rates are uncertain (open Jackson networks).

        `inputs` maps a rate to how uncertain it is: `{"Src1.rate": 0.1, "S1.rate": (1.8, 2.2)}`.
        A number is a relative standard deviation (0.1: "give or take 10 %"); a pair is a 95 %
        interval. Each draw is solved exactly; the seed is fixed, so the same call gives the same
        numbers. `samples` defaults to 20 000.
        """
        asked = []
        for name, spread in dict(inputs).items():
            node_name, _, key = str(name).rpartition(".")
            node = self._node(node_name or name)
            if node["kind"] not in ("source", "station") or (key and key not in ("rate", "lambda")):
                raise QnetError(f"Only arrival rates and service rates can be given an uncertainty: “{name}” is neither. Write \"Src1.rate\" or \"S1.rate\".")
            entry = {"kind": "arrival" if node["kind"] == "source" else "service", "node": node["name"], "id": f"{node['name']}.rate"}
            if isinstance(spread, dict):
                entry["spread"] = dict(spread)
            elif isinstance(spread, (tuple, list)):
                low, high = spread
                entry["spread"] = {"kind": "interval95", "low": float(low), "high": float(high)}
            else:
                entry["spread"] = {"kind": "relativeSd", "value": float(spread)}
            asked.append(entry)
        options = {"measure": _measure(measure, station), "inputs": asked, "arrivalsTogether": bool(arrivals_together)}
        if samples is not None:
            options["samples"] = int(samples)
        if seed is not None:
            options["seed"] = int(seed)
        return UncertaintyResult(self._run("uncertainty", options))

    def transient(self, horizon=None, initial="empty", surge=None, intervals=None, settle_fraction=None):
        """Mean number at each station over time, from time 0 to `horizon` (open networks, infinite buffers).

        `horizon=None` takes the one Qnet suggests from the stations' relaxation times.
        `initial`: "empty", "steady", or a list of the number at each station. `surge` multiplies
        the arrival rates for a while: `{"factor": 1.5, "from": 2.0, "until": 6.0}`.
        """
        options = {"initial": initial if isinstance(initial, str) else [int(n) for n in initial]}
        if horizon is not None:
            options["horizon"] = float(horizon)
        if surge is not None:
            options["surge"] = dict(surge)
        if intervals is not None:
            options["intervals"] = int(intervals)
        if settle_fraction is not None:
            options["settleFraction"] = float(settle_fraction)
        return TransientResult(self._run("transient", options))

    def sweep(self, parameter, values, method=None, settings=None):
        """Solves the network at each value of one parameter (`parameters()` lists the names).

        The network itself is not changed. `method` is as in `solve`; with None, the method Solve
        chooses at the first value is used for every value, so the points are comparable.
        `method="live"` uses the in-process closed form, which is immediate. A point that cannot
        be solved (an overloaded network, say) is kept as a gap, with the reason in `errors`.
        """
        values = list(values)
        self._locate(parameter)
        results, errors = [], {}
        label = method
        for x in values:
            point = self.copy().set(parameter, x)
            try:
                if label is None:
                    chosen = [m for m in point.methods() if m.chosen]
                    if not chosen:
                        raise RunFailed("No method can be run on this network as it is. methods() says why for each one.")
                    label = chosen[0].label
                r = point.solve(label, settings=settings)
                if isinstance(r, LiveResult) and r.tier != "exact":
                    raise NotApplicable(r.notes[0] if r.notes else f"No closed form here ({r.reason}).", r.reason, r.raw)
                results.append(r)
            except QnetError as e:
                results.append(None)
                errors[x] = str(e)
        return SweepResult(str(parameter), values, results, errors)

    def __repr__(self):
        kinds = [n["kind"] for n in self._spec["nodes"]]
        count = lambda k, word: f"{kinds.count(k)} {word}{'' if kinds.count(k) == 1 else 's'}"
        parts = [count("source", "source"), count("buffer", "buffer"), count("station", "station"), count("sink", "sink"), f"{len(self._spec['links'])} link{'' if len(self._spec['links']) == 1 else 's'}"]
        closed = f", population {self._spec['population']}" if self._spec.get("population") is not None else ""
        return f"<qnet.Network {self.name!r}: {', '.join(parts)}; {self._spec.get('buffers', 'infinite')} buffers{closed}>"


def _batch(batch):
    """A batch-size law as the description holds it (`batchSize`, core/src/bnet.rs)."""
    if isinstance(batch, dict):
        return dict(batch)
    if isinstance(batch, tuple) and len(batch) == 2 and batch[0] == "geometric":
        return {"kind": "geometric", "mean": float(batch[1])}
    if isinstance(batch, (list, tuple)):
        return {"kind": "pmf", "probabilities": [float(p) for p in batch]}
    if isinstance(batch, bool) or int(batch) != batch or batch < 1:
        raise QnetError(f"batch is a whole number of customers (1 or more), (\"geometric\", mean), or a list of probabilities for the sizes 1, 2, …; not {batch!r}.")
    return {"kind": "constant", "size": int(batch)}


def _profile(segments, periodic):
    """A rate profile as the description holds it (`rateProfile`)."""
    if isinstance(segments, dict):
        return dict(segments)
    try:
        listed = [{"until": float(until), "multiplier": float(multiplier)} for until, multiplier in segments]
    except (TypeError, ValueError):
        raise QnetError(f"rate_profile is a list of (until, multiplier) pairs, for example [(8, 0.5), (24, 1.5)]; not {segments!r}.") from None
    return {"periodic": bool(periodic), "segments": listed}


def _per_station(value, n, what):
    if isinstance(value, (list, tuple)):
        if len(value) != n:
            raise QnetError(f"{what} has {len(value)} entries for {n} stations: give one number, or one per station.")
        return list(value)
    return [value] * n


def _law(kind, distribution, rate, parameters):
    """The distribution fields of a node's description."""
    if distribution not in DISTRIBUTIONS:
        raise QnetError(f"There is no distribution called “{distribution}”. Qnet knows {', '.join(DISTRIBUTIONS)}.")
    if kind == "station" and distribution == "poisson":
        raise QnetError("A station's service time cannot be Poisson (that is an arrival process). Use exponential.")
    keys = DISTRIBUTIONS[distribution]
    values = {}
    if keys == ("rate",):
        values["rate"] = float(rate)
    elif keys == ("lambda",):
        values["lambda"] = float(parameters.pop("lambda", rate))
    elif "rate" in keys and "rate" not in parameters:
        values["rate"] = float(rate)
    for k, v in parameters.items():
        if k not in keys:
            raise QnetError(f"The {distribution} distribution takes {' and '.join(keys)}, not “{k}”.")
        values[k] = float(v)
    missing = [k for k in keys if k not in values]
    if missing:
        raise QnetError(f"The {distribution} distribution needs {' and '.join(missing)}.")
    return {"distribution": distribution, "parameters": values}


def _measure(measure, station):
    if isinstance(measure, dict):
        return dict(measure)
    table = _STATION_MEASURES if station is not None else _MEASURES
    kind = table.get(str(measure), str(measure))
    return {"kind": kind, "station": station} if station is not None else {"kind": kind}
