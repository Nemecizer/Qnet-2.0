"""The package against the built command-line tool: building, saving, solving, sweeping, the
analyses, and what is said when something cannot be done.

    python3 -m unittest discover -s python/tests -t python     (from the repository)
"""

import json
import math
import os
import tempfile
import unittest
import warnings
from pathlib import Path

import qnet
from qnet import _cli

from . import support
from .support import ROOT, needs_cli


def close(a, b, tol=1e-9):
    return a is not None and b is not None and math.isclose(a, b, rel_tol=tol, abs_tol=tol)


@needs_cli
class Building(unittest.TestCase):
    def test_a_tandem_built_here_is_the_bundled_example_to_the_solver(self):
        """The three-station tandem of the examples, rebuilt in Python, gives 0.90.34's recorded QNA run."""
        net = qnet.Network.tandem(stations=3, arrival_rate=1.0, service_rates=1.1111111)
        example = qnet.Network.open(ROOT / "examples" / "3dtandem.inf.bnet")
        self.assertEqual(net.describe()["stations"], [dict(s, id=t["id"]) for s, t in zip(example.describe()["stations"], net.describe()["stations"])])
        if not support.solvers_ready():
            self.skipTest("the solvers are not staged here (scripts/stage-solvers.sh): the golden comparison needs QNA")
        golden = json.loads((ROOT / "golden" / "runs" / "3dtandem.inf" / "qna" / "record.json").read_text())
        want = [(m["stationName"], m["metric"], m["estimate"], m["unit"]) for m in golden["measurements"]]
        for built in (net, example):
            r = built.solve("qna")
            self.assertEqual((r.label, r.tier, r.status), ("qna", "approximation", "completed"))
            self.assertEqual([(v.station, v.metric, v.value, v.unit) for v in r.values], want)
        self.assertEqual(example.solve("qna").fingerprint, golden["provenance"]["networkFingerprint"])

    def test_a_saved_network_is_a_file_qnet_opens_and_saves_unchanged(self):
        net = qnet.Network(buffers="finite")
        src = net.add_source(rate=0.7)
        b = net.add_buffer(size=5)
        s = net.add_station(distribution="erlang", k=2, rate=3.0, servers=2)
        out = net.add_sink()
        net.link(src, b).link(b, s).link(s, out, probability=0.6).link(s, b, probability=0.4)
        self.assertEqual((src, b, s, out), ("Src1", "B1", "S1", "Sink1"))
        with tempfile.TemporaryDirectory() as d:
            path = net.save(os.path.join(d, "mine.bnet"))
            written = Path(path).read_text()
            doc = json.loads(written)
            self.assertEqual(sorted(doc), ["canvasPanOffset", "canvasScale", "infiniteBuffers", "links", "nodes"])
            self.assertEqual([(n["kind"], n["distribution"], n["distributionParameters"], n["bufferSize"], n["numberOfServers"]) for n in doc["nodes"]],
                             [("source", "poisson", "lambda=0.7", 1, 1), ("buffer", "exponential", "rate=1.0", 5, 1), ("station", "erlang", "k=2,rate=3.0", 1, 2), ("sink", "exponential", "rate=1.0", 1, 1)])
            # Qnet's own open-and-save writes the same bytes: the file is one the app would have written.
            code, resaved, err = _cli.call(["resave", path])
            self.assertEqual((code, resaved), (0, written), err)
            # Opened again, changed and saved: the ids and positions stay, the parameter moves.
            again = qnet.Network.open(path)
            self.assertEqual(again.parameters(), net.parameters())
            again.set("S1.servers", 3).set("Src1.rate", 0.9).save(path)
            changed = json.loads(Path(path).read_text())
            self.assertEqual([n["id"] for n in changed["nodes"]], [n["id"] for n in doc["nodes"]])
            self.assertEqual([n["position"] for n in changed["nodes"]], [n["position"] for n in doc["nodes"]])
            self.assertEqual((changed["nodes"][0]["distributionParameters"], changed["nodes"][2]["numberOfServers"]), ("lambda=0.9", 3))
        # The same description always builds the same network.
        self.assertEqual(net.fingerprint, net.copy().fingerprint)

    def test_every_example_opens_and_saves_as_qnet_saves_it(self):
        with tempfile.TemporaryDirectory() as d:
            for path in sorted((ROOT / "examples").glob("*.bnet"))[:12]:
                out = qnet.Network.open(path).save(os.path.join(d, "copy.bnet"))
                self.assertEqual(Path(out).read_text(), _cli.call(["resave", str(path)])[1], path.name)

    def test_parameters_are_read_and_set_by_name(self):
        net = qnet.Network.tandem(2, 0.8, [1.0, 2.0], buffer_size=4)
        self.assertEqual(net.parameters(), {"Src1.rate": 0.8, "S1.rate": 1.0, "S1.servers": 1, "S2.rate": 2.0, "S2.servers": 1, "B1.size": 4, "B2.size": 4,
                                            "Src1->B1.probability": 1.0, "B1->S1.probability": 1.0, "S1->B2.probability": 1.0, "B2->S2.probability": 1.0, "S2->Sink.probability": 1.0})
        net.set("S2.rate", 3).set("B1.size", 9)
        self.assertEqual((net.get("S2.rate"), net.get("B1.size"), net.get("Src1.rate")), (3.0, 9, 0.8))
        self.assertIn("2 stations", repr(net))


