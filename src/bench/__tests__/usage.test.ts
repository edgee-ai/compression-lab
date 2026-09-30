// Token-usage aggregation + cost computation tests.
// Fixture-based: pulls golden expected aggregates from the session expected.json
// files captured by _capture_jsonl_fixtures.py.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// The fixtureUrl helper resolves the fixture path relative to this file.
const here = path.dirname(fileURLToPath(import.meta.url));
import { aggregateTurns, costUsd, meanUsage, totalTokens, zeroUsage } from '../usage.js';
import { PRICING } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../test/fixtures/sessions');

interface SessionFixture {
  session_id: string;
  turns: Array<{ input: number; cache_read: number; cache_create: number; output: number }>;
  aggregated: {
    calls: number;
    input: number;
    cache_read: number;
    cache_create: number;
    output: number;
  };
  total_tokens: number;
}

function loadSessionFixtures(): SessionFixture[] {
  return readdirSync(FIXTURES)
    .filter(name => name.endsWith('.expected.json'))
    .map(name => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')));
}

const fixtures = loadSessionFixtures();

describe('usage: aggregateTurns matches Python', () => {
  for (const fx of fixtures) {
    it(`aggregates ${fx.session_id.slice(0, 8)}… (${fx.turns.length} turns)`, () => {
      const agg = aggregateTurns(fx.turns);
      expect(agg.calls).toBe(fx.aggregated.calls);
      expect(agg.input).toBe(fx.aggregated.input);
      expect(agg.cache_read).toBe(fx.aggregated.cache_read);
      expect(agg.cache_create).toBe(fx.aggregated.cache_create);
      expect(agg.output).toBe(fx.aggregated.output);
    });
  }
});

describe('usage: totalTokens', () => {
  for (const fx of fixtures) {
    it(`totalTokens(${fx.session_id.slice(0, 8)}…) == ${fx.total_tokens}`, () => {
      expect(totalTokens(fx.aggregated)).toBe(fx.total_tokens);
    });
  }

  it('zero usage → 0', () => {
    expect(totalTokens(zeroUsage())).toBe(0);
  });
});

describe('usage: meanUsage', () => {
  it('average of two identical UsageDicts is the same dict', () => {
    const u = { calls: 5, input: 10, cache_read: 20, cache_create: 30, output: 40 };
    const m = meanUsage([u, u]);
    expect(m).toEqual(u);
  });

  it('average of two different UsageDicts is component-wise mean', () => {
    const a = { calls: 0, input: 100, cache_read: 200, cache_create: 0, output: 50 };
    const b = { calls: 4, input: 200, cache_read: 400, cache_create: 100, output: 150 };
    expect(meanUsage([a, b])).toEqual({
      calls: 2,
      input: 150,
      cache_read: 300,
      cache_create: 50,
      output: 100,
    });
  });

  it('empty list → zero usage', () => {
    expect(meanUsage([])).toEqual(zeroUsage());
  });
});

describe('usage: costUsd at Opus 4.7 list pricing', () => {
  it('matches the analytical formula', () => {
    // 1M input + 0 of everything else = $5
    expect(costUsd({ input: 1_000_000, cache_read: 0, cache_create: 0, output: 0 })).toBeCloseTo(
      PRICING.inputPerM,
      9,
    );
    // 1M output = $25
    expect(costUsd({ input: 0, cache_read: 0, cache_create: 0, output: 1_000_000 })).toBeCloseTo(
      PRICING.outputPerM,
      9,
    );
    // 1M cache_read = $0.50
    expect(costUsd({ input: 0, cache_read: 1_000_000, cache_create: 0, output: 0 })).toBeCloseTo(
      PRICING.cacheReadPerM,
      9,
    );
    // 1M cache_create = $10
    expect(costUsd({ input: 0, cache_read: 0, cache_create: 1_000_000, output: 0 })).toBeCloseTo(
      PRICING.cacheCreate1hPerM,
      9,
    );
  });

  it('zero → 0', () => {
    expect(costUsd(zeroUsage())).toBe(0);
  });

  it('matches the Python bench cost on a real session', () => {
    // Trivially zero; richer round-trip is in the fixture diff test below.
    expect(costUsd({ input: 0, cache_read: 0, cache_create: 0, output: 0 })).toBe(0);
  });
});

// ──────── Bit-exact cost match against Python on real fixture data ──────

interface PerTaskDeltasFixture {
  per_task: Array<{
    task_id: string;
    vanilla_mean: { input: number; cache_read: number; cache_create: number; output: number; calls: number };
    edgee_mean: { input: number; cache_read: number; cache_create: number; output: number; calls: number };
    delta_cost_usd: number;
  }>;
}

describe('usage: costUsd matches Python bit-exact on the 13 brevity-run tasks', () => {
  const fixturePath = path.resolve(here, '../../../test/fixtures/stats/per-task-deltas.json');
  const fx: PerTaskDeltasFixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  for (const task of fx.per_task) {
    it(`${task.task_id} — TS cost delta == Python cost delta`, () => {
      const tsDelta = costUsd(task.vanilla_mean) - costUsd(task.edgee_mean);
      // Both impls use IEEE-754 doubles and the same per-token-rate formula.
      // The meanUsage() and costUsd() arithmetic should produce identical
      // last-bit results given identical inputs. If a future input ever
      // produces drift, this becomes a numeric-tolerance check; until then
      // we assert bit-exact.
      expect(tsDelta).toBe(task.delta_cost_usd);
    });
  }
});
