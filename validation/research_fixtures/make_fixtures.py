#!/usr/bin/env python3
"""Writes the exact SRBM fixtures of Plans.md section 4 as JSON.

Each fixture is computed here from its closed form, never copied from a
solver run. `oracle_check.py` then verifies every file a second way (the
numbers Plans.md prints, BAR identities, exact rational moments), so a slip
in this script is caught there rather than trusted.

Conventions, shared with `run_solvers.py`:
  * `covariance` is the covariance matrix Gamma (the generator is
    0.5 * sum Gamma_ij d_ij + drift . grad), never a square root or Gamma/2.
  * `reflection` is d x d, row-major, and its COLUMN j is the direction
    pushed along on the face {z_j = 0}. `upper_reflection` (box only) is the
    same for the faces {z_j = K_j}.
  * Boundary rates are regulator rates E[Y_j(1)], not probabilities.

Run from anywhere: python3 make_fixtures.py
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")


def dumps(value, indent=0):
    """JSON with every list of numbers on one line, so a matrix reads as rows."""
    pad = "  " * indent
    if isinstance(value, dict):
        items = ["%s  %s: %s" % (pad, json.dumps(k), dumps(v, indent + 1)) for k, v in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(value, list) and value and isinstance(value[0], list):
        rows = ["%s  %s" % (pad, dumps(row, indent + 1)) for row in value]
        return "[\n" + ",\n".join(rows) + "\n" + pad + "]"
    return json.dumps(value)


def write(fixture):
    path = os.path.join(OUT, fixture["id"] + ".json")
    with open(path, "w", encoding="utf-8") as stream:
        stream.write(dumps(fixture) + "\n")
    print("wrote", os.path.relpath(path, HERE))


def product_form_orthant(fid, title, source, evidence, reflection, covariance, drift, rates, notes):
    """Independent exponential coordinates with the given rates."""
    d = len(drift)
    boundary = [0.5 * covariance[k][k] * rates[k] / reflection[k][k] for k in range(d)]
    write({
        "id": fid,
        "title": title,
        "evidence": evidence,
        "source": source,
        "model": {
            "domain": "orthant",
            "dimension": d,
            "drift": drift,
            "covariance": covariance,
            "reflection": reflection,
        },
        "expected": {
            "mean": [1.0 / r for r in rates],
            "second_moment": [2.0 / (r * r) for r in rates],
            "covariance_offdiagonal_zero": True,
            "product_form_rates": rates,
            "boundary_rates": boundary,
        },
        "notes": notes,
    })


def truncated_exponential(b, var, K):
    """Stationary law of a 1-D RBM on [0, K]: drift b, variance var, normal
    reflection. Density proportional to exp(-g x) with g = -2b/var."""
    g = -2.0 * b / var
    if g == 0.0:
        density0 = densityK = 1.0 / K
        mean = K / 2.0
        second = K * K / 3.0
    else:
        z = -math.expm1(-g * K)               # 1 - exp(-gK)
        density0 = g / z
        densityK = g * math.exp(-g * K) / z
        mean = 1.0 / g - K / math.expm1(g * K)
        # E[X^2] = 2/g^2 - (K^2 + 2K/g) e^{-gK} / (1 - e^{-gK})
        second = 2.0 / (g * g) - (K * K + 2.0 * K / g) * math.exp(-g * K) / z
    return {
        "mean": mean,
        "second_moment": second,
        "lower_rate": 0.5 * var * density0,
        "upper_rate": 0.5 * var * densityK,
    }


def box_tensor(fid, title, source, evidence, drifts, variances, bounds, notes):
    d = len(drifts)
    parts = [truncated_exponential(b, v, K) for b, v, K in zip(drifts, variances, bounds)]
    eye = [[1.0 if i == j else 0.0 for j in range(d)] for i in range(d)]
    write({
        "id": fid,
        "title": title,
        "evidence": evidence,
        "source": source,
        "model": {
            "domain": "box",
            "dimension": d,
            "drift": drifts,
            "covariance": [[variances[i] if i == j else 0.0 for j in range(d)] for i in range(d)],
            "reflection": eye,
            "upper_bounds": bounds,
            "upper_reflection": [[-x if x else 0.0 for x in row] for row in eye],
        },
        "expected": {
            "mean": [p["mean"] for p in parts],
            "second_moment": [p["second_moment"] for p in parts],
            "covariance_offdiagonal_zero": True,
            "boundary_rates": [p["lower_rate"] for p in parts],
            "upper_boundary_rates": [p["upper_rate"] for p in parts],
        },
        "notes": notes,
    })


def dai_zhang(d):
    R = [[1.0 if i == j else (-1.0 if i == j + 1 else 0.0) for j in range(d)] for i in range(d)]
    S = [[2.0 if i == j else (-1.0 if abs(i - j) == 1 else 0.0) for j in range(d)] for i in range(d)]
    return R, S, [-1.0] * d, [float(j) for j in range(1, d + 1)]


def main():
    os.makedirs(OUT, exist_ok=True)

    product_form_orthant(
        "E04", "One-dimensional orthant RBM",
        "Plans.md section 4, E04", "derived_exact",
        [[1.0]], [[2.0]], [-1.0], [1.0],
        "Stationary law Exp(1); beta = 1. A solver that confuses Gamma with Gamma/2 reads 0.5 or 2.")

    product_form_orthant(
        "E06", "Skew-symmetric 2-D RBM with a nonsymmetric R",
        "Plans.md section 4, E06; P24 (Dai-Zhang BAR LP) PDF p17, Table 3, example 3", "published_exact",
        [[1.0, -0.6], [-0.25, 1.0]], [[1.0, -0.425], [-0.425, 1.0]], [-0.85, 0.0], [2.0, 0.5],
        "R is not symmetric, so a solver that reads R by rows instead of columns solves a different SRBM.")

    # E07: Harrison's non-product-form RBM. Moments from Plans.md, rederived
    # exactly in oracle_check.py from the stationary density.
    write({
        "id": "E07",
        "title": "Harrison non-product-form 2-D RBM",
        "evidence": "published_exact",
        "source": "Plans.md section 4, E07; P24 PDF p15, example 1",
        "model": {
            "domain": "orthant",
            "dimension": 2,
            "drift": [-1.0, 0.0],
            "covariance": [[1.0, 0.0], [0.0, 1.0]],
            "reflection": [[1.0, 0.0], [-1.0, 1.0]],
        },
        "expected": {
            "mean": [0.5, 0.75],
            "second_moment": [0.5, 1.25],
            "cross_moment_12": 15.0 / 32.0,
            "covariance_12": 3.0 / 32.0,
            "boundary_rates": [1.0, 1.0],
            "sum_tail": {"1": 0.48392385851224, "2": 0.18736229631151,
                         "5": 0.0095217236897292, "10": 0.000064204953144813},
        },
        "notes": "Exact but not product form: the coordinates are dependent (Cov = 3/32). "
                 "A product-form solver cannot pass this by accident.",
    })

    for d in (3, 5, 20, 30):
        R, S, b, rates = dai_zhang(d)
        product_form_orthant(
            "E08_d%d" % d, "Dai-Zhang product-form family, d = %d" % d,
            "Plans.md section 4, E08; P16 (Dai-Zhang neural BAR) Appendix A, PDF pp11-12", "published_exact",
            R, S, b, rates,
            "Z_j ~ Exp(rate j), independent. Sum S has P(S <= t) = (1 - e^-t)^d.")

    box_tensor(
        "E05a", "Bounded 1-D RBM on [0, 2] with drift",
        "Plans.md section 4, E05", "derived_exact",
        [-1.0], [1.0], [2.0],
        "Mean 1/2 - 2/expm1(4). Lower minus upper regulator rate equals 1.")
    box_tensor(
        "E05b", "Bounded driftless 1-D RBM on [0, 2]",
        "Plans.md section 4, E05", "derived_exact",
        [0.0], [1.0], [2.0],
        "Uniform on [0, 2]: mean 1, both regulator rates 1/4.")
    box_tensor(
        "E05c", "2-D box, independent coordinates, unequal sides and drifts",
        "Plans.md section 4, E05 (tensor product)", "derived_exact",
        [-1.0, 0.5], [1.0, 2.0], [2.0, 3.0],
        "Coordinate 2 drifts upward, so its mass piles against the upper face. "
        "Distinct K_i and drifts catch a solver that swaps axes or faces.")


if __name__ == "__main__":
    main()
