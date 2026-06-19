// Markdown + JSON report emitters.
//
// Produces two coordinated artifacts:
//   reports/swe-<ISO>.md   — human-readable markdown (pipe tables, matches
//                            src/analyze.ts style)
//   reports/swe-<ISO>.json — lossless machine companion: { config, tasks,
//                            results, taskMeans, deltas, stats }
//
// Port of the rich.Table rendering at bench_tokens.py lines 845-1122. We
// deliberately don't use a Markdown table builder library — analyze.ts
// already hand-builds tables this way, so we follow the same idiom.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BenchConfig, FROZEN_TASKS } from './config.js';
import { BackendName, RunResult, UsageDict } from './types.js';
import { costUsd, meanUsage, totalTokens } from './usage.js';
import { SignTestResult } from './stats.js';

// ──────── Number formatting ──────────────────────────────────────────────

/** Thousands separator (mirrors analyze.ts `fmt`). */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Banker's-rounding format helper to N decimal places (matches Python format(x, '.Nf')).
 *  Documented in the plan as one of the two intentional divergences with JS's toFixed
 *  (which rounds half-away-from-zero); we use banker's here so report numbers match
 *  Python byte-for-byte. */
export function formatFixed(x: number, n: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity';
  const sign = x < 0 ? '-' : '';
  const abs = Math.abs(x);
  const pow = 10 ** n;
  const scaled = abs * pow;
  // Banker's rounding: round-half-to-even
  let rounded: number;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (diff > 0.5) {
    rounded = floor + 1;
  } else if (diff < 0.5) {
    rounded = floor;
  } else {
    // Exactly half — round to even
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  const whole = Math.trunc(rounded / pow);
  const frac = rounded - whole * pow;
  if (n === 0) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(n, '0');
  return `${sign}${whole}.${fracStr}`;
}

/** $X.XXXX cost formatter. */
function fmtCost(x: number): string {
  return `$${formatFixed(x, 4)}`;
}

/** N.NNx ratio formatter (e.g., "0.79×"). */
function fmtRatio(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return `${formatFixed(x, 2)}×`;
}

/** "+N,NNN" / "-N,NNN" signed integer with thousands separator. */
function fmtSignedInt(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${fmtInt(n)}`;
}

/** "+$X.XXXX" / "-$X.XXXX" signed cost. */
function fmtSignedCost(x: number): string {
  const sign = x >= 0 ? '+' : '-';
  return `${sign}$${formatFixed(Math.abs(x), 4)}`;
}

/**
 * Format a fractional reduction as a signed percentage, e.g.,
 *   0.21  → "+21.0%"  (edgee saved 21% relative to vanilla)
 *  -0.08  → "-8.0%"   (edgee used 8% MORE than vanilla)
 * The sign disambiguates direction so readers don't have to remember which
 * way the metric goes.
 */
function fmtSignedPct(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const sign = x >= 0 ? '+' : '';
  return `${sign}${formatFixed(x * 100, 1)}%`;
}

/** Star a p-value: ★ for p<0.05, † for 0.05≤p<0.10, '' otherwise. */
function pSignifier(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '';
  if (p < 0.05) return '★';
  if (p < 0.1) return '†';
  return '';
}

// ──────── Report data shapes ─────────────────────────────────────────────

export interface ReportInput {
  config: BenchConfig;
  /** Backend execution order (resolved). */
  backendOrder: BackendName[];
  /** Tasks actually attempted, in the order they ran. */
  tasksRun: string[];
  /** Per-(task, backend) array of per-replicate results. */
  results: Record<string, Record<string, RunResult[]>>;
  /** When the bench completed (ISO timestamp). */
  finishedAt: string;
  /** Statistical analysis output, only populated in stats mode. */
  stats?: StatsBlock;
}

export interface StatsBlock {
  medianTokenRatio: number;
  ciTokenRatio: { lo: number; hi: number };
  medianDeltaTokens: number;
  ciDeltaTokens: { lo: number; hi: number };
  medianDeltaOutput: number;
  ciDeltaOutput: { lo: number; hi: number };
  medianDeltaCost: number;
  ciDeltaCost: { lo: number; hi: number };
  signTestTokens: SignTestResult;
  signTestCost: SignTestResult;
  signTestOutput: SignTestResult;
  /** Mean within-(task,backend) CV across all (task,backend) cells that had ≥2 replicates. */
  withinTaskCvMean: number;
  /** Number of (task, backend) cells included in the CV mean. */
  withinTaskCvCells: number;
}

// ──────── Per-task aggregation ───────────────────────────────────────────

export interface TaskMeansRow {
  taskId: string;
  vanilla: UsageDict;
  edgee: UsageDict;
  deltaOutput: number;
  deltaTotalTokens: number;
  deltaCost: number;
  tokenRatio: number;
  costRatio: number;
}

function buildTaskMeansRows(input: ReportInput): TaskMeansRow[] {
  const rows: TaskMeansRow[] = [];
  for (const taskId of input.tasksRun) {
    const byBackend = input.results[taskId];
    if (!byBackend) continue;
    const vanillaRuns = (byBackend.vanilla ?? []).map(r => r.usage);
    const edgeeRuns = (byBackend.edgee ?? []).map(r => r.usage);
    const vMean = meanUsage(vanillaRuns);
    const eMean = meanUsage(edgeeRuns);
    const vTot = totalTokens(vMean);
    const eTot = totalTokens(eMean);
    const vCost = costUsd(vMean);
    const eCost = costUsd(eMean);
    rows.push({
      taskId,
      vanilla: vMean,
      edgee: eMean,
      deltaOutput: vMean.output - eMean.output,
      deltaTotalTokens: vTot - eTot,
      deltaCost: vCost - eCost,
      tokenRatio: vTot > 0 ? eTot / vTot : Number.NaN,
      costRatio: vCost > 0 ? eCost / vCost : Number.NaN,
    });
  }
  return rows;
}

// ──────── Headline %-reduction recap ─────────────────────────────────────

/**
 * Per-metric reduction summary. Each value is a fraction (0.21 → 21%):
 *   - `aggregate`: weighted by absolute size — (Σ_vanilla - Σ_edgee) / Σ_vanilla
 *   - `perTaskValues`: per-task (1 - edgee/vanilla); tasks where vanilla = 0 are dropped
 *   - `mean`: arithmetic mean of perTaskValues (equal-weight per task)
 *   - `median`: median of perTaskValues
 *
 * Positive value = edgee REDUCED the metric vs vanilla. Negative = edgee used MORE.
 */
export interface PercentageReductions {
  aggregate: number;
  perTaskValues: number[];
  mean: number;
  median: number;
}

function reductionsFor(
  rows: TaskMeansRow[],
  pick: (u: UsageDict) => number,
): PercentageReductions {
  let sumV = 0;
  let sumE = 0;
  const perTask: number[] = [];
  for (const r of rows) {
    const v = pick(r.vanilla);
    const e = pick(r.edgee);
    sumV += v;
    sumE += e;
    if (v > 0) perTask.push(1 - e / v);
  }
  const sorted = perTask.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const median =
    n === 0
      ? Number.NaN
      : n % 2 === 1
        ? sorted[(n - 1) / 2]
        : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    aggregate: sumV > 0 ? (sumV - sumE) / sumV : Number.NaN,
    perTaskValues: perTask,
    mean: n > 0 ? perTask.reduce((a, b) => a + b, 0) / n : Number.NaN,
    median,
  };
}

/** Headline reductions for the three metrics the bench reports on. */
export interface HeadlineReductions {
  cost: PercentageReductions;
  totalTokens: PercentageReductions;
  outputTokens: PercentageReductions;
}

export function computeHeadlineReductions(rows: TaskMeansRow[]): HeadlineReductions {
  return {
    cost: reductionsFor(rows, costUsd),
    totalTokens: reductionsFor(rows, totalTokens),
    outputTokens: reductionsFor(rows, u => u.output),
  };
}

// ──────── Markdown emission ──────────────────────────────────────────────

function renderTagsCallout(input: ReportInput): string[] {
  const tags = input.config.tags;
  const notes = input.config.notes;
  if (tags.length === 0 && !notes) return [];
  const lines: string[] = [];
  if (tags.length > 0) {
    const tagBadges = tags.map(t => `\`${t}\``).join(' ');
    lines.push(`> 🏷 **Tags:** ${tagBadges}`);
  }
  if (notes) {
    lines.push(`> 📝 **Notes:** ${notes}`);
  }
  lines.push(``);
  return lines;
}

