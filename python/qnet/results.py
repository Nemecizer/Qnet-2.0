"""What the analyses return: a table of rows with units and a tier, readable when printed.

Every result has

- `tier`: how much the numbers may be trusted — "exact", "simulation", "approximation",
  "diffusion", "bound" (the app's own five words), or "utilisation" for live results that stop
  at utilisation;
- `method`: the name of what computed them;
- `fingerprint`: the SHA-256 Qnet gives the network they were computed for;
- `table()`: the rows, as a list of dicts; `columns`: their keys in order;
- `to_pandas()`: the same as a DataFrame, when pandas is installed;
- `raw`: the JSON document `qnet-cli` printed, complete (docs/CLI.md describes it).
"""

from dataclasses import dataclass
from typing import Optional, Tuple


def _array(values):
    """A NumPy array when NumPy is installed, else the list itself."""
    try:
        import numpy
    except ImportError:
        return list(values)
    return numpy.array([float("nan") if v is None else v for v in values], dtype=float)


def _show(v):
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:.6g}"
    if isinstance(v, (list, tuple)):
        return ", ".join(_show(x) for x in v)
    return str(v)


def format_table(columns, rows, limit=40):
    """Rows as aligned text columns; numbers to six significant digits; "—" where there is none."""
    shown = [[_show(r.get(c)) for c in columns] for r in rows[:limit]]
    widths = [max([len(c)] + [len(line[i]) for line in shown]) for i, c in enumerate(columns)]
    numeric = [all(isinstance(r.get(c), (int, float)) or r.get(c) is None for r in rows[:limit]) and not all(r.get(c) is None for r in rows[:limit]) for c in columns]
    cell = lambda text, i: text.rjust(widths[i]) if numeric[i] else text.ljust(widths[i])
    lines = ["  ".join(cell(c, i) for i, c in enumerate(columns)).rstrip(), "  ".join("-" * w for w in widths)]
    lines += ["  ".join(cell(t, i) for i, t in enumerate(line)).rstrip() for line in shown]
    if len(rows) > limit:
        lines.append(f"… {len(rows) - limit} more rows (table() has them all)")
    return "\n".join(lines)


@dataclass(frozen=True)
class Value:
    """One number of a result, with what it measures, its unit and how sure it is."""

    station: str
    metric: str
    value: Optional[float]
    unit: str
    #: "exact", "simulation", "approximation", "diffusion", "bound" or "utilisation".
    tier: str
    #: (low, high, level), e.g. (1.9, 2.1, 0.95), when the method gives an interval.
    interval: Optional[Tuple[float, float, float]] = None
    standard_error: Optional[float] = None
    #: The customer class (0 is the first), or None for all classes together.
    customer_class: Optional[int] = None

    def __float__(self):
        return float("nan") if self.value is None else float(self.value)


class Result:
    """The base of every result: rows, columns, tier, method, the raw document."""

    #: The heading `repr` prints.
    title = "Result"

    def __init__(self, raw, rows, columns, tier=None, method=None, notes=()):
        self.raw = raw
        self.rows = rows
        self.columns = list(columns)
        self.tier = tier
        self.method = method
        self.fingerprint = raw.get("fingerprint") if isinstance(raw, dict) else None
        #: Sentences worth reading beside the numbers (warnings, what could not be certified).
        self.notes = list(notes)

    def table(self):
        """The rows, as a list of dicts with the keys of `columns`."""
        return [dict(r) for r in self.rows]

    def to_pandas(self):
        """The rows as a pandas DataFrame. pandas is not required by this package: install it to use this."""
        try:
            import pandas
        except ImportError:
            raise ImportError("to_pandas() needs pandas, which is not installed (pip install pandas). table() gives the same rows as plain dicts.") from None
        return pandas.DataFrame(self.rows, columns=self.columns)

    def __getitem__(self, key):
        return self.raw[key]

    def __len__(self):
        return len(self.rows)

    def __iter__(self):
        return iter(self.table())

    def _heading(self):
        parts = [self.title]
        if self.method:
            parts.append(str(self.method))
        if self.tier:
            parts.append(f"tier: {self.tier}")
        return " · ".join(parts)

    def __repr__(self):
        lines = [self._heading(), format_table(self.columns, self.rows)]
        lines += [f"note: {n}" for n in self.notes]
        return "\n".join(lines)

    def _repr_html_(self):
        """A table for notebooks."""
        import html

        head = "".join(f"<th>{html.escape(c)}</th>" for c in self.columns)
        body = "".join("<tr>" + "".join(f"<td>{html.escape(_show(r.get(c)))}</td>" for c in self.columns) + "</tr>" for r in self.rows[:200])
        notes = "".join(f"<p>{html.escape(n)}</p>" for n in self.notes)
        return f"<p><b>{html.escape(self._heading())}</b></p><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>{notes}"


