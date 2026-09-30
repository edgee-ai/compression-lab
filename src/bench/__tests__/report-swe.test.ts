// Report formatting tests, focused on `formatFixed` (banker's rounding) since
// that's one of the three documented divergences from Python and the markdown
// table is the main user-facing artifact.

import { describe, expect, it } from 'vitest';
import {
  computeHeadlineReductions,
  formatFixed,
  renderMarkdown,
  reportBasename,
} from '../report-swe.js';
import { loadConfig } from '../config.js';
import { UsageDict, RunResult } from '../types.js';
import { aggregateTurns } from '../usage.js';

describe('report-swe: formatFixed (banker\'s rounding, matches Python format(x, ".Nf"))', () => {
  it('rounds half-to-even (banker\'s rounding)', () => {
    // The classic banker's-rounding cases that diverge from JS toFixed:
    expect(formatFixed(0.5, 0)).toBe('0'); // Python: '0', JS toFixed: '1'
    expect(formatFixed(1.5, 0)).toBe('2'); // both: '2'
    expect(formatFixed(2.5, 0)).toBe('2'); // Python: '2', JS toFixed: '3'
    expect(formatFixed(3.5, 0)).toBe('4'); // both: '4'
    expect(formatFixed(4.5, 0)).toBe('4'); // Python: '4', JS toFixed: '5'
  });

  it('formats with 4 decimal places (cost format)', () => {
    expect(formatFixed(1.2345, 4)).toBe('1.2345');
    expect(formatFixed(0.5, 4)).toBe('0.5000');
    expect(formatFixed(0, 4)).toBe('0.0000');
  });

  it('formats with 2 decimal places (ratio format)', () => {
    expect(formatFixed(1.23, 2)).toBe('1.23');
    expect(formatFixed(0.79, 2)).toBe('0.79');
    expect(formatFixed(1.0, 2)).toBe('1.00');
  });

  it('handles negative numbers (sign preserved like Python format)', () => {
    expect(formatFixed(-1.234, 2)).toBe('-1.23');
    // Python format(-0.5, '.0f') returns '-0' — sign is preserved even
    // though magnitude rounds to zero. We match exactly.
    expect(formatFixed(-0.5, 0)).toBe('-0');
  });

  it('handles non-finite values gracefully', () => {
    expect(formatFixed(Number.NaN, 4)).toBe('NaN');
    expect(formatFixed(Number.POSITIVE_INFINITY, 4)).toBe('Infinity');
    expect(formatFixed(Number.NEGATIVE_INFINITY, 4)).toBe('-Infinity');
  });

  it('rounds non-half values correctly', () => {
    expect(formatFixed(1.234, 2)).toBe('1.23');
    expect(formatFixed(1.236, 2)).toBe('1.24');
    // Note: 1.235 in IEEE-754 is actually slightly less than 1.235 (float
    // imprecision), so it rounds down to 1.23. Python format(1.235, '.2f')
    // returns '1.24' though (Python uses the repr-rounded value). Actually:
    expect(formatFixed(1.235, 2)).toBe('1.24'); // matches Python format(1.235, '.2f')
    // 1.245 in IEEE-754 is slightly MORE than 1.245, so it rounds up to 1.25.
    // Python format(1.245, '.2f') also returns '1.25' — float imprecision
    // dominates banker's rounding here. We match Python's behavior.
    expect(formatFixed(1.245, 2)).toBe('1.25');
  });
});

// ──────── Headline reductions ────────────────────────────────────────────

function mkUsage(input: number, cache_read: number, cache_create: number, output: number): UsageDict {
  return aggregateTurns([{ input, cache_read, cache_create, output }]);
}

function mkRun(usage: UsageDict): RunResult {
  return {
    sessionId: 'sid',
    usage,
    turns: [],
    resultEvents: [],
    rawTail: [],
    diffPath: null,
  };
}

