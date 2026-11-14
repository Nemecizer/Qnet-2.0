printf '\033[A\033[2K'
printf '%s\n' "$$" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_pid_36073_bf3c5e82-2ed1-4a13-9369-88928c2ef8d8.txt"
trap 'printf "%s\n" "${_rc:-130}" > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_done_36073_bf3c5e82-2ed1-4a13-9369-88928c2ef8d8.txt" ; rm -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_36073.pl"' EXIT
_t0=$(perl -MTime::HiRes=time -e 'print time')
{
  printf 'Fitting adaptive low-rank BAR ...  [ ]%52s%6.1fs' '' 0.0 ; _t0=$(perl -MTime::HiRes=time -e 'print time') ; { (
  cleanup_qnet_solver_inputs() { rm -f '/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/qnet_adaptive_bar_a4b04799-cfad-422a-a740-9228c6b5aa3d.json'; }
  trap cleanup_qnet_solver_inputs EXIT
  trap 'exit 130' INT TERM
  '/opt/homebrew/bin/python3' -B '/Users/nobody/Library/Caches/qnet/solvers/stage/Resources/bin/infinite/BNAalr/low_rank_bar.py' '/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/qnet_adaptive_bar_a4b04799-cfad-422a-a740-9228c6b5aa3d.json' | awk -v w=1 -v mu='2.0408163265306123 1.4285714285714286' 'BEGIN{n=split(mu,m," ")}{print}/^E\[Z_[0-9]+\] =/{s=$1;gsub(/[^0-9]/,"",s);i=s+0;if(i>=1&&i<=n){q[i]=$3*m[i];z[i]=$3;u[i]=m[i];if(i>d)d=i}}END{if(d>0){printf "\n";for(i=1;i<=d;i++)printf "  L_%0*d = %.6f    (workload E[Z_%0*d] = %.6f, mu_i = %.6f)\n",w,i,q[i],w,i,z[i],u[i]}}'
) ; } > "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spin_36073_0ba07117.out" 2>&1 & _sim_pid=$! ; ( _spin=0 ; _spinchars='|/-\\' ; while kill -0 $_sim_pid 2>/dev/null ; do sleep 0.2 ; _spin=$(( (_spin + 1) % 4 )) ; _ch=$(printf '%s' "$_spinchars" | cut -c$((_spin + 1))) ; _el=$(perl -MTime::HiRes=time -e 'printf("%.1f", time - '$_t0')') ; printf '\r\033[KFitting adaptive low-rank BAR ...  [%s]%52s%6.1fs' "$_ch" '' "$_el" ; done ; ) & _poller_pid=$! ; wait $_sim_pid ; _rc=$? ; kill $_poller_pid 2>/dev/null ; wait $_poller_pid 2>/dev/null ; _el=$(perl -MTime::HiRes=time -e 'printf("%.1f", time - '$_t0')') ; printf '\r\033[KFitting adaptive low-rank BAR ...  [done]%49s%6.1fs\n' '' "$_el" ; cat "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spin_36073_0ba07117.out" 2>/dev/null ; rm -f "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_spin_36073_0ba07117.out" ; ( exit $_rc )
  _command_rc=$?
  perl -MTime::HiRes=time -e 'printf("Elapsed time: %.3fs\n\n", time - '"$_t0"')'
  exit $_command_rc
} 2>&1 | tee "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_run_output_36073_bf3c5e82-2ed1-4a13-9369-88928c2ef8d8.log" | { if [ -r "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_36073.pl" ]; then exec perl "/var/folders/l_/vgpy8df91c16yp_5pvskf0900000gn/T/BNET_outfmt_36073.pl" 3; else exec cat; fi; }
_rc=${PIPESTATUS[0]}
exit $_rc