function renderConfigSnapshot(input: ReportInput): string[] {
  const c = input.config;
  const tagsCell = c.tags.length > 0 ? c.tags.map(t => `\`${t}\``).join(', ') : '_(none — set via TAGS env var)_';
  const lines = [
    `## Configuration`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Mode | ${c.agentMode ? 'AGENT' : 'scripted (3 prompts)'} |`,
    `| Tags | ${tagsCell} |`,
    `| Notes | ${c.notes || '_(none — set via NOTES env var)_'} |`,
    `| Tasks attempted | ${input.tasksRun.length} |`,
    `| Replicates per (task, backend) | ${c.replicates} |`,
    `| Shuffle | ${c.shuffle ? 'yes' : 'no'} |`,
    `| Seed | ${c.seed} |`,
    `| Bootstrap iterations | ${c.bootstrapIters} |`,
    `| Backend order | ${input.backendOrder.join(', ')} |`,
    `| Finished | ${input.finishedAt} |`,
    ``,
    `> **Known divergences from the Python bench** (documented in the plan):`,
    `> 1. Bootstrap CI endpoints — TS uses random-js MT19937, Python uses CPython's MT19937 with a different seeding routine. CI half-widths agree within ~1% at 10k iterations (Monte Carlo error dominates).`,
    `> 2. \`stdev\` may differ from Python by ~1-2 ULPs at the 16th significant digit (Python uses Fraction-based exact arithmetic internally; we use a float two-pass). Below the report's reporting precision.`,
    `> 3. Last-decimal float formatting uses banker's rounding (\`formatFixed\` helper) to match Python's \`format(x, '.Nf')\`.`,
    ``,
  ];
  return lines;
}