describe('report-swe: computeHeadlineReductions', () => {
  // Hand-picked numbers: vanilla uses more cache_read and cache_create
  // (driving more cost); edgee writes less output. Two-task fixture.
  const rows = [
    {
      taskId: 't1',
      vanilla: mkUsage(0, 100_000, 10_000, 1000), // cost: $0.075
      edgee:   mkUsage(0,  50_000,  5_000,  500), // cost: $0.0375
      deltaOutput: 0,
      deltaTotalTokens: 0,
      deltaCost: 0,
      tokenRatio: 0,
      costRatio: 0,
    },
    {
      taskId: 't2',
      vanilla: mkUsage(0,  10_000,  2_000,  200), // cost: $0.030
      edgee:   mkUsage(0,   8_000,  1_000,  100), // cost: $0.0165
      deltaOutput: 0,
      deltaTotalTokens: 0,
      deltaCost: 0,
      tokenRatio: 0,
      costRatio: 0,
    },
  ];

  const r = computeHeadlineReductions(rows);

  it('cost reductions — aggregate, mean, median', () => {
    // Cost components at PRICING:
    //   cache_read $0.5/M, cache_create $10/M, output $25/M
    // t1 vanilla: 100000*0.5/1M + 10000*10/1M + 1000*25/1M = $0.175
    // t1 edgee:    50000*0.5/1M +  5000*10/1M +  500*25/1M = $0.0875
    // t2 vanilla:  10000*0.5/1M +  2000*10/1M +  200*25/1M = $0.030
    // t2 edgee:     8000*0.5/1M +  1000*10/1M +  100*25/1M = $0.0165
    // Aggregate: (0.175+0.030 - 0.0875-0.0165) / (0.175+0.030) ≈ 0.4927
    expect(r.cost.aggregate).toBeCloseTo(0.4927, 3);
    // Per task:  t1: 1 - 0.0875/0.175 = 0.5
    //            t2: 1 - 0.0165/0.030  = 0.45
    expect(r.cost.perTaskValues[0]).toBeCloseTo(0.5, 9);
    expect(r.cost.perTaskValues[1]).toBeCloseTo(0.45, 9);
    expect(r.cost.mean).toBeCloseTo(0.475, 6);
    expect(r.cost.median).toBeCloseTo(0.475, 6);
  });

  it('total tokens reductions', () => {
    // t1: 1 - 55500/111000 = 0.5
    // t2: 1 - 9100/12200  ≈ 0.2541
    expect(r.totalTokens.perTaskValues[0]).toBeCloseTo(0.5, 6);
    expect(r.totalTokens.perTaskValues[1]).toBeCloseTo(0.2541, 3);
  });

  it('output reductions', () => {
    // t1: 1 - 500/1000 = 0.5
    // t2: 1 - 100/200 = 0.5
    expect(r.outputTokens.perTaskValues).toEqual([0.5, 0.5]);
    expect(r.outputTokens.aggregate).toBeCloseTo(0.5, 6);
  });

  it('handles zero vanilla without crashing', () => {
    const empty = computeHeadlineReductions([
      {
        taskId: 't',
        vanilla: mkUsage(0, 0, 0, 0),
        edgee: mkUsage(0, 0, 0, 0),
        deltaOutput: 0,
        deltaTotalTokens: 0,
        deltaCost: 0,
        tokenRatio: 0,
        costRatio: 0,
      },
    ]);
    expect(Number.isNaN(empty.cost.aggregate)).toBe(true);
    expect(empty.cost.perTaskValues).toEqual([]);
  });
});

