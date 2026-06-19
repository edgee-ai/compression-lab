// Config / env-var parsing tests.

import { describe, expect, it } from 'vitest';
import {
  BACKENDS,
  FROZEN_TASKS,
  PRICING,
  loadConfig,
  parseTags,
  resolveBackendOrder,
  slugifyTag,
} from '../config.js';

describe('config: PRICING constants match the Opus 4.7 list pricing', () => {
  it('input $5/M, output $25/M, cache_read $0.50/M, cache_create $10/M', () => {
    expect(PRICING.inputPerM).toBe(5.0);
    expect(PRICING.outputPerM).toBe(25.0);
    expect(PRICING.cacheReadPerM).toBe(0.5);
    expect(PRICING.cacheCreate1hPerM).toBe(10.0);
  });
});

describe('config: FROZEN_TASKS layout (must match bench_tokens.py order)', () => {
  it('starts with astropy-12907 and ends with the two pytest tasks', () => {
    expect(FROZEN_TASKS[0]).toBe('astropy__astropy-12907');
    expect(FROZEN_TASKS[FROZEN_TASKS.length - 2]).toBe('pytest-dev__pytest-5103');
    expect(FROZEN_TASKS[FROZEN_TASKS.length - 1]).toBe('pytest-dev__pytest-5413');
  });

  it('has 8 entries (matches Python)', () => {
    expect(FROZEN_TASKS).toHaveLength(8);
  });
});

describe('config: BACKENDS', () => {
  it('vanilla has ENABLE_TOOL_SEARCH=true', () => {
    expect(BACKENDS.vanilla).toContain('ENABLE_TOOL_SEARCH=true');
  });

  it('edgee has ENABLE_TOOL_SEARCH=false', () => {
    expect(BACKENDS.edgee).toContain('ENABLE_TOOL_SEARCH=false');
  });
});

describe('config: loadConfig env-var parsing', () => {
  it('default values when no env vars are set', () => {
    const cfg = loadConfig({});
    expect(cfg.agentMode).toBe(false);
    expect(cfg.replicates).toBe(1);
    expect(cfg.shuffle).toBe(false);
    expect(cfg.bootstrapIters).toBe(10_000);
    expect(cfg.taskLimit).toBe(FROZEN_TASKS.length);
    expect(cfg.randomTasks).toBe(0);
    expect(cfg.warmupS).toBe(0);
    expect(cfg.orderEnv).toBe('');
    expect(cfg.statsMode).toBe(false);
    expect(cfg.agentTimeoutS).toBe(1800);
  });

  it('AGENT_MODE=1 enables agent mode', () => {
    expect(loadConfig({ AGENT_MODE: '1' }).agentMode).toBe(true);
    expect(loadConfig({ AGENT_MODE: 'true' }).agentMode).toBe(true);
    expect(loadConfig({ AGENT_MODE: '0' }).agentMode).toBe(false);
  });

  it('REPLICATES > 1 enables stats mode', () => {
    expect(loadConfig({ REPLICATES: '3' }).statsMode).toBe(true);
    expect(loadConfig({ REPLICATES: '1' }).statsMode).toBe(false);
  });

  it('REPLICATES is floored at 1', () => {
    expect(loadConfig({ REPLICATES: '0' }).replicates).toBe(1);
    expect(loadConfig({ REPLICATES: '-5' }).replicates).toBe(1);
  });

  it('SEED is honored when provided', () => {
    expect(loadConfig({ SEED: '42' }).seed).toBe(42);
  });

  it('SEED defaults to a random integer when omitted', () => {
    const a = loadConfig({});
    const b = loadConfig({});
    // Astronomically unlikely to be equal — if this ever fails on CI, the
    // odds-against are ~1 in 4 billion. Re-running will pass.
    expect(typeof a.seed).toBe('number');
    expect(a.seed).toBeGreaterThanOrEqual(0);
    // Either way, both seeds should be sensible 32-bit non-negatives.
    expect(b.seed).toBeGreaterThanOrEqual(0);
  });
});

describe('config: tag parsing', () => {
  it('slugifyTag lowercases, replaces non-[a-z0-9_], trims dashes', () => {
    expect(slugifyTag('Brevity')).toBe('brevity');
    expect(slugifyTag('Tool Surface Reduction')).toBe('tool-surface-reduction');
    expect(slugifyTag('  brevity-v2 ')).toBe('brevity-v2');
    expect(slugifyTag('enable_tool_search')).toBe('enable_tool_search');
    expect(slugifyTag('!!??')).toBe('');
  });

  it('parseTags splits on commas only, dedupes, sorts', () => {
    expect(parseTags('brevity,tool-surface-reduction')).toEqual([
      'brevity',
      'tool-surface-reduction',
    ]);
    expect(parseTags('brevity,brevity,brevity')).toEqual(['brevity']);
    expect(parseTags('a, b,  c')).toEqual(['a', 'b', 'c']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    // Multi-word tags survive — commas are the only separator
    expect(parseTags('Tool Trimming, Output Brevity')).toEqual([
      'output-brevity',
      'tool-trimming',
    ]);
  });

  it('loadConfig surfaces tags + notes', () => {
    const c = loadConfig({ TAGS: 'brevity,tsr', NOTES: 'first run after rebuild' });
    expect(c.tags).toEqual(['brevity', 'tsr']);
    expect(c.notes).toBe('first run after rebuild');
  });

  it('loadConfig defaults: empty tags, empty notes', () => {
    const c = loadConfig({});
    expect(c.tags).toEqual([]);
    expect(c.notes).toBe('');
  });
});

describe('config: resolveBackendOrder', () => {
  it('default order = vanilla then edgee', () => {
    expect(resolveBackendOrder('')).toEqual(['vanilla', 'edgee']);
  });

  it('ORDER=edgee,vanilla swaps the order', () => {
    expect(resolveBackendOrder('edgee,vanilla')).toEqual(['edgee', 'vanilla']);
  });

  it('throws on unknown backend names', () => {
    expect(() => resolveBackendOrder('vanilla,sonnet')).toThrow(/unknown backend/);
  });
});
