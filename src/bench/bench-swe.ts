#!/usr/bin/env node
// SWE-bench Lite token-consumption bench — TypeScript port of
// /Users/kham/Documents/code/benchmarks/cache/bench_tokens.py.
//
// CLI entrypoint. Env-var driven (no flags). Layout mirrors the Python
// `main()` at bench_tokens.py lines 616-1131.
//
// Knobs (1:1 with Python):
//   AGENT_MODE=1                Single autonomy prompt; agent loop drives.
//   AGENT_TIMEOUT_S=1800        Per-session timeout in agent mode.
//   REPLICATES=3                N per (task, backend); >1 enables stats mode.
//   SHUFFLE=1                   Randomize (backend, replicate) order per task.
//   SEED=42                     Pin RNG; defaults to a fresh random seed.
//   BOOTSTRAP_ITERS=10000       Resamples for CIs.
//   TASK_LIMIT=N                Slice FROZEN_TASKS.
//   RANDOM_TASKS=N              Override with N random tasks from SWE-bench Lite.
//   WARMUP_S=10                 Sleep before first prompt (MCP cold-start grace).
//   ORDER=edgee,vanilla         Backend order override.
//   BENCH_SWE_LITE_PATH=…       Local parquet path (for air-gapped runs).
//   EDGEE_BIN=…                 Override edgee binary path.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BACKENDS,
  FROZEN_TASKS,
  PATCHES_DIR_FROM_REPO,
  PER_TURN_TIMEOUT_S,
  REPORTS_DIR_FROM_REPO,
  loadConfig,
  resolveBackendOrder,
} from './config.js';
import { ensureRepo, resetRepo, captureDiff } from './repo.js';
import { fetchTask, sampleRandomTasks } from './tasks.js';
import { runStreamSession } from './stream-session.js';
import { parseSessionTurns } from './claude-jsonl.js';
import { aggregateTurns, costUsd, meanUsage, totalTokens, zeroUsage } from './usage.js';
import { bootstrapCi, dropNonFinite, median, signTestTwoSided, stdev, mean } from './stats.js';
import { createRng } from './rng.js';
import { buildPrompts } from './prompts.js';
import { writeReports, ReportInput, StatsBlock } from './report-swe.js';
import { BackendName, RunResult, Task, UsageDict } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Walk up from src/bench/ to the repo root.
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PATCHES_DIR = path.join(REPO_ROOT, PATCHES_DIR_FROM_REPO);
const REPORTS_DIR = path.join(REPO_ROOT, REPORTS_DIR_FROM_REPO);

async function main(): Promise<number> {
  const cfg = loadConfig(process.env);
  const backendOrder = resolveBackendOrder(cfg.orderEnv);
  const rng = createRng(cfg.seed);

  console.log(`Token consumption bench — SWE-bench Lite`);
  console.log(
    `mode: ${cfg.agentMode ? 'AGENT' : 'scripted (3 prompts)'}  ` +
      `backends: ${JSON.stringify(backendOrder)}  ` +
      `warmup: ${cfg.warmupS}s`,
  );
  if (cfg.statsMode) {
    console.log(`stats mode: REPLICATES=${cfg.replicates}  SHUFFLE=${cfg.shuffle}  SEED=${cfg.seed}`);
  }

  // ──── Task selection ───────────────────────────────────────────────────
  let tasksToRun: string[];
  if (cfg.randomTasks > 0) {
    // Use a dedicated RNG for sampling so SHUFFLE order remains
    // deterministic w.r.t. the same SEED regardless of how many tasks were
    // sampled.
    const sampleRng = createRng(cfg.seed);
    tasksToRun = await sampleRandomTasks(cfg.randomTasks, sampleRng, cfg.sweLitePathOverride);
    console.log(`Sampled ${tasksToRun.length} random task(s) from SWE-bench Lite (seed=${cfg.seed})`);
    for (const t of tasksToRun) console.log(`  - ${t}`);
  } else {
    tasksToRun = FROZEN_TASKS.slice(0, cfg.taskLimit);
  }
  console.log();

  // ──── Per-task run loop ────────────────────────────────────────────────
  const results: Record<string, Record<string, RunResult[]>> = {};
  for (const taskId of tasksToRun) results[taskId] = {};

  for (const taskId of tasksToRun) {
    console.log(`──── Task ${taskId} ────`);
    const task = await fetchTask(taskId, cfg.sweLitePathOverride);
    if (task === null) {
      console.log(`  [yellow] task not in SWE-bench Lite, skipping`);
      continue;
    }
    const repoPath = await ensureRepo(task);
    for (const name of backendOrder) results[taskId][name] = [];

    // Build the (backend, replicate) execution plan for this task.
    const runs: { backend: BackendName; replicate: number }[] = [];
    for (const backend of backendOrder) {
      for (let r = 0; r < cfg.replicates; r++) {
        runs.push({ backend, replicate: r });
      }
    }
    if (cfg.shuffle && cfg.statsMode) {
      const shuffled = rng.shuffle(runs);
      // shuffle returned a new array; replace in place
      runs.length = 0;
      runs.push(...shuffled);
    }

    for (const { backend, replicate } of runs) {
      const result = await runOneSession({
        task,
        repoPath,
        backend,
        replicate,
        cfg,
      });
      results[taskId][backend].push(result);
      const u = result.usage;
      const tot = totalTokens(u);
      const cost = costUsd(u);
      const label = cfg.statsMode
        ? `${backend} (replicate ${replicate + 1}/${cfg.replicates})`
        : backend;
      console.log(
        `  ${label}: calls=${u.calls} in=${u.input} cache_read=${u.cache_read.toLocaleString()} ` +
          `cache_create=${u.cache_create.toLocaleString()} out=${u.output.toLocaleString()} ` +
          `total=${tot.toLocaleString()} $${cost.toFixed(4)}`,
      );
      // Print the session_id so the user can verify this session against
      // ccusage in real time, without having to wait for the report.
      if (result.sessionId !== null) {
        console.log(`    sid → ${result.sessionId}`);
      }
      if (result.diffPath !== null) {
        console.log(`    diff → ${path.relative(REPO_ROOT, result.diffPath)}`);
      }
      if (u.calls === 0 || tot === 0) {
        // Surface a clear message when subscription-limit (or other early
        // bail-out) hits. Matches the Python bench's diagnostic block.
        const limitHit = result.resultEvents.some(ev => {
          const s = String((ev as Record<string, unknown>).result ?? '').toLowerCase();
          return s.includes('session limit') || s.includes('session-limit');
        });
        if (limitHit) {
          console.log('    [red] subscription session limit reached — remaining tasks likely to fail too');
        } else {
          console.log('    [yellow] no useful API output — last raw lines:');
          for (const line of result.rawTail.slice(-3)) console.log(`      raw: ${line}`);
        }
      }
    }
  }

  // ──── Stats (only in stats mode) ───────────────────────────────────────
  let stats: StatsBlock | undefined = undefined;
  if (cfg.statsMode) {
    stats = computeStats({ tasksToRun, results, backendOrder, cfg, rng });
  }

  // ──── Reports ──────────────────────────────────────────────────────────
  const finishedAt = new Date().toISOString();
  const reportInput: ReportInput = {
    config: cfg,
    backendOrder,
    tasksRun: tasksToRun,
    results,
    finishedAt,
    stats,
  };
  const { mdPath, jsonPath } = await writeReports(REPORTS_DIR, reportInput);
  console.log();
  console.log(`Wrote ${path.relative(REPO_ROOT, mdPath)}`);
  console.log(`Wrote ${path.relative(REPO_ROOT, jsonPath)}`);
  return 0;
}

