// Repo-management helpers — clone, reset, capture diff.
//
// Port of bench_tokens.py lines 210-278 (`ensure_repo`, `reset_repo`,
// `capture_diff`). Avoids external git libraries: 4 ops via execFile.
//
// Repos cache to `~/.cache/cache_bench_swe/repos/<repo>` (shared with the
// Python bench so cache state is interoperable across both impls).

import { execFile } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { REPOS_CACHE } from './config.js';
import { BackendName, Task } from './types.js';

const execFileP = promisify(execFile);

/** Internal: run a `git` command with stdout capture, throws on non-zero exit. */
async function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  // Big maxBuffer because `git diff` on large patches can exceed the 1MB default.
  return execFileP('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Ensure the task's repo is cloned and the requested commit is fetched.
 * Returns the local path. Idempotent: subsequent calls reuse the cache.
 *
 * Mirrors bench_tokens.py `ensure_repo` (lines 210-235):
 *   1. If <REPOS_CACHE>/<owner__repo>/.git doesn't exist → clone.
 *   2. If base_commit doesn't exist as a git object → fetch from origin.
 */
export async function ensureRepo(task: Task): Promise<string> {
  const localName = task.repo.replace('/', '__');
  const repoPath = path.join(REPOS_CACHE, localName);
  await mkdir(REPOS_CACHE, { recursive: true });

  // Check for `.git` to detect a fresh checkout vs an empty/broken dir.
  let needsClone = false;
  try {
    const s = await stat(path.join(repoPath, '.git'));
    if (!s.isDirectory()) needsClone = true;
  } catch {
    needsClone = true;
  }

  if (needsClone) {
    await runGit(['clone', '--quiet', `https://github.com/${task.repo}.git`, repoPath]);
  }

  // Verify the base_commit is reachable; fetch from origin if not.
  try {
    await runGit(['cat-file', '-e', task.base_commit], repoPath);
  } catch {
    await runGit(['fetch', '--quiet', 'origin', task.base_commit], repoPath);
  }

  return repoPath;
}

/**
 * Detach to the task's base commit and wipe untracked files.
 * Mirrors bench_tokens.py `reset_repo` (lines 238-247).
 *
 * Called BEFORE every (task, backend, replicate) session so Claude starts
 * each run from an identical filesystem state — eliminates cross-run
 * contamination from edits left behind by previous sessions.
 */
export async function resetRepo(repoPath: string, baseCommit: string): Promise<void> {
  await runGit(['reset', '--hard', '--quiet', baseCommit], repoPath);
  await runGit(['clean', '-fdx', '--quiet'], repoPath);
}

export interface CaptureDiffOptions {
  taskId: string;
  backend: BackendName;
  replicate: number;
  sessionId: string | null;
  /** Root dir where per-task subdirs are created. */
  patchesDir: string;
  repoPath: string;
}

/**
 * Capture `git diff HEAD` for the current repo state into a diff file with
 * a metadata header. Used in agent mode after each session to preserve
 * whatever Claude edited.
 *
 * Mirrors bench_tokens.py `capture_diff` (lines 250-278). The header lines
 * are byte-for-byte identical so existing tooling that reads the diffs
 * keeps working.
 *
 * Returns the path of the written file, or null on git error.
 */
export async function captureDiff(opts: CaptureDiffOptions): Promise<string | null> {
  const taskDir = path.join(opts.patchesDir, opts.taskId);
  await mkdir(taskDir, { recursive: true });
  const outPath = path.join(taskDir, `${opts.backend}__rep${opts.replicate}.diff`);

  let diff: string;
  try {
    const result = await runGit(['diff', 'HEAD'], opts.repoPath);
    diff = result.stdout;
  } catch {
    return null;
  }

  const header =
    `# task: ${opts.taskId}\n` +
    `# backend: ${opts.backend}\n` +
    `# replicate: ${opts.replicate}\n` +
    `# session_id: ${opts.sessionId ?? '(none)'}\n` +
    `# repo: ${opts.repoPath}\n` +
    `# diff_bytes: ${diff.length}\n` +
    `# ─────────────────────────────────────────\n`;
  await writeFile(outPath, header + diff);
  return outPath;
}