function renderRecap(
  reductions: HeadlineReductions,
  stats: StatsBlock | undefined,
  nTasks: number,
): string[] {
  // Pull p-values from the stats block if we have it. `stats` requires the
  // run to have been in stats mode (REPLICATES > 1). Without it, sign-test
  // p-values aren't computed; the row shows "—".
  const pCost = stats?.signTestCost.pValue ?? null;
  const pTokens = stats?.signTestTokens.pValue ?? null;
  const pOutput = stats?.signTestOutput.pValue ?? null;

  const sigLegend = stats
    ? '★ = p<0.05 ★, † = 0.05≤p<0.10 (trending), blank = not significant.'
    : '_(no stats — re-run with REPLICATES > 1 for sign-test p-values.)_';

  const fmtSign = (st: SignTestResult | undefined) =>
    st ? `${st.nPositive}/${st.nPositive + st.nNegative}` : '—';

  return [
    `## Recap — edgee vs vanilla, reduction %`,
    ``,
    `_Positive = edgee REDUCED the metric. Negative = edgee used MORE._`,
    `_Aggregate = (Σ vanilla − Σ edgee) / Σ vanilla. Mean / median = equal-weight per task._`,
    ``,
    `| Metric | Aggregate | Mean per task | Median per task | edgee wins | sign-test p | sig |`,
    `|---|---:|---:|---:|:---:|---:|:---:|`,
    `| **Cost ($)** | ${fmtSignedPct(reductions.cost.aggregate)} | ${fmtSignedPct(reductions.cost.mean)} | ${fmtSignedPct(reductions.cost.median)} | ${fmtSign(stats?.signTestCost)} | ${pCost === null ? '—' : formatFixed(pCost, 3)} | ${pSignifier(pCost)} |`,
    `| **Total tokens** | ${fmtSignedPct(reductions.totalTokens.aggregate)} | ${fmtSignedPct(reductions.totalTokens.mean)} | ${fmtSignedPct(reductions.totalTokens.median)} | ${fmtSign(stats?.signTestTokens)} | ${pTokens === null ? '—' : formatFixed(pTokens, 3)} | ${pSignifier(pTokens)} |`,
    `| **Output tokens** | ${fmtSignedPct(reductions.outputTokens.aggregate)} | ${fmtSignedPct(reductions.outputTokens.mean)} | ${fmtSignedPct(reductions.outputTokens.median)} | ${fmtSign(stats?.signTestOutput)} | ${pOutput === null ? '—' : formatFixed(pOutput, 3)} | ${pSignifier(pOutput)} |`,
    ``,
    sigLegend,
    ``,
    `Computed across ${nTasks} task(s) with non-zero vanilla data on each metric.`,
    ``,
  ];
}

