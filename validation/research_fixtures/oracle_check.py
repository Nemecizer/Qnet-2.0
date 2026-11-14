#!/usr/bin/env python3
"""Verifies every fixture in fixtures/ without running any solver.

Each expected value is checked by a route other than the one that wrote it:
  * the numbers Plans.md section 4 prints (transcribed here, not imported);
  * the basic adjoint relationship (BAR): theta + R beta = 0 for every SRBM,
    the transform identity for product forms, and the polynomial identities
    for the bounded 1-D law;
  * exact rational arithmetic for the Harrison (E07) moments, and an
    independent angular quadrature that also rejects the misprinted
    r^(+1/2) density of P16 v1;
  * 80-digit hypoexponential sums for the Dai-Zhang (E08) sum tails.

A fixture that passes here is an oracle; `run_solvers.py` then measures the
solvers against it. Standard library only. `--quiet` prints only failures and the summary.
"""

import json
import math
import os
import random
import sys
from decimal import Decimal, getcontext
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")

failures = []
passes = []
QUIET = "--quiet" in sys.argv


def check(name, ok, detail=""):
    if not ok or not QUIET:
        print("%s  %s%s" % ("PASS" if ok else "FAIL", name, (": " + detail) if detail else ""))
    (passes if ok else failures).append(name)


def close(a, b, rtol=1e-12, atol=1e-14):
    return abs(a - b) <= atol + rtol * abs(b)


def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


def cholesky_ok(S):
    n = len(S)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = S[i][j] - sum(L[i][k] * L[j][k] for k in range(j))
            if i == j:
                if s <= 0:
                    return False
                L[i][i] = math.sqrt(s)
            else:
                L[i][j] = s / L[j][j]
    return True


# --- generic model checks ---------------------------------------------------

def check_model(fx):
    m, e = fx["model"], fx["expected"]
    d, b, S, R = m["dimension"], m["drift"], m["covariance"], m["reflection"]
    fid = fx["id"]
    shapes = (len(b) == d and len(S) == d and len(R) == d
              and all(len(r) == d for r in S) and all(len(r) == d for r in R))
    check(fid + " shapes", shapes)
    sym = all(S[i][j] == S[j][i] for i in range(d) for j in range(d))
    check(fid + " covariance symmetric positive definite", sym and cholesky_ok(S))
    if m["domain"] == "orthant":
        # BAR with f = z_i: theta + R beta = 0, beta the regulator rates.
        beta = solve(R, [-x for x in b])
        check(fid + " BAR first order: beta = -R^-1 theta > 0",
              all(x > 0 for x in beta) and all(close(x, y, 1e-11) for x, y in zip(beta, e["boundary_rates"])),
              "beta = %s" % [round(x, 12) for x in beta])


# --- product forms (E04, E06, E08) -----------------------------------------

def phi_product(rates, s):
    out = 1.0
    for g, x in zip(rates, s):
        out *= g / (g + x)
    return out


def transform_residual(R, S, b, rates, beta, s):
    """(0.5 s'Ss - b.s) phi(s) - sum_i (r_i . s) phi_i(s), with phi_i the
    face transform beta_i prod_{j != i} rates_j / (rates_j + s_j)."""
    d = len(b)
    quad = 0.5 * sum(s[i] * S[i][j] * s[j] for i in range(d) for j in range(d))
    lin = sum(b[i] * s[i] for i in range(d))
    total = (quad - lin) * phi_product(rates, s)
    scale = abs(quad * phi_product(rates, s)) + abs(lin * phi_product(rates, s))
    for i in range(d):
        ri_s = sum(R[k][i] * s[k] for k in range(d))
        face = beta[i] * phi_product([g for j, g in enumerate(rates) if j != i],
                                     [x for j, x in enumerate(s) if j != i])
        total -= ri_s * face
        scale += abs(ri_s * face)
    return abs(total) / max(scale, 1e-300)


