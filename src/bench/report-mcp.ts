// MCP-bench markdown + JSON report emitters.
//
// Produces two coordinated artifacts:
//   reports/mcp-<ISO>.md   — human-readable markdown
//   reports/mcp-<ISO>.json — lossless machine companion
//
// Heavy reuse of report-swe.ts for the shared sections (Recap, Deltas,
// Per-task summary, Statistical analysis, Overall, Session IDs). Adds three
// MCP-specific sections — Safety audit, MCP tool-use summary, TSR resolution
// overhead — plus a Task definitions appendix for reproducibility.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BenchConfig } from './config.js';
import { BackendName, RunResult } from './types.js';
import {
  buildTaskMeansRows,
  computeHeadlineReductions,
  renderConfigSnapshot,
  renderDeltas,
  renderOverall,
  renderPerCallBreakdown,
  renderPerTaskSummary,
  renderRecap,
  renderSessionAppendix,
  renderStatsBlock,
  renderTagsCallout,
  reportBasename,
  ReportInput,
  StatsBlock,
} from './report-swe.js';
import { McpTask } from './mcp-tasks.js';
import { SafetyAuditEntry } from './mcp-safety.js';
import { ToolUseCount } from './mcp-tool-use.js';

// ──────── New report input shape ─────────────────────────────────────────

/** One session's tool-use trace, paired with its identifying metadata. */
export interface McpSessionToolUse {
  taskId: string;
  backend: BackendName;
  replicate: number;
  tools: ToolUseCount[];
}

export interface McpReportInput {
  config: BenchConfig;
  backendOrder: BackendName[];
  tasksRun: string[];
  results: Record<string, Record<string, RunResult[]>>;
  finishedAt: string;
  stats?: StatsBlock;
  /** The full McpTask definitions for every task that ran. */
  taskDefinitions: McpTask[];
  /** Audit results, one entry per session. */
  safetyAudit: SafetyAuditEntry[];
  /** Tool-use counts, one entry per session. */
  mcpToolUse: McpSessionToolUse[];
}

/** Map a McpReportInput onto the shared ReportInput shape the SWE renderers expect. */
function toReportInput(input: McpReportInput): ReportInput {
  return {
    config: input.config,
    backendOrder: input.backendOrder,
    tasksRun: input.tasksRun,
    results: input.results,
    finishedAt: input.finishedAt,
    stats: input.stats,
  };
}

// ──────── MCP-specific sections ──────────────────────────────────────────

/**
 * Render the safety audit. The most important section — if any write call was
 * recorded, this prints a red banner at the top so it's impossible to miss
 * when skimming the report.
 */
export function renderSafetyAudit(entries: readonly SafetyAuditEntry[]): string[] {
  const offenders = entries.filter(e => e.writeCalls.length > 0);
  const lines: string[] = [`## Safety audit`, ``];
  if (offenders.length > 0) {
    lines.push(
      `> 🚨 **SAFETY FAILURE — ${offenders.length} session(s) recorded write-tool calls.**`,
      `> The bench should have refused to continue; this report is preserved as a record of the failure.`,
      ``,
      `| Task | Backend | Replicate | Write calls |`,
      `|---|---|---:|---|`,
    );
    for (const e of offenders) {
      lines.push(
        `| \`${e.taskId}\` | ${e.backend} | ${e.replicate} | ${e.writeCalls.map(c => `\`${c}\``).join(', ')} |`,
      );
    }
    lines.push(``);
    return lines;
  }
  // Clean — summarise call counts.
  const totalSessions = entries.length;
  const totalMcpCalls = entries.reduce((s, e) => s + e.totalMcpCalls, 0);
  lines.push(
    `> ✅ **All ${totalSessions} session(s) clean — zero write-tool calls detected.**`,
    ``,
    `Across all sessions: **${totalMcpCalls.toLocaleString('en-US')}** MCP tool call(s), 0 of which matched any write pattern.`,
    ``,
    `_Safety enforcement: post-run JSONL audit against the WRITE_TOOL_PATTERNS regex set in \`mcp-safety.ts\`. The audit runs after every session and fails the bench non-zero if any matched tool was called._`,
    ``,
  );
  return lines;
}

