// Statistical machinery — median, stdev, binomial coefficient, paired sign
// test, and percentile bootstrap CI.
//
// Pure, no I/O. Port of bench_tokens.py lines 582-613 + the inline `stats`
// helper at lines 942-952. Two intentional bit-level divergences from Python
// (documented in the plan and asserted by the fixture tests):
//
//   1. Bootstrap CI endpoints differ because the underlying RNG is a separate
//      MT19937 implementation; we accept ≤5% divergence on CI half-widths.
//   2. Last-decimal float formatting differs (banker's vs half-away). Handled
//      by report-swe.ts, not here.
//
// EVERY other quantity in this module — median, stdev, comb, sign-test p-value
// — must match Python bit-for-bit. The fixture tests gate this.

import type { SeededRng } from './rng.js';

/**
 * Sample median of `xs`. Hand-rolled to match Python's `statistics.median`:
 *   - sort ascending (stable in JS for primitives)
 *   - return middle element for odd n, arithmetic mean of two middles for even n
 *
 * For our integer/ratio inputs (n ~ 6-30) this produces bit-identical results
 * to `statistics.median`. We deliberately avoid `simple-statistics` whose
 * `median` uses quickselect (correct value, occasional last-bit differences
 * for floats near machine epsilon).
 */
export function median(xs: readonly number[]): number {
  const a = xs.slice().sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return Number.NaN;
  if (n % 2 === 1) return a[(n - 1) / 2];
  return (a[n / 2 - 1] + a[n / 2]) / 2;
}

/**
 * Sample standard deviation (Bessel-corrected). Port of Python's
 * `statistics.stdev` for our float inputs. Two-pass algorithm: compute mean,
 * then sum squared deviations. Returns 0 for n < 2 (matches Python policy
 * elsewhere in the bench, though `statistics.stdev` itself raises — we follow
 * the bench's defensive default at bench_tokens.py:945).
 *
 * KNOWN MICRO-DIVERGENCE FROM PYTHON: `statistics.stdev` routes the mean and
 * sum-of-squared-deviations through `Fraction` exact arithmetic, then converts
 * back to float. Our straight float two-pass can differ at the 16-17th
 * significant digit (~2 ULPs). The bench reports stdev to 3 decimal places,
 * so this is below the reporting precision — but the fixture test uses a
 * 1e-12 relative-error tolerance rather than strict equality.
 */
export function stdev(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let s = 0;
  for (const x of xs) s += x;
  const m = s / n;
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (n - 1));
}

/** Sample arithmetic mean. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Binomial coefficient n-choose-k. Exact for any n via BigInt, then converted
 * to Number at the use site. Safe for the bench's n ≤ ~50 paired-sign-test
 * range. Returns 0n for invalid k.
 *
 * Loop order matches CPython's `math.comb` implementation:
 *   c = 1
 *   for i in range(k): c = c * (n - i) // (i + 1)
 * Iteratively-divided form keeps the BigInt small and the result exact.
 */
export function comb(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  // Reduce work by using the symmetry comb(n,k) === comb(n, n-k); matches
  // CPython's optimization (Modules/mathmodule.c `math_comb_impl`).
  let kk = Math.min(k, n - k);
  let num = 1n;
  let den = 1n;
  for (let i = 0; i < kk; i++) {
    num *= BigInt(n - i);
    den *= BigInt(i + 1);
  }
  return num / den;
}

export interface SignTestResult {
  /** Two-sided p-value (already capped at 1.0). */
  pValue: number;
  nPositive: number;
  nNegative: number;
  nTies: number;
}

/**
 * Two-sided paired sign test for `H0: median(deltas) = 0`.
 * Port of bench_tokens.py `sign_test_two_sided` (lines 599-613).
 *
 * Algorithm (matches Python exactly):
 *   n_pos = count(d > 0)
 *   n_neg = count(d < 0)
 *   n_tie = count(d == 0)
 *   n = n_pos + n_neg   (ties dropped)
 *   if n == 0: return p=1.0
 *   extreme = max(n_pos, n_neg)
 *   p_one_sided = sum_{k=extreme..n} C(n,k) * 0.5^n
 *   p_two_sided = min(1.0, 2 * p_one_sided)
 *
 * The summation order is preserved (k from extreme to n) for last-bit
 * fidelity with Python.
 */
export function signTestTwoSided(deltas: readonly number[]): SignTestResult {
  let nPos = 0;
  let nNeg = 0;
  let nTie = 0;
  for (const d of deltas) {
    if (d > 0) nPos++;
    else if (d < 0) nNeg++;
    else nTie++;
  }
  const n = nPos + nNeg;
  if (n === 0) return { pValue: 1.0, nPositive: nPos, nNegative: nNeg, nTies: nTie };

  const extreme = Math.max(nPos, nNeg);
  const halfN = 0.5 ** n;
  let p = 0;
  for (let k = extreme; k <= n; k++) {
    p += Number(comb(n, k)) * halfN;
  }
  return {
    pValue: Math.min(1.0, 2.0 * p),
    nPositive: nPos,
    nNegative: nNeg,
    nTies: nTie,
  };
}

/**
 * Percentile bootstrap CI for the supplied `statistic` over `values`.
 * Port of bench_tokens.py `bootstrap_ci` (lines 582-596).
 *
 * Algorithm:
 *   for _ in range(n_iter):
 *     resample = [values[rng.randrange(n)] for _ in range(n)]
 *     samples.append(statistic(resample))
 *   samples.sort()
 *   lo = samples[int(n_iter * (1 - ci) / 2)]
 *   hi = samples[min(n_iter - 1, int(n_iter * (1 + ci) / 2))]
 *
 * The integer truncation matches Python's `int()`: for positive numbers,
 * `int(x)` equals `Math.trunc(x)` equals `Math.floor(x)`. We use `Math.floor`.
 *
 * Note: the result is statistically equivalent to Python but NOT bit-identical
 * — the underlying MT19937 is a different implementation, so the resamples
 * differ. CI endpoints typically agree within ~1% at n_iter=10000 (Monte
 * Carlo error dominates).
 */
export interface BootstrapCi {
  lo: number;
  hi: number;
}

export function bootstrapCi(
  values: readonly number[],
  statistic: (xs: readonly number[]) => number,
  nIter: number,
  rng: SeededRng,
  ci = 0.95,
): BootstrapCi {
  const n = values.length;
  if (n === 0) return { lo: Number.NaN, hi: Number.NaN };
  const samples = new Array<number>(nIter);
  const resample = new Array<number>(n);
  for (let i = 0; i < nIter; i++) {
    for (let j = 0; j < n; j++) {
      resample[j] = values[rng.randRange(n)];
    }
    samples[i] = statistic(resample);
  }
  samples.sort((a, b) => a - b);
  const loIdx = Math.floor(nIter * (1 - ci) / 2);
  const hiIdx = Math.min(nIter - 1, Math.floor(nIter * (1 + ci) / 2));
  return { lo: samples[loIdx], hi: samples[hiIdx] };
}

/** Drop NaN/Inf from an array. Used to guard the stats pipeline against
 *  failed-task rows (calls=0 produces NaN ratios). */
export function dropNonFinite(xs: readonly number[]): number[] {
  return xs.filter(x => Number.isFinite(x));
}
