/*
 * BNA/FM Algorithm - Gaussian Quadrature Version (SuiteSparse + OpenMP)
 *
 * Brownian Network Analyzer with Finite Element Method
 * using 5-point Gauss-Legendre quadrature for integration.
 * Uses SuiteSparse (UMFPACK) for sparse linear system solving.
 * Parallelized with OpenMP for multi-core CPUs.
 *
 * Based on: Shen, Chen, Dai, Dai (2000)
 *
 * Usage: ./bna_fm_gauss input_file
 */

#include "bna_fm.h"
#include <time.h>
#include <omp.h>

int g_compact = 0;

/* ============================================================
 * Gauss-Legendre Quadrature
 * ============================================================ */

/* 4-point Gauss-Legendre exactly integrates polynomials up to degree 7.
 * Our integrand is L(f_i)·L(f_j) with f_i cubic Hermite, so the integrand
 * has max degree 6 per 1-D coordinate — 4-point is the minimum-safe choice
 * and is exact (no approximation error vs. the previous 5-point rule). */
#define N_GAUSS 4

static double gauss_points[N_GAUSS];
static double gauss_weights[N_GAUSS];

static void init_gauss_legendre(void) {
    /* 4-point Gauss-Legendre on [-1, 1]
     *   points:  ±sqrt((3 - 2·sqrt(6/5))/7), ±sqrt((3 + 2·sqrt(6/5))/7)
     *   weights: (18 ± sqrt(30)) / 36                                   */
    double p_inner = sqrt((3.0 - 2.0 * sqrt(6.0/5.0)) / 7.0);   /* ≈ 0.33998 */
    double p_outer = sqrt((3.0 + 2.0 * sqrt(6.0/5.0)) / 7.0);   /* ≈ 0.86114 */
    double w_inner = (18.0 + sqrt(30.0)) / 36.0;                /* ≈ 0.65215 */
    double w_outer = (18.0 - sqrt(30.0)) / 36.0;                /* ≈ 0.34785 */

    gauss_points[0] = -p_outer;
    gauss_points[1] = -p_inner;
    gauss_points[2] =  p_inner;
    gauss_points[3] =  p_outer;

    gauss_weights[0] = w_outer;
    gauss_weights[1] = w_inner;
    gauss_weights[2] = w_inner;
    gauss_weights[3] = w_outer;
}

/* ============================================================
 * Element Basis Functions
 * ============================================================ */

typedef struct {
    int node[MAX_DIM];
    int r[MAX_DIM];
    int global_idx;
} LocalBasis;

static int get_element_basis_funcs(int K, const int *mesh_n, const int *el,
                                   LocalBasis *basis) {
    int n_corners = ipow(2, K);
    int n_types = ipow(2, K);
    int idx = 0;

    for (int c = 0; c < n_corners; c++) {
        /* Compute corner node indices */
        int node[MAX_DIM];
        for (int j = 0; j < K; j++) {
            if (c & (1 << j)) {
                node[j] = el[j] + 1;  /* Upper corner (1-based) */
            } else {
                node[j] = el[j];      /* Lower corner */
            }
        }

        /* Each node has 2^K basis functions (phi/psi combinations) */
        for (int t = 0; t < n_types; t++) {
            int r[MAX_DIM];
            for (int j = 0; j < K; j++) {
                r[j] = (t >> j) & 1;
            }

            for (int j = 0; j < K; j++) {
                basis[idx].node[j] = node[j];
                basis[idx].r[j] = r[j];
            }
            basis[idx].global_idx = node_to_global_idx(node, r, K, mesh_n);
            idx++;
        }
    }

    return idx;
}

static int get_face_basis_funcs(int K, const int *mesh_n, const int *fel,
                                int face_dim, int is_lower, LocalBasis *basis) {
    int fixed_node = is_lower ? 1 : mesh_n[face_dim] + 1;
    int n_face_corners = ipow(2, K - 1);
    int n_types = ipow(2, K);
    int idx = 0;

    for (int c = 0; c < n_face_corners; c++) {
        int node[MAX_DIM];
        int bit_pos = 0;
        for (int j = 0; j < K; j++) {
            if (j == face_dim) {
                node[j] = fixed_node;
            } else {
                if (c & (1 << bit_pos)) {
                    node[j] = fel[j] + 1;
                } else {
                    node[j] = fel[j];
                }
                bit_pos++;
            }
        }

        for (int t = 0; t < n_types; t++) {
            int r[MAX_DIM];
            for (int j = 0; j < K; j++) {
                r[j] = (t >> j) & 1;
            }

            for (int j = 0; j < K; j++) {
                basis[idx].node[j] = node[j];
                basis[idx].r[j] = r[j];
            }
            basis[idx].global_idx = node_to_global_idx(node, r, K, mesh_n);
            idx++;
        }
    }

    return idx;
}

/* ============================================================
 * Multi-index Generation
 * ============================================================ */

static void idx_to_multi(int idx, const int *sizes, int K, int *multi) {
    for (int j = 0; j < K; j++) {
        multi[j] = idx % sizes[j];
        idx /= sizes[j];
    }
}

/* ============================================================
 * Size and parameter checks made before any memory is taken
 * ============================================================ */

static uint64_t mul_sat(uint64_t a, uint64_t b) {
    if (a != 0 && b > UINT64_MAX / a) return UINT64_MAX;
    return a * b;
}
static uint64_t add_sat(uint64_t a, uint64_t b) {
    return (b > UINT64_MAX - a) ? UINT64_MAX : a + b;
}

