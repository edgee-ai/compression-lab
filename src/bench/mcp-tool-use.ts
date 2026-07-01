// Extract `tool_use` names from Claude Code session JSONLs.
//
// The MCP bench needs to know which tools claude actually invoked per session
// (for the safety audit and the "TSR resolution overhead" report section).
// This module is intentionally separate from claude-jsonl.ts — that one
// extracts token-usage; this one extracts tool-use names. Different concern,
// different shape.

import { readFile } from 'node:fs/promises';
import fastGlob from 'fast-glob';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { encodeCwd } from './claude-jsonl.js';
import { readdir, stat } from 'node:fs/promises';

export interface ToolUseCount {
  name: string;
  count: number;
}

/**
 * Walk every assistant message's content array for `tool_use` blocks.
 * Return per-name call counts. Pure, no I/O — useful for unit testing.
 *
 * Deduplication by `message.id`: Claude Code logs each assistant message
 * twice (mid-stream + finalized), so without dedup we'd double-count every
 * tool call. We use the same Map-by-id pattern as claude-jsonl.ts, but
 * each id contributes its OWN tool_use blocks once.
 */
export function extractToolUses(jsonlText: string): ToolUseCount[] {
  // First pass: walk lines, build a map from message.id → array of tool_use
  // names that appear in THAT message. Replace on subsequent appearances of
  // the same id (matches the keep-latest-version semantics of the token
  // dedup; for tool_use blocks both copies should match anyway).
  const byMessageId = new Map<string, string[]>();

  for (const rawLine of jsonlText.split('\n')) {
    const s = rawLine.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    if ((obj as { type?: unknown }).type !== 'assistant') continue;
    const msg = (obj as { message?: unknown }).message;
    if (typeof msg !== 'object' || msg === null) continue;
    const mid = (msg as { id?: unknown }).id;
    const content = (msg as { content?: unknown }).content;
    if (typeof mid !== 'string' || !Array.isArray(content)) continue;

    const names: string[] = [];
    for (const block of content) {
      if (
        typeof block !== 'object' ||
        block === null ||
        (block as { type?: unknown }).type !== 'tool_use'
      ) {
        continue;
      }
      const name = (block as { name?: unknown }).name;
      if (typeof name === 'string') names.push(name);
    }
    // Always replace — Claude Code's two log entries for the same message id
    // contain the same content blocks, so this is idempotent.
    byMessageId.set(mid, names);
  }

  // Accumulate.
  const counts = new Map<string, number>();
  for (const names of byMessageId.values()) {
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

/**
 * Look up the JSONL for a session_id under `~/.claude/projects/` and extract
 * its tool-use counts. Mirrors claude-jsonl.ts's locateJsonl/parseSessionTurns
 * pattern. Returns [] if the file can't be found.
 */
export async function extractToolUsesForSession(
  cwd: string,
  sessionId: string,
): Promise<ToolUseCount[]> {
  const jsonlPath = await locateJsonl(cwd, sessionId);
  if (jsonlPath === null) return [];
  try {
    const text = await readFile(jsonlPath, 'utf8');
    return extractToolUses(text);
  } catch {
    return [];
  }
}

async function locateJsonl(cwd: string, sessionId: string): Promise<string | null> {
  // Primary: glob across all project dirs.
  const matches = await fastGlob(`${PROJECTS_DIR}/*/${sessionId}.jsonl`, {
    onlyFiles: true,
    suppressErrors: true,
  });
  if (matches.length > 0) return matches[0];

  // Fallback: encoded-cwd directory, newest-mtime jsonl.
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
