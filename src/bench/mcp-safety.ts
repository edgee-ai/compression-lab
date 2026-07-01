// Safety enforcement for the MCP bench.
//
// The MCP bench (bench-mcp.ts) runs synthetic queries against read-only Linear
// + Notion MCP servers. We never want to write anything (no created issues, no
// edited Notion pages, etc.). Defense in depth:
//
//   1. --allowedTools on the child process whitelists only the read-only tool
//      names — non-whitelisted tools are HIDDEN from the prefix (Claude
//      literally cannot call them).
//   2. After each session, we ALSO scan the JSONL for any tool_use whose name
//      matches a write pattern. If anything matches, the bench fails loudly
//      and exits non-zero. This catches future tool renames or any way an
//      unexpected write call slips through.
//
// Phase 2 future: when MCP queries are interleaved with SWE-bench tasks, the
// same audit module gates that too.

import { BackendName } from './types.js';

/**
 * Regex patterns that identify destructive / mutating MCP tools. ANY match
 * fails the safety audit. Patterns target the prefix-after-server-name so
 * they catch tools across all MCP servers (Linear, Notion, Slack, …).
 *
 * Examples that should match:
 *   mcp__linear__save_issue
 *   mcp__linear__create_attachment
 *   mcp__linear__delete_comment
 *   mcp__claude_ai_Notion__update_page  (if it exists)
 *   mcp__claude_ai_Slack__send_message  (defensive)
 *
 * Examples that should NOT match:
 *   mcp__linear__list_issues
 *   mcp__linear__get_issue
 *   mcp__linear__search_documentation
 *   Read, Bash, Edit  (native tools — never flagged)
 */
export const WRITE_TOOL_PATTERNS: readonly RegExp[] = [
  /^mcp__.*__save_/,
  /^mcp__.*__create_/,
  /^mcp__.*__delete_/,
  /^mcp__.*__update_/,
  /^mcp__.*__add_/,
  /^mcp__.*__extract_/, // catches extract_images (uploads content)
  /^mcp__.*__prepare_/, // catches prepare_attachment_upload
  /^mcp__.*__send_/, // defensive — Slack/Gmail send-message style
  /^mcp__.*__post_/, // defensive
  /^mcp__.*__upload_/, // defensive
];

/** True iff the given tool name matches any write pattern. */
export function isWriteTool(name: string): boolean {
  for (const re of WRITE_TOOL_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

/**
 * Read-only Linear MCP tool names. Whitelisted on both backends via
 * --allowedTools so non-listed tools are HIDDEN from the prefix.
 *
 * Source: enumerated from the Anthropic claude.ai MCP catalog by the
 * tool_inventory probe. 25 tools (12 list_*, 12 get_*, 1 search_*).
 */
export const LINEAR_READ_TOOLS: readonly string[] = [
  'mcp__linear__list_comments',
  'mcp__linear__list_cycles',
  'mcp__linear__list_diffs',
  'mcp__linear__list_documents',
  'mcp__linear__list_initiatives',
  'mcp__linear__list_issue_labels',
  'mcp__linear__list_issue_statuses',
  'mcp__linear__list_issues',
  'mcp__linear__list_milestones',
  'mcp__linear__list_projects',
  'mcp__linear__list_teams',
  'mcp__linear__list_users',
  'mcp__linear__get_attachment',
  'mcp__linear__get_diff',
  'mcp__linear__get_diff_threads',
  'mcp__linear__get_document',
  'mcp__linear__get_initiative',
  'mcp__linear__get_issue',
  'mcp__linear__get_issue_status',
  'mcp__linear__get_milestone',
  'mcp__linear__get_project',
  'mcp__linear__get_status_updates',
  'mcp__linear__get_team',
  'mcp__linear__get_user',
  'mcp__linear__search_documentation',
];

/**
 * Read-only Notion MCP tool names exposed by Notion's hosted MCP server
 * (mcp.notion.com). Best-guess list — if any actual tool name diverges,
 * the audit's WRITE_TOOL_PATTERNS still catch every write tool by regex,
 * so the worst case is "claude can't call a read tool we forgot to list"
 * (safe failure: Notion task no-ops, no data leak).
 *
 * To verify/refresh: open `/mcp` in an interactive claude session with the
 * Notion server connected, inspect the actual exposed tool names, and adjust.
 */
export const NOTION_READ_TOOLS: readonly string[] = [
  'mcp__notion__search',
  'mcp__notion__fetch',
  'mcp__notion__get_self',
  'mcp__notion__get_user',
  'mcp__notion__get_users',
];

/** Flat list of all read-only MCP tools, ready to splat into --allowedTools. */
export function allReadOnlyMcpTools(): string[] {
  return [...LINEAR_READ_TOOLS, ...NOTION_READ_TOOLS];
}

/** Comma-separated form for the --allowedTools CLI flag. */
export function allowedToolsFlag(): string {
  return allReadOnlyMcpTools().join(',');
}

// ──────── Audit ──────────────────────────────────────────────────────────

export interface SafetyAuditEntry {
  sessionId: string | null;
  taskId: string;
  backend: BackendName;
  replicate: number;
  totalMcpCalls: number;
  writeCalls: string[]; // empty array = session was clean
}

export interface ToolUseCount {
  name: string;
  count: number;
}

/**
 * Audit one session's tool-use list. Returns an entry capturing how many MCP
 * calls happened and whether any write-pattern names showed up.
 */
export function auditSession(
  toolUses: readonly ToolUseCount[],
  meta: {
    sessionId: string | null;
    taskId: string;
    backend: BackendName;
    replicate: number;
  },
): SafetyAuditEntry {
  let totalMcp = 0;
  const writeCalls: string[] = [];
  for (const t of toolUses) {
    if (!t.name.startsWith('mcp__')) continue;
    totalMcp += t.count;
    if (isWriteTool(t.name)) {
      // Record each write tool by name (with count for reporting fidelity).
      for (let i = 0; i < t.count; i++) writeCalls.push(t.name);
    }
  }
  return {
    sessionId: meta.sessionId,
    taskId: meta.taskId,
    backend: meta.backend,
    replicate: meta.replicate,
    totalMcpCalls: totalMcp,
    writeCalls,
  };
}

/**
 * Bench-level guard. Throws if ANY session recorded a write-tool call. Called
 * once after the main run loop completes. The bench's caller decides whether
 * to write the report before re-raising (we write the report so the failure
 * is preserved on disk, then exit non-zero).
 */
export class WriteToolDetectedError extends Error {
  constructor(public readonly offenders: SafetyAuditEntry[]) {
    const summary = offenders
      .map(
        e =>
          `  ${e.taskId} / ${e.backend} / rep ${e.replicate}: ${e.writeCalls.join(', ')}`,
      )
      .join('\n');
    super(
      `Safety audit failed: ${offenders.length} session(s) made write-tool calls.\n${summary}`,
    );
    this.name = 'WriteToolDetectedError';
  }
}

export function assertAllSessionsClean(entries: readonly SafetyAuditEntry[]): void {
  const offenders = entries.filter(e => e.writeCalls.length > 0);
  if (offenders.length > 0) throw new WriteToolDetectedError(offenders);
}
