#!/usr/bin/env node
// MCP Tool-Surface-Reduction Bench — Track B.
//
// Measures the isolated effect of the edgee gateway's MCP tool surface
// reduction (TSR) feature. Two backends side-by-side:
//
//   vanilla  ENABLE_TOOL_SEARCH=false → full MCP tool list in every prefix
//                                       (no Claude-native deferred-tool-loading)
//   edgee    via edgee binary with TSR enabled on the API key
//
// Workload: short read-only Linear + Notion queries (mcp-tasks.ts). Single
// user prompt per session, no agent loop, no SWE-bench machinery.
//
// Hard safety: --allowedTools whitelists only the read-only Linear/Notion
// tool names; post-run JSONL audit verifies no write-pattern tool_use was
// recorded. Bench exits non-zero on any audit failure.
//
// Phase 2 (future): extend by issuing MCP queries inside an SWE-bench task
// context. The modules used here (mcp-tasks, mcp-safety, mcp-tool-use) are
// designed to compose with bench-swe.ts without further refactoring.
//
// Knobs:
//   REPLICATES=3                  N per (task, backend); >1 enables stats mode.
//   SHUFFLE=1                     Randomize (backend, replicate) order per task.
//   SEED=42                       Pin RNG; defaults to a fresh random seed.
//   BOOTSTRAP_ITERS=10000         Resamples for CIs.
//   MCP_TASK_LIMIT=N              Slice MCP_TASKS to the first N.
//   WARMUP_S=10                   Sleep before first prompt (MCP cold-start grace).
//   ORDER=edgee,vanilla           Backend order override.
//   TAGS=tsr,linear-notion        Run tags (shown in report filename + header).
//   NOTES="…"                     Free-text note shown in the report.
//   MCP_ALLOW_WRITES=1            Escape hatch — disables the post-run write
//                                 assertion (audit still runs + reports).

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  EDGEE_BIN,
  PER_TURN_TIMEOUT_S,
  REPORTS_DIR_FROM_REPO,
  loadConfig,
  resolveBackendOrder,
  BenchConfig,
} from './config.js';
import { runStreamSession } from './stream-session.js';
import { parseSessionTurns } from './claude-jsonl.js';
import { aggregateTurns, costUsd, totalTokens, zeroUsage } from './usage.js';
import { createRng } from './rng.js';
import { computeStats } from './stats-pipeline.js';
import { MCP_TASKS, McpTask, selectTasks } from './mcp-tasks.js';
import {
  SafetyAuditEntry,
  WriteToolDetectedError,
  assertAllSessionsClean,
  auditSession,
} from './mcp-safety.js';
import { extractToolUsesForSession, ToolUseCount } from './mcp-tool-use.js';
import {
  McpReportInput,
  McpSessionToolUse,
  writeMcpReports,
} from './report-mcp.js';
import { StatsBlock } from './report-swe.js';
import { BackendName, RunResult, UsageDict } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const MCP_RUNS_DIR = path.join(REPO_ROOT, 'mcp-runs');
const REPORTS_DIR = path.join(REPO_ROOT, REPORTS_DIR_FROM_REPO);

/**
 * Optional MCP server config consumed by BOTH backends. When unset (the
 * default), the bench passes NO `--mcp-config` flag and `claude` falls back
 * to whatever MCP servers are wired up at the account/CLI level (typically
 * the claude.ai-managed `claude.ai Linear / Notion / …` servers — verify
 * with `/mcp` in any claude session).
 *
 * Set MCP_BENCH_CONFIG=<path> to override and point at a file that lists
 * direct Linear/Notion servers (or other MCP servers). Edgee's TSR feature
 * applies at the request-to-Anthropic layer, so both backends share the
 * same config — vanilla sees the full tool list; edgee strips/replaces it.
 */
// Resolve to an absolute path — claude spawns with cwd = mcp-runs/<task>/, so
// a relative path passed to --mcp-config would be looked up under the wrong dir.
const MCP_BENCH_CONFIG =
  process.env.MCP_BENCH_CONFIG != null ? path.resolve(process.env.MCP_BENCH_CONFIG) : null;

