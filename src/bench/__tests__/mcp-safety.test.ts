// Safety audit tests. The MCP bench's read-only enforcement is a hard
// promise — the test suite is what backs that promise. Every write-pattern
// tool name we know about needs to be flagged; every read-only name needs to
// pass cleanly.

import { describe, expect, it } from 'vitest';
import {
  LINEAR_READ_TOOLS,
  WRITE_TOOL_PATTERNS,
  WriteToolDetectedError,
  allReadOnlyMcpTools,
  allowedToolsFlag,
  assertAllSessionsClean,
  auditSession,
  isWriteTool,
} from '../mcp-safety.js';

describe('mcp-safety: WRITE_TOOL_PATTERNS', () => {
  // Concrete tool names from the Anthropic claude.ai catalog that we know
  // are destructive. If any of these slip past `isWriteTool`, that's a bug.
  const KNOWN_WRITE_TOOLS = [
    // Linear writes (enumerated earlier in the project)
    'mcp__claude_ai_Linear__save_issue',
    'mcp__claude_ai_Linear__save_comment',
    'mcp__claude_ai_Linear__save_document',
    'mcp__claude_ai_Linear__save_initiative',
    'mcp__claude_ai_Linear__save_milestone',
    'mcp__claude_ai_Linear__save_project',
    'mcp__claude_ai_Linear__save_status_update',
    'mcp__claude_ai_Linear__create_attachment',
    'mcp__claude_ai_Linear__create_attachment_from_upload',
    'mcp__claude_ai_Linear__create_issue_label',
    'mcp__claude_ai_Linear__delete_attachment',
    'mcp__claude_ai_Linear__delete_comment',
    'mcp__claude_ai_Linear__delete_status_update',
    'mcp__claude_ai_Linear__extract_images',
    'mcp__claude_ai_Linear__prepare_attachment_upload',
    // Defensive — speculative names for other servers
    'mcp__claude_ai_Slack__send_message',
    'mcp__claude_ai_Slack__post_to_channel',
    'mcp__claude_ai_Notion__update_page',
    'mcp__claude_ai_Notion__add_block',
    'mcp__claude_ai_Figma__upload_assets',
    'mcp__claude_ai_Gmail__send_email',
  ];

  for (const name of KNOWN_WRITE_TOOLS) {
    it(`flags ${name}`, () => {
      expect(isWriteTool(name)).toBe(true);
    });
  }

  it('flags every name across multiple patterns simultaneously', () => {
    // No tool name should match >0 patterns; we don't care which one fires,
    // just that ANY does.
    for (const name of KNOWN_WRITE_TOOLS) {
      const hits = WRITE_TOOL_PATTERNS.filter(re => re.test(name));
      expect(hits.length).toBeGreaterThan(0);
    }
  });
});

describe('mcp-safety: isWriteTool — read-only names pass', () => {
  // Every Linear read tool we whitelisted must NOT be flagged.
  for (const name of LINEAR_READ_TOOLS) {
    it(`clean: ${name}`, () => {
      expect(isWriteTool(name)).toBe(false);
    });
  }
});

describe('mcp-safety: isWriteTool — native tools never flagged', () => {
  const NATIVE_TOOLS = ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob', 'TaskCreate', 'WebSearch'];
  for (const name of NATIVE_TOOLS) {
    it(`clean: ${name}`, () => {
      expect(isWriteTool(name)).toBe(false);
    });
  }
});

