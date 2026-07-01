// Tool-use extraction tests. Reuses synthetic JSONL fixtures (no real
// session needed — the parser is pure once a JSONL string is in hand).

import { describe, expect, it } from 'vitest';
import { extractToolUses } from '../mcp-tool-use.js';

function assistantWithToolUse(id: string, toolUseNames: string[]): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      content: [
        { type: 'text', text: 'thinking…' },
        ...toolUseNames.map(name => ({ type: 'tool_use', name, input: {} })),
      ],
    },
  });
}

describe('mcp-tool-use: extractToolUses', () => {
  it('empty input → empty result', () => {
    expect(extractToolUses('')).toEqual([]);
  });

  it('counts tool_use blocks across assistant messages', () => {
    const text = [
      assistantWithToolUse('m1', ['mcp__claude_ai_Linear__list_issues']),
      assistantWithToolUse('m2', ['mcp__claude_ai_Linear__get_issue']),
      assistantWithToolUse('m3', ['mcp__claude_ai_Linear__get_issue']),
    ].join('\n');
    const result = extractToolUses(text);
    const byName = Object.fromEntries(result.map(t => [t.name, t.count]));
    expect(byName).toEqual({
      'mcp__claude_ai_Linear__list_issues': 1,
      'mcp__claude_ai_Linear__get_issue': 2,
    });
  });

  it('multiple tool_use blocks in one message all counted', () => {
    const text = assistantWithToolUse('m1', [
      'mcp__claude_ai_Linear__list_issues',
      'mcp__claude_ai_Linear__get_issue',
      'Bash',
    ]);
    const result = extractToolUses(text);
    const byName = Object.fromEntries(result.map(t => [t.name, t.count]));
    expect(byName).toEqual({
      'mcp__claude_ai_Linear__list_issues': 1,
      'mcp__claude_ai_Linear__get_issue': 1,
      'Bash': 1,
    });
  });

  it('deduplicates by message.id (Claude logs each message twice)', () => {
    // Same message id appears twice with identical content — must count
    // each tool_use ONCE, not twice.
    const block = assistantWithToolUse('msg-001', ['mcp__claude_ai_Linear__list_issues']);
    const text = [block, block].join('\n');
    const result = extractToolUses(text);
    expect(result).toEqual([{ name: 'mcp__claude_ai_Linear__list_issues', count: 1 }]);
  });

  it('skips non-assistant message types', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { id: 'u1', content: [{ type: 'text', text: 'go' }] } }),
      JSON.stringify({ type: 'summary', content: 'a summary' }),
      assistantWithToolUse('a1', ['Bash']),
    ].join('\n');
    const result = extractToolUses(text);
    expect(result).toEqual([{ name: 'Bash', count: 1 }]);
  });

  it('handles assistant messages with no tool_use blocks', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'just text' }] },
    });
    expect(extractToolUses(text)).toEqual([]);
  });

  it('handles malformed JSON lines gracefully (skips)', () => {
    const text = [
      'not json',
      assistantWithToolUse('m1', ['Bash']),
      '{partial',
    ].join('\n');
    expect(extractToolUses(text)).toEqual([{ name: 'Bash', count: 1 }]);
  });

  it('skips tool_use blocks without a name', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          { type: 'tool_use', input: {} }, // no name
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    });
    expect(extractToolUses(text)).toEqual([{ name: 'Read', count: 1 }]);
  });

  it('skips assistant messages without id (defensive)', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
    });
    expect(extractToolUses(text)).toEqual([]);
  });

  it('skips assistant messages where content is not an array', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', content: 'a string not an array' },
    });
    expect(extractToolUses(text)).toEqual([]);
  });

  it('mixed native + MCP tools — both counted under the same call', () => {
    const text = [
      assistantWithToolUse('m1', ['Read', 'mcp__claude_ai_Linear__list_issues']),
      assistantWithToolUse('m2', ['Read', 'Bash']),
    ].join('\n');
    const result = extractToolUses(text);
    const byName = Object.fromEntries(result.map(t => [t.name, t.count]));
    expect(byName).toEqual({
      'Read': 2,
      'mcp__claude_ai_Linear__list_issues': 1,
      'Bash': 1,
    });
  });
});
