// Per-task → deltas → stats pipeline. Extracted from bench-swe.ts so the
// SWE-bench and MCP-bench entrypoints can share it.
//
// Pure logic: takes the per-(task, backend, replicate) results dict, computes
// per-task means, builds the four delta arrays, runs bootstrap CIs +
// sign-tests + within-task CV. Same algorithm as the Python bench
// (bench_tokens.py 870-1075), bit-exact on sign-tests / counts / medians and
// within the documented RNG tolerance on bootstrap CIs.

import type { BenchConfig } from './config.js';
import type { SeededRng } from './rng.js';
import { bootstrapCi, dropNonFinite, mean, median, signTestTwoSided, stdev } from './stats.js';
import { BackendName, RunResult } from './types.js';
import { costUsd, meanUsage, totalTokens } from './usage.js';
import type { StatsBlock } from './report-swe.js';

export interface ComputeStatsOpts {
  tasksToRun: string[];
  results: Record<string, Record<string, RunResult[]>>;
  backendOrder: BackendName[];
  cfg: BenchConfig;
  /** Shared RNG — advanced by each of the four bootstrap calls in sequence,
   *  matching the Python bench's pattern (ratios → cost → total → output).
   *  See bench_tokens.py 1003-1008. */
  rng: SeededRng;
}

/**
 * Build per-task deltas and compute the full StatsBlock. Used by both
 * bench-swe.ts and bench-mcp.ts.
 *
 * Per-task filter rules (match Python):
 *   - both backends must have made ≥1 API call
 *   - both backends must have non-zero total tokens
 * Tasks failing either filter are dropped from the delta arrays.
 */
export function computeStats(opts: ComputeStatsOpts): StatsBlock {
  const { tasksToRun, results, cfg, rng, backendOrder } = opts;

  const tokenRatios: number[] = [];
  const deltaTokens: number[] = [];
  const deltaOutput: number[] = [];
  const deltaCost: number[] = [];

  for (const taskId of tasksToRun) {
    const byBackend = results[taskId];
    if (!byBackend) continue;
    const v = meanUsage((byBackend.vanilla ?? []).map(r => r.usage));
    const e = meanUsage((byBackend.edgee ?? []).map(r => r.usage));
    if (v.calls === 0 || e.calls === 0) continue;
    const vTot = totalTokens(v);
    const eTot = totalTokens(e);
    if (vTot === 0 || eTot === 0) continue;
    tokenRatios.push(eTot / vTot);
    deltaTokens.push(vTot - eTot);
    deltaOutput.push(v.output - e.output);
    deltaCost.push(costUsd(v) - costUsd(e));
  }

  const cleanRatios = dropNonFinite(tokenRatios);
  const cleanDeltaTokens = dropNonFinite(deltaTokens);
  const cleanDeltaOutput = dropNonFinite(deltaOutput);
  const cleanDeltaCost = dropNonFinite(deltaCost);

  // Bootstrap CIs — share the SAME rng across all four calls, in the same
  // order as Python's bench (ratios → cost → total → output). Each call
  // advances the RNG state, so the four sets of resamples are independent.
  const ciTokenRatio = bootstrapCi(cleanRatios, median, cfg.bootstrapIters, rng);
  const ciDeltaCost = bootstrapCi(cleanDeltaCost, median, cfg.bootstrapIters, rng);
  const ciDeltaTokens = bootstrapCi(cleanDeltaTokens, median, cfg.bootstrapIters, rng);
  const ciDeltaOutput = bootstrapCi(cleanDeltaOutput, median, cfg.bootstrapIters, rng);

  const signTestTokens = signTestTwoSided(cleanDeltaTokens);
  const signTestCost = signTestTwoSided(cleanDeltaCost);
  const signTestOutput = signTestTwoSided(cleanDeltaOutput);

  // Within-(task, backend) CV across all cells with ≥2 valid replicates.
  const cvs: number[] = [];
  for (const taskId of tasksToRun) {
    const byBackend = results[taskId];
    if (!byBackend) continue;
    for (const name of backendOrder) {
      const runs = byBackend[name] ?? [];
      const totals = runs.map(r => totalTokens(r.usage)).filter(t => t > 0);
      if (totals.length >= 2) {
        const m = mean(totals);
        const sd = stdev(totals);
        if (m > 0) cvs.push(sd / m);
      }
    }
  }
  const withinTaskCvMean = cvs.length > 0 ? mean(cvs) : 0;

  return {
    medianTokenRatio: median(cleanRatios),
    ciTokenRatio,
    medianDeltaTokens: median(cleanDeltaTokens),
    ciDeltaTokens,
    medianDeltaOutput: median(cleanDeltaOutput),
    ciDeltaOutput,
    medianDeltaCost: median(cleanDeltaCost),
    ciDeltaCost,
    signTestTokens,
    signTestCost,
    signTestOutput,
    withinTaskCvMean,
    withinTaskCvCells: cvs.length,
  };
}
