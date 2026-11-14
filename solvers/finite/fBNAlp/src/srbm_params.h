#ifndef SRBM_PARAMS_H
#define SRBM_PARAMS_H

#include "srbm_types.h"

/* Parse an input file and fill params.  Returns 0 on success. */
int srbm_params_read(const char *filename, srbm_params_t *params);

/* Validate parameters.  Returns 0 if OK, prints errors to stderr. */
int srbm_params_validate(const srbm_params_t *params);

/* Refuse a problem whose sizes do not fit the solver's int indices (n^d grid
 * points, C(m+d, d) basis functions, and the products the assembly forms from
 * them). Returns 0 if every count fits; otherwise prints one line on stderr
 * and returns -1. Call after srbm_params_validate and before any allocation. */
int srbm_params_check_size(const srbm_params_t *params);

/* Print parameters to stdout for confirmation. */
void srbm_params_print(const srbm_params_t *params);

#endif /* SRBM_PARAMS_H */
