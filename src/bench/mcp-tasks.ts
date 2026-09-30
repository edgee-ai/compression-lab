// Synthetic Linear + Notion read-only task list for the MCP bench.
//
// Each task is a short, fully-read-only prompt with a clear stopping
// condition. Output is naturally bounded (we ask for "brief summary" /
// "first N items" / "list 5") so cost stays predictable.
//
// Categories — covered by the list below:
//   - Linear-only: list and get queries within Linear
//   - Notion-only: search and fetch queries within Notion (Notion-only tasks
//     are present but will no-op cleanly if Notion isn't authenticated yet —
//     vanilla will say "I don't have access" rather than calling a write).
//   - Cross-server: tasks that legitimately need BOTH servers in a single
//     session, stressing the TSR's resolution-hop behavior across servers.
//
// SAFETY: every prompt is phrased so claude never has reason to write
// anything. We also enforce this defensively via `--allowedTools` (only
// read-only names whitelisted) and the post-run JSONL audit. See
// mcp-safety.ts.

export interface McpTask {
  /** Slugified ID — used in report filenames and per-task tables. */
  id: string;
  /** Verbatim user prompt sent to claude. */
  prompt: string;
  /** One-line rationale for why this task exists. Rendered in the report's
   *  "Task definitions" appendix so future readers know what was measured. */
  rationale: string;
}

export const MCP_TASKS: McpTask[] = [
  // ──── Cross-server kitchen sink ────────────────────────────────────────
  // Single dense task hitting both servers with ~10+ MCP calls. Designed
  // to be replicated many times (with SHUFFLE=1) for a tight signal:
  // between-task variance disappears, and TSR's prefix-savings amortize
  // over a larger call count.
  //
  // Use: MCP_TASK_LIMIT=1 REPLICATES=N npm run bench:mcp:stats
  {
    id: 'cross-status-report',
    prompt:
      "Give me a brief cross-system status report combining Linear and Notion data.\n\n" +
      "1. From Linear: list the 3 most recently updated projects. For each, give me " +
      "name, status, lead, and the count of currently open issues (use the project's " +
      "own metadata if available; otherwise a single filtered list call per project).\n\n" +
      "2. For each of those 3 projects: search Notion for pages whose title contains " +
      "the project name. List up to 1 matching page per project (title + last-edited " +
      "date only). If no match, say so.\n\n" +
      "3. End with a 2-sentence summary: which project has the most open issues, and " +
      "which has the most recent Notion activity.\n\n" +
      "Keep responses tight — no extra commentary, just structured output.",
    rationale:
      'Dense cross-server task forcing ~10+ MCP calls in one session (list_projects, per-project gets, per-project notion searches). The "kitchen sink" of MCP workloads — best signal for TSR when run with high REPLICATES.',
  },
  // ──── Linear-only ──────────────────────────────────────────────────────
  {
    id: 'linear-recent-issues',
    prompt:
      "List the 5 most recently updated issues across all teams in Linear. " +
      "For each, just give me: ID, title, state, and assignee (if any). " +
      "Keep it brief — no extra commentary.",
    rationale:
      'Light Linear-only task: typically 1-2 list_issues calls. Baseline for what a small MCP session costs.',
  },
  {
    id: 'linear-team-overview',
    prompt:
      "Tell me about the teams in our Linear workspace. " +
      "For each team, give me the name, key, and member count. " +
      "Just facts, no recommendations.",
    rationale:
      'Multi-step Linear-only: list_teams then get_team / list_users per team. Tests how TSR handles the per-team get round.',
  },
  {
    id: 'linear-project-summary',
    prompt:
      "Pick the most recently active Linear project and summarize its current state: " +
      "name, status, lead, and the count of open vs. completed issues. " +
      "Don't actually count issues one-by-one — use the project's own metadata if it's available, " +
      "otherwise rough numbers from a single list call.",
    rationale:
      'Linear-only task that requires reasoning about which tools to call (list_projects, get_project, maybe list_issues with a filter).',
  },

  // ──── Notion-only (active once Notion is authenticated) ────────────────
  {
    id: 'notion-search-compression',
    prompt:
      "Search our Notion workspace for pages mentioning 'compression'. " +
      "List the top 5 results by title and last-edited date. Brief summary only.",
    rationale:
      'Notion-only search query. Exercises the Notion MCP search tool.',
  },
  {
    id: 'notion-page-fetch',
    prompt:
      "Find a Notion page whose title contains 'roadmap' (case-insensitive). " +
      "If you find one, give me a 3-bullet summary of its content. " +
      "If you don't find any, just say so.",
    rationale:
      'Notion search then page-fetch (read content). Tests the search → fetch handoff.',
  },

  // ──── Cross-server (Linear + Notion together) ──────────────────────────
  {
    id: 'cross-linear-notion-bench',
    prompt:
      "Find any Linear issues OR Notion pages that mention 'bench' in their title. " +
      "For each result, give me a one-line summary including which system it's from. " +
      "Limit to the first 5 results across both systems.",
    rationale:
      'Cross-server query. With TSR, claude has to use search_tool twice (once to find Linear search, once to find Notion search), then call each. Best measurement of TSR resolution overhead.',
  },
  {
    id: 'cross-linear-issue-with-notion-context',
    prompt:
      "Get the details of the most recently updated Linear issue. " +
      "Then search Notion for any documents related to its topic and list up to 3 matches. " +
      "Brief summary of both parts at the end.",
    rationale:
      'Mixed query: Linear fetch + Notion search in one session. Realistic of how teams use Claude+MCP.',
  },
];

/** Slice the task list to the first N (TASK_LIMIT semantics, mirrors SWE-bench). */
export function selectTasks(limit: number): McpTask[] {
  return limit > 0 && limit < MCP_TASKS.length ? MCP_TASKS.slice(0, limit) : MCP_TASKS.slice();
}
