#!/usr/bin/env python3
"""Mutation fuzzer for infinite/BNAmd/mc_solver (the multi-class diffusion solver).

It takes valid .bnet documents, damages them (truncation, huge and negative
dimensions, NaN and infinity, missing keys, wrong types, deep nesting, damaged
bytes), runs a sanitizer build of the solver on each under a time limit, and
keeps every input on which the solver did anything other than

    exit 0, or
    exit 1 with a message on standard error.

A signal, an AddressSanitizer or UndefinedBehaviorSanitizer report, another exit
status, or a silent failure is a finding: the input, the arguments and the
solver's standard error are written to the corpus folder. A run that hits the
time limit is counted and kept under corpus/timeouts/ (a hang is not a memory
error, but it is worth a look).

Standard library only. Nothing is written outside --work and --corpus.

    python3 validation/fuzz/fuzz_mc_solver.py \
        --solver "$HOME/Library/Caches/qnet/solvers/hardening/src/infinite/BNAmd/mc_solver_asan" \
        --seeds examples --cases 5000

The same --seed and seed files give the same cases, so a finding can be made again.
"""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
import time

HUGE_INTS = [0, -1, -2, 1, 7, 8, 9, 255, 65536, 2**31 - 1, 2**31, -(2**31), 2**32, 2**63, -(2**63), 10**30]
ODD_NUMBERS = HUGE_INTS + [0.5, -0.5, 1e-320, 1e308, -1e308, 1.0000001, 2.5]
# Tokens that are not JSON numbers, or that overflow to infinity when read. They are spliced into
# the text after encoding, in place of a marker string.
RAW_TOKENS = ["NaN", "nan", "Infinity", "-Infinity", "inf", "1e999", "-1e999", "1e-999", "0x10",
              "1" + "0" * 400, "-" + "9" * 400, "1.7976931348623159e308", "--1", "1e", ".", "+1"]
PARAM_STRINGS = ["rate=nan", "rate=inf", "rate=-inf", "rate=-1", "rate=0", "rate=1e999", "rate=1e-320",
                 "rate=", "", "=", "k=0, rate=1", "k=-3, rate=2", "k=1e9, rate=1e-9", "shape=0, scale=0",
                 "shape=nan, scale=1", "min=5, max=1", "min=-1, max=-1", "value=0", "value=-4",
                 "mu=800, sigma=40", "mu=nan", "shape=1, scale=1", "shape=2, scale=inf", "lambda=0",
                 "rate=" + "9" * 400, "rate=1" + " " * 5000, "rate=1, k=4, " * 300]
DIST_NAMES = ["exponential", "erlang", "gamma", "constant", "uniform", "weibull", "lognormal", "pareto",
              "poisson", "", "Exponential", "normal", "\u0000", "x" * 5000]
NAMES = ["S1", "S0", "S8", "S9", "S999999999999999999999", "S-1", "Src1", "Src0", "Src9",
         "Src99999999999999999999", "", "1", "0", "99999999999", "S" + "1" * 300, "B1", "Sink",
         "😀", "S 2", "S2 ", "\t", "x" * 100000]
KINDS = ["source", "buffer", "station", "sink", "", "Station", "queue", "x" * 2000]
WRONG_TYPES = [None, True, False, 0, 1.5, "", "text", [], {}, [1, 2, 3], {"a": 1}, [[]], "0", "1"]
MARK = "@@RAW{}@@"


class Raw:
    """A placeholder that becomes an unquoted token in the encoded text."""

    def __init__(self, token):
        self.token = token


def walk(value, path=()):
    """Every (path, container, key) in a JSON value."""
    if isinstance(value, dict):
        for k in list(value):
            yield path + (k,), value, k
            yield from walk(value[k], path + (k,))
    elif isinstance(value, list):
        for i in range(len(value)):
            yield path + (i,), value, i
            yield from walk(value[i], path + (i,))


def nested(depth, rng):
    """Deeply nested JSON as text (a Python value that deep could not be walked or encoded)."""
    opener, closer = rng.choice([("[", "]"), ('{"k":', "}"), ('[{"nodes":', "}]")])
    closed = depth if rng.random() < 0.7 else rng.randrange(depth)  # sometimes left unbalanced
    return Raw(opener * depth + rng.choice(["1", '"x"', "null", ""]) + closer * closed)




def encode(doc, rng):
    raws = []

    def default(o):
        if isinstance(o, Raw):
            raws.append(o.token)
            return MARK.format(len(raws) - 1)
        raise TypeError

    style = rng.random()
    try:
        if style < 0.6:
            text = json.dumps(doc, indent=2, sort_keys=True, default=default, ensure_ascii=False)
        elif style < 0.8:
            text = json.dumps(doc, separators=(",", ":"), default=default)
        else:
            text = json.dumps(doc, default=default, ensure_ascii=True)
    except (ValueError, RecursionError):
        text = "{}"
    for i, token in enumerate(raws):
        text = text.replace('"' + MARK.format(i) + '"', token)
    return text.encode("utf-8", "surrogatepass")


