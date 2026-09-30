// Repo helpers integration test. Builds a tiny git repo in a tempdir and
// exercises resetRepo + captureDiff. Skips ensureRepo (clones from GitHub
// over the network — too slow / flaky for unit testing).

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureDiff, resetRepo } from '../repo.js';

const execFileP = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return stdout;
}

describe('repo: resetRepo + captureDiff (tempdir integration)', () => {
  let repoDir: string;
  let patchesDir: string;
  let baseCommit: string;

  beforeEach(async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'bench-repo-test-'));
    repoDir = path.join(tmp, 'repo');
    patchesDir = path.join(tmp, 'patches');
    await git(['init', '-q', '-b', 'main', repoDir], '/tmp');
    await writeFile(path.join(repoDir, 'a.txt'), 'one\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-q', '-m', 'initial'], repoDir);
    baseCommit = (await git(['rev-parse', 'HEAD'], repoDir)).trim();
  });

  afterEach(async () => {
    await rm(path.dirname(repoDir), { recursive: true, force: true });
  });

  it('resetRepo reverts tracked changes', async () => {
    await writeFile(path.join(repoDir, 'a.txt'), 'CHANGED\n');
    await resetRepo(repoDir, baseCommit);
    const after = await readFile(path.join(repoDir, 'a.txt'), 'utf8');
    expect(after).toBe('one\n');
  });

  it('resetRepo wipes untracked files', async () => {
    await writeFile(path.join(repoDir, 'untracked.txt'), 'should be wiped\n');
    await resetRepo(repoDir, baseCommit);
    // Should now error because the file was wiped
    await expect(readFile(path.join(repoDir, 'untracked.txt'), 'utf8')).rejects.toThrow();
  });

  it('captureDiff writes a header + diff body', async () => {
    await writeFile(path.join(repoDir, 'a.txt'), 'one\ntwo\n');
    const outPath = await captureDiff({
      taskId: 'demo__demo-1',
      backend: 'vanilla',
      replicate: 1,
      sessionId: 'sid-abc',
      patchesDir,
      repoPath: repoDir,
    });
    expect(outPath).toBeTruthy();
    expect(outPath).toContain('demo__demo-1/vanilla__rep1.diff');
    const content = await readFile(outPath as string, 'utf8');
    // Header bytes are part of the contract (matches Python's format).
    expect(content).toContain('# task: demo__demo-1\n');
    expect(content).toContain('# backend: vanilla\n');
    expect(content).toContain('# replicate: 1\n');
    expect(content).toContain('# session_id: sid-abc\n');
    expect(content).toContain(`# repo: ${repoDir}\n`);
    expect(content).toMatch(/# diff_bytes: \d+\n/);
    expect(content).toContain('# ─────────────────────────────────────────\n');
    // Diff body should contain the change
    expect(content).toContain('+two');
  });

  it('captureDiff with no edits writes an empty-body diff (header only)', async () => {
    const outPath = await captureDiff({
      taskId: 'demo__demo-1',
      backend: 'edgee',
      replicate: 2,
      sessionId: null,
      patchesDir,
      repoPath: repoDir,
    });
    expect(outPath).toBeTruthy();
    const content = await readFile(outPath as string, 'utf8');
    expect(content).toContain('# session_id: (none)\n');
    expect(content).toContain('# diff_bytes: 0\n');
    // Trailing content should be empty after the header.
    const afterHeader = content.split('─────────────────────────────────────────\n')[1];
    expect(afterHeader).toBe('');
  });
});