function renderPerTaskSummary(rows: TaskMeansRow[], statsMode: boolean): string[] {
  const title = statsMode ? `## Per-task token consumption (means across replicates)` : `## Per-task token consumption`;
  const lines = [
    title,
    ``,
    `| Task | vanilla total tok | vanilla $ cost | edgee total tok | edgee $ cost | token ratio | cost ratio |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.taskId} | ${fmtInt(totalTokens(r.vanilla))} | ${fmtCost(costUsd(r.vanilla))} | ${fmtInt(totalTokens(r.edgee))} | ${fmtCost(costUsd(r.edgee))} | ${fmtRatio(r.tokenRatio)} | ${fmtRatio(r.costRatio)} |`,
    );
  }
  lines.push(``);
  return lines;
}

function renderDeltas(rows: TaskMeansRow[]): string[] {
  const lines = [
    `## Deltas per task (vanilla − edgee; positive = edgee saves)`,
    ``,
    `| Task | Δ output | Δ total tok | Δ cost | token ratio edgee/vanilla |`,
    `|---|---:|---:|---:|---:|`,
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.taskId} | ${fmtSignedInt(r.deltaOutput)} | ${fmtSignedInt(r.deltaTotalTokens)} | ${fmtSignedCost(r.deltaCost)} | ${fmtRatio(r.tokenRatio)} |`,
    );
  }
  lines.push(``);
  return lines;
}

function renderStatsBlock(stats: StatsBlock, nTasks: number): string[] {
  const sig = (st: SignTestResult, totalDirection: string) =>
    `${st.nPositive}/${st.nPositive + st.nNegative} tasks ${totalDirection} edgee; p = ${formatFixed(st.pValue, 3)}`;
  return [
    `## Statistical analysis  (paired by task; n = ${nTasks})`,
    ``,
    `| Metric | Median | 95% CI |`,
    `|---|---:|---|`,
    `| Token ratio (edgee/vanilla) | ${fmtRatio(stats.medianTokenRatio)} | [${fmtRatio(stats.ciTokenRatio.lo)}, ${fmtRatio(stats.ciTokenRatio.hi)}] |`,
    `| Δ total tokens (vanilla − edgee) | ${fmtSignedInt(stats.medianDeltaTokens)} | [${fmtSignedInt(stats.ciDeltaTokens.lo)}, ${fmtSignedInt(stats.ciDeltaTokens.hi)}] |`,
    `| Δ output tokens (vanilla − edgee) | ${fmtSignedInt(stats.medianDeltaOutput)} | [${fmtSignedInt(stats.ciDeltaOutput.lo)}, ${fmtSignedInt(stats.ciDeltaOutput.hi)}] |`,
    `| Δ cost (vanilla − edgee) | ${fmtSignedCost(stats.medianDeltaCost)} | [${fmtSignedCost(stats.ciDeltaCost.lo)}, ${fmtSignedCost(stats.ciDeltaCost.hi)}] |`,
    ``,
    `### Paired sign test (two-sided, H₀: median Δ = 0)`,
    ``,
    `- **total tokens** — ${sig(stats.signTestTokens, 'favor')}`,
    `- **cost ($)** — ${sig(stats.signTestCost, 'favor')}`,
    `- **output tokens** — ${sig(stats.signTestOutput, 'favor')}`,
    ``,
    `### Within-(task, backend) variability`,
    ``,
    `Mean coefficient of variation across ${stats.withinTaskCvCells} cells: **${formatFixed(stats.withinTaskCvMean * 100, 1)}%** (>20% = consider adding replicates).`,
    ``,
  ];
}

