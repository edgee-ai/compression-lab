// Shared type definitions for the SWE-bench port.
//
// `UsageDict` and `Turn` use snake_case keys to match the JSONL emitted by
// Anthropic's API and the on-disk fixtures captured from the Python bench at
// /Users/kham/Documents/code/benchmarks/cache/bench_tokens.py. Do not
// rename — the parser tests diff TS output against Python-produced expected
// JSON byte-for-byte.

export type BackendName = 'vanilla' | 'edgee';

/** One assistant API call's token usage, deduped by message id. */
export interface Turn {
  input: number;
  cache_read: number;
  cache_create: number;
  output: number;
}

/** Per-(task,backend) aggregate: `calls` is the count of unique assistant ids. */
export interface UsageDict extends Turn {
  calls: number;
}

/** SWE-bench Lite test split row (subset of fields we use). */
export interface Task {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch?: string;
  test_patch?: string;
  hints_text?: string;
  version?: string;
  created_at?: string;
  FAIL_TO_PASS?: string;
  PASS_TO_PASS?: string;
  environment_setup_commit?: string;
}

/** Output of `runStreamSession` — everything we collected from one process. */
export interface StreamSessionResult {
  sessionId: string;
  /** All `type: "result"` events received from the stream (one per prompt turn). */
  resultEvents: Record<string, unknown>[];
  /** Last 10 non-JSON output lines (each truncated to 240 chars) — diagnostics. */
  rawTail: string[];
}

/** Per-(task,backend,replicate) recorded outcome. */
export interface RunResult {
  sessionId: string | null;
  usage: UsageDict;
  turns: Turn[];
  resultEvents: Record<string, unknown>[];
  rawTail: string[];
  /** Path to the captured `git diff` file, if AGENT_MODE was active. */
  diffPath: string | null;
}

/** `results[task_id][backend_name] = list of RunResult (one per replicate)`. */
export type TaskResults = Record<string, Record<string, RunResult[]>>;