function mcpBackends(): Record<BackendName, string[]> {
  // Safety relies entirely on the post-run JSONL audit (`assertAllSessionsClean`)
  // matching against `WRITE_TOOL_PATTERNS`. A previous version used
  // `--allowedTools` as a belt-and-braces whitelist, but it conflicted with
  // edgee's TSR — edgee resolves tool names dynamically via Claude Code's
  // ToolSearch, and any name not in the whitelist 400s the request mid-session.
  const claudeFlags: string[] = [];
  if (MCP_BENCH_CONFIG !== null) {
    claudeFlags.push('--mcp-config', MCP_BENCH_CONFIG);
  }
  return {
    vanilla: ['env', 'ENABLE_TOOL_SEARCH=false', 'claude', ...claudeFlags],
    edgee: ['env', 'ENABLE_TOOL_SEARCH=false', EDGEE_BIN, 'launch', 'claude', ...claudeFlags],
  };
}

async function main(): Promise<number> {
  const cfg = loadConfig(process.env);
  const backendOrder = resolveBackendOrder(cfg.orderEnv);
  const rng = createRng(cfg.seed);

  if (MCP_BENCH_CONFIG !== null && !existsSync(MCP_BENCH_CONFIG)) {
    console.error(
      `[red] MCP_BENCH_CONFIG points at a missing file: ${MCP_BENCH_CONFIG}`,
    );
    return 1;
  }

  const backends = mcpBackends();
  const allowWrites = process.env.MCP_ALLOW_WRITES === '1';

  console.log(`Token consumption bench — MCP TSR (synthetic read-only queries)`);
  console.log(
    `backends: ${JSON.stringify(backendOrder)}  warmup: ${cfg.warmupS}s`,
  );
  console.log(
    `mcp config: ${
      MCP_BENCH_CONFIG === null
        ? '(none — claude account-managed servers)'
        : path.relative(REPO_ROOT, MCP_BENCH_CONFIG)
    }`,
  );
  if (cfg.statsMode) {
    console.log(`stats mode: REPLICATES=${cfg.replicates}  SHUFFLE=${cfg.shuffle}  SEED=${cfg.seed}`);
  }
  if (allowWrites) {
    console.log('[red] MCP_ALLOW_WRITES=1 — write-call assertion DISABLED (audit still runs)');
  }

  // ──── Task selection ───────────────────────────────────────────────────
  const taskLimit = Number.parseInt(process.env.MCP_TASK_LIMIT ?? '0', 10);
  const tasksToRun = selectTasks(taskLimit);
  console.log(`Running ${tasksToRun.length} MCP task(s)`);
  for (const t of tasksToRun) console.log(`  - ${t.id}`);
  console.log();

  // ──── Per-task run loop ────────────────────────────────────────────────
  const taskIds = tasksToRun.map(t => t.id);
  const results: Record<string, Record<string, RunResult[]>> = {};
  const safetyAudit: SafetyAuditEntry[] = [];
  const mcpToolUse: McpSessionToolUse[] = [];
  for (const id of taskIds) results[id] = {};

  for (const task of tasksToRun) {
    console.log(`──── Task ${task.id} ────`);
    const cwd = await prepareTaskCwd(task.id);
    for (const name of backendOrder) results[task.id][name] = [];

    const runs: { backend: BackendName; replicate: number }[] = [];
    for (const backend of backendOrder) {
      for (let r = 0; r < cfg.replicates; r++) runs.push({ backend, replicate: r });
    }
    if (cfg.shuffle && cfg.statsMode) {
      const shuffled = rng.shuffle(runs);
      runs.length = 0;
      runs.push(...shuffled);
    }

    for (const { backend, replicate } of runs) {
      const { runResult, toolUses } = await runOneMcpSession({
        task,
        cwd,
        backend,
        replicate,
        cfg,
        backendCmd: backends[backend],
      });
      results[task.id][backend].push(runResult);

      // Audit + record tool-use for the report.
      const audit = auditSession(toolUses, {
        sessionId: runResult.sessionId,
        taskId: task.id,
        backend,
        replicate,
      });
      safetyAudit.push(audit);
      mcpToolUse.push({ taskId: task.id, backend, replicate, tools: toolUses });

      const u = runResult.usage;
      const tot = totalTokens(u);
      const cost = costUsd(u);
      const label = cfg.statsMode
        ? `${backend} (replicate ${replicate + 1}/${cfg.replicates})`
        : backend;
      console.log(
        `  ${label}: calls=${u.calls} total=${tot.toLocaleString()} $${cost.toFixed(4)} ` +
          `mcp=${audit.totalMcpCalls}${audit.writeCalls.length > 0 ? ' [WRITES!]' : ''}`,
      );
      if (runResult.sessionId !== null) {
        console.log(`    sid → ${runResult.sessionId}`);
      }
      if (audit.writeCalls.length > 0) {
        console.log(`    [red] write-call detected: ${audit.writeCalls.join(', ')}`);
      }
      if (u.calls === 0 || tot === 0) {
        console.log('    [yellow] no useful API output — last raw lines:');
        for (const line of runResult.rawTail.slice(-3)) console.log(`      raw: ${line}`);
      }
    }
  }

  // ──── Stats (only in stats mode) ───────────────────────────────────────
  let stats: StatsBlock | undefined = undefined;
  if (cfg.statsMode) {
    stats = computeStats({ tasksToRun: taskIds, results, backendOrder, cfg, rng });
  }

  // ──── Report (always written, even if audit failed) ────────────────────
  const finishedAt = new Date().toISOString();
  const reportInput: McpReportInput = {
    config: cfg,
    backendOrder,
    tasksRun: taskIds,
    results,
    finishedAt,
    stats,
    taskDefinitions: tasksToRun,
    safetyAudit,
    mcpToolUse,
  };
  const { mdPath, jsonPath } = await writeMcpReports(REPORTS_DIR, reportInput);
  console.log();
  console.log(`Wrote ${path.relative(REPO_ROOT, mdPath)}`);
  console.log(`Wrote ${path.relative(REPO_ROOT, jsonPath)}`);

  // ──── Safety gate ──────────────────────────────────────────────────────
  if (!allowWrites) {
    try {
      assertAllSessionsClean(safetyAudit);
    } catch (e) {
      if (e instanceof WriteToolDetectedError) {
        console.error();
        console.error('[red] ──── SAFETY AUDIT FAILED ────');
        console.error(e.message);
        console.error('[red] Report was written; exiting non-zero so CI/loop notices.');
        return 1;
      }
      throw e;
    }
  }
  return 0;
}