/* Entries the assembly writes, as build_fem_system() counts them: every
 * element contributes a dense (4^K x 4^K) block and every boundary face
 * element a dense (2^(2K-1) x 2^(2K-1)) block. Saturates at UINT64_MAX. */
static uint64_t assembly_entries(int K, const int *mesh_n) {
    uint64_t n_elem = 1;
    for (int j = 0; j < K; j++) n_elem = mul_sat(n_elem, (uint64_t)mesh_n[j]);
    uint64_t local_vol = (uint64_t)1 << (2 * K);            /* 4^K */
    uint64_t total = mul_sat(n_elem, mul_sat(local_vol, local_vol));
    if (K > 1) {
        uint64_t local_face = (uint64_t)1 << (2 * K - 1);   /* 2^(2K-1) */
        for (int face_dim = 0; face_dim < K; face_dim++) {
            uint64_t n_face = 1;
            for (int j = 0; j < K; j++)
                if (j != face_dim) n_face = mul_sat(n_face, (uint64_t)mesh_n[j]);
            total = add_sat(total, mul_sat(2, mul_sat(n_face, mul_sat(local_face, local_face))));
        }
    }
    return total;
}

/* The largest capacity build_fem_system() asks for in one piece: the per-thread
 * list, (n_elem / n_threads + 1) * 4^K * 4^K (for one thread a little more
 * than the volume total itself), or the merged total. */
static uint64_t assembly_need(int K, const int *mesh_n, int n_threads) {
    uint64_t n_elem = 1;
    for (int j = 0; j < K; j++) n_elem = mul_sat(n_elem, (uint64_t)mesh_n[j]);
    uint64_t local_vol = (uint64_t)1 << (2 * K);
    uint64_t per_thread = mul_sat(n_elem / (uint64_t)(n_threads > 0 ? n_threads : 1) + 1,
                                  mul_sat(local_vol, local_vol));
    uint64_t total = assembly_entries(K, mesh_n);
    return total > per_thread ? total : per_thread;
}

/* 1,234,567 — large counts are unreadable without separators. */
static const char *with_commas(uint64_t v, char *buf, size_t len) {
    char digits[32];
    int n = snprintf(digits, sizeof(digits), "%llu", (unsigned long long)v);
    size_t o = 0;
    for (int i = 0; i < n && o + 2 < len; i++) {
        if (i > 0 && (n - i) % 3 == 0) buf[o++] = ',';
        buf[o++] = digits[i];
    }
    buf[o] = 0;
    return buf;
}

static void merge_failed(size_t entries) {
    char b[40];
    bna_fatal("the finite-element matrix needs %s entries, more than this "
              "solver can hold or than the memory available. Use a coarser "
              "mesh (-n) or a network with fewer stations.",
              with_commas((uint64_t)entries, b, sizeof(b)));
}

/* Refuses, with a sentence a student can act on, a problem whose parameters
 * are not numbers or whose matrix cannot be indexed. Returns 0 when the solve
 * may start. Every count the assembly later computes in `int` (elements,
 * basis functions, per-thread capacities, the merged entry count) is bounded
 * by what is checked here. */
static int mc_fem_check_size(const BNAParams *params, int n_threads) {
    static const char *check_inputs =
        "Check the arrival and service distributions and their parameters, "
        "and the routing probabilities.";
    int K = params->K;
    if (K < 1 || K > MAX_DIM) {
        fprintf(stderr, "mc_solver: the network must have between 1 and %d "
                        "stations (it has %d).\n", MAX_DIM, K);
        return -1;
    }
    for (int i = 0; i < K; i++) {
        if (params->mesh_n[i] < 1) {
            fprintf(stderr, "mc_solver: the mesh needs at least 1 element per "
                            "station (got %d).\n", params->mesh_n[i]);
            return -1;
        }
        if (!isfinite(params->lb[i]) || !isfinite(params->ub[i]) ||
            !(params->ub[i] > params->lb[i]) ||
            !isfinite(params->h[i]) || !(params->h[i] > 0.0)) {
            fprintf(stderr, "mc_solver: station %d has no usable buffer size "
                            "(upper bound %g). Check the buffer in front of it.\n",
                    i + 1, params->ub[i]);
            return -1;
        }
        if (!isfinite(params->theta[i])) {
            fprintf(stderr, "mc_solver: the drift at station %d is not a finite "
                            "number (%g). %s\n", i + 1, params->theta[i], check_inputs);
            return -1;
        }
        for (int j = 0; j < K; j++) {
            if (!isfinite(params->Gamma[i][j])) {
                fprintf(stderr, "mc_solver: the covariance between stations %d "
                                "and %d is not a finite number (%g). %s\n",
                        i + 1, j + 1, params->Gamma[i][j], check_inputs);
                return -1;
            }
        }
        for (int j = 0; j < 2 * K; j++) {
            if (!isfinite(params->R[i][j])) {
                fprintf(stderr, "mc_solver: the reflection matrix has an entry "
                                "that is not a finite number (row %d, column %d). "
                                "%s\n", i + 1, j + 1, check_inputs);
                return -1;
            }
        }
    }

    const uint64_t limit = (uint64_t)INT_MAX;
    uint64_t need = assembly_need(K, params->mesh_n, n_threads);
    if (need > limit) {
        /* Largest uniform mesh that would fit, for the advice. */
        int largest = 0;
        for (int j = 0; j < K; j++)
            if (params->mesh_n[j] > largest) largest = params->mesh_n[j];
        int fit = 0;
        for (int n = 1; n <= largest; n++) {
            int trial[MAX_DIM];
            for (int j = 0; j < K; j++) trial[j] = n;
            if (assembly_need(K, trial, n_threads) > limit) break;
            fit = n;
        }
        char b1[40], b2[40];
        fprintf(stderr,
            "mc_solver: this network is too large for the multi-class "
            "finite-element solver at this mesh.\n"
            "  %d stations with %d mesh elements per station need %s matrix "
            "entries; the solver can hold at most %s.\n",
            K, largest,
            with_commas(need, b1, sizeof(b1)), with_commas(limit, b2, sizeof(b2)));
        if (fit >= 1)
            fprintf(stderr,
                "  A mesh of %d or fewer elements per station fits (option -n %d; "
                "in Qnet, \"Mesh size per dimension\" in Run Multi-Class SRBM). A coarser mesh "
                "is less accurate and can still need a lot of memory and time.\n",
                fit, fit);
        else
            fprintf(stderr,
                "  No mesh is small enough for %d stations. Use a method made "
                "for larger networks, such as QNA or simulation.\n", K);
        return -1;
    }
    return 0;
}

