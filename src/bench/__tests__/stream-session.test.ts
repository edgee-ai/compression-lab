// Unit tests for the cmd parser. The actual PTY-spawn behavior is integration-
// tested by running bench-swe against a live claude/edgee binary.

import { describe, expect, it } from 'vitest';
import { parseCmdAndEnv } from '../stream-session.js';

describe('stream-session: parseCmdAndEnv', () => {
  it('plain cmd without env prefix', () => {
    expect(parseCmdAndEnv(['claude', '--print'])).toEqual({
      executable: 'claude',
      args: ['--print'],
      envOverride: {},
    });
  });

  it('strips a single env-var prefix', () => {
    expect(parseCmdAndEnv(['env', 'ENABLE_TOOL_SEARCH=true', 'claude', '--print'])).toEqual({
      executable: 'claude',
      args: ['--print'],
      envOverride: { ENABLE_TOOL_SEARCH: 'true' },
    });
  });

  it('strips multiple env-var prefixes', () => {
    const result = parseCmdAndEnv([
      'env',
      'FOO=1',
      'BAR=hello world',
      'BAZ=',
      '/path/to/edgee',
      'launch',
      'claude',
    ]);
    expect(result.executable).toBe('/path/to/edgee');
    expect(result.args).toEqual(['launch', 'claude']);
    expect(result.envOverride).toEqual({
      FOO: '1',
      BAR: 'hello world',
      BAZ: '',
    });
  });

  it('values can contain = signs', () => {
    const result = parseCmdAndEnv(['env', 'URL=http://example.com/?a=1&b=2', 'wget']);
    expect(result.envOverride).toEqual({ URL: 'http://example.com/?a=1&b=2' });
    expect(result.executable).toBe('wget');
  });

  it('throws on env with no executable', () => {
    expect(() => parseCmdAndEnv(['env', 'FOO=1', 'BAR=2'])).toThrow(/no executable/);
  });

  it('throws on empty cmd', () => {
    expect(() => parseCmdAndEnv([])).toThrow(/empty cmd/);
  });

  it('matches BACKENDS shape from config', () => {
    // Same as the BACKENDS.vanilla and .edgee entries.
    const v = parseCmdAndEnv(['env', 'ENABLE_TOOL_SEARCH=true', 'claude', '--mcp-config', '/p']);
    expect(v.executable).toBe('claude');
    expect(v.args).toEqual(['--mcp-config', '/p']);
    expect(v.envOverride.ENABLE_TOOL_SEARCH).toBe('true');

    const e = parseCmdAndEnv(['env', 'ENABLE_TOOL_SEARCH=false', '/abs/edgee', 'launch', 'claude']);
    expect(e.executable).toBe('/abs/edgee');
    expect(e.args).toEqual(['launch', 'claude']);
    expect(e.envOverride.ENABLE_TOOL_SEARCH).toBe('false');
  });
});
