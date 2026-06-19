// Token-usage aggregation and cost computation.
//
// Pure functions, fully unit-testable. Ports bench_tokens.py lines 499-579.
// Key invariants:
//   - `aggregateTurns` sums per-call usage and sets `calls` to the count.
//   - `meanUsage` averages per-key across a list of replicate UsageDicts.
//   - `totalTokens` and `costUsd` use the exact pricing constants from
//     config.PRICING; cost matches Python's `cost_usd` byte-for-byte.

import { PRICING } from './config.js';
import { Turn, UsageDict } from './types.js';

const ZERO_USAGE: UsageDict = Object.freeze({
  calls: 0,
  input: 0,
  cache_read: 0,
  cache_create: 0,
  output: 0,
});

/** Build an empty UsageDict (caller-owned, mutable copy of the constant). */
export function zeroUsage(): UsageDict {
  return { calls: 0, input: 0, cache_read: 0, cache_create: 0, output: 0 };
}

/**
 * Sum per-call turns into a single UsageDict.
 * Port of bench_tokens.py `aggregate_turns` (lines 499-506).
 *
 *   out["calls"] = len(turns)
 *   out[k] += sum(t[k] for t in turns)  // for each token-type key
 */
export function aggregateTurns(turns: Turn[]): UsageDict {
  const out = zeroUsage();
  out.calls = turns.length;
  for (const t of turns) {
    out.input += t.input;
    out.cache_read += t.cache_read;
    out.cache_create += t.cache_create;
    out.output += t.output;
  }
  return out;
}

/**
 * Per-key arithmetic mean across a list of replicate UsageDicts.
 * Port of bench_tokens.py `mean_usage` (lines 572-579).
 *
 * Returns a UsageDict whose fields are non-integer when the inputs don't
 * divide evenly — Python does the same (it uses float division for the mean).
 */
export function meanUsage(usages: UsageDict[]): UsageDict {
  if (usages.length === 0) return zeroUsage();
  const n = usages.length;
  const sum = zeroUsage();
  for (const u of usages) {
    sum.calls += u.calls;
    sum.input += u.input;
    sum.cache_read += u.cache_read;
    sum.cache_create += u.cache_create;
    sum.output += u.output;
  }
  return {
    calls: sum.calls / n,
    input: sum.input / n,
    cache_read: sum.cache_read / n,
    cache_create: sum.cache_create / n,
    output: sum.output / n,
  };
}

/**
 * Total tokens across all four lanes. Used as the denominator for
 * "edgee uses N% fewer tokens" style claims and for ratios in the report.
 * Port of bench_tokens.py `total_tokens` (lines 567-569).
 */
export function totalTokens(u: { input: number; cache_read: number; cache_create: number; output: number }): number {
  return u.input + u.cache_read + u.cache_create + u.output;
}

/**
 * Anthropic cost in USD assuming Opus 4.7 list pricing and 1h-TTL cache writes.
 * Port of bench_tokens.py `cost_usd` (lines 557-564).
 *
 *   input * 5    + cache_read * 0.5 + cache_create * 10 + output * 25
 *   ─────────    ─────────────────  ──────────────────  ────────────
 *   per million
 */
export function costUsd(u: {
  input: number;
  cache_read: number;
  cache_create: number;
  output: number;
}): number {
  return (
    (u.input * PRICING.inputPerM) / 1_000_000 +
    (u.output * PRICING.outputPerM) / 1_000_000 +
    (u.cache_read * PRICING.cacheReadPerM) / 1_000_000 +
    (u.cache_create * PRICING.cacheCreate1hPerM) / 1_000_000
  );
}