/** Per-session tool-use summary, grouped by task → backend → replicate. */
export function renderMcpToolUseSummary(
  perSession: readonly McpSessionToolUse[],
): string[] {
  const lines: string[] = [`## MCP tools invoked`, ``];
  if (perSession.length === 0) {
    lines.push(`_No sessions captured._`, ``);
    return lines;
  }
  lines.push(
    `_What MCP tools did claude actually call, per session? Native tools (Read, Bash, …) are omitted — they are unrelated to TSR._`,
    ``,
    `| Task | Backend | Replicate | MCP calls | Tools (count × name) |`,
    `|---|---|---:|---:|---|`,
  );
  for (const s of perSession) {
    const mcpTools = s.tools.filter(t => t.name.startsWith('mcp__'));
    const mcpTotal = mcpTools.reduce((sum, t) => sum + t.count, 0);
    const renderTools = mcpTools.length === 0
      ? '_(none)_'
      : mcpTools
          .slice()
          .sort((a, b) => b.count - a.count)
          .map(t => `${t.count}× \`${shortToolName(t.name)}\``)
          .join('<br>');
    lines.push(
      `| \`${s.taskId}\` | ${s.backend} | ${s.replicate} | ${mcpTotal} | ${renderTools} |`,
    );
  }
  lines.push(``);
  return lines;
}

/**
 * Resolution overhead — TSR replaces all MCP tool defs with one virtual
 * search tool, so under TSR claude has to call `mcp__edgee_gateway__search`
 * before each real tool. This section quantifies that overhead.
 *
 * Per task, side-by-side: vanilla total MCP calls vs edgee total MCP calls,
 * with the gateway-search count called out separately.
 */
export function renderResolutionOverhead(
  perSession: readonly McpSessionToolUse[],
): string[] {
  const lines: string[] = [`## TSR resolution overhead`, ``];
  if (perSession.length === 0) {
    lines.push(`_No sessions captured._`, ``);
    return lines;
  }

  // Group by (taskId, backend) → mean MCP-call counts across replicates.
  type Agg = { mcpCalls: number[]; gatewaySearches: number[] };
  const byKey = new Map<string, Agg>();
  for (const s of perSession) {
    const key = `${s.taskId}|${s.backend}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = { mcpCalls: [], gatewaySearches: [] };
      byKey.set(key, agg);
    }
    let mcp = 0;
    let search = 0;
    for (const t of s.tools) {
      if (!t.name.startsWith('mcp__')) continue;
      mcp += t.count;
      if (t.name === 'mcp__edgee_gateway__search') search += t.count;
    }
    agg.mcpCalls.push(mcp);
    agg.gatewaySearches.push(search);
  }
  const mean = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  // Pull a stable task order from the input itself.
  const taskIds = Array.from(new Set(perSession.map(s => s.taskId)));

  lines.push(
    `_Measures the resolution-hop overhead TSR introduces. Under TSR, claude calls \`mcp__edgee_gateway__search\` to resolve the real MCP tool, then invokes it — so edgee's MCP-call count is roughly 2× the underlying real calls. Vanilla calls each real tool directly._`,
    ``,
    `| Task | vanilla MCP calls (mean) | edgee MCP calls (mean) | of which: gateway search calls (mean) | overhead (edgee − vanilla) |`,
    `|---|---:|---:|---:|---:|`,
  );
  for (const taskId of taskIds) {
    const v = byKey.get(`${taskId}|vanilla`);
    const e = byKey.get(`${taskId}|edgee`);
    const vMean = v ? mean(v.mcpCalls) : Number.NaN;
    const eMean = e ? mean(e.mcpCalls) : Number.NaN;
    const eSearch = e ? mean(e.gatewaySearches) : Number.NaN;
    const overhead = Number.isFinite(eMean) && Number.isFinite(vMean) ? eMean - vMean : Number.NaN;
    lines.push(
      `| \`${taskId}\` | ${fmtMean(vMean)} | ${fmtMean(eMean)} | ${fmtMean(eSearch)} | ${fmtSignedMean(overhead)} |`,
    );
  }
  lines.push(``);
  return lines;
}

