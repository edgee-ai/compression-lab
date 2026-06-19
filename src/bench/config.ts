// Environment-variable parsing, constants, and frozen config snapshot.
//
// Mirrors /Users/kham/Documents/code/benchmarks/cache/bench_tokens.py lines
// 50-149. The bench is intentionally env-var-driven (no CLI flags) so the
// invocation pattern matches the Python original exactly.

import os from 'node:os';
import path from 'node:path';
import { BackendName } from './types.js';

// Opus 4.7 list pricing (per million tokens). Source: bench_tokens.py 146-149.
// Used by `costUsd()` in usage.ts and printed in the report's config snapshot.
export const PRICING = Object.freeze({
  inputPerM: 5.0,
  outputPerM: 25.0,
  cacheReadPerM: 0.5,
  /** 1h-TTL cache writes (the default Claude Code uses). */
  cacheCreate1hPerM: 10.0,
});

const HOME = os.homedir();

/** Local cache root for SWE-bench tasks + cloned repos. Shared with Python. */
export const SWE_CACHE = path.join(HOME, '.cache', 'cache_bench_swe');
export const TASKS_CACHE = path.join(SWE_CACHE, 'tasks');
export const REPOS_CACHE = path.join(SWE_CACHE, 'repos');

/** Where Claude Code writes its per-session JSONL files. */
export const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

/** Where the bench writes agent-mode patches; gitignored. */
export const PATCHES_DIR_FROM_REPO = 'patches';

/** Where the bench writes its markdown + JSON reports. */
export const REPORTS_DIR_FROM_REPO = 'reports';

/** Edgee debug build path (matches bench_tokens.py:102). */
export const EDGEE_BIN =
  process.env.EDGEE_BIN ??
  '/Users/kham/Documents/code/localdev-edgee-gateway/edgee/target/debug/edgee';

export const EDGEE_MCP_CONFIG =
  process.env.EDGEE_MCP_CONFIG ?? path.join(HOME, '.config', 'edgee', 'mcp.json');

/** Per-turn timeout in scripted mode (Python sets 900s). */
export const PER_TURN_TIMEOUT_S = 900;

/**
 * Backend command-line definitions. Each entry mirrors the Python `BACKENDS`
 * dict at bench_tokens.py:134-142. `env VAR=val …` prefixes set env vars on
 * the child process without us needing a separate env-dict plumbing path.
 */
export const BACKENDS: Record<BackendName, string[]> = {
  vanilla: ['env', 'ENABLE_TOOL_SEARCH=true', 'claude', '--mcp-config', EDGEE_MCP_CONFIG],
  edgee: ['env', 'ENABLE_TOOL_SEARCH=false', EDGEE_BIN, 'launch', 'claude'],
};

/**
 * Frozen SWE-bench Lite task list. Same order as bench_tokens.py:65-74 so
 * `TASK_LIMIT=N` slices the same first N tasks in both impls. Lighter tasks
 * first so a TASK_LIMIT=6 run fits in ~2 hours of agent mode; the two pytest
 * tasks (heavy in agent mode) sit at the end.
 */
export const FROZEN_TASKS: string[] = [
  'astropy__astropy-12907', // separability_matrix bug
  'sympy__sympy-21055', // Matrix indexing
  'astropy__astropy-14365', // Cosmology equality
  'sympy__sympy-13647', // Matrix col_insert
  'psf__requests-2317', // method type, small repo
  'sphinx-doc__sphinx-8506', // citation labels
  'pytest-dev__pytest-5103', // assertion rewriting — HEAVY in agent mode
  'pytest-dev__pytest-5413', // context manager — HEAVY in agent mode
];

/** Follow-up prompts after the issue (scripted mode only). */
export const FOLLOWUP_PROMPTS: string[] = [
  'Show me the file:line where the bug most likely lives. Explain in 2-3 sentences.',
  "Propose the smallest possible patch in unified diff format. Don't run tests.",
];

// ──────── Env-var parsing ─────────────────────────────────────────────────