function renderOverall(rows: TaskMeansRow[], backendOrder: BackendName[], statsMode: boolean): string[] {
  const sum: Record<string, UsageDict> = {};
  for (const name of backendOrder) sum[name] = { calls: 0, input: 0, cache_read: 0, cache_create: 0, output: 0 };
  for (const r of rows) {
    sum.vanilla.calls += r.vanilla.calls;
    sum.vanilla.input += r.vanilla.input;
    sum.vanilla.cache_read += r.vanilla.cache_read;
    sum.vanilla.cache_create += r.vanilla.cache_create;
    sum.vanilla.output += r.vanilla.output;
    sum.edgee.calls += r.edgee.calls;
    sum.edgee.input += r.edgee.input;
    sum.edgee.cache_read += r.edgee.cache_read;
    sum.edgee.cache_create += r.edgee.cache_create;
    sum.edgee.output += r.edgee.output;
  }
  const vTot = totalTokens(sum.vanilla);
  const eTot = totalTokens(sum.edgee);
  const vCost = costUsd(sum.vanilla);
  const eCost = costUsd(sum.edgee);
  const title = statsMode ? `## Overall across all tasks (per-task means summed)` : `## Overall across all tasks`;
  const lines = [
    title,
    ``,
    `| Backend | calls | fresh in | cache_read | cache_create | output | total tokens | cost |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|`,
    `| **vanilla** | ${formatFixed(sum.vanilla.calls, 1)} | ${fmtInt(sum.vanilla.input)} | ${fmtInt(sum.vanilla.cache_read)} | ${fmtInt(sum.vanilla.cache_create)} | ${fmtInt(sum.vanilla.output)} | ${fmtInt(vTot)} | ${fmtCost(vCost)} |`,
    `| **edgee** | ${formatFixed(sum.edgee.calls, 1)} | ${fmtInt(sum.edgee.input)} | ${fmtInt(sum.edgee.cache_read)} | ${fmtInt(sum.edgee.cache_create)} | ${fmtInt(sum.edgee.output)} | ${fmtInt(eTot)} | ${fmtCost(eCost)} |`,
    ``,
    `**Token ratio (edgee/vanilla):** ${fmtRatio(vTot > 0 ? eTot / vTot : Number.NaN)} ${eTot < vTot ? '(edgee uses FEWER tokens)' : '(edgee uses MORE tokens)'}`,
    ``,
    `**Cost ratio (edgee/vanilla):** ${fmtRatio(vCost > 0 ? eCost / vCost : Number.NaN)} ${eCost < vCost ? '(edgee is CHEAPER)' : '(edgee is MORE EXPENSIVE)'}`,
    ``,
  ];
  return lines;
}

function renderSessionAppendix(input: ReportInput): string[] {
  const lines = [`## Session IDs (for ccusage verification)`, ``];
  for (const taskId of input.tasksRun) {
    const byBackend = input.results[taskId];
    if (!byBackend) continue;
    for (const name of input.backendOrder) {
      const runs = byBackend[name] ?? [];
      runs.forEach((run, i) => {
        const suffix = input.config.statsMode ? ` (replicate ${i + 1})` : '';
        lines.push(`- \`${taskId}\` / **${name}**${suffix} → ${run.sessionId ?? '(not run)'}`);
      });
    }
  }
  lines.push(``);
  return lines;
}

