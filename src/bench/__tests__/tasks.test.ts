// Task loader tests — exercises both the per-task JSON shard cache
// (interoperable with Python's bench_tokens.py cache) AND the hyparquet
// decode of the SWE-bench Lite test parquet when the local parquet cache
// is populated.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { fetchTask, loadSweBenchLite } from '../tasks.js';
import { TASKS_CACHE } from '../config.js';

describe('tasks: fetchTask hits the Python-interoperable shard cache', () => {
  // The Python bench writes per-task shards to TASKS_CACHE/<task_id>.json on
  // first fetch. These tests rely on at least one shard already existing
  // (the user's recent bench runs cached several django + astropy tasks).
  const hasCachedTask = existsSync(path.join(TASKS_CACHE, 'astropy__astropy-12907.json'));

  it.skipIf(!hasCachedTask)(
    'returns astropy__astropy-12907 from the existing shard cache (no network)',
    async () => {
      const task = await fetchTask('astropy__astropy-12907');
      expect(task).not.toBeNull();
      expect(task!.instance_id).toBe('astropy__astropy-12907');
      expect(task!.repo).toBe('astropy/astropy');
      expect(typeof task!.base_commit).toBe('string');
      expect(task!.base_commit.length).toBeGreaterThanOrEqual(7);
      expect(typeof task!.problem_statement).toBe('string');
      expect(task!.problem_statement.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!hasCachedTask)(
    'shard cache shape contains the SWE-bench Lite fields the bench uses',
    async () => {
      const task = await fetchTask('astropy__astropy-12907');
      expect(task).not.toBeNull();
      // The bench only DEPENDS on these four — others may exist but aren't required.
      for (const k of ['instance_id', 'repo', 'base_commit', 'problem_statement']) {
        expect(task).toHaveProperty(k);
      }
    },
  );
});

describe('tasks: hyparquet decode matches Python on every checked field', () => {
  // Skip when neither the parquet nor the shard is on disk. The user can
  // populate the parquet by running any bench with RANDOM_TASKS=1.
  const parquetPath = path.join(os.homedir(), '.cache', 'cache_bench_swe', 'lite-test.parquet');
  const shardPath = path.join(TASKS_CACHE, 'astropy__astropy-12907.json');
  const hasBoth = existsSync(parquetPath) && existsSync(shardPath);

  it.skipIf(!hasBoth)(
    'astropy__astropy-12907 decoded from parquet matches Python shard byte-for-byte',
    async () => {
      const rows = await loadSweBenchLite();
      const tsTask = rows.find(r => r.instance_id === 'astropy__astropy-12907');
      expect(tsTask).toBeDefined();
      const pyTask = JSON.parse(readFileSync(shardPath, 'utf8'));

      // The 11 fields the bench actually reads (or could read) from a task.
      // Bit-exact match required; the bench's prompt builder uses
      // problem_statement, so a single byte off would cause cache-prefix
      // hashes to drift across impls.
      const fields = [
        'instance_id',
        'repo',
        'base_commit',
        'problem_statement',
        'patch',
        'test_patch',
        'hints_text',
        'version',
        'FAIL_TO_PASS',
        'PASS_TO_PASS',
        'environment_setup_commit',
      ];
      for (const f of fields) {
        const ts = String((tsTask as Record<string, unknown>)[f] ?? '');
        const py = String((pyTask as Record<string, unknown>)[f] ?? '');
        if (ts !== py) {
          throw new Error(
            `field ${f}: TS (len ${ts.length}) != Python shard (len ${py.length}). ` +
              `First diff at char ${[...ts].findIndex((c, i) => c !== py[i])}`,
          );
        }
      }
    },
  );
});