/* ============================================================
 * FEM System Assembly (OpenMP Parallelized)
 * ============================================================ */

static void build_fem_system(const BNAParams *params, SparseTriplet *A, double *y) {
    int K = params->K;
    int n_elem = prod_int(params->mesh_n, K);
    int n_gp_total = ipow(N_GAUSS, K);
    int max_local = ipow(2, K) * ipow(2, K);
    int n_basis = get_n_basis(K, params->mesh_n);

    int n_threads = omp_get_max_threads();
    if (!g_compact) {
        printf("  Using %d OpenMP threads\n", n_threads);
        printf("  Processing %d elements for volume integrals...\n", n_elem);
    }

    /* Pre-compute Gauss sizes array */
    int gauss_sizes[MAX_DIM];
    for (int j = 0; j < K; j++) gauss_sizes[j] = N_GAUSS;

    /* Create thread-local triplet storage */
    SparseTriplet **thread_triplets = (SparseTriplet**)bna_xmalloc(
        (size_t)n_threads, sizeof(SparseTriplet*), "the assembly buffers");
    for (int t = 0; t < n_threads; t++) {
        /* Estimate capacity per thread. mc_fem_check_size() has already
         * established that this product fits an int. */
        int capacity_per_thread = (n_elem / n_threads + 1) * max_local * max_local;
        thread_triplets[t] = sparse_triplet_create(n_basis, n_basis, capacity_per_thread);
        if (!thread_triplets[t])
            bna_fatal("not enough memory to assemble the finite-element matrix "
                      "(%d entries per thread, %d threads). Use a coarser mesh (-n) "
                      "or a network with fewer stations.",
                      capacity_per_thread, n_threads);
    }

    /* Thread-local y vectors */
    double **thread_y = (double**)bna_xmalloc(
        (size_t)n_threads, sizeof(double*), "the assembly buffers");
    for (int t = 0; t < n_threads; t++) {
        thread_y[t] = (double*)bna_xcalloc((size_t)n_basis, sizeof(double),
                                           "the right-hand side");
    }

    /* Parallel loop over elements */
    #pragma omp parallel
    {
        int tid = omp_get_thread_num();
        SparseTriplet *my_triplet = thread_triplets[tid];
        double *my_y = thread_y[tid];

        /* Thread-local work arrays */
        LocalBasis *basis = (LocalBasis*)bna_xmalloc((size_t)max_local, sizeof(LocalBasis), "the element basis");
        double *Lf_vals = (double*)bna_xmalloc((size_t)max_local, sizeof(double), "the element basis");
        double *A_local = (double*)bna_xmalloc((size_t)max_local * (size_t)max_local, sizeof(double), "the element matrix");
        double *y_local = (double*)bna_xmalloc((size_t)max_local, sizeof(double), "the element basis");

        #pragma omp for schedule(dynamic, 4)
        for (int e = 0; e < n_elem; e++) {
            /* Convert linear index to element multi-index (1-based) */
            int el[MAX_DIM];
            idx_to_multi(e, params->mesh_n, K, el);
            for (int j = 0; j < K; j++) el[j] += 1;  /* 1-based */

            /* Element bounds */
            double el_lb[MAX_DIM], el_ub[MAX_DIM];
            for (int j = 0; j < K; j++) {
                el_lb[j] = params->lb[j] + (el[j] - 1) * params->h[j];
                el_ub[j] = el_lb[j] + params->h[j];
            }

            /* Get local basis functions */
            int n_local = get_element_basis_funcs(K, params->mesh_n, el, basis);

            /* Initialize local matrices */
            memset(A_local, 0, (size_t)n_local * (size_t)n_local * sizeof(double));
            memset(y_local, 0, (size_t)n_local * sizeof(double));

            /* Gauss quadrature */
            for (int g = 0; g < n_gp_total; g++) {
                /* Get quadrature point and weight */
                int gidx[MAX_DIM];
                idx_to_multi(g, gauss_sizes, K, gidx);

                double x[MAX_DIM];
                double w = 1.0;
                for (int j = 0; j < K; j++) {
                    /* Map [-1, 1] to [el_lb, el_ub] */
                    x[j] = el_lb[j] + (gauss_points[gidx[j]] + 1.0) / 2.0 * params->h[j];
                    w *= gauss_weights[gidx[j]] * params->h[j] / 2.0;
                }

                /* Evaluate Lf for all local basis functions */
                for (int i = 0; i < n_local; i++) {
                    Lf_vals[i] = eval_Lf_at_x(x, basis[i].node, basis[i].r, params);
                }

                /* Accumulate contributions */
                for (int i = 0; i < n_local; i++) {
                    y_local[i] += w * Lf_vals[i];
                    for (int j = 0; j < n_local; j++) {
                        A_local[i * n_local + j] += w * Lf_vals[i] * Lf_vals[j];
                    }
                }
            }

            /* Assemble into thread-local storage */
            for (int i = 0; i < n_local; i++) {
                int gi = basis[i].global_idx;
                my_y[gi] += y_local[i];
                for (int j = 0; j < n_local; j++) {
                    int gj = basis[j].global_idx;
                    sparse_triplet_add(my_triplet, gi, gj, A_local[i * n_local + j]);
                }
            }
        }

        free(basis);
        free(Lf_vals);
        free(A_local);
        free(y_local);
    }

    /* Merge thread-local results into global.
     * Previously this was an O(total_nnz) sparse_triplet_add() loop — one
     * function call (with capacity-check branch) per triplet. At d=4 that's
     * ~650M calls. Replacing with a single realloc to the exact total
     * capacity plus three memcpy's per thread gives a large speedup and
     * lets the compiler/runtime vectorize the copy. */
    size_t total_add = 0;
    for (int t = 0; t < n_threads; t++) {
        total_add += (size_t)thread_triplets[t]->nnz;
    }
    size_t new_nnz = (size_t)A->nnz + total_add;
    /* `A->capacity = (int)new_nnz` truncated a count above INT_MAX to a small
     * or negative int; realloc then returned a short block (or NULL) and the
     * memcpy below wrote past it — the recorded "Segmentation fault: 11". */
    if (sparse_triplet_reserve(A, new_nnz) != 0) merge_failed(new_nnz);
    for (int t = 0; t < n_threads; t++) {
        SparseTriplet *src = thread_triplets[t];
        if (src->nnz > 0) {
            memcpy(A->row + A->nnz, src->row, (size_t)src->nnz * sizeof(int));
            memcpy(A->col + A->nnz, src->col, (size_t)src->nnz * sizeof(int));
            memcpy(A->val + A->nnz, src->val, (size_t)src->nnz * sizeof(double));
            A->nnz += src->nnz;
        }
        sparse_triplet_free(src);

        for (int i = 0; i < n_basis; i++) {
            y[i] += thread_y[t][i];
        }
        free(thread_y[t]);
    }
    free(thread_triplets);
    free(thread_y);

    /* Boundary integrals */
    if (!g_compact)
        printf("  Processing boundary integrals...\n");

    if (K > 1) {
        int n_gp_face = ipow(N_GAUSS, K - 1);

        /* Allocate per-face, per-thread triplet buffers up front so we can
         * process every face inside a single `#pragma omp parallel` region
         * and avoid 2*K thread fork/join cycles. */
        SparseTriplet ***all_face_triplets = (SparseTriplet***)bna_xmalloc(
            (size_t)(2 * K), sizeof(SparseTriplet**), "the boundary buffers");
        int n_face_elem_per_face[2 * MAX_DIM];
        int face_mesh_all[2 * MAX_DIM][MAX_DIM];
        for (int face = 0; face < 2 * K; face++) {
            int face_dim = face < K ? face : face - K;
            for (int j = 0; j < K; j++) {
                face_mesh_all[face][j] = (j == face_dim) ? 1 : params->mesh_n[j];
            }
            n_face_elem_per_face[face] = prod_int(face_mesh_all[face], K);

            all_face_triplets[face] = (SparseTriplet**)bna_xmalloc(
                (size_t)n_threads, sizeof(SparseTriplet*), "the boundary buffers");
            for (int t = 0; t < n_threads; t++) {
                /* Fits an int: checked by mc_fem_check_size(). */
                int cap = (n_face_elem_per_face[face] / n_threads + 1)
                          * max_local * max_local;
                all_face_triplets[face][t] =
                    sparse_triplet_create(n_basis, n_basis, cap);
                if (!all_face_triplets[face][t])
                    bna_fatal("not enough memory to assemble the boundary terms "
                              "(%d entries per thread, %d threads). Use a coarser "
                              "mesh (-n) or a network with fewer stations.",
                              cap, n_threads);
            }
        }

        /* Single parallel region spans all boundary faces. Each face gets an
         * `#pragma omp for` with an implicit barrier, so thread pool startup
         * and teardown happens just once per boundary phase. */
        #pragma omp parallel
        {
            int tid = omp_get_thread_num();
            LocalBasis *basis = (LocalBasis*)bna_xmalloc((size_t)max_local, sizeof(LocalBasis), "the face basis");
            double *A_local = (double*)bna_xmalloc((size_t)max_local * (size_t)max_local, sizeof(double), "the face matrix");
            /* One value per local basis function. A face element has
             * 2^(K-1) corners with 2^K functions each, 2^(2K-1) in all: 128
             * for K = 4 but 512 for K = 5, which overran the fixed
             * `double Df_vals[256]` this replaces. */
            double *Df_vals = (double*)bna_xmalloc((size_t)max_local, sizeof(double), "the face basis");

            for (int face = 0; face < 2 * K; face++) {
                int face_dim = face < K ? face : face - K;
                double face_val = face < K
                    ? params->lb[face_dim]
                    : params->ub[face_dim];
                int is_lower = face < K;

                double v_k[MAX_DIM];
                for (int j = 0; j < K; j++) {
                    v_k[j] = params->R[j][face];
                }

                int *face_mesh = face_mesh_all[face];
                int n_face_elem = n_face_elem_per_face[face];
                SparseTriplet *my_triplet = all_face_triplets[face][tid];

                #pragma omp for schedule(dynamic, 4)
                for (int fe = 0; fe < n_face_elem; fe++) {
                    int fel[MAX_DIM];
                    idx_to_multi(fe, face_mesh, K, fel);
                    for (int j = 0; j < K; j++) fel[j] += 1;
                    fel[face_dim] = 1;

                    /* Get face basis functions */
                    int n_local = get_face_basis_funcs(K, params->mesh_n, fel,
                                                       face_dim, is_lower, basis);

                    memset(A_local, 0, (size_t)n_local * (size_t)n_local * sizeof(double));

                    /* Face element bounds */
                    double fel_lb[MAX_DIM];
                    for (int j = 0; j < K; j++) {
                        fel_lb[j] = params->lb[j] + (fel[j] - 1) * params->h[j];
                    }

                    /* Gauss quadrature on face */
                    for (int g = 0; g < n_gp_face; g++) {
                        int gidx[MAX_DIM];
                        int gi = g;
                        for (int j = 0; j < K; j++) {
                            if (j != face_dim) {
                                gidx[j] = gi % N_GAUSS;
                                gi /= N_GAUSS;
                            }
                        }

                        double x[MAX_DIM];
                        double w = 1.0;
                        for (int j = 0; j < K; j++) {
                            if (j == face_dim) {
                                x[j] = face_val;
                            } else {
                                x[j] = fel_lb[j] + (gauss_points[gidx[j]] + 1.0) / 2.0 * params->h[j];
                                w *= gauss_weights[gidx[j]] * params->h[j] / 2.0;
                            }
                        }

                        /* Evaluate D_k f = v_k' * grad(f) for all local basis */
                        for (int i = 0; i < n_local; i++) {
                            double grad_f[MAX_DIM];
                            eval_grad_f_at_x(x, basis[i].node, basis[i].r, params, grad_f);
                            Df_vals[i] = 0.0;
                            for (int j = 0; j < K; j++) {
                                Df_vals[i] += v_k[j] * grad_f[j];
                            }
                        }

                        /* Accumulate */
                        for (int i = 0; i < n_local; i++) {
                            for (int j = 0; j < n_local; j++) {
                                A_local[i * n_local + j] += w * Df_vals[i] * Df_vals[j];
                            }
                        }
                    }

                    /* Assemble */
                    for (int i = 0; i < n_local; i++) {
                        int gi = basis[i].global_idx;
                        for (int j = 0; j < n_local; j++) {
                            int gj = basis[j].global_idx;
                            sparse_triplet_add(my_triplet, gi, gj, A_local[i * n_local + j]);
                        }
                    }
                }
                /* Implicit barrier at end of `omp for` — all threads finish
                 * this face before any advances to the next one. */
            }

            free(basis);
            free(A_local);
            free(Df_vals);
        }

        /* Bulk-merge every (face, thread) buffer into the global triplet —
         * single realloc to exact total capacity + three memcpys per buffer,
         * replacing 2*K independent merge loops that each called
         * sparse_triplet_add() per entry. */
        size_t total_add = 0;
        for (int face = 0; face < 2 * K; face++) {
            for (int t = 0; t < n_threads; t++) {
                total_add += (size_t)all_face_triplets[face][t]->nnz;
            }
        }
        size_t new_nnz = (size_t)A->nnz + total_add;
        if (sparse_triplet_reserve(A, new_nnz) != 0) merge_failed(new_nnz);
        for (int face = 0; face < 2 * K; face++) {
            for (int t = 0; t < n_threads; t++) {
                SparseTriplet *src = all_face_triplets[face][t];
                if (src->nnz > 0) {
                    memcpy(A->row + A->nnz, src->row, (size_t)src->nnz * sizeof(int));
                    memcpy(A->col + A->nnz, src->col, (size_t)src->nnz * sizeof(int));
                    memcpy(A->val + A->nnz, src->val, (size_t)src->nnz * sizeof(double));
                    A->nnz += src->nnz;
                }
                sparse_triplet_free(src);
            }
            free(all_face_triplets[face]);
        }
        free(all_face_triplets);
    }
}

