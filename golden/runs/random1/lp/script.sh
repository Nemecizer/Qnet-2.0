printf '\033[A\033[2K'
printf '%s\n' "$$" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_pid_42076_86cb7522-fd19-4fcd-953a-2c45ea09e928.txt"
trap 'printf "%s\n" "${_rc:-130}" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_done_42076_86cb7522-fd19-4fcd-953a-2c45ea09e928.txt" ; rm -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_42076.pl"' EXIT
_t0=$(perl -MTime::HiRes=time -e 'print time')
{
  printf 'Running Linear Program (BNAlp, Saure-Glynn-Zeevi 2008)\n'
printf '%s\n\n' 'auto-scaled for d=4: grid_n=12, basis_m=4'
MU='0.81689999999999996 0.8173999999999999 0.85990733638543126 0.74573333333333336'
SERVERS='1 1 1 1'
set -o pipefail
"/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAlp/srbm_lp" --input "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_lp_42076_s0.in"  2>&1 | tee "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_lp_42076_s0.out"
RC=${PIPESTATUS[0]}
if [ $RC -ne 0 ]; then printf '\nSolver exited with code %d.\n' "$RC"; exit $RC; fi
printf '\n'
awk -v mu="$MU" -v servers="$SERVERS" '
  BEGIN {
    nMu = split(mu,      muarr, " ")
    nSv = split(servers, svarr, " ")
  }
  /^\[Solve\] Optimal/       { u_star=$4; solver_line=$0; next }
  /^\[Solve\] Using solver:/ { solver_name=$NF; next }
  /^\[Total\]/               { total_s=$2 "s"; next }
  /^  grid_n/                 { grid_n=$NF; next }
  /^  basis_m/                { basis_m=$NF; next }
  /^\[Build LP\]/            { build_line=$0; next }
  /^E\[X_[0-9]+\] = /        {
    m = match($1, /[0-9]+/)
    idx = substr($1, RSTART, RLENGTH) + 0
    workloads[idx] = $NF + 0
    if (idx > d) d = idx
    next
  }
  END {
    printf "Linear Program (Saure-Glynn-Zeevi 2008 LP)\n"
    printf "==========================================\n\n"
    printf "Solver: %s  |  grid_n = %s  |  basis_m = %s\n",
           solver_name, grid_n, basis_m
    if (build_line  != "") print build_line
    if (solver_line != "") print solver_line
    if (total_s     != "") printf "[Total] %s\n", total_s
    printf "\n%-6s %-8s %-16s %-16s %-10s\n",
           "Node","Servers","E[Y] (workload)","L = mu·E[Y]","mu_i"
    sumL = 0
    for (i = 1; i <= d; i++) {
      mu_i = muarr[i] + 0
      sv   = (i <= nSv ? svarr[i] : 1)
      L    = workloads[i] * mu_i
      printf "%-6d %-8d %-16.4f %-16.4f %-10.4f\n",
             i, sv, workloads[i], L, mu_i
      sumL += L
    }
    printf "\nNetwork Totals:\n"
    if (d > 0) {
      printf "  Total E[N]:             %.4f\n", sumL
      printf "  Average queue length:   %.4f\n", sumL / d
    }
  }
' "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_lp_42076_s0.out"
rm -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_lp_42076_s0.in" "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_lp_42076_s0.out"
  _command_rc=$?
  perl -MTime::HiRes=time -e 'printf("Elapsed time: %.3fs\n\n", time - '"$_t0"')'
  exit $_command_rc
} 2>&1 | tee "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_output_42076_86cb7522-fd19-4fcd-953a-2c45ea09e928.log" | { if [ -r "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_42076.pl" ]; then exec perl "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_42076.pl" 3; else exec cat; fi; }
_rc=${PIPESTATUS[0]}
exit $_rc