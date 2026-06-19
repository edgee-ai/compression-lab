// Seeded RNG determinism + range sanity. Does NOT assert match-with-Python —
// that's intentionally not guaranteed (see rng.ts header).

import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';

describe('rng: determinism', () => {
  it('same seed → same `random()` sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 50 }, () => a.random());
    const seqB = Array.from({ length: 50 }, () => b.random());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds → different sequences', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 50 }, () => a.random());
    const seqB = Array.from({ length: 50 }, () => b.random());
    expect(seqA).not.toEqual(seqB);
  });

  it('same seed → same shuffle', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const sA = createRng(7).shuffle(arr);
    const sB = createRng(7).shuffle(arr);
    expect(sA).toEqual(sB);
  });

  it('same seed → same sample', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const sA = createRng(7).sample(arr, 4);
    const sB = createRng(7).sample(arr, 4);
    expect(sA).toEqual(sB);
  });
});

describe('rng: ranges', () => {
  it('random() in [0, 1)', () => {
    const rng = createRng(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng.random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('randRange(10) in [0, 9]', () => {
    const rng = createRng(456);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = rng.randRange(10);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
      seen.add(v);
    }
    // Should hit all 10 values in 1000 draws (very high probability).
    expect(seen.size).toBe(10);
  });

  it('randInt(a, b) is inclusive', () => {
    const rng = createRng(789);
    let sawLo = false;
    let sawHi = false;
    for (let i = 0; i < 200; i++) {
      const v = rng.randInt(5, 7);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(7);
      if (v === 5) sawLo = true;
      if (v === 7) sawHi = true;
    }
    expect(sawLo).toBe(true);
    expect(sawHi).toBe(true);
  });

  it('randRange(0) throws', () => {
    expect(() => createRng(1).randRange(0)).toThrow();
  });

  it('sample(k > arr.length) throws', () => {
    expect(() => createRng(1).sample([1, 2], 3)).toThrow();
  });
});

describe('rng: sample / shuffle invariants', () => {
  it('sample(k) returns k distinct elements from the source', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const picks = createRng(1).sample(arr, 5);
    expect(picks).toHaveLength(5);
    expect(new Set(picks).size).toBe(5);
    for (const v of picks) expect(arr).toContain(v);
  });

  it('shuffle preserves elements (multiset equality)', () => {
    const arr = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const shuffled = createRng(11).shuffle(arr);
    expect(shuffled.slice().sort()).toEqual(arr.slice().sort());
  });

  it('shuffle does not mutate input', () => {
    const arr = [1, 2, 3, 4, 5];
    const original = arr.slice();
    createRng(1).shuffle(arr);
    expect(arr).toEqual(original);
  });
});