class _Valued(Result):
    """A result whose rows are `Value`s: one per station and quantity."""

    COLUMNS = ["station", "class", "metric", "value", "unit", "low", "high", "tier"]

    def __init__(self, raw, values, tier, method, notes=()):
        self.values = list(values)
        rows = [
            {
                "station": v.station,
                "class": v.customer_class,
                "metric": v.metric,
                "value": v.value,
                "unit": v.unit,
                "low": v.interval[0] if v.interval else None,
                "high": v.interval[1] if v.interval else None,
                "tier": v.tier,
            }
            for v in self.values
        ]
        columns = [c for c in self.COLUMNS if c not in ("class", "low", "high") or any(r[c] is not None for r in rows)]
        super().__init__(raw, rows, columns, tier, method, notes)

    def find(self, metric, station=None):
        """The `Value`s whose metric is `metric` (case does not matter), at `station` when one is named."""
        want = metric.casefold()
        return [v for v in self.values if v.metric.casefold() == want and (station is None or v.station == station)]

    def value(self, metric, station=None):
        """The one number for `metric` (at `station`); KeyError naming the choices when there is not exactly one."""
        found = self.find(metric, station)
        if len(found) == 1:
            return found[0].value
        at = f" at {station}" if station else ""
        if not found:
            metrics = sorted({v.metric for v in self.values})
            raise KeyError(f"This result has no “{metric}”{at}. It reports: {', '.join(metrics)}.")
        stations = ", ".join(v.station for v in found)
        raise KeyError(f"“{metric}” is reported for several stations ({stations}): name one with station=….")

    @property
    def metrics(self):
        """The quantities this result reports, in the order they first appear."""
        seen = []
        for v in self.values:
            if v.metric not in seen:
                seen.append(v.metric)
        return seen


class SolveResult(_Valued):
    """A solver run (`Network.solve`): the record the app's Results pane would hold."""

    title = "Solve"

    def __init__(self, raw):
        m = raw.get("method", {})
        tier = m.get("tier")
        values = []
        for v in raw.get("values", []):
            between = v.get("interval")
            values.append(
                Value(
                    station=v.get("station") or "",
                    metric=v.get("metric") or "",
                    value=v.get("value"),
                    unit=v.get("unit") or "",
                    tier=tier,
                    interval=(between["low"], between["high"], between.get("level")) if between else None,
                    standard_error=v.get("standardError"),
                    customer_class=v.get("class"),
                )
            )
        notes = list(raw.get("warnings", []))
        if raw.get("status") == "partial":
            notes.insert(0, "The run is partial: " + (raw.get("failure") or "not every quantity could be read."))
        super().__init__(raw, values, tier, m.get("name"), notes)
        #: The `qnet-cli run` label of the method that ran ("qna", "product_form", …).
        self.label = m.get("label")
        self.status = raw.get("status")
        self.seed = raw.get("seed")
        self.elapsed_seconds = raw.get("elapsedSeconds")
        self.warnings = list(raw.get("warnings", []))


