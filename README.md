# Claude Session Benchmark

A benchmarking suite that measures Claude Code's token consumption under three scenarios, then analyses the results to evaluate the economic impact of Edgee's AI token compressor.

---

## Overview

The benchmark works in two phases:

1. **Run** — Launch isolated Claude Code sessions that complete a fixed set of coding instructions. Each session runs in one of three *scenarios* (compression strategies).
2. **Analyse** — Read the session artefacts and produce cost reports.

---

## Prerequisites

- Node.js ≥ 18 with `npm`
- `claude` CLI installed and accessible in your `PATH`
- RTK (Rust Token Killer): required for the `rtk` scenario; see https://github.com/rtk-ai/rtk
- An `.env` file at the project root (see below)

Install dependencies:

```bash
npm install
```

---

## Environment setup

Create a `.env` file at the root of the project:

```env
EDGEE_API_TOKEN_NORMAL=<your-token-for-normal-sessions>
EDGEE_API_TOKEN_EDGEE=<your-token-for-edgee-sessions>
EDGEE_API_TOKEN_RTK=<your-token-for-rtk-sessions>
```

Each token is an Edgee API key used to route Claude's requests through the Edgee AI Gateway.

### Reports
If you want to generate reports, you'll need another variable:

```env
EDGEE_API_TOKEN_REPORT=<your-token-to-generate-reports>
```

---

## Running a benchmark session

```bash
./run.sh <scenario>
```

**Scenarios:**

| Scenario | Description |
|----------|-------------|
| `normal` | Baseline — Claude requests go through Edgee AI Gateway with no compression |
| `edgee`  | Edgee token compressor is enabled; input tokens are reduced before forwarding to Anthropic |
| `rtk`    | RTK (Rust Token Killer) is enabled as a local bash proxy; Claude's bash tool calls go through RTK before hitting the gateway |

Each run:
1. Copies the `cli/` source directory into a fresh `_<scenario>-<random>/` folder
2. Creates an isolated Claude config directory inside it
3. Launches Claude Code with `--dangerously-skip-permissions`

**Example:**

```bash
./run.sh edgee
```

This creates `_edgee-4a2f8c1d/` and starts a Claude session inside it.

### What to do inside the Claude session

Once Claude starts, put it in **plan mode**, then paste the coding instructions **one at a time** from `instructions.md`. For each instruction:

1. Paste the instruction
2. Let Claude produce a plan
3. Approve the plan and let it execute
4. Move on to the next instruction

The session records token usage and cost in `.claude/.claude.json` inside the session directory.

---

## Analysing results

### Standard benchmark (`npm run analyze`)

Reads all `_normal-*`, `_edgee-*`, and `_rtk-*` session directories (excluding `-full` ones), aggregates token and cost metrics, then calls the Edgee LLM API to produce an AI-written analysis.

```bash
npm run analyze
```

Outputs two files in the project root:

- `report-<ISO-date>.json` — raw aggregated metrics
- `report-<ISO-date>.md` — human-readable markdown report with tables and LLM analysis

### Endurance benchmark (`npm run analyze-full`)

Reads all `_*-full/` session directories and their `claude-pro-usage.json` files to measure how many instructions each scenario can complete before exhausting a Claude Pro plan.

```bash
npm run analyze-full
```

Outputs:

- `report-full-<ISO-date>.json`
- `report-full-<ISO-date>.md`