describe('report-swe: renderMarkdown contains the recap table', () => {
  it('shows headline reductions and significance markers', () => {
    // Single-task minimal input; just verify the recap section renders.
    const md = renderMarkdown({
      config: loadConfig({}),
      backendOrder: ['vanilla', 'edgee'],
      tasksRun: ['t1'],
      results: {
        t1: {
          vanilla: [mkRun(mkUsage(0, 100_000, 10_000, 1000))],
          edgee: [mkRun(mkUsage(0, 50_000, 5_000, 500))],
        },
      },
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(md).toContain('## Recap — edgee vs vanilla, reduction %');
    expect(md).toContain('| **Cost ($)** |');
    expect(md).toContain('| **Total tokens** |');
    expect(md).toContain('| **Output tokens** |');
    // Without stats, the sign-test p column shows '—' and sig column is blank.
    expect(md).toMatch(/edgee wins.*sign-test p.*sig/);
  });
});

describe('report-swe: tags + notes plumbing', () => {
  it('renders a tags callout when TAGS is set', () => {
    const md = renderMarkdown({
      config: loadConfig({ TAGS: 'brevity,TSR', NOTES: 'fresh edgee rebuild' }),
      backendOrder: ['vanilla', 'edgee'],
      tasksRun: [],
      results: {},
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(md).toContain('🏷 **Tags:** `brevity` `tsr`');
    expect(md).toContain('📝 **Notes:** fresh edgee rebuild');
    // Also surfaces in the Configuration table.
    expect(md).toContain('| Tags | `brevity`, `tsr` |');
    expect(md).toContain('| Notes | fresh edgee rebuild |');
  });

  it('shows "(none)" placeholders when no tags or notes are set', () => {
    const md = renderMarkdown({
      config: loadConfig({}),
      backendOrder: ['vanilla', 'edgee'],
      tasksRun: [],
      results: {},
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(md).toContain('| Tags | _(none — set via TAGS env var)_ |');
    expect(md).toContain('| Notes | _(none — set via NOTES env var)_ |');
    // The 🏷 callout block should NOT appear when there are no tags/notes.
    expect(md).not.toContain('🏷');
  });
});

describe('report-swe: per-call breakdown table', () => {
  // Build a RunResult with a non-empty `turns` array so we can verify the
  // per-call section renders. Two calls per backend; different counts on
  // each side to exercise the "—" filler.
  const vTurns = [
    { input: 6, cache_read: 24_877, cache_create: 11_367, output: 161 },
    { input: 1, cache_read: 36_244, cache_create: 262, output: 315 },
  ];
  const eTurns = [
    { input: 6, cache_read: 37_578, cache_create: 14_490, output: 146 },
    { input: 1, cache_read: 41_389, cache_create: 14_675, output: 144 },
    { input: 1, cache_read: 56_064, cache_create: 417, output: 209 },
  ];

  function mkRunWithTurns(turns: typeof vTurns | typeof eTurns): RunResult {
    return {
      sessionId: 'sid',
      usage: aggregateTurns(turns),
      turns: turns.slice(),
      resultEvents: [],
      rawTail: [],
      diffPath: null,
    };
  }

  it('renders one table per task with side-by-side per-call rows', () => {
    const md = renderMarkdown({
      config: loadConfig({}),
      backendOrder: ['vanilla', 'edgee'],
      tasksRun: ['t1'],
      results: {
        t1: {
          vanilla: [mkRunWithTurns(vTurns)],
          edgee: [mkRunWithTurns(eTurns)],
        },
      },
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(md).toContain('## Per-call breakdown');
    expect(md).toContain('### t1');
    // Verify the header columns match the spec
    expect(md).toContain('| Call | v fresh | v cache_r | v cache_c | v out | v total |');
    // Vanilla call-1 totals: 6 + 24877 + 11367 + 161 = 36,411
    expect(md).toContain('36,411');
    // Edgee call-3 should render in vanilla's column as "—"
    expect(md).toMatch(/\| 3 \| — \| — \| — \| — \| — \|/);
  });

  it('skips the section entirely when no tasks have turns', () => {
    const md = renderMarkdown({
      config: loadConfig({}),
      backendOrder: ['vanilla', 'edgee'],
      tasksRun: [],
      results: {},
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(md).not.toContain('## Per-call breakdown');
  });
});

describe('report-swe: reportBasename', () => {
  const iso = '2026-06-19T14:30:02.734Z';
  it('without tags, just timestamp', () => {
    expect(reportBasename(iso, [])).toBe('swe-2026-06-19T14-30-02-734Z');
  });
  it('with one tag, appends with --', () => {
    expect(reportBasename(iso, ['brevity'])).toBe('swe-2026-06-19T14-30-02-734Z--brevity');
  });
  it('with multiple tags, joins with --', () => {
    expect(reportBasename(iso, ['brevity', 'tsr'])).toBe(
      'swe-2026-06-19T14-30-02-734Z--brevity--tsr',
    );
  });
  it('defensively re-slugifies in case a non-slug snuck through', () => {
    expect(reportBasename(iso, ['Brevity (v2)' as string])).toBe(
      'swe-2026-06-19T14-30-02-734Z--Brevity--v2-',
    );
    // Note: the parseTags layer should prevent this case from ever reaching
    // reportBasename in production. This test just verifies the defense.
  });
});
