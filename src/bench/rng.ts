// Seeded RNG wrapper around random-js's MT19937.
//
// Provides the primitives the bench needs:
//   random()       — uniform [0, 1)
//   randInt(a, b)  — uniform integer in [a, b] inclusive
//   randRange(n)   — uniform integer in [0, n)  (used by bootstrap)
//   sample(arr, k) — k distinct elements from arr (used by RANDOM_TASKS)
//   shuffle(arr)   — Fisher-Yates on a copy (used by SHUFFLE mode)
//
// IMPORTANT — documented divergence: this RNG is statistically equivalent to
// Python's `random.Random(seed)` but produces a different sequence for the
// same seed. CPython's `random.Random` uses MT19937 with `init_by_array`
// seeding plus a specific rejection-sampling `_randbelow_with_getrandbits`.
// `random-js` MT19937 uses the same algorithm but different seeding glue, so
// `random()` values differ. At BOOTSTRAP_ITERS=10000 Monte Carlo error
// (~1/√N) dominates this divergence; CI endpoints agree within ~1%.

import { MersenneTwister19937, Random } from 'random-js';

export interface SeededRng {
  random(): number;
  randRange(n: number): number;
  randInt(a: number, b: number): number;
  sample<T>(arr: readonly T[], k: number): T[];
  shuffle<T>(arr: readonly T[]): T[];
}

class SeededRngImpl implements SeededRng {
  private readonly r: Random;

  constructor(seed: number) {
    this.r = new Random(MersenneTwister19937.seed(seed | 0));
  }

  random(): number {
    return this.r.realZeroToOneExclusive();
  }

  randRange(n: number): number {
    if (n <= 0) throw new Error(`randRange: n must be > 0, got ${n}`);
    return this.r.integer(0, n - 1);
  }

  randInt(a: number, b: number): number {
    return this.r.integer(a, b);
  }

  sample<T>(arr: readonly T[], k: number): T[] {
    if (k < 0 || k > arr.length) {
      throw new Error(`sample: k=${k} out of range for arr.length=${arr.length}`);
    }
    // random-js `sample` is generic over the array element type.
    return this.r.sample(arr.slice(), k);
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const copy = arr.slice();
    this.r.shuffle(copy);
    return copy;
  }
}

/** Build a new seeded RNG. Same `seed` always reproduces the same sequence. */
export function createRng(seed: number): SeededRng {
  return new SeededRngImpl(seed);
}