def check_product_form(fx):
    m, e = fx["model"], fx["expected"]
    d, b, S, R = m["dimension"], m["drift"], m["covariance"], m["reflection"]
    fid = fx["id"]
    rates = e["product_form_rates"]
    # Harrison-Williams (1987) skew symmetry: 2 Gamma = R D + D R^T,
    # D = diag(Gamma_kk / R_kk).
    D = [S[k][k] / R[k][k] for k in range(d)]
    skew = all(close(2 * S[i][j], R[i][j] * D[j] + D[i] * R[j][i], 1e-13, 1e-15)
               for i in range(d) for j in range(d))
    check(fid + " Harrison-Williams skew symmetry", skew)
    u = solve(R, b)
    gamma = [-2.0 * u[k] / D[k] for k in range(d)]
    check(fid + " exponential rates gamma = -2 D^-1 R^-1 theta",
          all(close(g, r, 1e-11) for g, r in zip(gamma, rates)))
    check(fid + " means and second moments from the rates",
          all(close(mu, 1 / r) for mu, r in zip(e["mean"], rates))
          and all(close(m2, 2 / r ** 2) for m2, r in zip(e["second_moment"], rates)))
    beta = e["boundary_rates"]
    rng = random.Random(20261021)
    worst = 0.0
    for _ in range(25):
        s = [rng.uniform(0.0, 3.0) for _ in range(d)]
        worst = max(worst, transform_residual(R, S, b, rates, beta, s))
    check(fid + " BAR transform identity at 25 random points", worst < 1e-12, "max relative residual %.1e" % worst)
    if any(R[i][j] != R[j][i] for i in range(d) for j in range(d)):
        RT = [[R[j][i] for j in range(d)] for i in range(d)]
        s = [rng.uniform(0.5, 3.0) for _ in range(d)]
        wrong = transform_residual(RT, S, b, rates, beta, s)
        check(fid + " negative control: transposed R violates the identity", wrong > 1e-6,
              "relative residual %.2e" % wrong)


# --- E07: Harrison's non-product-form RBM -----------------------------------

def double_factorial_odd(n):
    out = 1
    for k in range(1, n + 1, 2):
        out *= k
    return out


def harrison_moment(p, q):
    """E[X^p Y^q] = 2^(1-p) Gamma(p+q+3/2)/sqrt(pi) * int_0^1 (1-v^2)^p v^q dv,
    exactly. Gamma(n + 3/2)/sqrt(pi) = (2n+1)!! / 2^(n+1)."""
    n = p + q
    gamma_ratio = Fraction(double_factorial_odd(2 * n + 1), 2 ** (n + 1))
    integral = Fraction(0)
    for k in range(p + 1):          # (1 - v^2)^p = sum C(p,k) (-1)^k v^(2k)
        integral += Fraction(math.comb(p, k) * (-1) ** k, 2 * k + q + 1)
    return Fraction(2) ** (1 - p) * gamma_ratio * integral


def simpson(f, a, b, n=8192):
    h = (b - a) / n
    total = f(a) + f(b)
    for i in range(1, n):
        total += (4 if i % 2 else 2) * f(a + i * h)
    return total * h / 3


def angular_moment(p, q, exponent):
    """int over the quadrant of x^p y^q r^exponent e^-(r+x) cos(psi/2),
    with the radial integral done in closed form."""
    a = p + q + 1 + exponent          # r^(p+q) from x^p y^q, r from the Jacobian
    return simpson(lambda u: math.cos(u) ** p * math.sin(u) ** q * math.cos(u / 2)
                   * math.gamma(a + 1) / (1 + math.cos(u)) ** (a + 1), 0.0, math.pi / 2)


def upper_gamma_three_halves(x):
    return math.sqrt(x) * math.exp(-x) + 0.5 * math.sqrt(math.pi) * math.erfc(math.sqrt(x))