/** Task definitions appendix — keeps the report self-contained. */
export function renderTaskDefinitions(tasks: readonly McpTask[]): string[] {
  const lines: string[] = [`## Task definitions`, ``];
  if (tasks.length === 0) {
    lines.push(`_No tasks recorded._`, ``);
    return lines;
  }
  lines.push(
    `_The verbatim prompts that ran. Captured here so a reader can reproduce the workload without re-deriving it from the code._`,
    ``,
  );
  for (const t of tasks) {
    lines.push(`### \`${t.id}\``);
    lines.push(``);
    lines.push(`**Rationale:** ${t.rationale}`);
    lines.push(``);
    lines.push(`> ${t.prompt.replace(/\n/g, '\n> ')}`);
    lines.push(``);
  }
  return lines;
}

// ──────── Helpers ────────────────────────────────────────────────────────

/** Drop the `mcp__SERVER__` prefix for terser per-call breakdown rendering. */
function shortToolName(full: string): string {
  // mcp__claude_ai_Linear__list_issues → list_issues
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(full);
  if (m) return m[1];
  return full;
}

function fmtMean(x: number): string {
  if (!Number.isFinite(x)) return '—';
  // One decimal is enough — these are call counts, but we want to surface
  // partial differences across replicates.
  return x.toFixed(1);
}

function fmtSignedMean(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const sign = x >= 0 ? '+' : '';
  return `${sign}${x.toFixed(1)}`;
}

// ──────── Top-level composition ──────────────────────────────────────────

/** Build the full MCP-bench markdown report text. */
export function renderMcpMarkdown(input: McpReportInput): string {
  const base = toReportInput(input);
  const rows = buildTaskMeansRows(base);
  const reductions = computeHeadlineReductions(rows);
  const lines: string[] = [
    `# MCP Tool-Surface-Reduction Bench`,
    ``,
    '_Comparison of edgee gateway (TSR-only) vs vanilla Claude Code (ENABLE_TOOL_SEARCH=false) on synthetic read-only Linear + Notion queries._',
    ``,
    ...renderTagsCallout(base),
    ...renderConfigSnapshot(base),
    ...renderRecap(reductions, input.stats, rows.length),
    ...renderSafetyAudit(input.safetyAudit),
    ...renderPerTaskSummary(rows, input.config.statsMode),
    ...renderDeltas(rows),
    ...renderMcpToolUseSummary(input.mcpToolUse),
    ...renderResolutionOverhead(input.mcpToolUse),
  ];
  if (input.stats !== undefined) {
    lines.push(...renderStatsBlock(input.stats, rows.length));
  }
  lines.push(...renderPerCallBreakdown(base));
  lines.push(...renderOverall(rows, input.backendOrder, input.config.statsMode));
  lines.push(...renderSessionAppendix(base));
  lines.push(...renderTaskDefinitions(input.taskDefinitions));
  return lines.join('\n');
}

/** Build the lossless JSON companion for an MCP-bench run. */
export function buildMcpJsonReport(input: McpReportInput): Record<string, unknown> {
  const base = toReportInput(input);
  const rows = buildTaskMeansRows(base);
  const reductions = computeHeadlineReductions(rows);
  return {
    schema_version: 2,
    bench_kind: 'mcp',
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
    task_definitions: input.taskDefinitions,
    safety_audit: input.safetyAudit,
    mcp_tool_use: input.mcpToolUse,
  };
}

export interface WriteMcpReportsResult {
  mdPath: string;
  jsonPath: string;
}

/** Write the markdown + JSON reports to `reports/mcp-<ISO>[--<tags>].{md,json}`. */
export async function writeMcpReports(
  reportsDir: string,
  input: McpReportInput,
): Promise<WriteMcpReportsResult> {
  await mkdir(reportsDir, { recursive: true });
  const base = reportBasename(input.finishedAt, input.config.tags, 'mcp');
  const mdPath = path.join(reportsDir, `${base}.md`);
  const jsonPath = path.join(reportsDir, `${base}.json`);
  await writeFile(mdPath, renderMcpMarkdown(input));
  await writeFile(jsonPath, JSON.stringify(buildMcpJsonReport(input), null, 2));
  return { mdPath, jsonPath };
}
