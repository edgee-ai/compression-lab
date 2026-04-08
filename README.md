# Compression Lab - Benchmark

A benchmarking suite that measures Coding Agent's token consumption under different scenarios, then analyses the results to evaluate the economic impact of Edgee's AI token compressor.

> **See the [`reports/`](./reports/) folder for detailed, real-world reports from our latest benchmark runs, including token usage, costs, and scenario breakdowns.**

---

## Overview

The benchmark works in two phases:

1. **Run** — Launch isolated coding-agent sessions that complete a fixed set of coding instructions. Each session runs in one of three *scenarios* (compression strategies).
2. **Analyse** — Read the generated session artefacts and produce cost reports.

---

## Prerequisites

- Node.js ≥ 18 with `npm`
- `edgee` CLI installed 
- `claude` CLI installed and accessible in your `PATH`
- RTK (Rust Token Killer): required for the `rtk` scenario; see https://github.com/rtk-ai/rtk
- An `.env` file at the project root (see below)

Install dependencies:

```bash
npm install
```

---

## Environment setup

First, create an empty `.edgee/credentials.toml` file at the root of this project, so you can use mulitple edgee profiles.
Then, create two Edgee accounts, one for the `normal` scenario (without compression) and one for the `edgee` scenario (with compression).
_If you want to test rtk as well, you'll have to create another account dedicated to it (optional)._

Then use login
```env
edgee auth login -p normal 
edgee auth login -p edgee
edgee auth login -p rtk #optional
```

### Reports
If you want to generate reports, you'll need the following variable:

```env
EDGEE_API_TOKEN_REPORT=<your-token-to-generate-reports>
```

---

## Running a benchmark session

```bash
./run.sh <agent> <scenario>
```

**Agents:**

| Scenario | Description |
|----------|-------------|
| `claude` | Baseline — Claude requests go through Edgee AI Gateway with no compression |
| `codex`  | Edgee token compressor is enabled; input tokens are reduced before forwarding to Anthropic |

**Scenarios:**

| Scenario | Description |
|----------|-------------|
| `normal` | Baseline — Claude requests go through Edgee AI Gateway with no compression |
| `edgee`  | Edgee token compressor is enabled; input tokens are reduced before forwarding to Anthropic |
| `rtk`    | RTK (Rust Token Killer) is enabled as a local bash proxy; Claude's bash tool calls go through RTK before hitting the gateway |

Each run:
1. Copies the `cli/` source directory into a fresh `_<agent>-<scenario>-<random>/` folder
2. Creates an isolated Claude/Codex config directory inside it
3. Launches Claude/Codex with `--dangerously-skip-permissions` (or equivalent)

**Example:**

```bash
./run.sh claude edgee
```

This creates `_claude-edgee-4a2f8c1d/` and starts a Claude session inside it.

### What to do inside the Coding Agent session

Once the agent starts, put it in **plan mode**, then paste the coding instructions **one at a time** from `instructions.md`. For each instruction:

1. Paste the instruction
2. Let Claude produce a plan
3. Approve the plan and let it execute
4. Move on to the next instruction

---

## Analysing results

### Standard benchmark (`npm run analyze`)

Reads all `_<agent>-<scenario>-*` session directories that contain `session-stats.json` (excluding `-full` ones), aggregates token and cost metrics by agent + scenario, then calls the Edgee LLM API to produce an AI-written analysis.

```bash
npm run analyze
```

Outputs two files in the project root:

- `report-<ISO-date>.json` — raw aggregated metrics
- `report-<ISO-date>.md` — human-readable markdown report with tables and LLM analysis

### Endurance benchmark (`npm run analyze-full`)

Reads all `_<agent>-<scenario>-*-full` session directories, uses `session-stats.json` for token/cost totals, and uses `claude-pro-usage.json` for the recorded per-instruction endurance progression.

```bash
npm run analyze-full
```

Outputs:

- `report-full-<ISO-date>.json`
- `report-full-<ISO-date>.md`