# ── structural mutations (on the decoded document) ────────────────────────────────────────────

def m_number(doc, rng):
    spots = [(c, k) for _, c, k in walk(doc) if isinstance(c[k], (int, float)) and not isinstance(c[k], bool)]
    if spots:
        c, k = rng.choice(spots)
        c[k] = rng.choice(ODD_NUMBERS) if rng.random() < 0.6 else Raw(rng.choice(RAW_TOKENS))


def m_named_number(doc, rng):
    """The fields the solver sizes or indexes things with."""
    wanted = ("bufferSize", "numberOfServers", "customerClass", "routingProbability", "canvasScale")
    spots = [(c, k) for _, c, k in walk(doc) if k in wanted]
    for c, k in rng.sample(spots, min(len(spots), rng.choice([1, 1, 2, 5, len(spots)]))):
        c[k] = rng.choice(ODD_NUMBERS) if rng.random() < 0.6 else Raw(rng.choice(RAW_TOKENS))


def m_delete_key(doc, rng):
    spots = [(c, k) for _, c, k in walk(doc) if isinstance(c, dict)]
    for c, k in rng.sample(spots, min(len(spots), rng.choice([1, 1, 1, 3, 10]))):
        c.pop(k, None)


def m_wrong_type(doc, rng):
    spots = [(c, k) for _, c, k in walk(doc)]
    for c, k in rng.sample(spots, min(len(spots), rng.choice([1, 1, 2, 6]))):
        try:
            c[k] = copy.deepcopy(rng.choice(WRONG_TYPES))
        except (IndexError, KeyError):
            pass


def m_deep(doc, rng):
    spots = [(c, k) for _, c, k in walk(doc)]
    c, k = rng.choice(spots) if spots else (doc, "nodes")
    try:
        c[k] = nested(rng.choice([5, 50, 900, 999, 1001, 5000]), rng)
    except (IndexError, KeyError):
        pass


def m_params(doc, rng):
    spots = [(c, k) for _, c, k in walk(doc) if k == "distributionParameters"]
    for c, k in rng.sample(spots, min(len(spots), rng.choice([1, 1, 2, len(spots)]))):
        c[k] = rng.choice(PARAM_STRINGS)
    spots = [(c, k) for _, c, k in walk(doc) if k == "distribution"]
    if spots and rng.random() < 0.5:
        c, k = rng.choice(spots)
        c[k] = rng.choice(DIST_NAMES)


def m_names(doc, rng):
    nodes = doc.get("nodes") if isinstance(doc, dict) else None
    if isinstance(nodes, list) and nodes:
        for node in rng.sample(nodes, min(len(nodes), rng.choice([1, 1, 2, len(nodes)]))):
            if isinstance(node, dict):
                field = rng.choice(["name", "name", "kind", "id"])
                node[field] = rng.choice(KINDS if field == "kind" else NAMES)


def m_grow(doc, rng):
    """Many more nodes or links than the solver's fixed tables hold."""
    if not isinstance(doc, dict):
        return
    key = rng.choice(["nodes", "links"])
    items = doc.get(key)
    if isinstance(items, list) and items:
        n = rng.choice([9, 20, 200, 3000])
        extra = []
        for i in range(n):
            item = copy.deepcopy(rng.choice(items))
            if isinstance(item, dict):
                if key == "nodes" and rng.random() < 0.8:
                    item["id"] = "N%d" % i
                    if rng.random() < 0.7:
                        item["name"] = "%s%d" % (rng.choice(["S", "Src", "B", ""]), rng.choice([i, i + 1, 0]))
                if key == "links" and rng.random() < 0.5:
                    item["customerClass"] = rng.choice([i, -i, i % 9, 7, 8])
            extra.append(item)
        items.extend(extra)


def m_shuffle_links(doc, rng):
    """Point links at other nodes, at themselves, or at nothing."""
    if not isinstance(doc, dict):
        return
    nodes, links = doc.get("nodes"), doc.get("links")
    if not (isinstance(nodes, list) and isinstance(links, list) and links):
        return
    ids = [n.get("id") for n in nodes if isinstance(n, dict)] + ["", "nowhere", None]
    for link in rng.sample(links, min(len(links), rng.choice([1, 2, len(links)]))):
        if isinstance(link, dict):
            link[rng.choice(["fromNodeID", "toNodeID"])] = rng.choice(ids)


