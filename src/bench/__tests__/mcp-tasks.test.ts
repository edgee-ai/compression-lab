// MCP task list shape tests. The bench depends on these invariants:
//   - Every task has a unique slug ID (filenames + per-task tables)
//   - Prompts are non-empty
//   - Prompts don't accidentally instruct claude to write anything

import { describe, expect, it } from 'vitest';
import { MCP_TASKS, selectTasks } from '../mcp-tasks.js';

describe('mcp-tasks: shape', () => {
  it('has tasks defined', () => {
    expect(MCP_TASKS.length).toBeGreaterThan(0);
  });

  it('every task has a slug ID (lowercase, dashes, no spaces)', () => {
    for (const t of MCP_TASKS) {
      expect(t.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('all task IDs are unique', () => {
    const ids = MCP_TASKS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every task has a non-empty prompt + rationale', () => {
    for (const t of MCP_TASKS) {
      expect(t.prompt.trim().length).toBeGreaterThan(20);
      expect(t.rationale.trim().length).toBeGreaterThan(10);
    }
  });
});

describe('mcp-tasks: safety — prompts must not request writes', () => {
  // Light pre-flight check that no prompt contains imperative phrasing
  // that would tempt claude to call a write tool. The real safety is
  // --allowedTools + post-run audit; this is a belt-and-braces lint.
  const WRITE_VERBS_NEAR_LINEAR_OR_NOTION = [
    /\bcreate\s+(a|an|new)?\s*(linear|notion)/i,
    /\bdelete\s+(the|a|any)?\s*(linear|notion|issue|page)/i,
    /\bedit\s+(the|a|any)?\s*(linear|notion|issue|page)/i,
    /\bupdate\s+(the|a|any)?\s*(linear|notion|issue|page)/i,
    /\bsave\s+(a|an|new)?\s*(issue|comment|page)/i,
    /\bpost\s+(a|to)\s*(message|comment|update)/i,
  ];

  for (const t of MCP_TASKS) {
    it(`'${t.id}' prompt contains no write-imperative phrasing`, () => {
      for (const re of WRITE_VERBS_NEAR_LINEAR_OR_NOTION) {
        expect(t.prompt).not.toMatch(re);
      }
    });
  }
});

describe('mcp-tasks: selectTasks', () => {
  it('returns the full list when limit is 0 or >= length', () => {
    expect(selectTasks(0)).toHaveLength(MCP_TASKS.length);
    expect(selectTasks(MCP_TASKS.length)).toHaveLength(MCP_TASKS.length);
    expect(selectTasks(1000)).toHaveLength(MCP_TASKS.length);
  });

  it('slices to the first N when limit is in range', () => {
    expect(selectTasks(2)).toEqual(MCP_TASKS.slice(0, 2));
    expect(selectTasks(4)).toEqual(MCP_TASKS.slice(0, 4));
  });

  it('returns a copy (not the same array reference)', () => {
    const sliced = selectTasks(0);
    expect(sliced).not.toBe(MCP_TASKS);
    sliced.pop();
    expect(MCP_TASKS.length).toBeGreaterThan(sliced.length);
  });
});
