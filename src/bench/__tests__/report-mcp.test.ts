// Report-mcp tests. Focus on the four MCP-specific sections — the shared
// renderers are covered by report-swe.test.ts. Smoke-render each new section
// and exercise the top-level renderer end-to-end.

import { describe, expect, it } from 'vitest';
import {
  buildMcpJsonReport,
  renderMcpMarkdown,
  renderMcpToolUseSummary,
  renderResolutionOverhead,
  renderSafetyAudit,
  renderTaskDefinitions,
  type McpReportInput,
  type McpSessionToolUse,
} from '../report-mcp.js';
import { loadConfig } from '../config.js';
import { aggregateTurns } from '../usage.js';
import type { SafetyAuditEntry } from '../mcp-safety.js';
import type { McpTask } from '../mcp-tasks.js';
import type { RunResult, UsageDict } from '../types.js';

function mkUsage(input: number, cache_read: number, cache_create: number, output: number): UsageDict {
  return aggregateTurns([{ input, cache_read, cache_create, output }]);
}

function mkRun(usage: UsageDict, sessionId: string): RunResult {
  return { sessionId, usage, turns: [], resultEvents: [], rawTail: [], diffPath: null };
}

// ──────── renderSafetyAudit ──────────────────────────────────────────────

describe('report-mcp: renderSafetyAudit', () => {
  it('renders a green banner when every session is clean', () => {
    const md = renderSafetyAudit([
      { sessionId: 's1', taskId: 't1', backend: 'vanilla', replicate: 0, totalMcpCalls: 5, writeCalls: [] },
      { sessionId: 's2', taskId: 't1', backend: 'edgee', replicate: 0, totalMcpCalls: 8, writeCalls: [] },
    ]).join('\n');
    expect(md).toContain('## Safety audit');
    expect(md).toContain('✅');
    expect(md).toContain('All 2 session(s) clean');
    // 5 + 8 = 13 total MCP calls
    expect(md).toContain('**13**');
    expect(md).not.toContain('🚨');
  });

  it('renders a red banner with offender table when any session has writeCalls', () => {
    const md = renderSafetyAudit([
      { sessionId: 's1', taskId: 't-clean', backend: 'vanilla', replicate: 0, totalMcpCalls: 5, writeCalls: [] },
      {
        sessionId: 's2',
        taskId: 't-bad',
        backend: 'edgee',
        replicate: 1,
        totalMcpCalls: 4,
        writeCalls: ['mcp__claude_ai_Linear__save_issue', 'mcp__claude_ai_Linear__delete_comment'],
      },
    ]).join('\n');
    expect(md).toContain('🚨');
    expect(md).toContain('SAFETY FAILURE');
    expect(md).toContain('1 session(s) recorded write-tool calls');
    expect(md).toContain('t-bad');
    expect(md).toContain('edgee');
    expect(md).toContain('save_issue');
    expect(md).toContain('delete_comment');
    // The clean session shouldn't appear in the offenders table
    expect(md).not.toContain('t-clean');
  });

  it('renders the section even when entries is empty', () => {
    const md = renderSafetyAudit([]).join('\n');
    expect(md).toContain('## Safety audit');
    expect(md).toContain('All 0 session(s) clean');
  });
});

// ──────── renderMcpToolUseSummary ────────────────────────────────────────

describe('report-mcp: renderMcpToolUseSummary', () => {
  const sample: McpSessionToolUse[] = [
    {
      taskId: 'linear-recent-issues',
      backend: 'vanilla',
      replicate: 0,
      tools: [
        { name: 'mcp__claude_ai_Linear__list_issues', count: 2 },
        { name: 'Bash', count: 4 }, // native, should be omitted from rendering
      ],
    },
    {
      taskId: 'linear-recent-issues',
      backend: 'edgee',
      replicate: 0,
      tools: [
        { name: 'mcp__edgee_gateway__search', count: 2 },
        { name: 'mcp__claude_ai_Linear__list_issues', count: 2 },
      ],
    },
  ];

  it('renders a row per session with MCP-only tool list', () => {
    const md = renderMcpToolUseSummary(sample).join('\n');
    expect(md).toContain('## MCP tools invoked');
    // Vanilla row: 2 total MCP calls (Bash not counted in the MCP column)
    expect(md).toMatch(/\| `linear-recent-issues` \| vanilla \| 0 \| 2 \|/);
    // Edgee row: 4 total MCP calls
    expect(md).toMatch(/\| `linear-recent-issues` \| edgee \| 0 \| 4 \|/);
    // The short-name strip should drop the mcp__SERVER__ prefix
    expect(md).toContain('list_issues');
    // Bash is a native tool — it must not appear in any table row's tool list.
    // (The intro paragraph mentions Bash by name as an example, so we check
    // table rows specifically.)
    const tableRows = md.split('\n').filter(line => line.startsWith('| `'));
    expect(tableRows.every(r => !r.includes('Bash'))).toBe(true);
  });

  it('renders "(none)" when a session had zero MCP calls', () => {
    const md = renderMcpToolUseSummary([
      {
        taskId: 'native-only',
        backend: 'vanilla',
        replicate: 0,
        tools: [{ name: 'Bash', count: 3 }],
      },
    ]).join('\n');
    expect(md).toContain('_(none)_');
  });

  it('handles empty input', () => {
    const md = renderMcpToolUseSummary([]).join('\n');
    expect(md).toContain('## MCP tools invoked');
    expect(md).toContain('No sessions captured');
  });
});