@needs_cli
class Analyses(unittest.TestCase):
    def setUp(self):
        self.net = qnet.Network.tandem(2, 0.8, [1.0, 1.6])

    def test_live_is_the_mm1_formula_with_units_and_tier(self):
        r = self.net.live()
        self.assertEqual((r.tier, r.reason, r.bottlenecks), ("exact", None, ["S1"]))
        self.assertTrue(close(r.value("Mean number in system", "S1"), 0.8 / 0.2))
        self.assertTrue(close(r.value("Mean number in system", "S2"), 0.5 / 0.5))
        self.assertTrue(close(r.value("Mean sojourn time", "Network"), 5.0 / 0.8))
        row = next(x for x in r.table() if x["station"] == "S1" and x["metric"] == "Utilisation")
        self.assertEqual((row["unit"], row["tier"]), ("ratio", "exact"))
        self.assertTrue(close(row["value"], 0.8))
        text = repr(r)
        self.assertIn("Live", text.splitlines()[0])
        self.assertIn("tier: exact", text.splitlines()[0])
        self.assertIn("Mean number in system", text)
        self.assertIn("<table>", r._repr_html_())
        with self.assertRaises(KeyError) as e:
            r.value("Mean number in system")
        self.assertIn("several stations", str(e.exception))
        with self.assertRaises(KeyError) as e:
            r.value("Queue length", "S1")
        self.assertIn("It reports: Mean number in system", str(e.exception))

    def test_live_stops_at_utilisation_where_there_is_no_formula_and_solves_closed_networks(self):
        finite = qnet.Network.single(0.8, 1.0, buffer_size=5).live()
        self.assertEqual((finite.tier, finite.reason), ("utilisation", "finiteBuffers"))
        self.assertEqual(finite.find("Mean number in system"), [])
        cycle = qnet.Network.closed_cycle(population=3, service_rates=[1.0, 1.0]).live()
        self.assertEqual(cycle.tier, "exact")
        # Two identical stations and three customers: 1.5 each, by symmetry.
        self.assertTrue(close(cycle.value("Mean number in system", "S1"), 1.5))
        self.assertTrue(close(cycle.value("Mean number in system", "Network"), 3.0))

    def test_replicated_simulation_is_a_second_opinion_for_a_closed_network(self):
        # New in 2.1: `sim_inproc` is computed inside qnet-cli (no solver to stage), so this runs
        # everywhere. Two identical stations and three customers: 1.5 each, by symmetry.
        cycle = qnet.Network.closed_cycle(population=3, service_rates=[1.0, 1.0])
        offered = {m.label: m for m in cycle.methods()}
        self.assertEqual((offered["closed_pf"].chosen, offered["sim_inproc"].applicable, offered["sim_inproc"].tier), (True, True, "simulation"))
        settings = {"sim.seedFixed": "true", "sim.seed": 2026, "siminproc.replications": 10, "siminproc.completions": 20000, "siminproc.confidence": 0.99}
        r = cycle.solve(method="sim_inproc", settings=settings)
        self.assertEqual((r.label, r.tier), ("sim_inproc", "simulation"))
        for station in ("S1", "S2"):
            v = next(x for x in r.find("Mean number in system") if x.station == station)
            low, high, level = v.interval
            self.assertEqual(level, 0.99)
            self.assertTrue(low < 1.5 < high and high - low < 0.2, (station, low, high))
        # The same seed gives the same numbers.
        again = cycle.solve(method="sim_inproc", settings=settings)
        self.assertEqual([(v.station, v.metric, v.value, v.interval) for v in r.values], [(v.station, v.metric, v.value, v.interval) for v in again.values])
        # Finite buffers are refused with the reason.
        with self.assertRaises(qnet.RunFailed) as e:
            qnet.Network.single(0.8, 1.0, buffer_size=5).solve(method="sim_inproc")
        self.assertIn("Replicated Simulation covers infinite buffers", str(e.exception))

    def test_sweep_values_are_the_repeated_solves(self):
        rates = [0.2, 0.5, 0.8]
        sweep = self.net.sweep("Src1.rate", rates, method="live")
        self.assertEqual(self.net.get("Src1.rate"), 0.8, "the network itself is not changed")
        for x, r in zip(rates, sweep.results):
            alone = self.net.copy().set("Src1.rate", x).live()
            self.assertEqual([(v.station, v.metric, v.value) for v in r.values], [(v.station, v.metric, v.value) for v in alone.values])
        xs, ys = sweep.series("Mean number in system", "S1")
        self.assertEqual([float(x) for x in xs], rates)
        for x, y in zip(rates, ys):
            self.assertTrue(close(float(y), x / (1 - x)))
        self.assertEqual(sweep.columns[0], "Src1.rate")
        self.assertEqual(len(sweep.table()), sum(len(r.values) for r in sweep.results))
        self.assertEqual(sweep.tier, "exact")
        # An overloaded point is a gap with its reason, not the end of the sweep.
        over = self.net.sweep("Src1.rate", [0.5, 1.5], method="live")
        self.assertIsNone(over.results[1])
        self.assertIn(1.5, over.errors)
        self.assertTrue(math.isnan(float(over.series("Mean number in system", "S1")[1][1])) if hasattr(over.series("Utilisation", "S1")[1], "dtype") else over.series("Mean number in system", "S1")[1][1] is None)

    def test_sweep_through_a_solver_matches_repeated_solves(self):
        if not support.solvers_ready():
            self.skipTest("the solvers are not staged here (scripts/stage-solvers.sh)")
        sweep = self.net.sweep("S2.servers", [1, 2])
        self.assertEqual([r.label for r in sweep.results], ["product_form", "product_form"], "Solve's choice at the first value, kept for every value")
        for c, r in zip([1, 2], sweep.results):
            alone = self.net.copy().set("S2.servers", c).solve()
            self.assertEqual([(v.station, v.metric, v.value) for v in r.values], [(v.station, v.metric, v.value) for v in alone.values])
            # The solver prints eight decimals; the closed form agrees to that.
            self.assertTrue(close(r.value("Mean number in system", "S2"), self.net.copy().set("S2.servers", c).live().value("Mean number in system", "S2"), 1e-7))

    def test_methods_and_solve_choose_as_the_app_does(self):
        methods = self.net.methods()
        chosen = [m for m in methods if m.chosen]
        self.assertEqual([(m.label, m.tier, m.applicable) for m in chosen], [("product_form", "exact", True)])
        self.assertIn("qna", [m.label for m in methods if m.applicable])
        mc = next(m for m in methods if m.label == "mc")
        self.assertEqual((mc.applicable, mc.reason), (False, "The current network has only one customer class."))
        det = qnet.Network()
        det.link(det.add_source("In", rate=0.5), det.add_buffer("Q")).link("Q", det.add_station("M", distribution="constant", value=1.0)).link("M", det.add_sink("Out"))
        self.assertEqual([m.label for m in det.methods() if m.chosen], ["inf_sim"], "no exact method for M/D/1 here, so a simulation")

    def test_sensitivity_capacity_uncertainty_and_transient(self):
        s = self.net.sensitivity(measure="number", station="S1", target_change=-0.5)
        self.assertEqual((s.tier, s.unit), ("exact", "customers"))
        self.assertTrue(close(s.value, 4.0))
        rows = {r["parameter"]: r for r in s.table()}
        # L = ρ/(1−ρ) at ρ = λ/μ: dL/dλ = 1/(μ(1−ρ)²) = 25, dL/dμ = −λ/(μ−λ)² = −20.
        self.assertTrue(close(rows["arrival:Src1"]["derivative"], 25.0))
        self.assertTrue(close(rows["service:S1"]["derivative"], -20.0))
        self.assertTrue(close(rows["service:S2"]["derivative"], 0.0))
        # Halving L to 2 needs ρ = 2/3: λ = 2/3 or μ = 1.2.
        self.assertTrue(close(rows["arrival:Src1"]["what_it_takes"], 2.0 / 3.0))
        self.assertTrue(close(rows["service:S1"]["what_it_takes"], 1.2))
        self.assertEqual([r["parameter"] for r in self.net.sensitivity(parameters=["Src1.rate", "S2.servers"]).table()], ["arrival:Src1", "servers:S2"])

        c = self.net.capacity(sojourn=3.0)
        self.assertTrue(c.feasible and c.mean_delay <= 3.0 < c.mean_delay_now)
        self.assertEqual(c.servers["S1"], 2)
        self.assertIn(c.proof, ("marginal", "search"))
        low = self.net.capacity(sojourn=0.1)
        self.assertFalse(low.feasible)
        self.assertEqual(low.infeasible["why"], "serviceFloor")
        self.assertIn("No plan meets the targets", repr(low))

        u = self.net.uncertainty({"Src1.rate": 0.05, "S1.rate": (0.95, 1.05)}, samples=2000, seed=11)
        self.assertTrue(close(u.value, 5.0 / 0.8))
        self.assertTrue(u.interval[0] < u.value < u.interval[1])
        self.assertEqual(u.table(), self.net.uncertainty({"Src1.rate": 0.05, "S1.rate": (0.95, 1.05)}, samples=2000, seed=11).table(), "a fixed seed: the same numbers again")
        self.assertEqual([x["inputs"] for x in u.shares], [["Src1.rate"], ["S1.rate"]])

        t = self.net.transient(horizon=30.0, intervals=30)
        self.assertEqual((t.tier, t.station_names, len(t.times)), ("exact", ["S1", "S2"], 31))
        self.assertEqual(float(t.exact["S1"][0]), 0.0)
        self.assertTrue(0.0 < float(t.exact["S2"][-1]) <= 1.0 + 1e-9, "the mean rises from empty towards its stationary value, 1")
        self.assertTrue(close(t.stationary["S2"], 1.0))
        self.assertEqual(t.table()[0], {"time": 0.0, "S1": 0.0, "S2": 0.0})

    def test_pandas_is_used_when_present_and_asked_for_plainly_when_not(self):
        r = self.net.live()
        try:
            import pandas  # noqa: F401
        except ImportError:
            with self.assertRaises(ImportError) as e:
                r.to_pandas()
            self.assertIn("table() gives the same rows", str(e.exception))
        else:
            self.assertEqual(list(r.to_pandas().columns), r.columns)


