# compression-lab

Benchmarks for measuring the cost and token impact of the [edgee](https://edgee.ai) gateway's compression strategies against vanilla Claude Code.

The repository ships **two complementary benchmarks** that solve different problems: an interactive **manual bench** for exploratory scenario comparisons, and an automated **statistical bench** for replicate-driven paired A/B measurements. Both live side by side and share the same underlying primitives.

---

## Which bench should I use?

| | **Manual bench** | **Statistical bench** |
|---|---|---|
| **Best for** | Exploratory investigation, ad-hoc scenario comparison, running each scenario by hand | Automated A/B measurement with proper paired statistics |
| **Trigger** | `./run.sh <agent> <scenario>` | `npm run bench:swe` / `npm run bench:mcp` |
| **Interaction model** | Human pastes instructions one at a time into a live Claude/Codex session | Fully automated — the bench drives the child process |
| **Scenarios / backends** | `normal`, `edgee`, `rtk` (three-way) | `vanilla` vs `edgee` (paired A/B) |
| **Statistics** | Aggregated totals + LLM-generated commentary | Paired sign test, bootstrap CIs, within-task CV |
| **Output** | `report-<ISO>.{md,json}` at repo root | `reports/{swe,mcp}-<ISO>--<tags>.{md,json}` |
| **Effort per run** | ~30 min of interactive work | Hands-off; hours-long agent runs possible |

Both benches are fully supported. Pick the one that matches the shape of your question.

---

## Quick start

### Manual bench

```sh
npm install

# One-time — create two edgee profiles for the scenarios you want
edgee auth login -p normal
edgee auth login -p edgee

# Start an interactive session
./run.sh claude edgee

# Paste instructions from instructions.md one at a time
# When done, aggregate:
npm run analyze
```

### Statistical bench

```sh
npm install
npm test                                # sanity-check the pipeline

# Run a small SWE-bench Lite smoke (agent-mode, 6 frozen tasks, 1 replicate)
npm run bench:swe

# Or a small MCP smoke (requires mcp-bench.json — see below)
MCP_BENCH_CONFIG=./mcp-bench.json MCP_TASK_LIMIT=1 REPLICATES=1 npm run bench:mcp

# Report is in reports/
open reports/swe-*.md
```

---

## Prerequisites

### Shared

- Node.js ≥ 18 (statistical bench recommends ≥ 20)
- `npm install` — installs both benches' dependencies in one shot
- [`edgee`](https://edgee.ai) CLI on `PATH`, or set `EDGEE_BIN` explicitly
- [`claude`](https://claude.com/claude-code) CLI on `PATH`

### Manual bench only

- **RTK (Rust Token Killer)** — required for the `rtk` scenario; see <https://github.com/rtk-ai/rtk>
- Multi-profile edgee login (one profile per scenario you want to compare)
- `.env` at the repo root with `EDGEE_API_TOKEN_REPORT=<token>` if you want the LLM-generated analysis at the end

### Statistical bench only

- A `mcp-bench.json` at the repo root if you want to run `bench:mcp` (see [MCP setup](#mcp-setup))
- The system `edgee` binary usually gives cleaner results than the local debug build; set `EDGEE_BIN=/Users/$USER/.local/bin/edgee` to force it

---

## Path A — Manual interactive bench

### Overview

The manual bench works in two phases:

1. **Run** — Launch isolated coding-agent sessions that complete a fixed set of coding instructions. Each session runs in one of three *scenarios* (compression strategies).
2. **Analyse** — Read the generated session artefacts and produce a cost report.

### A.1 Environment setup

First, create an empty `.edgee/credentials.toml` file at the root of this project so you can use multiple edgee profiles. Then create Edgee accounts for the scenarios you'll compare — one for the `normal` scenario (no compression), one for `edgee` (compression enabled), optionally one for `rtk`.

Log in each profile:

```sh
edgee auth login -p normal
edgee auth login -p edgee
edgee auth login -p rtk       # optional, only if you'll use the rtk scenario
```

For LLM-generated report analysis, set in `.env`:

```env
EDGEE_API_TOKEN_REPORT=<your-token-to-generate-reports>
```

### A.2 Running a session

```sh
./run.sh <agent> <scenario>
```

**Agents:**

| Agent | Description |
|---|---|
| `claude` | Claude Code |
| `codex`  | OpenAI Codex |

**Scenarios:**

| Scenario | Description |
|---|---|
| `normal` | Baseline — requests go through Edgee AI Gateway with no compression |
| `edgee`  | Edgee token compressor enabled; input tokens reduced before forwarding to Anthropic |
| `rtk`    | RTK (Rust Token Killer) is enabled as a local bash proxy; the agent's bash tool calls go through RTK before hitting the gateway |

Each `./run.sh` invocation:

1. Copies the `cli/` source directory into a fresh `_<agent>-<scenario>-<random>/` folder
2. Creates an isolated Claude/Codex config directory inside it
3. Launches the agent with `--dangerously-skip-permissions` (or equivalent)

Example:

```sh
./run.sh claude edgee
```

Creates `_claude-edgee-4a2f8c1d/` and starts a Claude session inside it.

### A.3 What to do inside the coding-agent session

Once the agent starts, put it in **plan mode**, then paste the coding instructions **one at a time** from [`instructions.md`](./instructions.md). For each instruction:

1. Paste the instruction
2. Let the agent produce a plan
3. Approve the plan and let it execute
4. Move on to the next instruction

### A.4 Analysing results

**Standard analysis** (one report across all completed sessions in the repo):

```sh
npm run analyze
```

Reads all `_<agent>-<scenario>-*` session directories that contain `session-stats.json` (excluding `-full` ones), aggregates token and cost metrics by agent + scenario, then calls the Edgee LLM API to produce an AI-written analysis. Outputs `report-<ISO>.{json,md}` at the repo root.

**Endurance analysis** (long-session runs with per-instruction progression):

```sh
npm run analyze-full
```

Reads all `_<agent>-<scenario>-*-full` session directories; uses `session-stats.json` for token/cost totals and `claude-pro-usage.json` for per-instruction endurance progression. Outputs `report-full-<ISO>.{json,md}`.

### A.5 Output locations

Legacy outputs are all gitignored: `report-*.{json,md}` at the repo root, `simulation-*`, `claude-pro-usage.json`, and the `_<agent>-<scenario>-*/` session directories themselves.

Historical `battle-report-*.md` and `endurance-report-*.md` files in `reports/` are checked in for reference — they capture the state of earlier campaigns.

---

## Path B — Automated statistical bench

### Overview

The statistical bench drives Claude Code (and Claude Code routed through the edgee gateway) automatically across a fixed workload with controlled replicates, and applies paired statistics to the results. It's the right tool for defensible A/B claims.

Two workloads are shipped:

- **`bench:swe`** — autonomous coding tasks from [SWE-bench Lite](https://www.swebench.com). Measures brevity, tool-result trimming, and any strategy that touches output or system-prompt-level compression.
- **`bench:mcp`** — read-only Linear + Notion queries through MCP servers. Measures tool-surface-reduction and any strategy that targets MCP-catalog prefix bloat.

### B.1 Running

```sh
# SWE-bench
npm run bench:swe            # scripted mode (3 prompts per task, lighter)
npm run bench:swe:agent      # agent mode (single autonomy prompt)
npm run bench:swe:stats      # REPLICATES=3 SHUFFLE=1 — statistics-grade

# MCP (requires mcp-bench.json)
MCP_BENCH_CONFIG=./mcp-bench.json npm run bench:mcp
MCP_BENCH_CONFIG=./mcp-bench.json npm run bench:mcp:stats
```

### B.2 Configuration

The statistical bench is env-var-driven. Values are frozen at startup and printed in each report's Configuration block for reproducibility.

**Shared:**

| Env var | Default | Purpose |
|---|---|---|
| `REPLICATES` | `1` | Replicates per (task, backend). `> 1` activates stats mode |
| `SHUFFLE` | `0` | Randomize (backend, replicate) order within each task |
| `SEED` | random | RNG seed for shuffle + random task selection. Pin for reproducibility |
| `BOOTSTRAP_ITERS` | `10000` | Iterations for bootstrap CIs |
| `ORDER` | `vanilla,edgee` | Comma-separated backend order |
| `WARMUP_S` | `0` | Sleep before first prompt of each session (MCP cold-start grace) |
| `TAGS` | none | Comma-separated tags written to the report header and filename |
| `NOTES` | none | Free-text note written to the report header |
| `EDGEE_BIN` | local debug build | Override the edgee binary used |

**`bench:swe` only:**

| Env var | Default | Purpose |
|---|---|---|
| `AGENT_MODE` | `0` | `1` = single autonomy prompt; `0` = scripted 3-prompt sequence |
| `AGENT_TIMEOUT_S` | `1800` | Per-session timeout in agent mode |
| `TASK_LIMIT` | all frozen | Slice `FROZEN_TASKS` to first N (see `src/bench/config.ts`) |
| `RANDOM_TASKS` | `0` | Override frozen list with N random SWE-bench Lite tasks (seeded by `SEED`) |
| `BENCH_SWE_LITE_PATH` | none | Local parquet path for air-gapped runs |

**`bench:mcp` only:**

| Env var | Default | Purpose |
|---|---|---|
| `MCP_BENCH_CONFIG` | none | Required. Path to MCP server config JSON |
| `MCP_TASK_LIMIT` | all | Slice `MCP_TASKS` to first N |
| `MCP_ALLOW_WRITES` | `0` | Escape hatch — disables the post-run write-call assertion |

### B.3 MCP setup

For `bench:mcp` runs, create `mcp-bench.json` at the repo root:

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer lin_api_<your-token>" }
    },
    "notion": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

Notes:

- The server name (`linear`, `notion`) becomes the tool prefix (`mcp__linear__*`) and must match the read-only tool whitelist in `src/bench/mcp-safety.ts`.
- Prefer **personal API tokens** (Bearer headers) over OAuth — headless mode doesn't have a browser for the OAuth callback.
- For claude.ai-managed connectors (which use OAuth), they're inherited automatically by `claude --print` when at least one explicit server is listed in `mcp-bench.json`.
- **This file is gitignored** — never commit auth tokens.

### B.4 Safety (MCP only)

The MCP bench enforces a hard read-only guarantee through two layers:

1. **Regex audit.** After every session, every `tool_use` block in the JSONL is matched against `WRITE_TOOL_PATTERNS` in `src/bench/mcp-safety.ts` (matches `mcp__*__save_/create_/delete_/update_/add_/extract_/prepare_/send_/post_/upload_`).
2. **Post-run assertion.** The bench exits non-zero with a prominent failure banner if any session matched a write pattern, even once.

Across the runs we've published, **0 write-tool calls were detected in 100+ MCP sessions**.

Extend `WRITE_TOOL_PATTERNS` if you add MCP servers whose write tools follow different naming conventions.

### B.5 Methodology

The statistical bench is built around four design choices that make its numbers defensible:

1. **Direct token accounting from session logs.** Token usage is parsed from Claude Code's per-session JSONL files (`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`), not from any gateway-reported number. Cost is computed locally from the four-class Anthropic price table (input / cache_read / cache_create / output) defined in `src/bench/config.ts`. *The gateway contributes zero numbers to the analysis.*

2. **Replicates with shuffle.** With `REPLICATES=N` and `SHUFFLE=1`, each (task, backend) cell is run N times and the within-task order is randomized to remove cache-warming bias from "all vanilla then all edgee" patterns.

3. **Per-replicate nonces.** A random `[trial: <nonce>]` line is prepended to the first user prompt of each replicate in stats mode. The differing bytes invalidate Anthropic's prefix cache, so every replicate starts cold and per-replicate variance reflects real session variance, not cache amortization.

4. **Paired statistics.** Per-task means are paired across backends; the report computes (a) the paired sign test for direction-of-effect across tasks, (b) 95% bootstrap CIs on token/cost ratios via 10,000 percentile resamples, and (c) within-task coefficient of variation as a noise-floor diagnostic.

Three aggregations are reported for every metric — **aggregate** (volume-weighted), **mean per task**, and **median per task** — because none of the three alone tells the full story. Details in `src/bench/stats.ts`.

### B.6 Reports

Every run produces two coordinated artifacts in `reports/`:

```
reports/<bench-prefix>-<finished-at-ISO>--<tags>.md      # human-readable
reports/<bench-prefix>-<finished-at-ISO>--<tags>.json    # lossless companion
```

- `<bench-prefix>` is `swe-` or `mcp-` depending on which bench produced the report.
- The markdown report contains: configuration snapshot, recap table with aggregate/mean/median reductions and sign-test p-values, per-task token consumption, deltas, statistical analysis (in stats mode), overall summary, per-call breakdown, and a session-ID appendix (for `ccusage` verification).
- The JSON companion contains the full per-session usage breakdown — useful for re-analysis or plotting.

`swe-*` and `mcp-*` reports are gitignored so each run's output stays local.