// ──────── renderResolutionOverhead ───────────────────────────────────────

describe('report-mcp: renderResolutionOverhead', () => {
  it('computes mean MCP-call counts per (task, backend) and the overhead delta', () => {
    // Vanilla: 2 list_issues (no gateway search). Edgee: 2 gateway searches +
    // 2 list_issues. Overhead = 4 - 2 = 2.0 calls.
    const md = renderResolutionOverhead([
      {
        taskId: 'linear-recent-issues',
        backend: 'vanilla',
        replicate: 0,
        tools: [{ name: 'mcp__claude_ai_Linear__list_issues', count: 2 }],
      },
      {
        taskId: 'linear-recent-issues',
        backend: 'edgee',
        replicate: 0,
        tools: [
          { name: 'mcp__edgee_gateway__search', count: 2 },
          { name: 'mcp__claude_ai_Linear__list_issues', count: 2 },
        ],
      },
    ]).join('\n');
    expect(md).toContain('## TSR resolution overhead');
    // vanilla mean = 2.0; edgee mean = 4.0; gateway-search mean = 2.0; overhead = +2.0
    expect(md).toMatch(/\| `linear-recent-issues` \| 2\.0 \| 4\.0 \| 2\.0 \| \+2\.0 \|/);
  });

  it('averages across replicates', () => {
    const md = renderResolutionOverhead([
      {
        taskId: 't1',
        backend: 'edgee',
        replicate: 0,
        tools: [{ name: 'mcp__edgee_gateway__search', count: 2 }],
      },
      {
        taskId: 't1',
        backend: 'edgee',
        replicate: 1,
        tools: [{ name: 'mcp__edgee_gateway__search', count: 4 }],
      },
    ]).join('\n');
    // edgee mean across 2 replicates = (2 + 4) / 2 = 3.0
    expect(md).toContain('3.0');
  });

  it('renders — when only one backend has data for a task', () => {
    const md = renderResolutionOverhead([
      {
        taskId: 'edgee-only',
        backend: 'edgee',
        replicate: 0,
        tools: [{ name: 'mcp__edgee_gateway__search', count: 1 }],
      },
    ]).join('\n');
    // Vanilla column should be — since no vanilla session ran
    expect(md).toMatch(/\| `edgee-only` \| — \|/);
  });

  it('handles empty input', () => {
    const md = renderResolutionOverhead([]).join('\n');
    expect(md).toContain('## TSR resolution overhead');
    expect(md).toContain('No sessions captured');
  });
});

// ──────── renderTaskDefinitions ──────────────────────────────────────────

describe('report-mcp: renderTaskDefinitions', () => {
  const sample: McpTask[] = [
    {
      id: 'linear-recent-issues',
      prompt: 'List the 5 most recently updated issues.',
      rationale: 'Light Linear-only baseline.',
    },
    {
      id: 'cross-task',
      prompt: 'Find Linear issues OR Notion pages.',
      rationale: 'Cross-server query.',
    },
  ];

  it('renders one subsection per task with prompt + rationale', () => {
    const md = renderTaskDefinitions(sample).join('\n');
    expect(md).toContain('## Task definitions');
    expect(md).toContain('### `linear-recent-issues`');
    expect(md).toContain('Light Linear-only baseline');
    expect(md).toContain('> List the 5 most recently updated issues.');
    expect(md).toContain('### `cross-task`');
    expect(md).toContain('Find Linear issues OR Notion pages.');
  });

  it('renders empty-message when there are no tasks', () => {
    const md = renderTaskDefinitions([]).join('\n');
    expect(md).toContain('## Task definitions');
    expect(md).toContain('No tasks recorded');
  });
});

// ──────── renderMcpMarkdown (top-level composition) ──────────────────────

