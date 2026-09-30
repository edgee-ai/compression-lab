// Prompt template builder.
//
// Port of bench_tokens.py `build_prompts` (lines 281-316). The string
// templates are intentionally byte-for-byte identical so cache prefixes
// computed by Anthropic match across the Python and TS impls. The
// prompt fixture suite at test/fixtures/prompts/ asserts this.
//
// Two modes:
//   - Scripted (default): one issue prompt + 2 follow-ups (FOLLOWUP_PROMPTS).
//   - Agent (AGENT_MODE=1): single autonomy prompt; the agent loop drives.
//
// Optional `nonce`: when stats mode is active, a `[trial: <nonce>]` marker is
// prepended to the FIRST prompt only. This invalidates Anthropic's content-
// keyed prompt cache between replicates so each replicate starts cold.

import { FOLLOWUP_PROMPTS } from './config.js';
import { Task } from './types.js';

export interface BuildPromptsOptions {
  /** Per-replicate nonce. When set, prepended as `[trial: <nonce>]\n\n` to the first prompt. */
  nonce?: string | null;
  /** Agent mode = single autonomy prompt. Default false = scripted 3-prompt sequence. */
  agentMode?: boolean;
}

/**
 * Build the prompt sequence for one (task, replicate) run.
 * MUST match Python `build_prompts` output byte-for-byte. See
 * test/fixtures/prompts/MANIFEST.json for the golden fixtures.
 */
export function buildPrompts(task: Task, opts: BuildPromptsOptions = {}): string[] {
  const { nonce = null, agentMode = false } = opts;
  const problem = task.problem_statement.trim();
  const marker = nonce ? `[trial: ${nonce}]\n\n` : '';

  if (agentMode) {
    const prompt =
      `${marker}You are working autonomously on a bug fix in the ` +
      `${task.repo} repository. A GitHub issue is reproduced below. ` +
      `Your task: investigate the codebase, identify the root cause, ` +
      `and edit the relevant files to fix it.\n\n` +
      `You have full permission to read, grep, and edit any file in ` +
      `the repo. Stop when you believe the fix is complete. Do not ` +
      `ask for confirmation — proceed autonomously.\n\n` +
      `=== ISSUE ===\n${problem}\n=== END ISSUE ===`;
    return [prompt];
  }

  const first =
    `${marker}I'm investigating an issue in the ${task.repo} codebase. ` +
    `Read it, explore the relevant code, and tell me where in this ` +
    `codebase the bug most likely lives. Don't propose a fix in this turn.\n\n` +
    `=== ISSUE ===\n${problem}\n=== END ISSUE ===`;
  return [first, ...FOLLOWUP_PROMPTS];
}