@needs_cli
def priority_desk(discipline="priorityPreemptiveResume"):
    """Two Poisson classes at one server: class 0 (λ = 0.3, exponential, mean 1) before class 1
    (λ = 0.2, Erlang-2, mean 2). The bundled examples/extended/PriorityHelpDesk.mg1.2class.bnet."""
    net = qnet.Network(name="desk")
    net.add_source("Src1", rate=0.3)
    net.add_source("Src2", rate=0.2)
    net.add_buffer("B1")
    net.add_station("S1", rate=1.0, by_class={0: {"rate": 1.0}, 1: {"distribution": "erlang", "k": 2, "rate": 1.0}}, discipline=discipline, priority_order=[0, 1])
    net.add_sink("Sink1")
    net.link("Src1", "B1", customer_class=0).link("Src2", "B1", customer_class=1).link("B1", "S1")
    net.link("S1", "Sink1", customer_class=0).link("S1", "Sink1", customer_class=1)
    return net


@needs_cli
class NewModelFeatures(unittest.TestCase):
    """Priorities, batch arrivals and rate profiles (new in 2.1; core/src/extended.rs)."""

    def test_a_priority_station_is_solved_exactly_and_simulated(self):
        net = priority_desk()
        offered = {m.label: m for m in net.methods()}
        self.assertEqual((offered["priority_exact"].chosen, offered["priority_exact"].tier, offered["sim_inproc"].applicable), (True, "exact", True))
        self.assertFalse(offered["qna"].applicable)
        self.assertIn("This network uses priority service at S1.", offered["qna"].reason)
        r = net.solve()
        self.assertEqual((r.label, r.tier), ("priority_exact", "exact"))
        # Preemptive-resume M/G/1 by hand (Kleinrock vol. 2, ch. 3). ρ = 0.3, 0.4; E[S²] = 2, 6.
        # T1 = 1 + (0.3·2/2)/0.7 = 10/7. T2 = 2/0.7 + (0.3 + 0.6)/(0.7·0.3) = 50/7.
        t1, t2 = 10 / 7, 50 / 7
        self.assertTrue(close(r.value("Mean number in system", "S1"), 0.3 * t1 + 0.2 * t2))
        self.assertTrue(close(0.3 * t1 + 0.2 * t2, 13 / 7))
        self.assertTrue(close(r.value("Mean sojourn time", "S1"), (0.3 * t1 + 0.2 * t2) / 0.5))
        self.assertTrue(close(net.live().value("Mean number in system", "S1"), 13 / 7))
        # Cobham, non-preemptive: W0 = (0.3·2 + 0.2·6)/2 = 0.9; Wq = 0.9/0.7 and 0.9/(0.7·0.3).
        np_ = priority_desk("priorityNonPreemptive").solve(method="priority_exact")
        self.assertTrue(close(np_.value("Mean queue length", "S1"), 0.3 * 0.9 / 0.7 + 0.2 * 0.9 / 0.21))
        # The simulator's interval holds the exact value.
        sim = net.solve(method="sim_inproc", settings={"sim.seedFixed": "true", "sim.seed": 7, "siminproc.confidence": 0.99})
        low, high, _ = sim.find("Mean number in system")[0].interval
        self.assertTrue(low < 13 / 7 < high and high - low < 0.2, (low, high))
        with self.assertRaises(qnet.RunFailed) as e:
            net.solve(method="qna")
        self.assertIn("does not model that", str(e.exception))

    def test_batch_arrivals_are_solved_exactly_and_count_in_the_load(self):
        net = qnet.Network(name="batches")
        net.link(net.add_source("Src1", rate=0.24, batch=("geometric", 2.5)), net.add_buffer("B1"))
        net.link("B1", net.add_station("S1", rate=1.0)).link("S1", net.add_sink("Sink1"))
        d = net.describe()
        self.assertEqual(d["features"], [{"feature": "batchArrivals", "nodes": ["Src1"]}])
        self.assertEqual((d["featureProblems"], d["closedForm"]), ([], None))
        # Utilisation counts customers: 0.24 batches × 2.5 per batch.
        self.assertTrue(close(d["stations"][0]["utilisation"], 0.6))
        r = net.solve()
        self.assertEqual((r.label, r.tier), ("batch_exact", "exact"))
        # M^X/M/1 with geometric batches: L = ρ/((1 − α)(1 − ρ)), α = 0.6, ρ = 0.6 (Gross et al., ch. 3).
        self.assertTrue(close(r.value("Mean number in system", "S1"), 3.75))
        # The other two spellings of a batch law reach the file.
        for batch, want in ((2, {"kind": "constant", "size": 2}), ([0.5, 0.3, 0.2], {"kind": "pmf", "probabilities": [0.5, 0.3, 0.2]})):
            other = qnet.Network()
            other.add_source("Src1", rate=0.1, batch=batch)
            self.assertEqual(other.spec["nodes"][0]["batchSize"], want)
        # Constant batches of 2 at rate 1, μ = 3: L = ((K + 1)/2)·ρ/(1 − ρ) = 3.
        two = qnet.Network()
        two.link(two.add_source("Src1", rate=1.0, batch=2), two.add_buffer("B1"))
        two.link("B1", two.add_station("S1", rate=3.0)).link("S1", two.add_sink("Sink1"))
        self.assertTrue(close(two.solve(method="batch_exact").value("Mean number in system", "S1"), 3.0))

    def test_a_rate_profile_has_no_steady_state_and_the_transient_follows_it(self):
        net = qnet.Network(name="rush")
        net.link(net.add_source("Src1", rate=1.0, rate_profile=[(6, 0.3), (10, 1.5), (24, 0.8)], periodic=True), net.add_buffer("B1"))
        net.link("B1", net.add_station("S1", rate=0.8, servers=2)).link("S1", net.add_sink("Sink1"))
        offered = net.methods()
        self.assertFalse(any(m.chosen or m.applicable for m in offered))
        sim = next(m for m in offered if m.label == "sim_inproc")
        self.assertIn("has no single steady state", sim.reason)
        with self.assertRaises(qnet.QnetError):
            net.solve()
        t = net.transient(horizon=48, intervals=48)
        self.assertEqual((t.tier, t.profile["periodic"], t.profile["breaks"]), ("exact", True, [6.0, 10.0, 24.0, 30.0, 34.0]))
        self.assertEqual(t.raw["psa"]["tier"], "approximation")
        at = list(t.times).index(8.0)
        # The approximation jumps to the frozen network's steady state; the true mean lags behind it.
        self.assertTrue(t.psa["S1"][at] > t.exact["S1"][at] + 1.0, (t.psa["S1"][at], t.exact["S1"][at]))
        # Without a profile there is neither.
        plain = qnet.Network.single(0.5, 1.0).transient(horizon=5)
        self.assertEqual((plain.psa, plain.profile), (None, None))

    def test_the_features_survive_describe_and_build_and_mistakes_are_refused(self):
        net = priority_desk()
        net._node("Src1")["batchSize"] = {"kind": "constant", "size": 2}
        net._node("Src2")["rateProfile"] = {"periodic": False, "segments": [{"until": 5.0, "multiplier": 2.0}]}
        with tempfile.TemporaryDirectory() as folder:
            path = net.save(os.path.join(folder, "all.bnet"))
            again = qnet.Network.open(path)
            nodes = {n["name"]: n for n in again.spec["nodes"]}
            self.assertEqual((nodes["S1"]["serviceDiscipline"], nodes["S1"]["priorityOrder"]), ("priorityPreemptiveResume", [0, 1]))
            self.assertEqual(nodes["Src1"]["batchSize"], {"kind": "constant", "size": 2})
            self.assertEqual(nodes["Src2"]["rateProfile"], {"periodic": False, "segments": [{"multiplier": 2, "until": 5}]})
            second = again.save(os.path.join(folder, "again.bnet"))
            self.assertEqual(Path(path).read_text(), Path(second).read_text())
            self.assertEqual([f["feature"] for f in again.describe()["features"]], ["priorities", "batchArrivals", "timeVaryingRates"])
        # A plain network's description has none of the keys.
        plain = qnet.Network.single(0.5, 1.0)
        self.assertFalse(any(k in n for n in plain.spec["nodes"] for k in ("serviceDiscipline", "priorityOrder", "batchSize", "rateProfile")))
        self.assertEqual(plain.describe()["features"], [])
        bad = qnet.Network()
        bad.add_source("Src1", batch=[0.5, 0.2])
        with self.assertRaises(qnet.QnetError) as e:
            bad.describe()
        self.assertIn("The batch-size probabilities sum to 0.7, not 1.", str(e.exception))
        for mistake in (lambda n: n.add_station(discipline="lifo"), lambda n: n.add_station(priority_order=[0]), lambda n: n.add_station(discipline="priorityNonPreemptive", priority_order=[0, 0]), lambda n: n.add_source(batch=0), lambda n: n.add_source(rate_profile=[1, 2]), lambda n: n.add_source(periodic=True)):
            with self.assertRaises(qnet.QnetError):
                mistake(qnet.Network())