describe('mcp-safety: auditSession', () => {
  const META = { sessionId: 'sid-1', taskId: 'demo-task', backend: 'vanilla' as const, replicate: 0 };

  it('clean session — only read-only calls, native tools mixed in', () => {
    const result = auditSession(
      [
        { name: 'mcp__claude_ai_Linear__list_issues', count: 3 },
        { name: 'mcp__claude_ai_Linear__get_issue', count: 5 },
        { name: 'Bash', count: 2 }, // native; ignored
      ],
      META,
    );
    expect(result.totalMcpCalls).toBe(8); // 3 + 5; Bash not counted as MCP
    expect(result.writeCalls).toEqual([]);
  });

  it('flags a save_ tool', () => {
    const result = auditSession(
      [
        { name: 'mcp__claude_ai_Linear__list_issues', count: 1 },
        { name: 'mcp__claude_ai_Linear__save_issue', count: 2 },
      ],
      META,
    );
    expect(result.writeCalls).toEqual([
      'mcp__claude_ai_Linear__save_issue',
      'mcp__claude_ai_Linear__save_issue',
    ]);
    expect(result.totalMcpCalls).toBe(3);
  });

  it('flags multiple distinct write tools', () => {
    const result = auditSession(
      [
        { name: 'mcp__claude_ai_Linear__create_attachment', count: 1 },
        { name: 'mcp__claude_ai_Linear__delete_comment', count: 1 },
      ],
      META,
    );
    expect(result.writeCalls).toEqual([
      'mcp__claude_ai_Linear__create_attachment',
      'mcp__claude_ai_Linear__delete_comment',
    ]);
  });

  it('empty input → clean', () => {
    const result = auditSession([], META);
    expect(result.totalMcpCalls).toBe(0);
    expect(result.writeCalls).toEqual([]);
  });

  it('preserves session metadata in the entry', () => {
    const result = auditSession([], {
      sessionId: 'sid-xyz',
      taskId: 'task-abc',
      backend: 'edgee',
      replicate: 4,
    });
    expect(result.sessionId).toBe('sid-xyz');
    expect(result.taskId).toBe('task-abc');
    expect(result.backend).toBe('edgee');
    expect(result.replicate).toBe(4);
  });
});

describe('mcp-safety: assertAllSessionsClean', () => {
  it('passes when no session has writeCalls', () => {
    expect(() =>
      assertAllSessionsClean([
        { sessionId: 's1', taskId: 't1', backend: 'vanilla', replicate: 0, totalMcpCalls: 3, writeCalls: [] },
        { sessionId: 's2', taskId: 't2', backend: 'edgee', replicate: 0, totalMcpCalls: 5, writeCalls: [] },
      ]),
    ).not.toThrow();
  });

  it('throws WriteToolDetectedError when any session has writeCalls', () => {
    expect(() =>
      assertAllSessionsClean([
        { sessionId: 's1', taskId: 't1', backend: 'vanilla', replicate: 0, totalMcpCalls: 3, writeCalls: [] },
        {
          sessionId: 's2',
          taskId: 't2',
          backend: 'edgee',
          replicate: 0,
          totalMcpCalls: 4,
          writeCalls: ['mcp__claude_ai_Linear__save_issue'],
        },
      ]),
    ).toThrow(WriteToolDetectedError);
  });

  it('the thrown error names the offenders in its message', () => {
    try {
      assertAllSessionsClean([
        {
          sessionId: 's1',
          taskId: 'linear-test',
          backend: 'edgee',
          replicate: 1,
          totalMcpCalls: 2,
          writeCalls: ['mcp__claude_ai_Linear__delete_comment'],
        },
      ]);
      throw new Error('expected assertion to throw');
    } catch (e) {
      if (!(e instanceof WriteToolDetectedError)) throw e;
      expect(e.message).toContain('linear-test');
      expect(e.message).toContain('edgee');
      expect(e.message).toContain('delete_comment');
      expect(e.offenders).toHaveLength(1);
    }
  });
});

describe('mcp-safety: allowedToolsFlag', () => {
  it('returns the comma-joined Linear read tools (Notion stub empty for now)', () => {
    const flag = allowedToolsFlag();
    // Sanity: contains a few canonical Linear names
    expect(flag).toContain('mcp__linear__list_issues');
    expect(flag).toContain('mcp__linear__get_issue');
    expect(flag).toContain('mcp__linear__search_documentation');
    // No commas-at-edges, no double commas
    expect(flag.startsWith(',')).toBe(false);
    expect(flag.endsWith(',')).toBe(false);
    expect(flag.includes(',,')).toBe(false);
  });

  it('contains zero write-tool names by construction', () => {
    for (const name of allReadOnlyMcpTools()) {
      expect(isWriteTool(name)).toBe(false);
    }
  });

  it('every tool name follows the mcp__SERVER__OP pattern', () => {
    for (const name of allReadOnlyMcpTools()) {
      expect(name).toMatch(/^mcp__\w+__\w+/);
    }
  });
});