function renderPatchesList(input: ReportInput): string[] {
  if (!input.config.agentMode) return [];
  const lines = [`## Patches`, ``];
  for (const taskId of input.tasksRun) {
    const byBackend = input.results[taskId];
    if (!byBackend) continue;
    for (const name of input.backendOrder) {
      const runs = byBackend[name] ?? [];
      runs.forEach((run, i) => {
        if (!run.diffPath) return;
        lines.push(`- \`${taskId}\` ${name} rep${i + 1} → \`${run.diffPath}\``);
      });
    }
  }
  lines.push(``);
  return lines;
}

/** Build the full markdown report text. */
export function renderMarkdown(input: ReportInput): string {
  const rows = buildTaskMeansRows(input);
  const reductions = computeHeadlineReductions(rows);
  const lines: string[] = [
    `# SWE-bench Token Bench`,
    ``,
    '_Comparison of edgee gateway vs vanilla Claude Code on SWE-bench Lite tasks._',
    ``,
    ...renderTagsCallout(input),
    ...renderConfigSnapshot(input),
    ...renderRecap(reductions, input.stats, rows.length),
    ...renderPerTaskSummary(rows, input.config.statsMode),
    ...renderDeltas(rows),
  ];
  if (input.stats !== undefined) {
    lines.push(...renderStatsBlock(input.stats, rows.length));
  }
  lines.push(...renderOverall(rows, input.backendOrder, input.config.statsMode));
  lines.push(...renderSessionAppendix(input));
  lines.push(...renderPatchesList(input));
  return lines.join('\n');
}

/** Build the lossless JSON companion. */
export function buildJsonReport(input: ReportInput): Record<string, unknown> {
  const rows = buildTaskMeansRows(input);
  const reductions = computeHeadlineReductions(rows);
  return {
    schema_version: 2,
    finished_at: input.finishedAt,
    tags: input.config.tags,
    notes: input.config.notes,
    config: input.config,
    backend_order: input.backendOrder,
    tasks_run: input.tasksRun,
    results: input.results,
    task_means: rows,
    reductions,
    stats: input.stats ?? null,
  };
}

export interface WriteReportsResult {
  mdPath: string;
  jsonPath: string;
}

/**
 * Build the basename for the per-run report files. Tags are joined with `--`
 * so the resulting filename is sortable AND discoverable by tag:
 *   swe-2026-06-19T14-30-02-734Z--brevity--tsr.md
 *
 * Without tags, just `swe-<ISO>.{md,json}` to keep older runs clean.
 * Exported for testing.
 */
export function reportBasename(finishedAtIso: string, tags: readonly string[]): string {
  const iso = finishedAtIso.replace(/[:.]/g, '-');
  if (tags.length === 0) return `swe-${iso}`;
  // Tags are already slugified by parseTags, but be defensive.
  const tagPart = tags.map(t => t.replace(/[^a-z0-9_-]/gi, '-')).join('--');
  return `swe-${iso}--${tagPart}`;
}

/** Write the markdown + JSON reports to `reports/swe-<ISO>[--<tags>].{md,json}`. */
export async function writeReports(reportsDir: string, input: ReportInput): Promise<WriteReportsResult> {
  await mkdir(reportsDir, { recursive: true });
  const base = reportBasename(input.finishedAt, input.config.tags);
  const mdPath = path.join(reportsDir, `${base}.md`);
  const jsonPath = path.join(reportsDir, `${base}.json`);
  await writeFile(mdPath, renderMarkdown(input));
  await writeFile(jsonPath, JSON.stringify(buildJsonReport(input), null, 2));
  return { mdPath, jsonPath };
}

// FROZEN_TASKS re-export so callers writing the JSON snapshot can reference
// it without importing config directly.
export { FROZEN_TASKS };
