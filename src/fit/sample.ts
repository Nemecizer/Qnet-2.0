// "Use Example Data": 60 made-up service times (drawn once from a Gamma law with shape 3.2 and
// scale 1.4, rounded to two decimals), so the panel can be tried before any measuring is done.
// The browser preview's recorded answer for them is src/dev/mock/fit-fixtures.json ("service").
export const EXAMPLE_VALUES: readonly number[] = [
  2.32, 3.52, 2.0, 1.29, 3.14, 4.48, 7.08, 4.51, 4.39, 3.32,
  2.01, 4.34, 3.72, 3.2, 4.04, 3.44, 3.02, 2.21, 4.58, 6.17,
  3.28, 7.27, 5.39, 4.0, 5.51, 6.55, 10.58, 4.71, 3.18, 5.77,
  0.3, 7.13, 7.92, 1.25, 1.77, 3.43, 1.21, 2.55, 5.79, 13.28,
  0.84, 1.44, 6.12, 3.12, 4.66, 5.79, 4.9, 5.26, 1.75, 1.85,
  6.69, 2.23, 6.37, 2.8, 4.88, 5.56, 6.02, 2.47, 4.72, 1.99,
];

export const EXAMPLE_TEXT = EXAMPLE_VALUES.join("\n");
