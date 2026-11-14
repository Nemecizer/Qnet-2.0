# Multi-class SRBM experiment — research-grade solver
#
#   * OpenMP   — for FEM element-assembly parallelism (Tier 1 pattern)
#   * Accelerate — Apple's BLAS + SpMV (SparseBLAS)
#   * SuiteSparse — UMFPACK for unsymmetric LU, CHOLMOD for supernodal
#     Cholesky with Tikhonov regularization (Tier 2 pattern)
#   * cJSON    — for direct .bnet JSON parsing

CC      = cc
CSTD    = -std=c99
OPT     = -O3
WARN    = -Wall -Wextra -Wno-unused-parameter

HB_INC  = -I/opt/homebrew/include
HB_LIB  = -L/opt/homebrew/lib
OMP_DIR = /opt/homebrew/opt/libomp
OMP_INC = -I$(OMP_DIR)/include
OMP_LIB = -L$(OMP_DIR)/lib
SUITE_INC = -I/opt/homebrew/include/suitesparse

CFLAGS  = $(CSTD) $(OPT) $(WARN) $(OMP_INC) $(HB_INC) $(SUITE_INC) \
          -Icommon -Isrc \
          -Xpreprocessor -fopenmp \
          -DACCELERATE_NEW_LAPACK
LDFLAGS = $(OMP_LIB) $(HB_LIB) \
          -lomp -lumfpack -lcholmod -lamd -lcolamd -lccolamd -lcamd \
          -lsuitesparseconfig -lcjson -framework Accelerate -lm

# ─── Sources ──────────────────────────────────────────────────────────────
COMMON_SRC = common/bna_fm_common.c
PARSER_SRC = src/bnet_parser.c
DIST_SRC   = src/mc_dist.c
PARAMS_SRC = src/mc_params.c
ADAPT_SRC  = src/mc_adapter.c
FEM_SRC    = src/mc_fem_gauss.c
SOLVER_SRC = src/mc_solver.c

MC_SOLVER_SRC = $(COMMON_SRC) $(PARSER_SRC) $(DIST_SRC) $(PARAMS_SRC) \
                $(ADAPT_SRC) $(FEM_SRC) $(SOLVER_SRC)
MC_SOLVER_OBJ = $(MC_SOLVER_SRC:.c=.o)

# Sanitizer build (AddressSanitizer + UndefinedBehaviorSanitizer), used by
# `make check-asan` and by validation/fuzz/. Every undefined-behaviour report
# ends the run, so a check cannot pass over one.
SAN_OPT = -O1 -g -fno-omit-frame-pointer \
          -fsanitize=address,undefined -fno-sanitize-recover=undefined
SAN_CFLAGS = $(CSTD) $(SAN_OPT) $(WARN) $(OMP_INC) $(HB_INC) $(SUITE_INC) \
          -Icommon -Isrc \
          -Xpreprocessor -fopenmp \
          -DACCELERATE_NEW_LAPACK
MC_HEADERS = common/bna_fm.h src/mc_fem.h src/mc_srbm.h

# ─── Targets ──────────────────────────────────────────────────────────────
.PHONY: all solver asan clean check check-inputs check-asan test

all: solver

solver: mc_solver

mc_solver: $(MC_SOLVER_OBJ)
	$(CC) $(CFLAGS) -o $@ $(MC_SOLVER_OBJ) $(LDFLAGS)

%.o: %.c $(MC_HEADERS)
	$(CC) $(CFLAGS) -c $< -o $@

asan: mc_solver_asan

mc_solver_asan: $(MC_SOLVER_SRC) $(MC_HEADERS)
	$(CC) $(SAN_CFLAGS) -o $@ $(MC_SOLVER_SRC) $(LDFLAGS)

# Parameter-computation-only check: prints the resolved
#   (theta, Sigma, R, a) from any .bnet input so we can diff it against
#   what the Swift exporter would have produced.
tests/test_params: tests/test_params.c src/mc_params.c src/mc_dist.c src/mc_srbm.h
	$(CC) -std=c99 -O2 -Wall -Wextra -Werror -Isrc \
		tests/test_params.c src/mc_params.c src/mc_dist.c -lm -o $@

tests/test_params_asan: tests/test_params.c src/mc_params.c src/mc_dist.c src/mc_srbm.h
	$(CC) -std=c99 $(SAN_OPT) -Wall -Wextra -Werror -Isrc \
		tests/test_params.c src/mc_params.c src/mc_dist.c -lm -o $@

test: tests/test_params
	./tests/test_params

# Input-handling checks (tests/check_inputs.sh): damaged, oversized and
# formerly crashing .bnet files in tests/inputs/ must end in a result or in a
# message and exit status 1, never in a signal. They need the full solver, so
# on a machine without cJSON, SuiteSparse, libomp and Accelerate they are
# skipped with a note and `check` still covers the parameter layer.
check-inputs:
	@if $(MAKE) -s solver >/dev/null 2>tests/.solver-build.log; then \
		rm -f tests/.solver-build.log; \
		sh tests/check_inputs.sh ./mc_solver; \
	else \
		echo "Input checks skipped: mc_solver did not build (see tests/.solver-build.log)."; \
		echo "Run 'make solver' when cJSON, SuiteSparse, libomp and Accelerate are installed."; \
	fi

check: test check-inputs
	@echo "Multiclass diffusion checks passed."

# The same checks under AddressSanitizer and UndefinedBehaviorSanitizer.
check-asan: tests/test_params_asan mc_solver_asan
	./tests/test_params_asan
	sh tests/check_inputs.sh ./mc_solver_asan
	@echo "Multiclass diffusion checks passed under the sanitizers."

clean:
	rm -f $(MC_SOLVER_OBJ)
	rm -f mc_solver mc_solver_asan tests/test_params tests/test_params_asan
	rm -rf mc_solver_asan.dSYM tests/test_params_asan.dSYM tests/.solver-build.log
