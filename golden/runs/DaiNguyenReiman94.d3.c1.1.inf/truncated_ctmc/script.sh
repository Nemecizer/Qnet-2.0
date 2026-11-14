printf '\033[A\033[2K'
printf '%s\n' "$$" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_pid_25080_3ecfd29e-7d95-4c16-8b8c-f14d6bb213a9.txt"
trap 'printf "%s\n" "${_rc:-130}" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_done_25080_3ecfd29e-7d95-4c16-8b8c-f14d6bb213a9.txt" ; rm -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_25080.pl"' EXIT
_t0=$(perl -MTime::HiRes=time -e 'print time')
{
  printf 'Solving adaptive truncated CTMC (C) ...  [ ]%52s%6.1fs' '' 0.0 ; _t0=$(perl -MTime::HiRes=time -e 'print time') ; { (
  cleanup_qnet_solver_inputs() { rm -f '/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/qnet_truncated_ctmc_89694731-4388-4b58-a1d3-6c6b3532d3d7.json'; }
  trap cleanup_qnet_solver_inputs EXIT
  trap 'exit 130' INT TERM
  '/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAtc/bna_tc' '/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/qnet_truncated_ctmc_89694731-4388-4b58-a1d3-6c6b3532d3d7.json' --human
) ; } > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spin_25080_6b533346.out" 2>&1 & _sim_pid=$! ; ( _spin=0 ; _spinchars='|/-\\' ; while kill -0 $_sim_pid 2>/dev/null ; do sleep 0.2 ; _spin=$(( (_spin + 1) % 4 )) ; _ch=$(printf '%s' "$_spinchars" | cut -c$((_spin + 1))) ; _el=$(perl -MTime::HiRes=time -e 'printf("%.1f", time - '$_t0')') ; printf '\r\033[KSolving adaptive truncated CTMC (C) ...  [%s]%52s%6.1fs' "$_ch" '' "$_el" ; done ; ) & _poller_pid=$! ; wait $_sim_pid ; _rc=$? ; kill $_poller_pid 2>/dev/null ; wait $_poller_pid 2>/dev/null ; _el=$(perl -MTime::HiRes=time -e 'printf("%.1f", time - '$_t0')') ; printf '\r\033[KSolving adaptive truncated CTMC (C) ...  [done]%49s%6.1fs\n' '' "$_el" ; cat "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spin_25080_6b533346.out" 2>/dev/null ; rm -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spin_25080_6b533346.out" ; ( exit $_rc )
  _command_rc=$?
  perl -MTime::HiRes=time -e 'printf("Elapsed time: %.3fs\n\n", time - '"$_t0"')'
  exit $_command_rc
} 2>&1 | tee "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_output_25080_3ecfd29e-7d95-4c16-8b8c-f14d6bb213a9.log" | { if [ -r "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_25080.pl" ]; then exec perl "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_25080.pl" 3; else exec cat; fi; }
_rc=${PIPESTATUS[0]}
exit $_rc