// ──────── One-session helper ───────────────────────────────────────────────

interface RunOneSessionOpts {
  task: Task;
  repoPath: string;
  backend: BackendName;
  replicate: number;
  cfg: ReturnType<typeof loadConfig>;
}

async function runOneSession(opts: RunOneSessionOpts): Promise<RunResult> {
  const { task, repoPath, backend, replicate, cfg } = opts;

  await resetRepo(repoPath, task.base_commit);

  // Per-replicate nonce so each replicate starts from cold cache. Only
  // applied in stats mode (matches Python).
  const nonce = cfg.statsMode ? Math.random().toString(36).slice(2, 14) : null;
  const prompts = buildPrompts(task, { nonce, agentMode: cfg.agentMode });

  const { sessionId, resultEvents, rawTail } = await runStreamSession({
    cmd: BACKENDS[backend],
    cwd: repoPath,
    prompts,
    perTurnTimeoutS: cfg.agentMode ? cfg.agentTimeoutS : PER_TURN_TIMEOUT_S,
    warmupS: cfg.warmupS,
    onTurnStart: (i, n, p) => {
      const preview = p.split('\n', 1)[0]?.slice(0, 70) ?? '';
      console.log(`    turn ${i}/${n}: ${preview}${preview.length === 70 ? '…' : ''}`);
    },
  });

  const turns = sessionId !== null ? await parseSessionTurns(repoPath, sessionId) : [];
  const usage: UsageDict = turns.length > 0 ? aggregateTurns(turns) : zeroUsage();

  let diffPath: string | null = null;
  if (cfg.agentMode && sessionId !== null) {
    diffPath = await captureDiff({
      taskId: task.instance_id,
      backend,
      replicate: replicate + 1,
      sessionId,
      patchesDir: PATCHES_DIR,
      repoPath,
    });
  }

  return { sessionId, usage, turns, resultEvents, rawTail, diffPath };
}

// ──────── Stats computation ───────────────────────────────────────────────

interface ComputeStatsOpts {
  tasksToRun: string[];
  results: Record<string, Record<string, RunResult[]>>;
  backendOrder: BackendName[];
  cfg: ReturnType<typeof loadConfig>;
  rng: ReturnType<typeof createRng>;
}

function computeStats(opts: ComputeStatsOpts): StatsBlock {
  const { tasksToRun, results, cfg, rng } = opts;

  // Build per-task delta arrays.
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
  // (Earlier draft created fresh per-metric RNGs, which incorrectly made
  // the resamples correlated across metrics.)
  const ciTokenRatio = bootstrapCi(cleanRatios, median, cfg.bootstrapIters, rng);
  const ciDeltaCost = bootstrapCi(cleanDeltaCost, median, cfg.bootstrapIters, rng);
  const ciDeltaTokens = bootstrapCi(cleanDeltaTokens, median, cfg.bootstrapIters, rng);
  const ciDeltaOutput = bootstrapCi(cleanDeltaOutput, median, cfg.bootstrapIters, rng);

  // Sign tests.
  const signTestTokens = signTestTwoSided(cleanDeltaTokens);
  const signTestCost = signTestTwoSided(cleanDeltaCost);
  const signTestOutput = signTestTwoSided(cleanDeltaOutput);

  // Within-(task, backend) CV across all cells with ≥2 valid replicates.
  const cvs: number[] = [];
  for (const taskId of tasksToRun) {
    const byBackend = results[taskId];
    if (!byBackend) continue;
    for (const name of opts.backendOrder) {
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

// ──────── Entrypoint ───────────────────────────────────────────────────────

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
