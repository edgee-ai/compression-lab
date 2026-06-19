// JSONL parser tests. Diff each fixture session's TS-parsed output against
// the Python golden in <sid>.expected.json — must be byte-identical.
//
// The 3 fixtures cover:
//   - small-vanilla: 4 assistant messages, 1 duplicate-id pair (basic dedup)
//   - small-edgee:   edgee-backend session, similar size
//   - large-with-many-dups: 55 asst msgs / 36 unique ids — primary stress
//                            test for the keep-highest-output rule and the
//                            insertion-order preservation invariant.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwd, parseJsonlFile, parseJsonlText } from '../claude-jsonl.js';
import { aggregateTurns, totalTokens } from '../usage.js';
import { Turn } from '../types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../test/fixtures/sessions');

interface SessionExpected {
  session_id: string;
  label: string;
  turns: Turn[];
  aggregated: { calls: number; input: number; cache_read: number; cache_create: number; output: number };
  total_tokens: number;
  n_assistant_unique_ids: number;
}

function loadFixtures(): SessionExpected[] {
  return readdirSync(FIXTURES_DIR)
    .filter(n => n.endsWith('.expected.json'))
    .sort()
    .map(n => JSON.parse(readFileSync(path.join(FIXTURES_DIR, n), 'utf8')));
}

const fixtures = loadFixtures();

describe('claude-jsonl: parseJsonlFile matches Python parse_session_turns', () => {
  for (const fx of fixtures) {
    const jsonlPath = path.join(FIXTURES_DIR, `${fx.session_id}.jsonl`);

    it(`${fx.label} — turn count matches`, async () => {
      const turns = await parseJsonlFile(jsonlPath);
      expect(turns).toHaveLength(fx.turns.length);
    });

    it(`${fx.label} — every turn matches byte-for-byte (insertion order + dedup)`, async () => {
      const turns = await parseJsonlFile(jsonlPath);
      for (let i = 0; i < turns.length; i++) {
        expect(turns[i]).toEqual(fx.turns[i]);
      }
    });

    it(`${fx.label} — aggregateTurns matches Python aggregated`, async () => {
      const turns = await parseJsonlFile(jsonlPath);
      const agg = aggregateTurns(turns);
      expect(agg).toEqual(fx.aggregated);
    });

    it(`${fx.label} — totalTokens matches`, async () => {
      const turns = await parseJsonlFile(jsonlPath);
      const agg = aggregateTurns(turns);
      expect(totalTokens(agg)).toBe(fx.total_tokens);
    });
  }
});

describe('claude-jsonl: dedup-by-highest-output rule', () => {
  // Synthesize a JSONL with two records sharing the same id, second has
  // higher output. The result should keep the higher-output entry.
  it('keeps the higher-output entry on collision', () => {
    const text = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_001',
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_001',
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 150 },
        },
      }),
    ].join('\n');
    const turns = parseJsonlText(text);
    expect(turns).toHaveLength(1);
    expect(turns[0].output).toBe(150);
  });

  it('does NOT replace when later entry has lower output', () => {
    const text = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_001',
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 200 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_001',
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 },
        },
      }),
    ].join('\n');
    const turns = parseJsonlText(text);
    expect(turns).toHaveLength(1);
    expect(turns[0].output).toBe(200);
  });

  it('preserves first-seen insertion order on dedup', () => {
    // 3 messages in order: A, B, A (dup). The dup of A should NOT bump A to
    // the end — order must remain [A, B].
    const text = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'A',
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'B',
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'A',
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 999 },
        },
      }),
    ].join('\n');
    const turns = parseJsonlText(text);
    expect(turns).toHaveLength(2);
    expect(turns[0].output).toBe(999); // A, with higher-output replaced
    expect(turns[1].output).toBe(20);  // B, original position
  });
});

describe('claude-jsonl: edge cases', () => {
  it('empty string → empty turns', () => {
    expect(parseJsonlText('')).toEqual([]);
  });

  it('blank lines and whitespace → ignored', () => {
    expect(parseJsonlText('   \n\n  \n')).toEqual([]);
  });

  it('malformed JSON → skipped (Python parity)', () => {
    const text = [
      'not json at all',
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_x',
          usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
        },
      }),
      '{partial json',
    ].join('\n');
    expect(parseJsonlText(text)).toEqual([
      { input: 1, cache_read: 2, cache_create: 3, output: 4 },
    ]);
  });

  it('non-assistant rows → skipped', () => {
    const text = [
      JSON.stringify({ type: 'summary', content: 'a summary' }),
      JSON.stringify({ type: 'user', message: { id: 'u_1' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'a_1',
          usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 },
        },
      }),
    ].join('\n');
    expect(parseJsonlText(text)).toEqual([
      { input: 5, cache_read: 0, cache_create: 0, output: 10 },
    ]);
  });

  it('assistant row missing message.id → skipped', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 1 } },
    });
    expect(parseJsonlText(text)).toEqual([]);
  });

  it('assistant row missing usage → skipped', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: { id: 'a_1' },
    });
    expect(parseJsonlText(text)).toEqual([]);
  });

  it('missing usage fields default to 0', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: { id: 'a_1', usage: { input_tokens: 7 } }, // only input_tokens set
    });
    expect(parseJsonlText(text)).toEqual([
      { input: 7, cache_read: 0, cache_create: 0, output: 0 },
    ]);
  });

  it('NaN or string usage values → coerced to 0', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'a_1',
        usage: { input_tokens: 'oops', cache_read_input_tokens: null, output_tokens: 42 },
      },
    });
    expect(parseJsonlText(text)).toEqual([
      { input: 0, cache_read: 0, cache_create: 0, output: 42 },
    ]);
  });
});

describe('claude-jsonl: encodeCwd', () => {
  it('slashes → dashes', () => {
    expect(encodeCwd('/Users/kham/Documents/code')).toBe('-Users-kham-Documents-code');
  });

  it('underscores → dashes', () => {
    expect(encodeCwd('/path/to/foo_bar')).toBe('-path-to-foo-bar');
  });

  it('mixed slashes + underscores', () => {
    expect(encodeCwd('/cache/cache_bench_swe/repos/astropy__astropy')).toBe(
      '-cache-cache-bench-swe-repos-astropy--astropy',
    );
  });
});

describe('claude-jsonl: parseJsonlFile missing file → empty array', () => {
  it('returns [] when file does not exist', async () => {
    const turns = await parseJsonlFile('/tmp/this-file-does-not-exist.jsonl');
    expect(turns).toEqual([]);
  });
});