/* ============================================================
 * Compute Stationary Mean (OpenMP Parallelized)
 * ============================================================ */

static void compute_stationary_mean(const double *u, const BNAParams *params,
                                    double *q, double *kappa_out) {
    int K = params->K;
    int n_elem = prod_int(params->mesh_n, K);
    int n_gp_total = ipow(N_GAUSS, K);
    int max_local = ipow(2, K) * ipow(2, K);

    /* Pre-compute Gauss sizes array */
    int gauss_sizes[MAX_DIM];
    for (int j = 0; j < K; j++) gauss_sizes[j] = N_GAUSS;

    /* Compute integral of 1 and Σ u_i Lf_i over domain */
    double integral_one = prod_double(params->h, K) * n_elem;
    double integral_Lf = 0.0;

    #pragma omp parallel reduction(+:integral_Lf)
    {
        LocalBasis *basis = (LocalBasis*)bna_xmalloc((size_t)max_local, sizeof(LocalBasis), "the element basis");

        #pragma omp for schedule(dynamic, 4)
        for (int e = 0; e < n_elem; e++) {
            int el[MAX_DIM];
            idx_to_multi(e, params->mesh_n, K, el);
            for (int j = 0; j < K; j++) el[j] += 1;

            double el_lb[MAX_DIM];
            for (int j = 0; j < K; j++) {
                el_lb[j] = params->lb[j] + (el[j] - 1) * params->h[j];
            }

            int n_local = get_element_basis_funcs(K, params->mesh_n, el, basis);

            for (int g = 0; g < n_gp_total; g++) {
                int gidx[MAX_DIM];
                idx_to_multi(g, gauss_sizes, K, gidx);

                double x[MAX_DIM];
                double w = 1.0;
                for (int j = 0; j < K; j++) {
                    x[j] = el_lb[j] + (gauss_points[gidx[j]] + 1.0) / 2.0 * params->h[j];
                    w *= gauss_weights[gidx[j]] * params->h[j] / 2.0;
                }

                double sum_uLf = 0.0;
                for (int i = 0; i < n_local; i++) {
                    double Lf_val = eval_Lf_at_x(x, basis[i].node, basis[i].r, params);
                    sum_uLf += u[basis[i].global_idx] * Lf_val;
                }

                integral_Lf += w * sum_uLf;
            }
        }

        free(basis);
    }

    double kappa = 1.0 / (integral_one - integral_Lf);
    if (!g_compact)
        printf("  Normalization constant kappa = %.6e\n", kappa);
    *kappa_out = kappa;

    /* Compute mean */
    memset(q, 0, K * sizeof(double));

    #pragma omp parallel
    {
        double q_thread[MAX_DIM] = {0};
        LocalBasis *basis = (LocalBasis*)bna_xmalloc((size_t)max_local, sizeof(LocalBasis), "the element basis");

        #pragma omp for schedule(dynamic, 4)
        for (int e = 0; e < n_elem; e++) {
            int el[MAX_DIM];
            idx_to_multi(e, params->mesh_n, K, el);
            for (int j = 0; j < K; j++) el[j] += 1;

            double el_lb[MAX_DIM];
            for (int j = 0; j < K; j++) {
                el_lb[j] = params->lb[j] + (el[j] - 1) * params->h[j];
            }

            int n_local = get_element_basis_funcs(K, params->mesh_n, el, basis);

            for (int g = 0; g < n_gp_total; g++) {
                int gidx[MAX_DIM];
                idx_to_multi(g, gauss_sizes, K, gidx);

                double x[MAX_DIM];
                double w = 1.0;
                for (int j = 0; j < K; j++) {
                    x[j] = el_lb[j] + (gauss_points[gidx[j]] + 1.0) / 2.0 * params->h[j];
                    w *= gauss_weights[gidx[j]] * params->h[j] / 2.0;
                }

                double sum_uLf = 0.0;
                for (int i = 0; i < n_local; i++) {
                    double Lf_val = eval_Lf_at_x(x, basis[i].node, basis[i].r, params);
                    sum_uLf += u[basis[i].global_idx] * Lf_val;
                }

                double p0_val = kappa * (1.0 - sum_uLf);
                for (int j = 0; j < K; j++) {
                    q_thread[j] += w * x[j] * p0_val;
                }
            }
        }

        free(basis);

        /* Combine thread results */
        #pragma omp critical
        {
            for (int j = 0; j < K; j++) {
                q[j] += q_thread[j];
            }
        }
    }
}