function parseBool(s: string | undefined): boolean {
  return s === '1' || s === 'true';
}

function parseInt10(s: string | undefined, fallback: number): number {
  if (s === undefined || s === '') return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatOr(s: string | undefined, fallback: number): number {
  if (s === undefined || s === '') return fallback;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

/** Frozen snapshot of all env-controlled knobs at startup. */
export interface BenchConfig {
  readonly agentMode: boolean;
  readonly agentTimeoutS: number;
  readonly replicates: number;
  readonly shuffle: boolean;
  readonly seed: number;
  readonly bootstrapIters: number;
  readonly taskLimit: number;
  readonly randomTasks: number;
  readonly warmupS: number;
  readonly orderEnv: string;
  readonly statsMode: boolean;
  readonly perTurnTimeoutS: number;
  /** When set, load SWE-bench Lite from a local file instead of HuggingFace. */
  readonly sweLitePathOverride: string | null;
  /**
   * Slugified, deduped, sorted set of tags describing the gateway/strategy
   * configuration for this run (e.g. `["brevity", "tsr"]`). Captured from
   * the TAGS env var. Surfaced in the report filename and the Configuration
   * block so future-you knows what was active on the gateway side without
   * having to crack open git history.
   */
  readonly tags: readonly string[];
  /** Free-text note (NOTES env var). Renders next to the tags in the report. */
  readonly notes: string;
}

/** Lowercase, replace non-[a-z0-9_] runs with single `-`, trim leading/trailing `-`. */
export function slugifyTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse the TAGS env var: comma-separated, slugified, deduped, sorted.
 *
 * Splits ONLY on commas so multi-word tags work without quoting:
 *   TAGS="Tool Trimming, Output Brevity"
 *     → ["output-brevity", "tool-trimming"]
 *
 * Empty strings are dropped.
 */
export function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const set = new Set<string>();
  for (const piece of raw.split(',')) {
    const slug = slugifyTag(piece);
    if (slug) set.add(slug);
  }
  return [...set].sort();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BenchConfig {
  const replicates = Math.max(1, parseInt10(env.REPLICATES, 1));
  const seedEnv = env.SEED;
  const seed =
    seedEnv && seedEnv !== ''
      ? parseInt10(seedEnv, 0)
      : // Match Python's `random.SystemRandom().randint(0, 2**32 - 1)` behavior:
        // pick a fresh 32-bit non-negative integer each run.
        Math.floor(Math.random() * 0x1_0000_0000);
  return Object.freeze({
    agentMode: parseBool(env.AGENT_MODE),
    agentTimeoutS: parseInt10(env.AGENT_TIMEOUT_S, 1800),
    replicates,
    shuffle: parseBool(env.SHUFFLE),
    seed,
    bootstrapIters: parseInt10(env.BOOTSTRAP_ITERS, 10_000),
    taskLimit: parseInt10(env.TASK_LIMIT, FROZEN_TASKS.length),
    randomTasks: parseInt10(env.RANDOM_TASKS, 0),
    warmupS: parseFloatOr(env.WARMUP_S, 0),
    orderEnv: (env.ORDER ?? '').trim(),
    statsMode: replicates > 1,
    perTurnTimeoutS: PER_TURN_TIMEOUT_S,
    sweLitePathOverride: env.BENCH_SWE_LITE_PATH ?? null,
    tags: parseTags(env.TAGS),
    notes: (env.NOTES ?? '').trim(),
  });
}

/** Resolved backend execution order based on `ORDER` env var. */
export function resolveBackendOrder(
  orderEnv: string,
  backends: typeof BACKENDS = BACKENDS,
): BackendName[] {
  if (!orderEnv) return Object.keys(backends) as BackendName[];
  const names = orderEnv
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0) as BackendName[];
  const unknown = names.filter(n => !(n in backends));
  if (unknown.length > 0) {
    throw new Error(`unknown backend(s) in ORDER: ${JSON.stringify(unknown)}`);
  }
  return names;
}