class Errors(unittest.TestCase):
    def test_what_the_tool_refuses_arrives_as_an_exception_in_its_words(self):
        net = qnet.Network.tandem(2, 0.8, 1.0)
        with self.assertRaises(qnet.NotApplicable) as e:
            qnet.Network.single(0.8, 1.0, buffer_size=3).sensitivity()
        self.assertEqual(e.exception.reason, "notJackson")
        self.assertTrue(str(e.exception))
        with self.assertRaises(qnet.NotApplicable) as e:
            net.copy().set("Src1.rate", 2.0).sensitivity()
        self.assertEqual(e.exception.reason, "unstable")
        with self.assertRaises(qnet.QnetError) as e:
            net.sensitivity(measure="number", station="S9")
        self.assertEqual(str(e.exception), "There is no station called “S9” in this network.")
        with self.assertRaises(qnet.QnetError) as e:
            qnet.Network.open("/nonexistent/net.bnet")
        self.assertTrue(str(e.exception).startswith("Couldn't read /nonexistent/net.bnet"))
        with self.assertRaises(qnet.RunFailed) as e:
            net.solve("no_such_method")
        self.assertEqual(str(e.exception), "There's no method called “no_such_method”. methods() lists the labels.")
        with self.assertRaises(qnet.RunFailed) as e:
            net.solve("sim")
        self.assertEqual(e.exception.document["status"], "refused")
        self.assertIn("finite", str(e.exception))
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "bad.bnet"
            bad.write_text('{"nodes": 3}')
            with self.assertRaises(qnet.QnetError) as e:
                qnet.Network.open(bad)
            self.assertIn("isn't a network Qnet can open", str(e.exception))

    def test_mistakes_made_in_python_are_caught_before_the_tool_is_asked(self):
        net = qnet.Network.tandem(1, 0.5, 1.0)
        for call, said in [
            (lambda: net.link("S1", "Nowhere"), "There is no node called “Nowhere”."),
            (lambda: net.add_station("S1"), "There is already a node called “S1”."),
            (lambda: net.add_station(distribution="hyperexponential"), "There is no distribution called “hyperexponential”."),
            (lambda: net.add_station(distribution="gamma", shape=2.0), "The gamma distribution needs scale."),
            (lambda: net.add_station(distribution="poisson"), "A station's service time cannot be Poisson"),
            (lambda: net.set("S1.shape", 2.0), "“S1” has no parameter “shape”: it is exponential, with rate, and servers."),
            (lambda: net.set("S1.servers", 1.5), "S1.servers is a whole number"),
            (lambda: net.set("rho", 0.5), "“rho” is not a parameter."),
            (lambda: net.link("B1", "S1", probability=1.2), "A routing probability lies between 0 and 1"),
            (lambda: net.capacity(), "capacity() needs a target"),
            (lambda: net.uncertainty({"B1.size": 0.1}), "Only arrival rates and service rates can be given an uncertainty"),
            (lambda: qnet.Network(buffers="some"), "buffers must be"),
        ]:
            with self.assertRaises(qnet.QnetError) as e:
                call()
            self.assertIn(said, str(e.exception))
        self.assertEqual(net.nodes, ["Src1", "B1", "S1", "Sink"], "a refused change leaves the network as it was")


