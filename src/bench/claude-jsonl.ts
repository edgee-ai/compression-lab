// Claude Code session JSONL parser.
//
// Reads `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`, dedups
// assistant messages by `message.id`, sums per-API-call token usage.
// Port of bench_tokens.py lines 448-554 (`parse_session_turns`,
// `parse_session_usage`).
//
// Critical correctness invariants (gated by test/fixtures/sessions/):
//   1. Dedup-by-id rule: when two records share `message.id`, KEEP the entry
//      with the HIGHER `output_tokens`. Claude Code logs each assistant
//      message twice (mid-stream + finalized); the second has higher output.
//   2. Insertion order: when a dedup happens, the entry's POSITION in the
//      returned array does NOT change. This matches Python's separate
//      `order` list approach (lines 488-495).
//   3. Lookup: prefer `~/.claude/projects/*/<sid>.jsonl` glob; if that
//      misses, fall back to the encoded-cwd directory's newest-mtime jsonl.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fastGlob from 'fast-glob';
import { PROJECTS_DIR } from './config.js';
import { Turn, UsageDict } from './types.js';
import { aggregateTurns, zeroUsage } from './usage.js';

/** Slash → dash, underscore → dash. Matches Claude Code's project-dir naming. */
export function encodeCwd(cwd: string): string {
  return path.resolve(cwd).replace(/\//g, '-').replace(/_/g, '-');
}

/**
 * Find the JSONL file for a given session_id. Prefers the glob path; falls
 * back to the encoded-cwd directory's newest-mtime *.jsonl. Returns null if
 * neither yields a hit.
 */
async function locateJsonl(cwd: string, sessionId: string): Promise<string | null> {
  // Primary: glob across all project dirs. This is what the bench used for
  // the post-Ctrl+C robust-lookup path (and matches Python's preferred path
  // at bench_tokens.py lines 461-463).
  const matches = await fastGlob(`${PROJECTS_DIR}/*/${sessionId}.jsonl`, {
    onlyFiles: true,
    suppressErrors: true,
  });
  if (matches.length > 0) return matches[0];

  // Fallback: look in the encoded-cwd directory for the newest .jsonl.
  const projectDir = path.join(PROJECTS_DIR, encodeCwd(cwd));
  let dirents: string[];
  try {
    dirents = await readdir(projectDir);
  } catch {
    return null;
  }
  const candidates = await Promise.all(
    dirents
      .filter(n => n.endsWith('.jsonl'))
      .map(async n => {
        const p = path.join(projectDir, n);
        try {
          const s = await stat(p);
          return { path: p, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const valid = candidates.filter((x): x is { path: string; mtimeMs: number } => x !== null);
  if (valid.length === 0) return null;
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return valid[0].path;
}

/**
 * Parse a single JSONL file into per-call `Turn[]`, deduped by message id.
 * Exported for fixture tests; production code calls `parseSessionTurns`
 * instead (which handles the `~/.claude/projects/` lookup first).
 *
 * Mirrors bench_tokens.py `parse_session_turns` (lines 468-496) exactly.
 * The returned array preserves first-seen insertion order; on a
 * higher-output replacement the position does NOT change (Map.set on an
 * existing key keeps its original slot in JS, matching Python's separate
 * `order` list).
 */
export async function parseJsonlFile(jsonlPath: string): Promise<Turn[]> {
  let text: string;
  try {
    text = await readFile(jsonlPath, 'utf8');
  } catch {
    return [];
  }
  return parseJsonlText(text);
}

/**
 * Parse JSONL text content into per-call `Turn[]`. Pure function — no I/O.
 * Useful for in-memory tests and for the captured-fixture round-trip.
 */
export function parseJsonlText(text: string): Turn[] {
  // Match Python's `read_text().splitlines()` eager-read pattern. Files are
  // <50MB in the worst case, so memory is fine and we avoid streaming edge
  // cases. `split('\n')` mirrors Python's behavior for Claude Code's
  // plain-`\n`-terminated JSONL (no CRLF, no BOM).
  const lines = text.split('\n');

  // Ordered Map keyed by message.id. Map.set on an existing key keeps the
  // original insertion position (load-bearing for the order-preservation
  // invariant — see test/fixtures/sessions/MANIFEST.json).
  const byId = new Map<string, Turn>();

  for (const rawLine of lines) {
    const s = rawLine.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      // Match Python's `except JSONDecodeError: continue` (line 478).
      continue;
    }
    if (
      typeof obj !== 'object' ||
      obj === null ||
      (obj as { type?: unknown }).type !== 'assistant'
    ) {
      continue;
    }
    const msg = (obj as { message?: unknown }).message;
    if (typeof msg !== 'object' || msg === null) continue;
    const mid = (msg as { id?: unknown }).id;
    const usage = (msg as { usage?: unknown }).usage;
    if (typeof mid !== 'string' || typeof usage !== 'object' || usage === null) continue;

    const u = usage as Record<string, unknown>;
    const entry: Turn = {
      input: numberOrZero(u.input_tokens),
      cache_read: numberOrZero(u.cache_read_input_tokens),
      cache_create: numberOrZero(u.cache_creation_input_tokens),
      output: numberOrZero(u.output_tokens),
    };

    const existing = byId.get(mid);
    if (existing === undefined || entry.output > existing.output) {
      byId.set(mid, entry);
    }
  }

  // Map.values() preserves first-insertion order. This matches Python's
  // `[by_id[mid] for mid in order]` (line 496) byte-for-byte.
  return Array.from(byId.values());
}

/**
 * Look up the JSONL for a session_id under `~/.claude/projects/` and parse.
 * Production entry point — bench-swe.ts calls this after each session ends.
 */
export async function parseSessionTurns(cwd: string, sessionId: string): Promise<Turn[]> {
  const jsonlPath = await locateJsonl(cwd, sessionId);
  if (jsonlPath === null) return [];
  return parseJsonlFile(jsonlPath);
}

/** Convenience: parse then aggregate. Mirrors Python's `parse_session_usage`. */
export async function parseSessionUsage(cwd: string, sessionId: string): Promise<UsageDict> {
  const turns = await parseSessionTurns(cwd, sessionId);
  if (turns.length === 0) return zeroUsage();
  return aggregateTurns(turns);
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