/* ============================================================
 * Compute Boundary Measures (delta)
 * ============================================================
 *
 * The boundary measure for face k is:
 *   delta_k = -kappa * sum_i u_i * integral_{F_k} D_k f_i(x) dsigma(x)
 *
 * where D_k f_i(x) = v_k . grad(f_i)(x) is the directional derivative
 * in the reflection direction v_k = R[:,k].
 *
 * Face ordering: faces 0..K-1 are lower faces (x_k = 0),
 *                faces K..2K-1 are upper faces (x_k = a_k).
 */

static void compute_boundary_measures(const double *u, const BNAParams *params,
                                      double kappa, double *delta) {
    int K = params->K;
    int max_local = ipow(2, K) * ipow(2, K);

    for (int face = 0; face < 2 * K; face++) {
        int face_dim = face < K ? face : face - K;
        int is_lower = face < K;
        double face_val = is_lower ? params->lb[face_dim] : params->ub[face_dim];

        /* Reflection direction for this face */
        double v_k[MAX_DIM];
        for (int j = 0; j < K; j++) {
            v_k[j] = params->R[j][face];
        }

        /* Face mesh */
        int face_mesh[MAX_DIM];
        for (int j = 0; j < K; j++) {
            face_mesh[j] = (j == face_dim) ? 1 : params->mesh_n[j];
        }
        int n_face_elem = prod_int(face_mesh, K);

        int n_gp_face = ipow(N_GAUSS, K - 1);

        double face_integral = 0.0;

        #pragma omp parallel reduction(+:face_integral)
        {
            LocalBasis *basis = (LocalBasis*)bna_xmalloc((size_t)max_local, sizeof(LocalBasis), "the face basis");

            #pragma omp for schedule(dynamic, 4)
            for (int fe = 0; fe < n_face_elem; fe++) {
                int fel[MAX_DIM];
                idx_to_multi(fe, face_mesh, K, fel);
                for (int j = 0; j < K; j++) fel[j] += 1;
                fel[face_dim] = 1;

                /* Get face basis functions */
                int n_local = get_face_basis_funcs(K, params->mesh_n, fel,
                                                   face_dim, is_lower, basis);

                /* Face element bounds */
                double fel_lb[MAX_DIM];
                for (int j = 0; j < K; j++) {
                    fel_lb[j] = params->lb[j] + (fel[j] - 1) * params->h[j];
                }

                /* (K-1)-dimensional Gauss quadrature on the face */
                for (int g = 0; g < n_gp_face; g++) {
                    int gidx[MAX_DIM];
                    int gi = g;
                    for (int j = 0; j < K; j++) {
                        if (j != face_dim) {
                            gidx[j] = gi % N_GAUSS;
                            gi /= N_GAUSS;
                        }
                    }

                    double x[MAX_DIM];
                    double w = 1.0;
                    for (int j = 0; j < K; j++) {
                        if (j == face_dim) {
                            x[j] = face_val;
                        } else {
                            x[j] = fel_lb[j] + (gauss_points[gidx[j]] + 1.0) / 2.0 * params->h[j];
                            w *= gauss_weights[gidx[j]] * params->h[j] / 2.0;
                        }
                    }

                    /* Evaluate sum u_i * D_k f_i(x) = sum u_i * (v_k . grad f_i(x)) */
                    double sum_uDf = 0.0;
                    for (int i = 0; i < n_local; i++) {
                        double grad_f[MAX_DIM];
                        eval_grad_f_at_x(x, basis[i].node, basis[i].r, params, grad_f);
                        double Df_val = 0.0;
                        for (int j = 0; j < K; j++) {
                            Df_val += v_k[j] * grad_f[j];
                        }
                        sum_uDf += u[basis[i].global_idx] * Df_val;
                    }

                    face_integral += w * sum_uDf;
                }
            }

            free(basis);
        }

        delta[face] = -kappa * face_integral;
    }
}