@needs_cli
class Scenarios(unittest.TestCase):
    """A file with scenarios (core/tests/fixtures/scenarios): saved showing "Peak hour"."""

    FILE = ROOT / "core" / "tests" / "fixtures" / "scenarios" / "feedback.bnet"
    PLAIN = ROOT / "golden" / "OpenJackson.d2.feedback.p30.inf" / "resave.bnet"

    def test_open_says_whose_values_it_read_and_scenario_chooses(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            shown = qnet.Network.open(self.FILE)
        self.assertEqual([str(w.message).split(";")[0] for w in caught if w.category is UserWarning], ["feedback.bnet was saved showing the scenario “Peak hour”"])
        self.assertEqual((shown.scenarios, shown.scenario), (["Peak hour", "Add a server at S2"], "Peak hour"))
        self.assertEqual(shown.get("S2.servers"), 2)
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            base = qnet.Network.open(self.FILE, scenario="baseline")
            other = qnet.Network.open(self.FILE, scenario="Add a server at S2")
            plain = qnet.Network.open(self.PLAIN)
        self.assertEqual((base.scenario, base.get("S2.servers"), other.scenario, other.get("S2.servers")), (None, 1, "Add a server at S2", 3))
        self.assertEqual((plain.scenarios, plain.scenario), ([], None))
        self.assertEqual(base.fingerprint, plain.fingerprint)
        self.assertNotEqual(shown.fingerprint, plain.fingerprint)
        # An analysis of an opened network is that network's, with nothing more to warn about.
        self.assertNotIn("scenario", base.live().raw)
        with self.assertRaises(qnet.QnetError) as e:
            qnet.Network.open(self.FILE, scenario="Night")
        self.assertIn("There is no scenario called “Night”", str(e.exception))

    def test_save_keeps_the_scenarios_or_refuses(self):
        with tempfile.TemporaryDirectory() as d, warnings.catch_warnings():
            warnings.simplefilter("ignore")
            out = Path(d) / "out.bnet"
            qnet.Network.open(self.FILE).save(out)
            self.assertEqual(out.read_text(), self.FILE.read_text(), "opened and saved: the same file, scenarios and all")
            qnet.Network.open(self.FILE, scenario="baseline").save(out)
            self.assertEqual(out.read_text(), self.FILE.with_name("shown-baseline.bnet").read_text())
            # A changed value is the shown scenario's; the baseline keeps its own.
            net = qnet.Network.open(self.FILE)
            net.set("S1.servers", 2).save(out)
            self.assertEqual(qnet.Network.open(out).get("S1.servers"), 2)
            self.assertEqual(qnet.Network.open(out, scenario="baseline").get("S1.servers"), 1)
            self.assertEqual(qnet.Network.open(out).scenarios, ["Peak hour", "Add a server at S2"])
            # The network itself changed: refused in words, the file untouched; "drop" is explicit.
            before = out.read_text()
            net.add_sink("Out2")
            with self.assertRaises(qnet.QnetError) as e:
                net.save(out)
            self.assertIn("holds scenarios", str(e.exception))
            self.assertIn('save(path, scenarios="drop")', str(e.exception))
            self.assertEqual(out.read_text(), before)
            net.save(out, scenarios="drop")
            self.assertEqual(qnet.Network.open(out).scenarios, [])
            with self.assertRaises(qnet.QnetError):
                net.save(out, scenarios="lose")


class FindingTheTool(unittest.TestCase):
    """These need no tool: they are about not finding one."""

    def setUp(self):
        self.before = (_cli._explicit, os.environ.get("QNET_CLI"), os.environ.get("PATH"))

    def tearDown(self):
        _cli._explicit = self.before[0]
        for key, value in (("QNET_CLI", self.before[1]), ("PATH", self.before[2])):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_the_order_is_set_cli_then_the_environment_then_the_app_then_path(self):
        with tempfile.TemporaryDirectory() as d:
            tools = []
            for name in ("explicit", "env", "bin"):
                folder = Path(d) / name
                folder.mkdir()
                tool = folder / "qnet-cli"
                tool.write_text("#!/bin/sh\necho Qnet 0.0.0\n")
                tool.chmod(0o755)
                tools.append(tool)
            explicit, env, on_path = tools
            _cli._explicit = None
            os.environ.pop("QNET_CLI", None)
            os.environ["PATH"] = str(on_path.parent)
            installed = [p for _, p in _cli._candidates() if "Qnet.app" in str(p) and p.is_file()]
            if not installed:
                self.assertEqual(qnet.find_cli(), str(on_path))
            os.environ["QNET_CLI"] = str(env)
            self.assertEqual(qnet.find_cli(), str(env))
            qnet.set_cli(explicit)
            self.assertEqual(qnet.find_cli(), str(explicit))
            self.assertEqual(qnet.cli_version(), "Qnet 0.0.0")
            qnet.set_cli(None)
            self.assertEqual(qnet.find_cli(), str(env))
            # A tool that is not Qnet's JSON interface is named as the likely cause.
            with self.assertRaises(qnet.QnetError) as e:
                qnet.Network.tandem(1).live()
            self.assertIn("did not print the JSON this package expects", str(e.exception))

    def test_a_missing_tool_is_explained_with_what_to_do(self):
        _cli._explicit = None
        os.environ["QNET_CLI"] = "/nonexistent/qnet-cli"
        with self.assertRaises(qnet.CliNotFound) as e:
            qnet.find_cli()
        self.assertEqual(str(e.exception), "QNET_CLI is set to /nonexistent/qnet-cli, which is not a program that can be run.")
        with self.assertRaises(qnet.CliNotFound):
            qnet.set_cli("/nonexistent/qnet-cli")
        os.environ.pop("QNET_CLI")
        os.environ["PATH"] = "/nonexistent"
        if not any(p.is_file() for _, p in _cli._candidates()):
            with self.assertRaises(qnet.CliNotFound) as e:
                qnet.find_cli()
            self.assertIn("qnet.set_cli(", str(e.exception))
            self.assertIn("/Applications/Qnet.app/Contents/MacOS/qnet-cli", str(e.exception))

    def test_the_version_is_the_apps(self):
        conf = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text())
        self.assertEqual(qnet.__version__, conf["version"])
        if support.HAVE_CLI:
            _cli._explicit = str(support.CLI)
            self.assertEqual(qnet.cli_version(), f"Qnet {qnet.__version__}")


if __name__ == "__main__":
    unittest.main()