def m_service_classes(doc, rng):
    nodes = doc.get("nodes") if isinstance(doc, dict) else None
    if isinstance(nodes, list):
        for node in nodes:
            if isinstance(node, dict) and node.get("kind") == "station" and rng.random() < 0.6:
                table = {}
                for _ in range(rng.choice([1, 3, 12])):
                    key = rng.choice(["0", "1", "7", "8", "-1", "99999999999999999999", "x", "", "1.5"])
                    table[key] = rng.choice([
                        {"distribution": rng.choice(DIST_NAMES), "distributionParameters": rng.choice(PARAM_STRINGS)},
                        rng.choice(WRONG_TYPES),
                    ])
                node["serviceDistributions"] = table


STRUCTURAL = [m_number, m_named_number, m_named_number, m_delete_key, m_wrong_type, m_deep, m_params,
              m_params, m_names, m_names, m_grow, m_shuffle_links, m_service_classes]


# ── byte mutations (on the encoded text) ──────────────────────────────────────────────────────

def b_truncate(data, rng):
    return data[: rng.randrange(0, len(data) + 1)] if data else data


def b_flip(data, rng):
    if not data:
        return data
    out = bytearray(data)
    for _ in range(rng.choice([1, 1, 2, 8, 64])):
        out[rng.randrange(len(out))] = rng.randrange(256)
    return bytes(out)


def b_delete(data, rng):
    if len(data) < 2:
        return data
    a = rng.randrange(len(data))
    return data[:a] + data[a + rng.choice([1, 2, 16, 200]):]


def b_repeat(data, rng):
    if not data:
        return data
    a = rng.randrange(len(data))
    b = min(len(data), a + rng.choice([1, 8, 100, 2000]))
    return data[:a] + data[a:b] * rng.choice([2, 10, 200]) + data[b:]


def b_token(data, rng):
    """Replace one number in the text with a token that is not a finite number."""
    import re
    spots = [m.span() for m in re.finditer(rb"-?\d+(\.\d+)?([eE][-+]?\d+)?", data)]
    if not spots:
        return data
    a, b = rng.choice(spots)
    return data[:a] + rng.choice(RAW_TOKENS).encode() + data[b:]


def b_whole(data, rng):
    return rng.choice([b"", b"{", b"[", b"null", b"[]", b"{}", b"\x00", b"\xff\xfe", b'{"nodes":[],"links":[]}',
                       b'{"nodes":{},"links":{}}', b'{"nodes":[{}],"links":[{}]}', b"[" * 2000,
                       b'{"a":' * 2000, b'"' + b"x" * 100000, b'{"nodes":[' + b"1," * 50000 + b'1],"links":[]}',
                       b"\xef\xbb\xbf" + data, data + b"\x00garbage", data + data])


BYTEWISE = [b_truncate, b_truncate, b_flip, b_delete, b_repeat, b_token, b_token, b_whole]

MESH_ARGS = [["-n", "1"], ["-n", "1"], ["-n", "1"], ["-n", "2"], ["-n", "0"], ["-n", "-1"], ["-n", "abc"],
             ["-n", "99999999999999999999"], ["-n", "2147483647"], ["-n", "1e3"], ["-n", ""], ["-n"]]


def make_case(seed_docs, rng):
    """One damaged input and the arguments to run it with."""
    name, doc, raw = rng.choice(seed_docs)
    how = []
    roll = rng.random()
    if roll < 0.7:
        doc = copy.deepcopy(doc)
        for _ in range(rng.choice([1, 1, 1, 2, 3])):
            m = rng.choice(STRUCTURAL)
            try:
                m(doc, rng)
            except (AttributeError, TypeError, ValueError, IndexError, KeyError):
                pass
            how.append(m.__name__)
        data = encode(doc, rng)
        if rng.random() < 0.15:
            m = rng.choice(BYTEWISE)
            data = m(data, rng)
            how.append(m.__name__)
    else:
        data = raw
        for _ in range(rng.choice([1, 1, 2])):
            m = rng.choice(BYTEWISE)
            data = m(data, rng)
            how.append(m.__name__)

    args = [rng.choice(["-G", "-G", "-G", "-c", "", "--dump-params"])]
    if rng.random() < 0.3:
        args.append("--legacy-params")
    # A small mesh keeps a still-valid network to about a second under the sanitizers; one case in
    # six leaves the mesh to the solver or passes a damaged -n.
    args += ["-n", "1"] if rng.random() < 0.83 else rng.choice(MESH_ARGS + [[]])
    return name, how, data, [a for a in args if a != ""] if "" in args[:1] else args


def classify(returncode, stderr, timed_out):
    if timed_out:
        return "timeout"
    if b"AddressSanitizer" in stderr or b"runtime error:" in stderr or b"LeakSanitizer" in stderr:
        return "sanitizer"
    if returncode < 0:
        return "signal%d" % -returncode
    if returncode == 0:
        return "ok"
    if returncode == 1 and stderr.strip():
        return "refused"
    if returncode == 1:
        return "silent-failure"
    return "exit%d" % returncode