describe('report-mcp: renderMcpMarkdown end-to-end', () => {
  function mkInput(overrides: Partial<McpReportInput> = {}): McpReportInput {
    const vUsage = mkUsage(0, 50_000, 5_000, 500);
    const eUsage = mkUsage(0, 30_000, 3_000, 300);
    return {
      config: loadConfig({}),
      backendOrder: ['vanilla', 'edgee'],
      tasksRun: ['linear-recent-issues'],
      results: {
        'linear-recent-issues': {
          vanilla: [mkRun(vUsage, 'v-sid')],
          edgee: [mkRun(eUsage, 'e-sid')],
        },
      },
      finishedAt: '2026-06-23T12:00:00.000Z',
      taskDefinitions: [
        { id: 'linear-recent-issues', prompt: 'List recent issues.', rationale: 'Baseline.' },
      ],
      safetyAudit: [
        { sessionId: 'v-sid', taskId: 'linear-recent-issues', backend: 'vanilla', replicate: 0, totalMcpCalls: 2, writeCalls: [] },
        { sessionId: 'e-sid', taskId: 'linear-recent-issues', backend: 'edgee', replicate: 0, totalMcpCalls: 4, writeCalls: [] },
      ],
      mcpToolUse: [
        {
          taskId: 'linear-recent-issues',
          backend: 'vanilla',
          replicate: 0,
          tools: [{ name: 'mcp__claude_ai_Linear__list_issues', count: 2 }],
        },
        {
          taskId: 'linear-recent-issues',
          backend: 'edgee',
          replicate: 0,
          tools: [
            { name: 'mcp__edgee_gateway__search', count: 2 },
            { name: 'mcp__claude_ai_Linear__list_issues', count: 2 },
          ],
        },
      ],
      ...overrides,
    };
  }

  it('renders the MCP-specific title (not the SWE title)', () => {
    const md = renderMcpMarkdown(mkInput());
    expect(md).toContain('# MCP Tool-Surface-Reduction Bench');
    expect(md).not.toContain('# SWE-bench Token Bench');
  });

  it('composes all expected sections in order', () => {
    const md = renderMcpMarkdown(mkInput());
    const sections = [
      '# MCP Tool-Surface-Reduction Bench',
      '## Configuration',
      '## Recap',
      '## Safety audit',
      '## Per-task token consumption',
      '## Deltas per task',
      '## MCP tools invoked',
      '## TSR resolution overhead',
      '## Overall',
      '## Session IDs',
      '## Task definitions',
    ];
    let lastIdx = -1;
    for (const s of sections) {
      const idx = md.indexOf(s);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('the safety audit shows ✅ for a clean run', () => {
    const md = renderMcpMarkdown(mkInput());
    expect(md).toContain('✅');
    expect(md).not.toContain('🚨');
  });

  it('passes through tags + notes to the tags callout', () => {
    const md = renderMcpMarkdown(
      mkInput({ config: loadConfig({ TAGS: 'tsr,linear', NOTES: 'first MCP run' }) }),
    );
    expect(md).toContain('🏷');
    expect(md).toContain('`tsr`');
    expect(md).toContain('`linear`');
    expect(md).toContain('first MCP run');
  });

  it('shows the safety failure banner when the audit found writes', () => {
    const badAudit: SafetyAuditEntry[] = [
      {
        sessionId: 'e-sid',
        taskId: 'linear-recent-issues',
        backend: 'edgee',
        replicate: 0,
        totalMcpCalls: 5,
        writeCalls: ['mcp__claude_ai_Linear__save_issue'],
      },
    ];
    const md = renderMcpMarkdown(mkInput({ safetyAudit: badAudit }));
    expect(md).toContain('🚨');
    expect(md).toContain('save_issue');
  });
});

// ──────── buildMcpJsonReport ─────────────────────────────────────────────

describe('report-mcp: buildMcpJsonReport', () => {
  it('includes the four MCP-specific fields + the bench_kind discriminator', () => {
    const vUsage = mkUsage(0, 1000, 100, 10);
    const eUsage = mkUsage(0, 500, 50, 5);
    const json = buildMcpJsonReport({
      config: loadConfig({}),
      backendOrder: ['vanilla', 'edgee'],
      tasksRun: ['t1'],
      results: { t1: { vanilla: [mkRun(vUsage, 'v')], edgee: [mkRun(eUsage, 'e')] } },
      finishedAt: '2026-06-23T12:00:00.000Z',
      taskDefinitions: [{ id: 't1', prompt: 'do x', rationale: 'because' }],
      safetyAudit: [
        { sessionId: 'v', taskId: 't1', backend: 'vanilla', replicate: 0, totalMcpCalls: 1, writeCalls: [] },
      ],
      mcpToolUse: [
        {
          taskId: 't1',
          backend: 'vanilla',
          replicate: 0,
          tools: [{ name: 'mcp__claude_ai_Linear__list_issues', count: 1 }],
        },
      ],
    });
    expect(json.bench_kind).toBe('mcp');
    expect(json.task_definitions).toEqual([{ id: 't1', prompt: 'do x', rationale: 'because' }]);
    expect(Array.isArray(json.safety_audit)).toBe(true);
    expect(Array.isArray(json.mcp_tool_use)).toBe(true);
    // Sanity: the shared fields from the SWE JSON shape come through too.
    expect(json.schema_version).toBe(2);
    expect(json.results).toBeDefined();
    expect(json.task_means).toBeDefined();
    expect(json.reductions).toBeDefined();
  });
});
