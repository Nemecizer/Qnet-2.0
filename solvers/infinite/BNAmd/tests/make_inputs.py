#!/usr/bin/env python3
"""Writes the hand-made cases in tests/inputs/ (run from anywhere).

Each case is <name>.bnet with <name>.expect beside it; tests/check_inputs.sh
runs them. Cases named fuzz-* were found by validation/fuzz/fuzz_mc_solver.py
and are kept as found; this script does not write them.
"""
import copy
import json
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "inputs")


def node(i, kind, name, params="rate=1.0", dist="exponential", buf=1, service=None):
    return {"bufferSize": buf, "distribution": dist, "distributionParameters": params, "id": "N%d" % i,
            "kind": kind, "name": name, "numberOfServers": 1, "serviceDistributions": service or {}}


def link(a, b, cls=0, p=1):
    return {"customerClass": cls, "fromNodeID": "N%d" % a, "toNodeID": "N%d" % b, "routingProbability": p}


def tandem(d):
    """Src1 -> B1 -> S1 -> ... -> Bd -> Sd -> Sink, rho = 0.9 everywhere."""
    nodes, links = [node(0, "source", "Src1", "rate=0.9")], []
    prev = 0
    for k in range(1, d + 1):
        b, s = 2 * k - 1, 2 * k
        nodes += [node(b, "buffer", "B%d" % k, buf=10), node(s, "station", "S%d" % k)]
        links += [link(prev, b), link(b, s)]
        prev = s
    nodes.append(node(2 * d + 1, "sink", "Sink1"))
    links.append(link(prev, 2 * d + 1))
    return {"canvasScale": 1, "infiniteBuffers": True, "links": links, "nodes": nodes}


def two_class():
    """Two stations, two classes with their own service laws and feedback."""
    s1 = {"0": {"distribution": "exponential", "distributionParameters": "rate=2.0"},
          "1": {"distribution": "constant", "distributionParameters": "value=1.0"}}
    s2 = {"0": {"distribution": "exponential", "distributionParameters": "rate=2.0"},
          "1": {"distribution": "exponential", "distributionParameters": "rate=1.0"}}
    nodes = [node(1, "source", "Src1", "rate=0.5"), node(2, "source", "Src2", "rate=0.25"),
             node(3, "buffer", "B1", buf=10), node(4, "station", "S1", "rate=2.0", service=s1),
             node(5, "buffer", "B2", buf=10), node(6, "station", "S2", "rate=2.0", service=s2),
             node(7, "sink", "Sink1")]
    links = []
    for cls, src, stay in ((0, 1, 0.5), (1, 2, 0.2)):
        links += [link(src, 3, cls), link(3, 4, cls), link(4, 5, cls, stay), link(4, 7, cls, 1 - stay),
                  link(5, 6, cls), link(6, 3, cls, stay), link(6, 7, cls, 1 - stay)]
    return {"canvasScale": 1, "infiniteBuffers": True, "links": links, "nodes": nodes}


def write(name, doc, args, exit_code, stderr="", stdout="", raw=None, note=""):
    text = raw if raw is not None else json.dumps(doc, indent=1, sort_keys=True)
    with open(os.path.join(OUT, name + ".bnet"), "w") as f:
        f.write(text)
    with open(os.path.join(OUT, name + ".expect"), "w") as f:
        if note:
            f.write("# %s\n" % note)
        f.write("args=%s\nexit=%d\n" % (args, exit_code))
        if stderr:
            f.write("stderr=%s\n" % stderr)
        if stdout:
            f.write("stdout=%s\n" % stdout)


