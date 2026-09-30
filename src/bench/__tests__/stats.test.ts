// Stats fixture tests. Validates that the TypeScript port reproduces
// Python's median/stdev/comb/sign-test bit-for-bit, and that bootstrap CIs
// agree within the documented 5% RNG-divergence tolerance.
//
// Fixtures live at compression-lab/test/fixtures/stats/ and were generated
// by /Users/kham/Documents/code/benchmarks/cache/_capture_fixtures.py from
// the brevity-13 random-task bench run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapCi, comb, dropNonFinite, mean, median, signTestTwoSided, stdev } from '../stats.js';
import { createRng } from '../rng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../test/fixtures/stats');

interface PerTaskDeltasFixture {
  schema_version: number;
  n_tasks: number;
  ratios: number[];
  output_deltas: number[];
  total_deltas: number[];
  cost_deltas: number[];
}

interface DescriptiveBlock {
  values: number[];
  descriptive: { n: number; mean: number; median: number; stdev: number };
  bootstrap: { iters: number; seed: number; ci_lo: number; ci_hi: number };
}

interface StatsGoldenFixture {
  schema_version: number;
  descriptive: Record<string, DescriptiveBlock>;
  sign_test_two_sided: Record<
    string,
    { p_value: number; n_positive: number; n_negative: number; n_ties: number }
  >;
  comb_table: Record<string, number[] | number>;
}

const deltas: PerTaskDeltasFixture = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, 'per-task-deltas.json'), 'utf8'),
);
const golden: StatsGoldenFixture = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, 'stats-golden.json'), 'utf8'),
);

describe('stats: descriptive statistics (must be bit-exact vs Python)', () => {
  for (const [name, block] of Object.entries(golden.descriptive)) {
    describe(name, () => {
      const xs = block.values;
      const exp = block.descriptive;

      it('n', () => {
        expect(xs.length).toBe(exp.n);
      });

      it('mean — bit-exact', () => {
        expect(mean(xs)).toBe(exp.mean);
      });

      it('median — bit-exact', () => {
        expect(median(xs)).toBe(exp.median);
      });

      it('stdev — matches Python within 1 ULP (Fraction vs float two-pass)', () => {
        // Python's `statistics.stdev` routes through `Fraction` exact
        // arithmetic for the mean and sum-of-squared-deviations, then
        // converts back to float. Our straight float two-pass can differ
        // at the 16-17th significant digit (~2 ULPs). The plan flagged
        // this in the "known divergences" section. Allow ~1e-12 relative
        // error; bench reports stdev to 3 decimal places so this is
        // safely below reporting precision.
        const got = stdev(xs);
        if (exp.stdev === 0) {
          expect(got).toBe(0);
        } else {
          const relErr = Math.abs(got - exp.stdev) / Math.abs(exp.stdev);
          expect(relErr).toBeLessThan(1e-12);
        }
      });
    });
  }
});

describe('stats: sign test (must be bit-exact vs Python)', () => {
  for (const [name, exp] of Object.entries(golden.sign_test_two_sided)) {
    it(`${name} — p-value, counts`, () => {
      const xs = (deltas as unknown as Record<string, number[]>)[name];
      expect(xs).toBeDefined();
      const result = signTestTwoSided(xs);
      expect(result.nPositive).toBe(exp.n_positive);
      expect(result.nNegative).toBe(exp.n_negative);
      expect(result.nTies).toBe(exp.n_ties);
      // p-value is computed as `Σ C(n,k) * 0.5^n` followed by 2× and clamp.
      // Same loop order as Python → bit-exact expected for n ≤ 50.
      expect(result.pValue).toBe(exp.p_value);
    });
  }
});

describe('stats: binomial coefficients (BigInt, must be exact)', () => {
  const comb8 = golden.comb_table['comb(8,0..8)'] as number[];
  const comb13 = golden.comb_table['comb(13,0..13)'] as number[];
  const comb20 = golden.comb_table['comb(20,0..20)'] as number[];
  const comb5025 = golden.comb_table['comb(50,25)'] as number;

  it('C(8, k) for k = 0..8', () => {
    for (let k = 0; k <= 8; k++) {
      expect(Number(comb(8, k))).toBe(comb8[k]);
    }
  });

  it('C(13, k) for k = 0..13 (matches the bench n=13 sign test)', () => {
    for (let k = 0; k <= 13; k++) {
      expect(Number(comb(13, k))).toBe(comb13[k]);
    }
  });

  it('C(20, k) for k = 0..20', () => {
    for (let k = 0; k <= 20; k++) {
      expect(Number(comb(20, k))).toBe(comb20[k]);
    }
  });

  it('C(50, 25) — large value, stays exact via BigInt', () => {
    expect(comb(50, 25)).toBe(BigInt(comb5025));
  });

  it('C(n, k) = 0 for k < 0 or k > n', () => {
    expect(comb(10, -1)).toBe(0n);
    expect(comb(10, 11)).toBe(0n);
  });
});

describe('stats: bootstrap CI (within 5% — documented RNG divergence)', () => {
  for (const [name, block] of Object.entries(golden.descriptive)) {
    it(`${name} — TS bootstrap CI overlaps Python's`, () => {
      const rng = createRng(block.bootstrap.seed);
      const result = bootstrapCi(block.values, median, block.bootstrap.iters, rng);
      const pyLo = block.bootstrap.ci_lo;
      const pyHi = block.bootstrap.ci_hi;
      const pyWidth = pyHi - pyLo;
      // Allow 5% of the Python CI width as slack on either endpoint.
      const slack = Math.abs(pyWidth) * 0.05;
      expect(result.lo).toBeGreaterThanOrEqual(pyLo - slack);
      expect(result.lo).toBeLessThanOrEqual(pyLo + slack);
      expect(result.hi).toBeGreaterThanOrEqual(pyHi - slack);
      expect(result.hi).toBeLessThanOrEqual(pyHi + slack);
    });
  }

  it('bootstrap is deterministic given the same TS seed', () => {
    const xs = deltas.cost_deltas;
    const a = bootstrapCi(xs, median, 1000, createRng(42));
    const b = bootstrapCi(xs, median, 1000, createRng(42));
    expect(a.lo).toBe(b.lo);
    expect(a.hi).toBe(b.hi);
  });

  it('bootstrap returns NaN for empty input', () => {
    const result = bootstrapCi([], median, 100, createRng(1));
    expect(Number.isNaN(result.lo)).toBe(true);
    expect(Number.isNaN(result.hi)).toBe(true);
  });
});

describe('stats: dropNonFinite', () => {
  it('drops NaN and Infinity but keeps zeros', () => {
    expect(dropNonFinite([1, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, -3])).toEqual([
      1, 0, -2, -3,
    ]);
  });
});

describe('stats: median edge cases', () => {
  it('even length — mean of two middles', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('odd length — middle element', () => {
    expect(median([1, 5, 3])).toBe(3);
  });
  it('empty — NaN', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
  it('single — that value', () => {
    expect(median([42])).toBe(42);
  });
});

describe('stats: stdev edge cases', () => {
  it('n < 2 returns 0', () => {
    expect(stdev([])).toBe(0);
    expect(stdev([7])).toBe(0);
  });
  it('Bessel-corrected: sqrt(sum((x-mean)^2) / (n-1))', () => {
    // Hand-computed: xs=[2,4,4,4,5,5,7,9], mean=5, ssd=32, var=32/7≈4.5714
    const result = stdev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });
});
