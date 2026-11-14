printf '\033[A\033[2K'
printf '%s\n' "$$" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_pid_74825_58fa6c5c-a42b-4033-b376-01a14a5eaa20.txt"
trap 'printf "%s\n" "${_rc:-130}" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_done_74825_58fa6c5c-a42b-4033-b376-01a14a5eaa20.txt" ; rm -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_74825.pl"' EXIT
_t0=$(perl -MTime::HiRes=time -e 'print time')
{
  printf '══════════════════════════════════════════════════════════════════\n'
printf 'Infinite Spectral Convergence — 2 cases × 3 ρ values\n'
printf '  Stations:  2…3\n'
printf '  Classes:   1…1\n'
printf '  ρ sweep:   %.3f → %.3f step %.3f  (3 values)\n' 0.5 0.7 0.1
printf '  Topology:  feed-forward\n'
printf '  Base seed: 20261112\n'
printf '  Reference: Sim   |   Baseline: QNA\n'
printf '──────────────────────────────────────────────────────────────────\n'
printf '  [%d/2] d=%d K=%d  (3 ρ values)\n' 1 2 1
_pfx=$(printf '      ρ=%.3f' 0.5)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsm/bnet" -c "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r0.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r0_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAqna/bna_qna" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r0.qna" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r0_QNA.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsim/jackson_sim" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r0.sim" -c -n 8 -w 10000 -r 200000 -s 1419347312 > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r0_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
_pfx=$(printf '      ρ=%.3f' 0.6)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsm/bnet" -c "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r1.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r1_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAqna/bna_qna" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r1.qna" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r1_QNA.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsim/jackson_sim" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r1.sim" -c -n 8 -w 10000 -r 200000 -s 1419347312 > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r1_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
_pfx=$(printf '      ρ=%.3f' 0.7)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsm/bnet" -c "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r2.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r2_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAqna/bna_qna" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r2.qna" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r2_QNA.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsim/jackson_sim" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_0_r2.sim" -c -n 8 -w 10000 -r 200000 -s 1419347312 > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_0_r2_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
printf '  [%d/2] d=%d K=%d  (3 ρ values)\n' 2 2 1
_pfx=$(printf '      ρ=%.3f' 0.5)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsm/bnet" -c "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r0.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r0_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAqna/bna_qna" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r0.qna" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r0_QNA.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsim/jackson_sim" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r0.sim" -c -n 8 -w 10000 -r 200000 -s 993486962 > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r0_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
_pfx=$(printf '      ρ=%.3f' 0.6)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsm/bnet" -c "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r1.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r1_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAqna/bna_qna" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r1.qna" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r1_QNA.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsim/jackson_sim" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r1.sim" -c -n 8 -w 10000 -r 200000 -s 993486962 > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r1_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
_pfx=$(printf '      ρ=%.3f' 0.7)
printf '%s [ ]' "$_pfx"
_t0=$(perl -MTime::HiRes=time -e 'print time')
{ "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsm/bnet" -c "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r2.smin" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r2_Spectral.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAqna/bna_qna" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r2.qna" -c > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r2_QNA.txt" 2>/dev/null ; "/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAsim/jackson_sim" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/case_1_r2.sim" -c -n 8 -w 10000 -r 200000 -s 993486962 > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276/out_1_r2_Sim.txt" 2>/dev/null ; } &
_pid=$!
( _i=0 ; _ch='|/-\\' ; while kill -0 $_pid 2>/dev/null ; do sleep 0.15 ; _i=$(( (_i + 1) % 4 )) ; _c=$(printf '%s' "$_ch" | cut -c$((_i + 1))) ; printf '\r%s [%s]' "$_pfx" "$_c" ; done ) &
_poll=$!
wait $_pid
kill $_poll 2>/dev/null ; wait $_poll 2>/dev/null
_el=$(perl -MTime::HiRes=time -e 'printf("%.2f", time - '"$_t0"')')
printf '\r%s done in %ss\n' "$_pfx" "$_el"
awk -v RHO_LIST="0.500000,0.600000,0.700000" '
BEGIN { n_rho = split(RHO_LIST, rho_list, ",") }
FNR == 1 {
  # Filename: <workDir>/out_<caseIdx>_r<rhoIdx>_<algo>.txt
  nm = FILENAME
  sub(/.*\/out_/, "", nm)
  sub(/\.txt$/, "", nm)
  # Split on underscore: <case>_r<rhoIdx>_<algo>
  split(nm, parts, "_")
  cur_case = parts[1] + 0
  rtok = parts[2]; sub(/^r/, "", rtok); cur_rho = rtok + 0
  cur_algo = parts[3]
}
{
  if ($1 ~ /^E\[Q_[0-9]+\]$/ && $2 == "=") {
    s = $1; sub(/^E\[Q_/, "", s); sub(/\]$/, "", s)
    k = s + 0
    val[cur_case, cur_rho, cur_algo, k] = $3 + 0
    have[cur_case, cur_rho, cur_algo, k] = 1
    if (k > nstn[cur_case, cur_rho]) nstn[cur_case, cur_rho] = k
    cases[cur_case] = 1
  }
}
END {
  # For each (case, rho), compute per-algo mean-abs-%err vs Sim.
  for (c in cases) {
    for (ri = 0; ri < n_rho; ri++) {
      n = nstn[c, ri]
      if (n < 1) continue
      if (!((c SUBSEP ri SUBSEP "Sim" SUBSEP 1) in have)) continue
      for (algo_i = 1; algo_i <= 2; algo_i++) {
        algo = (algo_i == 1 ? "Spectral" : "QNA")
        sum = 0; cnt = 0
        for (k = 1; k <= n; k++) {
          if (have[c, ri, "Sim", k] && have[c, ri, algo, k]) {
            rv = val[c, ri, "Sim", k]
            av = val[c, ri, algo, k]
            if (rv > 1e-9 || rv < -1e-9) {
              d = av - rv; if (d < 0) d = -d
              sum += d / (rv > 0 ? rv : -rv) * 100
              cnt++
            }
          }
        }
        if (cnt > 0) {
          ce = sum / cnt
          err_sum[ri, algo] += ce
          err_n[ri, algo] += 1
          if (ce > err_max[ri, algo]) err_max[ri, algo] = ce
        }
      }
      # Average-of-Algorithms case-error: per-station mean of
      # Spectral and QNA, then |Δ|/|ref|·100% averaged over k.
      sum_avg = 0; cnt_avg = 0
      for (k = 1; k <= n; k++) {
        if (!have[c, ri, "Sim", k]) continue
        rv = val[c, ri, "Sim", k]
        if (!(rv > 1e-9 || rv < -1e-9)) continue
        ssum = 0; scnt = 0
        if (have[c, ri, "Spectral", k]) { ssum += val[c, ri, "Spectral", k]; scnt++ }
        if (have[c, ri, "QNA",      k]) { ssum += val[c, ri, "QNA",      k]; scnt++ }
        if (scnt > 0) {
          avg_v = ssum / scnt
          d = avg_v - rv; if (d < 0) d = -d
          sum_avg += d / (rv > 0 ? rv : -rv) * 100
          cnt_avg++
        }
      }
      if (cnt_avg > 0) {
        ce = sum_avg / cnt_avg
        err_sum[ri, "Avg"] += ce
        err_n[ri, "Avg"]   += 1
      }
    }
  }
  printf "\n"
  printf "%-7s  %14s  %12s  %12s  %14s  %5s\n", "ρ", "Spectral mean", "Spectral max", "QNA mean", "Avg-algos mean", "N"
  printf "───────────────────────────────────────────────────────────────────────────────────\n"
  for (ri = 0; ri < n_rho; ri++) {
    sn = err_n[ri, "Spectral"] + 0
    qn = err_n[ri, "QNA"] + 0
    an = err_n[ri, "Avg"] + 0
    if (sn == 0 && qn == 0 && an == 0) {
      printf "%-7.3f  %14s  %12s  %12s  %14s  %5d\n", rho_list[ri+1], "—", "—", "—", "—", 0
      continue
    }
    sm = (sn > 0 ? err_sum[ri, "Spectral"] / sn : 0)
    smax = (sn > 0 ? err_max[ri, "Spectral"] : 0)
    qm = (qn > 0 ? err_sum[ri, "QNA"] / qn : 0)
    am = (an > 0 ? err_sum[ri, "Avg"] / an : 0)
    nmax = sn; if (qn > nmax) nmax = qn; if (an > nmax) nmax = an
    printf "%-7.3f  %13.2f%%  %11.2f%%  %11.2f%%  %13.2f%%  %5d\n", rho_list[ri+1], sm, smax, qm, am, nmax
  }
  printf "\n"
  printf "Each row: per-case mean abs %% error of E[Q_k] vs Sim, averaged across\n"
  printf "the cases that reached that rho.  Spectral converges toward the QNA\n"
  printf "accuracy band as rho approaches 1 (heavy-traffic regime); QNA stays\n"
  printf "flat near zero for the Markovian-style random networks generated here.\n"
  printf "══════════════════════════════════════════════════════════════════\n"
}' "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276"/out_*.txt
rm -rf "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spc_74825_1794373645276"

  _command_rc=$?
  perl -MTime::HiRes=time -e 'printf("Elapsed time: %.3fs\n\n", time - '"$_t0"')'
  exit $_command_rc
} 2>&1 | tee "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_output_74825_58fa6c5c-a42b-4033-b376-01a14a5eaa20.log" | { if [ -r "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_74825.pl" ]; then exec perl "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_74825.pl" 3; else exec cat; fi; }
_rc=${PIPESTATUS[0]}
exit $_rc