def run_case(job):
    index, solver, work, timeout, name, how, data, args = job
    path = os.path.join(work, "case-%06d.bnet" % index)
    with open(path, "wb") as f:
        f.write(data)
    env = dict(os.environ)
    env.setdefault("OMP_NUM_THREADS", "2")
    env["ASAN_OPTIONS"] = env.get("ASAN_OPTIONS", "detect_leaks=0:abort_on_error=0:allocator_may_return_null=1")
    env["UBSAN_OPTIONS"] = env.get("UBSAN_OPTIONS", "print_stacktrace=1:halt_on_error=1")
    started = time.time()
    timed_out = False
    try:
        done = subprocess.run([solver] + args + [path], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=timeout, env=env, cwd=work)
        code, out, err = done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired as e:
        timed_out, code, out, err = True, -9, e.stdout or b"", e.stderr or b""
    verdict = classify(code, err, timed_out)
    if verdict in ("ok", "refused"):
        os.unlink(path)
    return index, verdict, code, time.time() - started, name, how, args, path, out, err


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--solver", required=True, help="the mc_solver to run (a sanitizer build)")
    ap.add_argument("--seeds", nargs="+", required=True, help=".bnet files, or folders of them")
    ap.add_argument("--cases", type=int, default=5000)
    ap.add_argument("--seed", type=int, default=20261112, help="random seed (the cases repeat for one seed)")
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds allowed for one case")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--corpus", default=os.path.join(here, "corpus"), help="where findings are kept")
    ap.add_argument("--work", default=None, help="scratch folder (default: a new one under $TMPDIR)")
    opt = ap.parse_args()

    files = []
    for s in opt.seeds:
        if os.path.isdir(s):
            files += sorted(os.path.join(s, f) for f in os.listdir(s) if f.endswith(".bnet"))
        else:
            files.append(s)
    seed_docs = []
    for f in files:
        with open(f, "rb") as fh:
            raw = fh.read()
        try:
            seed_docs.append((os.path.basename(f), json.loads(raw), raw))
        except ValueError:
            print("skipping %s: not JSON" % f, file=sys.stderr)
    if not seed_docs:
        sys.exit("no usable seed files")

    work = opt.work or tempfile.mkdtemp(prefix="qnet-fuzz-mc-")
    os.makedirs(work, exist_ok=True)
    rng = random.Random(opt.seed)
    solver = os.path.abspath(opt.solver)

    def jobs():
        for i in range(opt.cases):
            name, how, data, args = make_case(seed_docs, rng)
            yield (i, solver, work, opt.timeout, name, how, data, args)

    counts, findings, slowest = {}, [], 0.0
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=opt.jobs) as pool:
        for index, verdict, code, took, name, how, args, path, out, err in pool.map(run_case, jobs()):
            counts[verdict] = counts.get(verdict, 0) + 1
            slowest = max(slowest, took)
            if verdict not in ("ok", "refused"):
                with open(path, "rb") as f:
                    data = f.read()
                digest = hashlib.sha256(data + " ".join(args).encode()).hexdigest()[:16]
                folder = os.path.join(opt.corpus, "timeouts") if verdict == "timeout" else opt.corpus
                os.makedirs(folder, exist_ok=True)
                base = os.path.join(folder, "%s-%s" % (verdict, digest))
                with open(base + ".bnet", "wb") as f:
                    f.write(data)
                with open(base + ".txt", "w") as f:
                    f.write("verdict: %s (exit %d) after %.1f s\n" % (verdict, code, took))
                    f.write("arguments: %s\n" % " ".join(args))
                    f.write("made from: %s by %s (seed %d, case %d)\n" % (name, ", ".join(how), opt.seed, index))
                    f.write("standard error (first 4000 bytes):\n")
                    f.write(err[:4000].decode("utf-8", "replace"))
                os.unlink(path)
                findings.append((verdict, base + ".bnet"))
                print("FINDING %s: %s" % (verdict, base + ".bnet"), flush=True)
            if (index + 1) % 500 == 0:
                print("%d cases, %.0f s: %s" % (index + 1, time.time() - started,
                                                ", ".join("%s %d" % kv for kv in sorted(counts.items()))), flush=True)

    print("\n%d cases in %.0f s (slowest %.1f s), seed %d" % (opt.cases, time.time() - started, slowest, opt.seed))
    for verdict, n in sorted(counts.items()):
        print("  %-16s %d" % (verdict, n))
    bad = [f for f in findings if f[0] != "timeout"]
    if bad:
        print("\n%d finding(s) kept in %s" % (len(bad), opt.corpus))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