def main():
    os.makedirs(OUT, exist_ok=True)
    base = two_class()

    write("ok-two-class", base, "-G -n 4", 0, stdout="N_total(class 2) =",
          note="a valid two-class network still runs")
    write("ok-tandem-1", tandem(1), "-G -n 8", 0, stdout="E[X_1] =", note="one station (no boundary faces to couple)")

    write("d5-automatic-mesh", tandem(5), "-G", 1, stderr="too large",
          note="5 stations at the automatic mesh (6): 11.5e9 entries, past INT_MAX; was Segmentation fault: 11")
    write("d5-mesh-1", tandem(5), "-G -n 1", 0, stdout="E[X_5] =",
          note="5 stations: a face element has 512 basis functions; was a stack overflow of Df_vals[256]")
    write("d8-no-mesh-fits", tandem(8), "-G -n 1", 1, stderr="No mesh is small enough",
          note="8 stations: even one element needs 4^16 entries")
    write("d9-too-many-stations", tandem(9), "-G", 1, stderr="too many stations")

    write("mesh-zero", base, "-G -n 0", 1, stderr="mesh size", note="-n 0 divided by zero")
    write("mesh-not-a-number", base, "-G -n abc", 1, stderr="mesh size")
    write("mesh-overflow", base, "-G -n 99999999999999999999", 1, stderr="mesh size")

    d = copy.deepcopy(base)
    d["links"][2]["customerClass"] = -1
    write("class-negative", d, "-G -n 4", 1, stderr="customer class",
          note="a negative class indexed before the routing table")
    d = copy.deepcopy(base)
    d["links"][2]["customerClass"] = -2147483648
    write("class-int-min", d, "-G -n 4", 1, stderr="customer class")
    d = copy.deepcopy(base)
    d["links"] += [link(4, 5, 9, 0.5), link(5, 6, 9)]
    write("class-9-through-buffer", d, "-G -n 4", 0, stdout="E[X_2] =",
          note="class 9 has no source: its links are skipped; station -> buffer -> station wrote past the table")
    d = copy.deepcopy(base)
    d["links"] += [link(4, 5, 2147483647, 0.5), link(5, 6, 2147483647)]
    write("class-int-max", d, "-G -n 4", 0, stdout="E[X_2] =")
    d = copy.deepcopy(base)
    d["links"][2]["customerClass"] = "0"
    write("class-is-text", d, "-G -n 4", 1, stderr="customer class")

    d = copy.deepcopy(base)
    d["nodes"][3]["name"] = "S99999999999999999999"
    write("station-number-overflows", d, "-G -n 4", 1, stderr="too many stations",
          note="atoi on a number that does not fit an int")
    d = copy.deepcopy(base)
    d["nodes"][0]["name"] = "Src99999999999999999999"
    write("source-number-overflows", d, "-G -n 4", 1, stderr="too many customer classes")

    d = copy.deepcopy(base)
    d["nodes"][0]["distributionParameters"] = "rate=nan"
    write("rate-nan", d, "-G -n 4", 1, stderr="not a finite number")
    d = copy.deepcopy(base)
    d["nodes"][1]["distributionParameters"] = "rate=inf"
    write("rate-infinite", d, "-G -n 4", 1, stderr="not a finite number")
    d = copy.deepcopy(base)
    d["nodes"][0]["distribution"] = "constant"
    d["nodes"][0]["distributionParameters"] = "value=0"
    write("interarrival-zero", d, "-G -n 4", 1, stderr="not a finite number")
    text = json.dumps(base, indent=1, sort_keys=True).replace('"routingProbability": 0.5', '"routingProbability": 1e999', 1)
    write("routing-overflows", None, "-G -n 4", 1, stderr="routing probability", raw=text)

    text = json.dumps(base, indent=1, sort_keys=True)
    write("truncated", None, "-G", 1, stderr="JSON", raw=text[: len(text) // 2])
    write("empty-file", None, "-G", 1, stderr="JSON", raw="")
    write("not-an-object", None, "-G", 1, stderr="not a Qnet network", raw="[1, 2, 3]")
    write("nodes-not-a-list", None, "-G", 1, stderr="nodes/links", raw='{"nodes": {}, "links": 3}')
    write("deep-nesting", None, "-G", 1, stderr="JSON", raw="[" * 5000)
    write("node-without-name", None, "-G", 1, stderr="missing id/name/kind",
          raw='{"nodes": [{"id": "a", "kind": "station"}], "links": []}')
    write("too-many-links", None, "-G", 1, stderr="too large to read",
          raw='{"nodes": [], "links": [' + ", ".join(["{}"] * 10001) + "]}",
          note="10,001 links: the link scans are quadratic")


if __name__ == "__main__":
    main()
