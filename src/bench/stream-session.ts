// Subprocess driver for spawning `claude` / `edgee launch claude` and
// exchanging stream-json messages.
//
// Port of bench_tokens.py `run_stream_session` (lines 319-445). The Python
// version uses asymmetric I/O: a `subprocess.PIPE` for child stdin and a
// `pty.openpty()` pair for stdout+stderr (PTY-for-output was needed because
// edgee historically refused to start without a TTY; pipe-for-input was
// needed because Claude Code's `--input-format stream-json` parser bails out
// if it detects a TTY on stdin).
//
// Node's std lib doesn't expose `openpty()`, and `node-pty`'s API is full-
// duplex only (PTY for stdin too — which breaks the stream-json input). We
// therefore use `child_process.spawn` with all-pipe stdio. The strict
// "edgee requires TTY" check appears to no longer apply on current edgee
// builds (this is verified by the smoke test); if a future regression
// brings it back, we'll need a native openpty addon to restore the
// asymmetric setup.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { StreamSessionResult } from './types.js';

export interface RunStreamSessionOptions {
  /** argv0 + args for the backend. May start with `env VAR=val …`. */
  cmd: string[];
  /** Working directory the backend will see. */
  cwd: string;
  /** User prompts to feed, in order. In agent mode this is length 1. */
  prompts: string[];
  /** Per-turn deadline in seconds. */
  perTurnTimeoutS: number;
  /** Pre-first-prompt sleep (for MCP cold-start grace). */
  warmupS: number;
  /** Optional callback for "turn 1/N: …" style progress lines. */
  onTurnStart?: (turnIdx: number, totalTurns: number, prompt: string) => void;
}

const RAW_TAIL_MAX = 10;
const RAW_TAIL_LINE_CAP = 240;

/**
 * Strip a leading `env VAR=val …` prefix from `cmd`. Idempotent for cmds
 * without an `env` prefix. Exported for unit testing.
 */
export function parseCmdAndEnv(cmd: string[]): {
  executable: string;
  args: string[];
  envOverride: NodeJS.ProcessEnv;
} {
  if (cmd.length === 0) {
    throw new Error('parseCmdAndEnv: empty cmd');
  }
  if (cmd[0] !== 'env') {
    return { executable: cmd[0], args: cmd.slice(1), envOverride: {} };
  }
  const envOverride: NodeJS.ProcessEnv = {};
  let i = 1;
  while (i < cmd.length && cmd[i].includes('=')) {
    const eq = cmd[i].indexOf('=');
    const key = cmd[i].slice(0, eq);
    const value = cmd[i].slice(eq + 1);
    envOverride[key] = value;
    i++;
  }
  if (i >= cmd.length) {
    throw new Error(`parseCmdAndEnv: 'env' prefix with no executable: ${JSON.stringify(cmd)}`);
  }
  return {
    executable: cmd[i],
    args: cmd.slice(i + 1),
    envOverride,
  };
}

/**
 * Spawn the backend, feed each prompt as a stream-json line, wait for the
 * matching `result` event (per turn), and collect everything for the caller.
 *
 * Always returns; on subprocess crash or per-turn timeout the result
 * contains whatever was collected so far. The caller's
 * `parseSessionTurns(cwd, sid)` will read the Claude-Code-written JSONL to
 * recover the per-call usage.
 */
export async function runStreamSession(opts: RunStreamSessionOptions): Promise<StreamSessionResult> {
  const sessionId = randomUUID();
  const { executable, args: cmdArgs, envOverride } = parseCmdAndEnv(opts.cmd);

  const fullArgs = [
    ...cmdArgs,
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--add-dir', opts.cwd,
    '--session-id', sessionId,
  ];

  const proc = spawn(executable, fullArgs, {
    cwd: opts.cwd,
    env: { ...process.env, ...envOverride },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const resultEvents: Record<string, unknown>[] = [];
  const rawTail: string[] = [];
  let outBuffer = '';
  let dataResolver: ((chunk: string) => void) | null = null;
  let exited = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  // Merge stdout + stderr into one stream (matches Python's PTY-shared FD).
  const onChunk = (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    outBuffer += s;
    if (dataResolver !== null) {
      const r = dataResolver;
      dataResolver = null;
      r(s);
    }
  };
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk);
  proc.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    if (dataResolver !== null) {
      const r = dataResolver;
      dataResolver = null;
      r('');
    }
  });
  // Swallow EPIPE on stdin so a child that closes early doesn't kill us.
  proc.stdin?.on('error', () => {
    /* ignore */
  });

  function consumeBuffer(): { sawResult: boolean } {
    let sawResult = false;
    while (true) {
      const nl = outBuffer.indexOf('\n');
      if (nl < 0) break;
      const line = outBuffer.slice(0, nl);
      outBuffer = outBuffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) {
        rawTail.push(trimmed.length > RAW_TAIL_LINE_CAP ? trimmed.slice(0, RAW_TAIL_LINE_CAP) : trimmed);
        if (rawTail.length > RAW_TAIL_MAX) rawTail.shift();
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        rawTail.push(trimmed.length > RAW_TAIL_LINE_CAP ? trimmed.slice(0, RAW_TAIL_LINE_CAP) : trimmed);
        if (rawTail.length > RAW_TAIL_MAX) rawTail.shift();
        continue;
      }
      if (parsed.type === 'result') {
        resultEvents.push(parsed);
        sawResult = true;
      }
    }
    return { sawResult };
  }

  async function waitForResult(timeoutS: number): Promise<boolean> {
    const deadline = Date.now() + timeoutS * 1000;
    if (consumeBuffer().sawResult) return true;
    while (!exited && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      // Race between the next chunk, an exit, and a 1-second tick (so we
      // can re-check exit + deadline). Mirrors Python's
      // `select.select(..., min(remaining, 1.0))` polling pattern.
      const chunk = await Promise.race([
        new Promise<string>(res => {
          dataResolver = res;
        }),
        sleep(Math.min(remaining, 1000), '__tick__'),
      ]);
      if (chunk === '__tick__') continue;
      if (consumeBuffer().sawResult) return true;
    }
    return consumeBuffer().sawResult;
  }

  try {
    if (opts.warmupS > 0) {
      await sleep(opts.warmupS * 1000);
    }
    for (let i = 0; i < opts.prompts.length; i++) {
      opts.onTurnStart?.(i + 1, opts.prompts.length, opts.prompts[i]);
      const payload =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: opts.prompts[i] },
        }) + '\n';
      // child_process.spawn returns Writable for stdin; write returns false
      // on backpressure but data is still queued.
      try {
        proc.stdin?.write(payload);
      } catch {
        // pipe broken — child exited early; bail and let the diagnostics
        // surface in the caller.
        break;
      }
      const finished = await waitForResult(opts.perTurnTimeoutS);
      if (!finished) break;
    }
    // Close stdin so Claude knows we're done sending prompts. Some
    // versions of Claude Code wait for EOF before exiting cleanly.
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    // Give the child a grace period to flush before we kill it.
    const flushDeadline = Date.now() + 30_000;
    while (!exited && Date.now() < flushDeadline) {
      await sleep(50);
    }
  } finally {
    if (!exited) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const killDeadline = Date.now() + 5000;
      while (!exited && Date.now() < killDeadline) {
        await sleep(50);
      }
      if (!exited) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Final drain in case the child wrote after our last consume + exit.
  consumeBuffer();
  void exitInfo; // referenced for future diagnostic surfacing

  return { sessionId, resultEvents, rawTail };
}
