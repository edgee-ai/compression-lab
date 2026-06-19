// Task loader tests — exercises the per-task JSON shard cache path
// (interoperable with Python's bench_tokens.py cache).
//
// The HuggingFace parquet download + hyparquet decode paths are NOT covered
// here because they require network I/O. They're smoke-tested as part of
// the end-to-end bench validation.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchTask } from '../tasks.js';
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