def check_harrison(fx):
    e = fx["expected"]
    fid = fx["id"]
    norm = harrison_moment(0, 0)
    check(fid + " density integrates to 1 (exact)", norm == 1, str(norm))
    m1, m2 = harrison_moment(1, 0), harrison_moment(0, 1)
    s1, s2, xy = harrison_moment(2, 0), harrison_moment(0, 2), harrison_moment(1, 1)
    check(fid + " exact means (1/2, 3/4)", (m1, m2) == (Fraction(1, 2), Fraction(3, 4))
          and [float(m1), float(m2)] == e["mean"], "%s, %s" % (m1, m2))
    check(fid + " exact second moments (1/2, 5/4), E[XY] = 15/32",
          (s1, s2, xy) == (Fraction(1, 2), Fraction(5, 4), Fraction(15, 32))
          and [float(s1), float(s2)] == e["second_moment"] and float(xy) == e["cross_moment_12"])
    check(fid + " covariance 3/32", xy - m1 * m2 == Fraction(3, 32) and float(xy - m1 * m2) == e["covariance_12"])

    # Independent route: angular quadrature of the stated density.
    C = 2 ** 1.5 / math.sqrt(math.pi)
    quad = [C * angular_moment(p, q, -0.5) for p, q in ((0, 0), (1, 0), (0, 1))]
    check(fid + " quadrature of the density agrees", close(quad[0], 1, 1e-9)
          and close(quad[1], 0.5, 1e-9) and close(quad[2], 0.75, 1e-9),
          "mass %.12f, means %.12f %.12f" % tuple(quad))
    # The r^(+1/2) misprint in P16 v1 also integrates to one, so only the
    # means expose it; this oracle must tell the two densities apart.
    wrong = [C * angular_moment(p, q, +0.5) for p, q in ((0, 0), (1, 0), (0, 1))]
    check(fid + " misprinted r^(+1/2) density gives (0.75, 1.40625), not the oracle",
          close(wrong[0], 1, 1e-9) and close(wrong[1] / wrong[0], 0.75, 1e-9)
          and close(wrong[2] / wrong[0], 1.40625, 1e-9),
          "mass %.12f, means %.12f %.12f" % tuple(wrong))

    for t, expected in e["sum_tail"].items():
        t = float(t)
        tail = C * simpson(lambda u: math.cos(u / 2)
                           * upper_gamma_three_halves((1 + math.cos(u)) * t / (math.cos(u) + math.sin(u)))
                           / (1 + math.cos(u)) ** 1.5, 0.0, math.pi / 2)
        check(fid + " P(X+Y > %g)" % t, abs(tail - expected) <= 1e-9, "%.14g vs %.14g" % (tail, expected))


# --- E08: sum of independent Exp(j) -----------------------------------------

PLANS_E08 = {  # d: (E[S], Var[S], P(S>5), P(S>10)), Plans.md E08 table
    5: (2.283333333333333, 1.463611111111111, 0.03323878442912733, 0.000226979038211941),
    20: (3.597739657143682, 1.596163243913023, 0.1264719074229225, 0.000907607082717755),
    30: (3.994987130920391, 1.612150117601598, 0.1835768428433344, 0.001361101670851879),
}


def check_dai_zhang_sum(fx):
    d = fx["model"]["dimension"]
    fid = fx["id"]
    if d not in PLANS_E08:
        return
    mean, var, t5, t10 = PLANS_E08[d]
    rates = fx["expected"]["product_form_rates"]
    check(fid + " E[S] and Var[S] match Plans.md",
          close(sum(1 / r for r in rates), mean, 1e-15) and close(sum(1 / r ** 2 for r in rates), var, 1e-15))
    # Hypoexponential tail P(S > t) = sum_j e^{-jt} prod_{k != j} k/(k - j),
    # exact rational coefficients, 80 significant digits: it does not use the
    # max-of-exponentials identity the table was computed from.
    getcontext().prec = 80
    for t, expected in ((5, t5), (10, t10)):
        total = Decimal(0)
        for j in range(1, d + 1):
            coeff = Fraction(1)
            for k in range(1, d + 1):
                if k != j:
                    coeff *= Fraction(k, k - j)
            total += Decimal(coeff.numerator) / Decimal(coeff.denominator) * (Decimal(-j * t).exp())
        check(fid + " P(S > %d) by hypoexponential sum" % t, close(float(total), expected, 1e-13),
              "%.16g vs %.16g" % (float(total), expected))
        identity = -math.expm1(d * math.log1p(-math.exp(-t)))
        check(fid + " P(S > %d) = 1 - (1 - e^-t)^d" % t, close(identity, expected, 1e-13))