class LiveResult(_Valued):
    """The exact closed form Qnet shows as you draw (`Network.live`): an open Jackson network or a
    closed (Gordon–Newell) one. For any other network `tier` is "utilisation" (or "none") and
    `reason` says why the queue lengths have no formula."""

    title = "Live"

    QUANTITIES = [
        ("throughput", "Throughput"),
        ("utilisation", "Utilisation"),
        ("meanInSystem", "Mean number in system"),
        ("meanWaiting", "Mean number waiting"),
        ("meanSojourn", "Mean sojourn time"),
        ("meanWait", "Mean wait"),
    ]

    def __init__(self, raw):
        tier = raw.get("tier")
        units = raw.get("units", {})
        exact = tier == "exact"
        values = []
        for s in raw.get("stations", []):
            for key, name in self.QUANTITIES:
                if s.get(key) is None:
                    continue
                # Utilisation and throughput come from the traffic equations whatever the tier.
                values.append(Value(s["name"], name, s[key], units.get(key, ""), "exact" if exact or raw.get("utilisationExact") else "utilisation"))
        totals = raw.get("totals") or {}
        for key, name, unit in [("throughput", "Throughput", "customers / time"), ("meanNumber", "Mean number in system", "customers"), ("meanDelay", "Mean sojourn time", "time")]:
            if totals.get(key) is not None:
                values.append(Value("Network", name, totals[key], unit, "exact"))
        notes = [raw["reasonDetail"]] if raw.get("reasonDetail") else []
        super().__init__(raw, values, tier, raw.get("method"), notes)
        #: Why the result stops short of exact ("finiteBuffers", "notExponential", "unstable", …), or None.
        self.reason = raw.get("reason")
        #: The most loaded station(s), by name.
        self.bottlenecks = list(raw.get("bottlenecks", []))


class SensitivityResult(Result):
    """How one measure responds to each parameter (`Network.sensitivity`), by closed formula."""

    title = "Sensitivity"

    def __init__(self, raw):
        rows = []
        for p in raw.get("parameters", []):
            takes = p.get("whatItTakes") or {}
            rows.append(
                {
                    "parameter": p.get("id"),
                    "current": p.get("current"),
                    "derivative": p.get("derivative"),
                    "elasticity": p.get("elasticity"),
                    "one_more": p.get("oneMore"),
                    "what_it_takes": takes.get("value") if takes.get("achieved") else None,
                    "note": p.get("note") or (None if not takes or takes.get("achieved") else f"cannot reach the target ({takes.get('why')})"),
                }
            )
        columns = ["parameter", "current", "derivative", "elasticity", "one_more"]
        if raw.get("target") is not None:
            columns.append("what_it_takes")
        if any(r["note"] for r in rows):
            columns.append("note")
        super().__init__(raw, rows, columns, raw.get("tier"), raw.get("method"))
        self.measure = raw.get("measure", {})
        #: The measure now, and its unit.
        self.value = raw.get("value")
        self.unit = raw.get("unit")
        #: The measure asked for by target_change, when one was given.
        self.target = raw.get("target")
        self.bottlenecks = list(raw.get("bottlenecks", []))

    def _heading(self):
        m = self.measure
        what = m.get("kind", "") + (f" at {m['station']}" if m.get("station") else "")
        return f"{super()._heading()} · {what} = {_show(self.value)} {self.unit or ''}".rstrip()


class CapacityResult(Result):
    """The cheapest servers or service rates that meet the targets (`Network.capacity`)."""

    title = "Capacity"

    def __init__(self, raw):
        rates = raw.get("decision") == "rates"
        rows = [
            {
                "station": s["name"],
                "now": s["rateNow"] if rates else s["serversNow"],
                "proposed": s["rate"] if rates else s["servers"],
                "utilisation_now": s.get("utilisationNow"),
                "utilisation": s.get("utilisation"),
                "cost": s.get("cost"),
            }
            for s in raw.get("stations", [])
        ]
        notes = []
        if not raw.get("feasible"):
            why = raw.get("infeasible") or {}
            notes.append(f"No plan meets the targets ({why.get('why')}" + (f"; the least it can reach is {_show(why['value'])}" if why.get("value") is not None else "") + ").")
        elif raw.get("proof") == "none":
            notes.append("This plan is good but not proven cheapest: the exact search reached its limit.")
        super().__init__(raw, rows, ["station", "now", "proposed", "utilisation_now", "utilisation", "cost"], raw.get("tier"), raw.get("method"), notes)
        self.decision = raw.get("decision")
        self.feasible = bool(raw.get("feasible"))
        #: Why no plan meets the targets: {"why": …, "constraint": …, "station": …, "value": …}, or None.
        self.infeasible = raw.get("infeasible")
        #: "marginal" (optimal by theorem), "search" (certified by exact search), "closedForm", or "none".
        self.proof = raw.get("proof")
        self.cost_now = raw.get("costNow")
        self.cost = raw.get("cost")
        self.mean_delay_now = raw.get("meanDelayNow")
        self.mean_delay = raw.get("meanDelay")
        self.constraints = list(raw.get("constraints", []))

    @property
    def servers(self):
        """Station name → proposed number of servers."""
        return {s["name"]: s["servers"] for s in self.raw.get("stations", [])}

    @property
    def rates(self):
        """Station name → proposed service rate."""
        return {s["name"]: s["rate"] for s in self.raw.get("stations", [])}