/* ============================================================
 * Main
 * ============================================================ */

/* mc_fem_run — library-style entry point.
 *
 * Accepts an already-populated BNAParams (theta, Gamma, R, lb, ub, mesh_n,
 * h, service_rates, per-class data) and runs the full FEM solve + post-
 * processing.  `output_format`:
 *     0 = verbose (human-readable),
 *     1 = compact (E[X_i] only),
 *     2 = GUI (standardized rho/Gamma/sojourn/E[X] lines).
 *
 * Returns 0 on success, non-zero on failure. */
int mc_fem_run(BNAParams *params_ptr, int output_format)
{
    BNAParams params = *params_ptr;
    int compact  = (output_format >= 1);
    int gui_mode = (output_format == 2);
    if (gui_mode) compact = 1;
    g_compact = compact;

    /* Before anything is printed or allocated: refuse what cannot be solved. */
    if (mc_fem_check_size(&params, omp_get_max_threads()) != 0)
        return 1;

    if (!compact)
        printf("=== MC-SRBM (Gaussian Quadrature + SuiteSparse + OpenMP) ===\n");

    if (!compact)
        print_params(&params);

    int n_basis = get_n_basis(params.K, params.mesh_n);
    if (!compact)
        printf("Number of basis functions: %d\n", n_basis);

    /* Initialize Gauss quadrature */
    init_gauss_legendre();

    /* Initialize CHOLMOD */
    cholmod_common c;
    cholmod_start(&c);

    /* Build system */
    if (!compact)
        printf("Building system matrix...\n");
    double start = omp_get_wtime();

    /* n_basis * 100 is only a first guess (the merge reserves the exact
     * count); keep it where it fits an int. */
    int first_capacity = (n_basis <= INT_MAX / 100) ? n_basis * 100 : n_basis;
    SparseTriplet *A_triplet = sparse_triplet_create(n_basis, n_basis, first_capacity);
    if (!A_triplet)
        bna_fatal("not enough memory for the finite-element matrix (%d unknowns). "
                  "Use a coarser mesh (-n) or a network with fewer stations.", n_basis);
    double *y = (double*)bna_xcalloc((size_t)n_basis, sizeof(double), "the right-hand side");

    build_fem_system(&params, A_triplet, y);

    /* Convert to CHOLMOD sparse */
    cholmod_sparse *A = triplet_to_cholmod(A_triplet, &c);
    sparse_triplet_free(A_triplet);
    if (!A) {
        fprintf(stderr, "mc_solver: the finite-element matrix could not be built "
                        "(not enough memory, or too many entries). Use a coarser "
                        "mesh (-n) or a network with fewer stations.\n");
        cholmod_finish(&c);
        free(y);
        return 1;
    }

    if (!compact)
        printf("System matrix built. nnz = %ld\n", (long)cholmod_nnz(A, &c));

    /* Solve linear system */
    if (!compact)
        printf("Solving linear system...\n");
    double *u = (double*)bna_xcalloc((size_t)n_basis, sizeof(double), "the solution vector");

    if (smart_solve(A, y, u, &c) != 0) {
        fprintf(stderr, "Solver failed\n");
        cholmod_free_sparse(&A, &c);
        cholmod_finish(&c);
        free(y);
        free(u);
        return 1;
    }

    /* Compute mean */
    if (!compact)
        printf("Computing stationary mean...\n");
    double q[MAX_DIM], kappa;
    compute_stationary_mean(u, &params, q, &kappa);

    /* Compute boundary measures */
    if (!compact)
        printf("Computing boundary measures...\n");
    double delta[2 * MAX_DIM];
    compute_boundary_measures(u, &params, kappa, delta);

    double elapsed = omp_get_wtime() - start;

    if (gui_mode) {
        printf("Finite Element Method (Gauss-Legendre)\n");
        printf("==================\n\n");

        /* Per-station throughput. Prefer the analytically-known α_i carried
         * in cc_alpha_total (solved from the traffic equations); fall back
         * to the boundary-flux estimate μ_i − δ_i only when α_i is absent.
         * The boundary-flux form is only correct when R has the specific
         * manufacturing-blocking shape (lower face = e_i); under Harrison-
         * Reiman R = I − Pᵀ with off-diagonal entries, δ_i stops being the
         * idleness rate and the derived ρ/Γ values become meaningless. */
        double gamma_sta[MAX_DIM];
        for (int i = 0; i < params.K; i++) {
            if (params.cc_num_classes > 0 && params.cc_alpha_total[i] > 0.0) {
                gamma_sta[i] = params.cc_alpha_total[i];
            } else if (params.has_service_rates) {
                gamma_sta[i] = params.service_rates[i] - delta[i];
            } else {
                gamma_sta[i] = 0.0;
            }
        }

        if (params.has_service_rates) {
            for (int i = 0; i < params.K; i++) {
                double rho_i = (params.service_rates[i] > 1e-12)
                    ? gamma_sta[i] / params.service_rates[i] : 0.0;
                printf("rho_%d = %.6f\n", i + 1, rho_i);
            }
            printf("\n");
            for (int i = 0; i < params.K; i++)
                printf("Gamma_%d = %.6f\n", i + 1, gamma_sta[i]);
            printf("\n");
            for (int i = 0; i < params.K; i++) {
                double sojourn = (gamma_sta[i] > 1e-12) ? q[i] / gamma_sta[i] : 0.0;
                printf("sojourn_%d = %.6f\n", i + 1, sojourn);
            }
            printf("\n");
        }

        {
            int w = 1;
            for (int t = params.K; t >= 10; t /= 10) w++;
            for (int i = 0; i < params.K; i++)
                printf("E[X_%0*d] = %.6f\n", w, i + 1, q[i]);
        }
        printf("\n");

        /* Per-class statistics */
        if (params.cc_num_classes > 0 && params.has_service_rates) {
            int Kcc = params.cc_num_classes;
            int d = params.K;

            double ew_sta[MAX_DIM];
            for (int i = 0; i < d; i++) {
                double sojourn_i = (gamma_sta[i] > 1e-12) ? q[i] / gamma_sta[i] : 0.0;
                ew_sta[i] = sojourn_i - 1.0 / params.service_rates[i];
                if (ew_sta[i] < 0) ew_sta[i] = 0;
            }

            for (int k = 0; k < Kcc; k++) {
                if (params.cc_lambda[k] < 1e-15) {
                    printf("W_total(class %d) = 0.000000\n", k + 1);
                    continue;
                }
                double w_total = 0.0;
                for (int i = 0; i < d; i++) {
                    double visit = params.cc_alpha[k][i] / params.cc_lambda[k];
                    w_total += visit * ew_sta[i];
                }
                printf("W_total(class %d) = %.6f\n", k + 1, w_total);
            }
            printf("\n");

            for (int k = 0; k < Kcc; k++) {
                if (params.cc_lambda[k] < 1e-15) {
                    printf("T_total(class %d) = 0.000000\n", k + 1);
                    continue;
                }
                double t_total = 0.0;
                for (int i = 0; i < d; i++) {
                    double visit = params.cc_alpha[k][i] / params.cc_lambda[k];
                    t_total += visit * (ew_sta[i] + 1.0 / params.cc_mu[k][i]);
                }
                printf("T_total(class %d) = %.6f\n", k + 1, t_total);
            }
            printf("\n");

            for (int k = 0; k < Kcc; k++) {
                double t_total = 0.0;
                if (params.cc_lambda[k] >= 1e-15) {
                    for (int i = 0; i < d; i++) {
                        double visit = params.cc_alpha[k][i] / params.cc_lambda[k];
                        t_total += visit * (ew_sta[i] + 1.0 / params.cc_mu[k][i]);
                    }
                }
                printf("N_total(class %d) = %.6f\n", k + 1, params.cc_lambda[k] * t_total);
            }
            printf("\n");
        }
    } else if (compact) {
        printf("Finite Element Method (Gauss-Legendre)\n");
        printf("==================\n");
        {
            int w = 1;
            for (int t = params.K; t >= 10; t /= 10) w++;
            for (int i = 0; i < params.K; i++) {
                printf("E[X_%0*d] = %.6f\n", w, i + 1, q[i]);
            }
        }
        printf("\n");
    } else {
        /* Display results — print E[X_k] last so they are always visible */
        printf("\n=== Results ===\n");

        printf("Boundary measures (delta):\n");
        for (int face = 0; face < 2 * params.K; face++) {
            int dim = face < params.K ? face : face - params.K;
            const char *type = face < params.K ? "lower" : "upper";
            printf("  delta(x_%d=%s) = %.6f\n", dim + 1, type, delta[face]);
        }

        printf("\nTotal time: %.2f seconds\n", elapsed);

        /* Print throughput if service rates available */
        if (params.has_service_rates) {
            printf("\n");
            for (int i = 0; i < params.K; i++) {
                /* delta grouped: delta[i] = lower face of dim i */
                double gamma_k = params.service_rates[i] - delta[i];
                printf("Gamma_%d = %.6f\n", i + 1, gamma_k);
            }
        }

        printf("\n");
        {
            int w = 1;
            for (int t = params.K; t >= 10; t /= 10) w++;
            for (int i = 0; i < params.K; i++) {
                printf("E[X_%0*d] = %.6f\n", w, i + 1, q[i]);
            }
        }
    }

    /* Cleanup */
    cholmod_free_sparse(&A, &c);
    cholmod_finish(&c);
    free(y);
    free(u);

    return 0;
}