# --- E05: bounded 1-D laws --------------------------------------------------

PLANS_E05 = {  # fixture: (mean, lower rate, upper rate) as printed in Plans.md E05
    "E05a": (0.4626852792724519, 1 / (1 - math.exp(-4)), math.exp(-4) / (1 - math.exp(-4))),
    "E05b": (1.0, 0.25, 0.25),
}


def check_box(fx):
    m, e = fx["model"], fx["expected"]
    fid = fx["id"]
    d = m["dimension"]
    eye = all(m["reflection"][i][j] == (1.0 if i == j else 0.0) for i in range(d) for j in range(d))
    minus = all(m["upper_reflection"][i][j] == (-1.0 if i == j else 0.0) for i in range(d) for j in range(d))
    diag = all(m["covariance"][i][j] == 0.0 for i in range(d) for j in range(d) if i != j)
    check(fid + " normal reflection and diagonal covariance (coordinates independent)", eye and minus and diag)
    for i in range(d):
        b, v, K = m["drift"][i], m["covariance"][i][i], m["upper_bounds"][i]
        mean, second = e["mean"][i], e["second_moment"][i]
        lo, hi = e["boundary_rates"][i], e["upper_boundary_rates"][i]
        # BAR with f = x, x^2, x^3 on [0, K]: the lower face contributes
        # nothing for f' = 0 at 0 except f = x, the upper face pushes along -1.
        r1 = b + lo - hi
        r2 = 2 * b * mean + v - 2 * K * hi
        # E[X^3] closed form is not stored; check density normalization
        # through the lower rate instead: lo = (v/2) p(0).
        g = -2 * b / v
        p0 = (g / -math.expm1(-g * K)) if g != 0 else 1 / K
        check("%s coordinate %d BAR identities (f = x, x^2) and p(0)" % (fid, i + 1),
              abs(r1) < 1e-14 and abs(r2) < 1e-13 and close(lo, 0.5 * v * p0),
              "residuals %.1e, %.1e" % (r1, r2))
        # Mean as an integral of the density, by quadrature.
        if g != 0:
            dens = lambda x: g * math.exp(-g * x) / -math.expm1(-g * K)
        else:
            dens = lambda x: 1 / K
        qm = simpson(lambda x: x * dens(x), 0.0, K)
        q2 = simpson(lambda x: x * x * dens(x), 0.0, K)
        check("%s coordinate %d mean and E[X^2] by quadrature" % (fid, i + 1),
              close(qm, mean, 1e-12) and close(q2, second, 1e-12))
    if fid in PLANS_E05:
        pm, plo, phi = PLANS_E05[fid]
        check(fid + " matches the values Plans.md prints",
              close(e["mean"][0], pm, 1e-15) and close(e["boundary_rates"][0], plo, 1e-15)
              and close(e["upper_boundary_rates"][0], phi, 1e-15))


def main():
    names = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json"))
    for name in names:
        with open(os.path.join(FIXTURES, name), encoding="utf-8") as stream:
            fx = json.load(stream)
        check_model(fx)
        if fx["model"]["domain"] == "box":
            check_box(fx)
        elif "product_form_rates" in fx["expected"]:
            check_product_form(fx)
            check_dai_zhang_sum(fx)
        elif fx["id"] == "E07":
            check_harrison(fx)
        else:
            check(fx["id"] + " has an oracle check", False)
    if not QUIET:
        print()
    if failures:
        print("%d oracle check(s) failed." % len(failures))
        sys.exit(1)
    print("All %d fixtures verified as oracles (%d checks)." % (len(names), len(passes)))


if __name__ == "__main__":
    main()