class UncertaintyResult(Result):
    """One measure's distribution when arrival and service rates are uncertain (`Network.uncertainty`).

    The rows are the statistics: sampled (each draw solved exactly; with its Monte Carlo standard
    error) and, beside them, the delta method's linear approximation."""

    title = "Uncertainty"

    def __init__(self, raw):
        s = raw.get("sampling") or {}
        lin = raw.get("linear") or {}
        unit = raw.get("unit")
        rows = [{"statistic": "value at the nominal inputs", "value": raw.get("value"), "standard_error": None, "unit": unit, "tier": "exact"}]
        for key, name in [("mean", "mean"), ("median", "median"), ("q025", "2.5 % quantile"), ("q975", "97.5 % quantile")]:
            if s.get(key):
                rows.append({"statistic": name, "value": s[key]["value"], "standard_error": s[key]["standardError"], "unit": unit, "tier": "simulation"})
        if s.get("sd") is not None:
            rows.append({"statistic": "standard deviation", "value": s["sd"], "standard_error": None, "unit": unit, "tier": "simulation"})
        if s.get("probabilityUnstable"):
            rows.append({"statistic": "probability of overload", "value": s["probabilityUnstable"]["value"], "standard_error": s["probabilityUnstable"]["standardError"], "unit": "probability", "tier": "simulation"})
        if lin:
            rows.append({"statistic": "linear: standard deviation", "value": lin.get("sd"), "standard_error": None, "unit": unit, "tier": "approximation"})
            rows.append({"statistic": "linear: 2.5 %", "value": lin.get("low"), "standard_error": None, "unit": unit, "tier": "approximation"})
            rows.append({"statistic": "linear: 97.5 %", "value": lin.get("high"), "standard_error": None, "unit": unit, "tier": "approximation"})
        notes = []
        d, limit = raw.get("disagreement"), raw.get("disagreementThreshold")
        if d is not None and limit is not None and d > limit:
            notes.append(f"The linear approximation and the sampling disagree by {d:.0%} (more than {limit:.0%}): trust the sampled rows.")
        if s and not s.get("meanExists", True):
            notes.append("The mean of the answer does not exist under these uncertainties (overload is possible), so none is given. The median and the quantiles do exist.")
        super().__init__(raw, rows, ["statistic", "value", "standard_error", "unit", "tier"], raw.get("tier"), raw.get("method"), notes)
        self.value = raw.get("value")
        self.unit = unit
        #: (2.5 % quantile, 97.5 % quantile) of the sampled answers, or None.
        self.interval = (s["q025"]["value"], s["q975"]["value"]) if s.get("q025") and s.get("q975") else None
        self.probability_unstable = (s.get("probabilityUnstable") or {}).get("value")
        #: Per uncertain input (or group): its share of the variance — linear, and Sobol' first and total.
        self.shares = [
            {"inputs": x["inputs"], "linear": x.get("linear"), "first": (x.get("first") or {}).get("value"), "total": (x.get("total") or {}).get("value")}
            for x in raw.get("shares", [])
        ]


