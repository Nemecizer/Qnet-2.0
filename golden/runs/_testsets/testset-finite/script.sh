printf '\033[A\033[2K'
printf '%s\n' "$$" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_pid_74825_510cc519-5803-4f86-808c-8fce946978d3.txt"
trap 'printf "%s\n" "${_rc:-130}" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_done_74825_510cc519-5803-4f86-808c-8fce946978d3.txt" ; rm -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_74825.pl"' EXIT
_t0=$(perl -MTime::HiRes=time -e 'print time')
{
  printf '══════════════════════════════════════════════════════════════════\n'
printf 'Finite Test Set — 3 cases\n'
printf '  Stations:  2…3\n'
printf '  Classes:   1…2\n'
printf '  ρ range:   %.2f…%.2f\n' 0.5 0.85
printf '  Topology:  feed-forward\n'
printf '  Base seed: 20261111\n'
printf '  Reference: Sim\n'
printf '──────────────────────────────────────────────────────────────────\n'
_pfx=$(printf '  [%d/3] d=%d K=%d ρ=%.3f' 1 3 1 0.8065065694877607)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAsm/srbm_solver" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_0.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_0_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAfm/bna_fm_gauss" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_0.fmin" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_0_FE.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAlp/fBNAlp_solver" --input "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_0.lpin" --solver highs -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_0_LP.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAsim/fBNAsim" -G -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_0.sim" -n 8 -w 10000 -T 200000 -s 1667127313 -e > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_0_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
_pfx=$(printf '  [%d/3] d=%d K=%d ρ=%.3f' 2 2 2 0.6722246405982715)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAsm/srbm_solver" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_1.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_1_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAfm/bna_fm_gauss" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_1.fmin" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_1_FE.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAlp/fBNAlp_solver" --input "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_1.lpin" --solver highs -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_1_LP.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAsim/fBNAsim" -G -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_1.sim" -n 8 -w 10000 -T 200000 -s 1705805618 -e > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_1_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
_pfx=$(printf '  [%d/3] d=%d K=%d ρ=%.3f' 3 3 1 0.6732534647719599)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAsm/srbm_solver" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_2.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_2_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAfm/bna_fm_gauss" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_2.fmin" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_2_FE.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAlp/fBNAlp_solver" --input "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_2.lpin" --solver highs -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_2_LP.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/finite/fBNAsim/fBNAsim" -G -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/case_2.sim" -n 8 -w 10000 -T 200000 -s 1257666572 -e > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848/out_2_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
awk -v VAR="X" -v ALGOS="Spectral,FE,LP,Sim" -v REF="Sim" '
BEGIN {
  n_algos = split(ALGOS, algos, ",")
}
FNR == 1 {
  # Filename pattern: <workDir>/out_<idx>_<algo>.txt
  nm = FILENAME
  sub(/.*\/out_/, "", nm)
  sub(/\.txt$/, "", nm)
  split(nm, parts, "_")
  cur_case = parts[1] + 0
  cur_algo = parts[2]
  seen_case[cur_case] = 1
}
{
  # Match "E[<VAR>_k] = value". $1 = "E[<VAR>_k]", $3 = value.
  if ($1 ~ "^E\\[" VAR "_[0-9]+\\]$" && $2 == "=") {
    s = $1; sub("^E\\[" VAR "_", "", s); sub("\\]$", "", s)
    k = s + 0
    eq[cur_case, cur_algo, k] = $3 + 0
    have_k[cur_case, cur_algo, k] = 1
    if (k > nstn[cur_case]) nstn[cur_case] = k
  }
}
END {
  # Per (algo): collect per-case mean abs % error vs REF.
  # Also collect the ensemble ("Average of Algorithms") case
  # error by averaging every non-REF algorithm at each station
  # for that case, then computing the same |Δ|/|ref|·100% summary.
  # Track the single largest per-station error per algorithm
  # across the entire sweep ("worst station" column).
  AVG_IDX = n_algos + 1   # synthetic algo slot for the ensemble
  for (t in seen_case) {
    if (!((t SUBSEP REF SUBSEP 1) in have_k)) continue
    n = nstn[t]
    if (n < 1) continue
    for (a = 1; a <= n_algos; a++) {
      algo = algos[a]
      if (algo == REF) continue
      sum = 0; cnt = 0
      for (k = 1; k <= n; k++) {
        if (have_k[t, REF, k] && have_k[t, algo, k]) {
          rv = eq[t, REF, k]
          av = eq[t, algo, k]
          if (rv > 1e-9 || rv < -1e-9) {
            d = av - rv; if (d < 0) d = -d
            pct = d / (rv > 0 ? rv : -rv) * 100
            sum += pct
            cnt++
            if (pct > worst_station[a]) worst_station[a] = pct
          }
        }
      }
      if (cnt > 0) {
        ce = sum / cnt
        case_err[a, ++case_count[a]] = ce
      }
    }
    # Ensemble row: per-station mean across all non-REF algos.
    sum_avg = 0; cnt_avg = 0
    for (k = 1; k <= n; k++) {
      if (!have_k[t, REF, k]) continue
      rv = eq[t, REF, k]
      if (!(rv > 1e-9 || rv < -1e-9)) continue
      ssum = 0; scnt = 0
      for (a = 1; a <= n_algos; a++) {
        algo = algos[a]
        if (algo == REF) continue
        if (have_k[t, algo, k]) { ssum += eq[t, algo, k]; scnt++ }
      }
      if (scnt > 0) {
        avg_v = ssum / scnt
        d = avg_v - rv; if (d < 0) d = -d
        pct = d / (rv > 0 ? rv : -rv) * 100
        sum_avg += pct
        cnt_avg++
        if (pct > worst_station[AVG_IDX]) worst_station[AVG_IDX] = pct
      }
    }
    if (cnt_avg > 0) {
      ce = sum_avg / cnt_avg
      case_err[AVG_IDX, ++case_count[AVG_IDX]] = ce
    }
  }
  # Header. First column widened to fit "Average of Algorithms".
  printf "\n"
  printf "%-22s  %10s  %8s  %8s  %8s  %12s  %5s\n", "Algorithm", "Mean %err", "P50", "P90", "Max", "Worst station", "N"
  printf "──────────────────────────────────────────────────────────────────────────────────────────\n"
  # Helper: print one row from a case_err slot, computing the
  # quantile summary and a label that may include " (ref)".
  # Implemented inline (no awk functions needed).
  for (a = 1; a <= n_algos; a++) {
    algo = algos[a]
    if (algo == REF) continue
    cn = case_count[a] + 0
    if (cn == 0) {
      printf "%-22s  %10s  %8s  %8s  %8s  %12s  %5d\n", algo, "—", "—", "—", "—", "—", 0
      continue
    }
    # Sort case_err[a,1..cn] ascending (insertion sort; small N).
    for (i = 1; i <= cn; i++) sorted[i] = case_err[a, i]
    for (i = 2; i <= cn; i++) {
      v = sorted[i]; j = i - 1
      while (j >= 1 && sorted[j] > v) { sorted[j+1] = sorted[j]; j-- }
      sorted[j+1] = v
    }
    mean = 0; for (i = 1; i <= cn; i++) mean += sorted[i]; mean /= cn
    pi50 = int((cn - 1) * 0.50 + 1.5); if (pi50 > cn) pi50 = cn
    pi90 = int((cn - 1) * 0.90 + 1.5); if (pi90 > cn) pi90 = cn
    p50  = sorted[pi50]; p90 = sorted[pi90]; mx = sorted[cn]
    ws = worst_station[a] + 0
    printf "%-22s  %9.2f%%  %7.2f%%  %7.2f%%  %7.2f%%  %11.2f%%  %5d\n", algo, mean, p50, p90, mx, ws, cn
    delete sorted
  }
  # Ensemble row.
  cn = case_count[AVG_IDX] + 0
  if (cn > 0) {
    for (i = 1; i <= cn; i++) sorted[i] = case_err[AVG_IDX, i]
    for (i = 2; i <= cn; i++) {
      v = sorted[i]; j = i - 1
      while (j >= 1 && sorted[j] > v) { sorted[j+1] = sorted[j]; j-- }
      sorted[j+1] = v
    }
    mean = 0; for (i = 1; i <= cn; i++) mean += sorted[i]; mean /= cn
    pi50 = int((cn - 1) * 0.50 + 1.5); if (pi50 > cn) pi50 = cn
    pi90 = int((cn - 1) * 0.90 + 1.5); if (pi90 > cn) pi90 = cn
    p50  = sorted[pi50]; p90 = sorted[pi90]; mx = sorted[cn]
    ws = worst_station[AVG_IDX] + 0
    printf "%-22s  %9.2f%%  %7.2f%%  %7.2f%%  %7.2f%%  %11.2f%%  %5d\n", "Average of Algorithms", mean, p50, p90, mx, ws, cn
    delete sorted
  } else {
    printf "%-22s  %10s  %8s  %8s  %8s  %12s  %5d\n", "Average of Algorithms", "—", "—", "—", "—", "—", 0
  }
  # Reference line for completeness.
  ref_n = 0; for (t in seen_case) if ((t SUBSEP REF SUBSEP 1) in have_k) ref_n++
  printf "%-22s  %10s  %8s  %8s  %8s  %12s  %5d\n", REF " (ref)", "—", "—", "—", "—", "—", ref_n
  printf "\n"
  printf "All numeric columns are percent errors.  Per case, err = mean over\n"
  printf "stations of |algo_k - ref_k| / |ref_k| * 100%%, with ref = %s.\n", REF
  printf "Mean = average across cases; P50 / P90 = 50th / 90th percentile;\n"
  printf "Max = single worst case; N = cases that contributed to the row.\n"
  printf "Worst station = the single largest |algo_k - ref_k|/|ref_k|*100 seen at\n"
  printf "any station in any case (highlights where this algorithm struggles).\n"
  printf "Average of Algorithms: per case and per station, the unweighted mean\n"
  printf "of every non-reference algorithm cell, then the same error summary.\n"
  printf "══════════════════════════════════════════════════════════════════════════════════════════\n"
}' "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848"/out_*.txt
rm -rf "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_testset_74825_1794373643848"

  _command_rc=$?
  perl -MTime::HiRes=time -e 'printf("Elapsed time: %.3fs\n\n", time - '"$_t0"')'
  exit $_command_rc
} 2>&1 | tee "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_output_74825_510cc519-5803-4f86-808c-8fce946978d3.log" | { if [ -r "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_74825.pl" ]; then exec perl "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_74825.pl" 3; else exec cat; fi; }
_rc=${PIPESTATUS[0]}
exit $_rc