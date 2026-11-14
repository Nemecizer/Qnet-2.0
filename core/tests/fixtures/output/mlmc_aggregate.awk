  BEGIN {
    n_mu = split(mu, muarr, " ")
    n_seed = split(seeds, seedarr, " ")
    printf "SRBM MLMC (Blanchet-Chen-Glynn-Si)\n"
    printf "==============================================\n"
  }
  function process_file(path, k,    line, idx, w, native_se, fields, n, j) {
    while ((getline line < path) > 0) {
      if (line ~ /^# Dimension:/ && k == 1) { print line; continue }
      if (line ~ /^# gamma=/) {
        if (k == 1) print line
        n = split(line, fields, " ")
        for (j = 1; j <= n; j++) {
          if (fields[j] ~ /^N=/) {
            actual_n[k] = fields[j]
            sub(/^N=/, "", actual_n[k])
          }
        }
        continue
      }
      if (line ~ /^# backend=/   && k == 1) { print line; continue }
      if (line ~ /^# antithetic/) {
        if (k == 1) print line
        if (line ~ /adaptive=on/) {
          adaptive_runs++
          if (line ~ /stop=SE target achieved/) {
            stop_status[k] = "precision-met"
          } else {
            stop_status[k] = "cap-reached"
            adaptive_unmet++
          }
        } else {
          stop_status[k] = "fixed-count"
        }
        continue
      }
      if (line ~ /^# Total Gaussian/) {
        gauss_this = line
        sub(/.* /, "", gauss_this)
        total_gauss += gauss_this + 0
        continue
      }
      if (line ~ /^  *[0-9]+ +[-0-9.eE+]+ /) {
        # Native row: component, mean, standard error, 95% half-width.
        n = split(line, fields, " ")
        idx       = fields[1] + 0
        w         = fields[2] + 0
        native_se = fields[3] + 0
        sum_w[idx]  += w
        sum_w2[idx] += w * w
        run_w[k, idx] = w
        run_se[k, idx] = native_se
        if (idx > d) d = idx
      }
    }
    close(path)
  }
  END {
    for (k = 1; k <= K; k++) process_file(base "." k, k)
    printf "# Replications: %d (independent top-level streams)\n", K
    printf "# Replication seeds: %s\n", seeds
    for (k = 1; k <= K; k++)
      printf "# Replication %d: seed=%s N=%s stop=%s\n",
             k, seedarr[k], actual_n[k], stop_status[k]
    printf "#\n"
    printf "\nPer-Station Mean Queue Length (L_i = mu_i * E[Y_i]):\n"
    sumq = 0
    iw = 1; _t = d; while (_t >= 10) { iw++; _t = int(_t/10) }
    for (i = 1; i <= d; i++) {
      m   = sum_w[i] / K
      var = (K >= 2) ? (sum_w2[i] - K * m * m) / (K - 1) : 0
      if (var < 0) var = 0
      # Preserve the native within-run SE for K=1. For K>1,
      # uncertainty comes from independent replication estimates.
      se  = (K >= 2) ? sqrt(var / K) : run_se[1, i]
      mu_i = muarr[i] + 0
      L = m * mu_i
      printf "  L_%0*d = %10.4f  ± %7.4f (95%%)    (workload E[Y_%0*d] = %7.4f ± %6.4f, mu_i = %.4f)\n",
             iw, i, L, critical * se * mu_i, iw, i, m, critical * se, mu_i
      sumq += L
    }
    avgq = (d > 0) ? sumq / d : 0
    if (K >= 2 && d > 0) {
      sum_avg = 0; sum_avg2 = 0
      for (k = 1; k <= K; k++) {
        avg_run = 0
        for (i = 1; i <= d; i++)
          avg_run += (muarr[i] + 0) * run_w[k, i]
        avg_run /= d
        sum_avg += avg_run
        sum_avg2 += avg_run * avg_run
      }
      avg_var = (sum_avg2 - K * (sum_avg / K) * (sum_avg / K)) / (K - 1)
      if (avg_var < 0) avg_var = 0
      avg_se = sqrt(avg_var / K)
      printf "\nAverage queue length: %.4f  ± %.4f (95%% across independent replications)\n",
             avgq, critical * avg_se
    } else {
      printf "\nAverage queue length: %.4f (no joint CI: one run does not identify cross-station covariance)\n", avgq
    }
    printf "Total Gaussian RVs (summed over replications): %lld\n", total_gauss
    if (adaptive_runs > 0)
      # The ternary MUST stay parenthesised. /usr/bin/awk (BWK
      # one-true-awk 20200816, the macOS default) parses `>` in a
      # print/printf argument list as an output redirection, so a
      # bare `adaptive_unmet > 0 ? "no" : "yes"` is a syntax error
      # at PARSE time — which killed the whole aggregator and left
      # every MLMC run with no table, no status record and no
      # visible failure.
      printf "QNET_MLMC_STATUS_V1 adaptive=yes precision_met=%s cap_hits=%d\n",
             (adaptive_unmet > 0 ? "no" : "yes"), adaptive_unmet
    else
      printf "QNET_MLMC_STATUS_V1 adaptive=no precision_met=na cap_hits=0\n"
  }
  { }