class TransientResult(Result):
    """Mean number at each station over time (`Network.transient`).

    `exact` holds the uniformised Markov chain's means (a proven lower bound; `shortfall` bounds
    how far below) where the network is a small enough open Jackson network; `fluid` holds the
    fluid model's levels for any open network with infinite buffers. The rows are one per time:
    the exact means when there are some, else the fluid levels."""

    title = "Transient"

    def __init__(self, raw):
        names = [s["name"] for s in raw.get("stations", [])]
        times = raw.get("times", [])
        ex, fl = raw.get("exact"), raw.get("fluid")
        curves = (ex or {}).get("mean") or (fl or {}).get("level") or []
        rows = [dict([("time", t)] + [(names[i], curves[i][k]) for i in range(len(names))]) for k, t in enumerate(times)]
        notes = []
        if ex is None and raw.get("exactReason"):
            notes.append(f"No exact answer: {raw['exactReason']} The rows are the fluid model's.")
        if ex and any(ex.get("uncertified", [])):
            notes.append("A settling time could not be certified for: " + ", ".join(n for n, u in zip(names, ex["uncertified"]) if u) + ".")
        super().__init__(raw, rows, ["time"] + names, "exact" if ex else "approximation", (ex or fl or {}).get("method"), notes)
        self.station_names = names
        #: The time grid (a NumPy array when NumPy is installed).
        self.times = _array(times)
        #: Station name → exact mean number over time, or None when the exact tier does not apply.
        self.exact = {n: _array(ex["mean"][i]) for i, n in enumerate(names)} if ex else None
        #: Station name → fluid level over time.
        self.fluid = {n: _array(fl["level"][i]) for i, n in enumerate(names)} if fl else None
        #: Station name → the stationary mean the curves approach (None where there is none).
        self.stationary = {s["name"]: s.get("stationary") for s in raw.get("stations", [])}
        #: Station name → the time after which the mean stays within settle_fraction of stationary (exact tier).
        self.settling = dict(zip(names, ex["settling"])) if ex else None
        #: Station name → a proven bound on how far the exact curve lies below the true mean.
        self.shortfall = dict(zip(names, ex["shortfall"])) if ex else None
        self.horizon = raw.get("horizon")
        psa, profile = raw.get("psa"), raw.get("profile")
        #: Station name → the pointwise stationary approximation over time (None in an entry
        #: where the frozen network is overloaded), when the rates change in time and the
        #: network is a Jackson network; else None. An approximation: it ignores how long the
        #: queue takes to follow the rate.
        self.psa = {n: list(psa["mean"][i]) for i, n in enumerate(names)} if psa else None
        #: The stored rate profile the analysis followed: {"breaks", "periodic", "rates"}, or None.
        self.profile = profile


class SweepResult(Result):
    """One parameter varied over several values, the network solved at each (`Network.sweep`).

    The rows are long: one per parameter value, station and quantity. `results` holds each
    point's own result (None where the point could not be solved; `errors` says why)."""

    title = "Sweep"

    def __init__(self, parameter, values, results, errors):
        self.parameter = parameter
        self.parameter_values = list(values)
        self.results = list(results)
        #: Parameter value → the sentence saying why that point has no result.
        self.errors = dict(errors)
        rows = []
        for x, r in zip(self.parameter_values, self.results):
            if r is None:
                continue
            for v in r.values:
                rows.append({parameter: x, "station": v.station, "metric": v.metric, "value": v.value, "unit": v.unit, "low": v.interval[0] if v.interval else None, "high": v.interval[1] if v.interval else None, "tier": v.tier})
        columns = [parameter, "station", "metric", "value", "unit", "low", "high", "tier"]
        columns = [c for c in columns if c not in ("low", "high") or any(r[c] is not None for r in rows)]
        first = next((r for r in self.results if r is not None), None)
        tiers = sorted({r.tier for r in self.results if r is not None and r.tier})
        notes = [f"{parameter} = {_show(x)}: {message}" for x, message in self.errors.items()]
        super().__init__({"parameter": parameter, "values": self.parameter_values}, rows, columns, tiers[0] if len(tiers) == 1 else ("mixed" if tiers else None), first.method if first else None, notes)
        self.fingerprint = None

    def series(self, metric, station=None):
        """(x, y): the parameter values and `metric` (at `station`) at each; NaN (or None without
        NumPy) where a point has no such number. Arrays when NumPy is installed, else lists."""
        ys = []
        for r in self.results:
            if r is None:
                ys.append(None)
                continue
            found = r.find(metric, station)
            if len(found) > 1:
                stations = ", ".join(v.station for v in found)
                raise KeyError(f"“{metric}” is reported for several stations ({stations}): name one with station=….")
            ys.append(found[0].value if found else None)
        if all(y is None for y in ys) and any(r is not None for r in self.results):
            metrics = sorted({v.metric for r in self.results if r is not None for v in r.values})
            raise KeyError(f"No point of this sweep reports “{metric}”" + (f" at {station}" if station else "") + f". It reports: {', '.join(metrics)}.")
        return _array(self.parameter_values), _array(ys)