// ──────── One-session helper ───────────────────────────────────────────────

interface RunOneMcpSessionOpts {
  task: McpTask;
  cwd: string;
  backend: BackendName;
  replicate: number;
  cfg: BenchConfig;
  backendCmd: string[];
}

async function runOneMcpSession(opts: RunOneMcpSessionOpts): Promise<{
  runResult: RunResult;
  toolUses: ToolUseCount[];
}> {
  const { task, cwd, backend, replicate, cfg, backendCmd } = opts;

  // Per-replicate nonce so each replicate starts from cold prefix cache. Same
  // idea as in bench-swe.ts.
  const nonce = cfg.statsMode ? Math.random().toString(36).slice(2, 14) : null;
  const promptBody = nonce !== null ? `${task.prompt}\n\n(run nonce: ${nonce})` : task.prompt;

  const { sessionId, resultEvents, rawTail } = await runStreamSession({
    cmd: backendCmd,
    cwd,
    prompts: [promptBody],
    perTurnTimeoutS: PER_TURN_TIMEOUT_S,
    warmupS: cfg.warmupS,
    onTurnStart: (i, n, p) => {
      const preview = p.split('\n', 1)[0]?.slice(0, 70) ?? '';
      console.log(`    turn ${i}/${n}: ${preview}${preview.length === 70 ? '…' : ''}`);
    },
  });

  const turns = sessionId !== null ? await parseSessionTurns(cwd, sessionId) : [];
  const usage: UsageDict = turns.length > 0 ? aggregateTurns(turns) : zeroUsage();
  const toolUses = sessionId !== null ? await extractToolUsesForSession(cwd, sessionId) : [];

  void backend;
  void replicate;
  return {
    runResult: { sessionId, usage, turns, resultEvents, rawTail, diffPath: null },
    toolUses,
  };
}

// ──────── CWD prep ─────────────────────────────────────────────────────────

async function prepareTaskCwd(taskId: string): Promise<string> {
  const dir = path.join(MCP_RUNS_DIR, taskId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

// ──────── Entrypoint ───────────────────────────────────────────────────────

void MCP_TASKS; // referenced for callers that import this module

/**
 * Only run main() when invoked as the entrypoint (via `tsx src/bench/bench-mcp.ts`),
 * NOT when imported. A bare `import('./bench-mcp.ts')` would otherwise spawn the
 * real backends and burn API budget — learned the hard way.
 */
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
