import fs from 'fs';
import path from 'path';
import {
  discoverSessionDirs,
  formatAgentScenarioLabel,
  readSessionStats,
  type SessionDescriptor,
  type TokenMetrics,
} from './session-stats.js';

function loadEnv(envPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  } catch {
    // rely on process.env
  }
  return env;
}

type ParsedUsage =
  | { kind: 'pct'; value: number }
  | { kind: 'half' }
  | { kind: 'not-run' }
  | { kind: 'pending' };

interface InstructionEntry {
  n: number;
  usage: ParsedUsage;
  delta: number | null;
}

interface ScenarioFullMetrics {
  key: string;
  agent: string;
  scenario: string;
  sourceDir: string;
  instructions: InstructionEntry[];
  lastCompleted: number;
  halfAt: number | null;
  effectiveInstructions: number;
  avgPctPerInstruction: number;
  tokens: TokenMetrics;
}

function parseUsage(raw: string): ParsedUsage {
  const t = raw.trim();
  if (t === '-') return { kind: 'not-run' };
  if (t === 'half') return { kind: 'half' };
  if (t === '') return { kind: 'pending' };
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? { kind: 'pending' } : { kind: 'pct', value: n };
}

function parseScenarioUsageFile(session: SessionDescriptor): ScenarioFullMetrics | null {
  const usagePath = path.join(session.dir, 'claude-pro-usage.json');
  let raw: Record<string, string>;
  try {
    const data = JSON.parse(fs.readFileSync(usagePath, 'utf8')) as {
      instructions: Record<string, string>;
    };
    raw = data.instructions;
  } catch {
    console.warn(`  Warning: Could not read ${usagePath}`);
    return null;
  }

  const sortedKeys = Object.keys(raw).sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    return Number.isNaN(na) || Number.isNaN(nb) ? a.localeCompare(b) : na - nb;
  });

  const entries: InstructionEntry[] = [];
  let lastPct = 0;
  let lastCompleted = 0;
  let halfAt: number | null = null;
  const deltas: number[] = [];

  for (const key of sortedKeys) {
    const n = parseInt(key, 10);
    if (Number.isNaN(n)) continue;
    const usage = parseUsage(raw[key] ?? '');

    let delta: number | null = null;
    if (usage.kind === 'pct') {
      delta = usage.value - lastPct;
      deltas.push(delta);
      lastPct = usage.value;
      lastCompleted = n;
    } else if (usage.kind === 'half' && halfAt === null) {
      halfAt = n;
    }

    entries.push({ n, usage, delta });
  }

  return {
    key: `${session.agent}:${session.scenario}`,
    agent: session.agent,
    scenario: session.scenario,
    sourceDir: path.basename(session.dir),
    instructions: entries,
    lastCompleted,
    halfAt,
    effectiveInstructions: lastCompleted + (halfAt !== null ? 0.5 : 0),
    avgPctPerInstruction: deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0,
    tokens: {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      apiDurationMs: 0,
    },
  };
}

function loadFullScenarios(cwd: string): ScenarioFullMetrics[] {
  const results: ScenarioFullMetrics[] = [];
  const sessions = discoverSessionDirs(cwd, true);

  for (const session of sessions) {
    const metrics = parseScenarioUsageFile(session);
    if (!metrics) continue;

    const tokenMetrics = readSessionStats(session.dir);
    if (tokenMetrics) {
      metrics.tokens = {
        totalCost: tokenMetrics.totalCost,
        totalInputTokens: tokenMetrics.totalInputTokens,
        totalOutputTokens: tokenMetrics.totalOutputTokens,
        cacheReadTokens: tokenMetrics.cacheReadTokens,
        cacheCreationTokens: tokenMetrics.cacheCreationTokens,
        apiDurationMs: tokenMetrics.apiDurationMs,
      };
    } else {
      console.warn(`  Warning: Missing session-stats.json for ${session.dir}`);
    }

    results.push(metrics);
    console.log(
      `  Found: ${path.basename(session.dir)} -> ${metrics.key}, ${metrics.lastCompleted} instructions${metrics.halfAt ? `, half at #${metrics.halfAt}` : ''}`,
    );
  }

  results.sort((a, b) => {
    const agentCmp = a.agent.localeCompare(b.agent);
    if (agentCmp !== 0) return agentCmp;
    return a.scenario.localeCompare(b.scenario);
  });

  return results;
}

function buildPrompt(scenarios: ScenarioFullMetrics[]): string {
  const summary = scenarios.map((m) => ({
    key: m.key,
    label: formatAgentScenarioLabel(m.agent, m.scenario),
    agent: m.agent,
    scenario: m.scenario,
    lastCompleted: m.lastCompleted,
    halfAt: m.halfAt,
    effectiveInstructions: m.effectiveInstructions,
    avgPctPerInstruction: +m.avgPctPerInstruction.toFixed(2),
    pctProgression: Object.fromEntries(
      m.instructions
        .filter((e) => e.usage.kind === 'pct' || e.usage.kind === 'half')
        .map((e) => [
          e.n,
          e.usage.kind === 'pct'
            ? `${e.usage.value}% (Δ${e.delta !== null ? `+${e.delta}` : '?'})`
            : 'half (limit mid-instruction)',
        ]),
    ),
    tokenMetrics: {
      totalCost: +m.tokens.totalCost.toFixed(4),
      totalInputTokens: m.tokens.totalInputTokens,
      totalOutputTokens: m.tokens.totalOutputTokens,
      cacheReadTokens: m.tokens.cacheReadTokens,
      cacheCreationTokens: m.tokens.cacheCreationTokens,
      apiDurationMs: m.tokens.apiDurationMs,
    },
  }));

  return `You are analyzing endurance benchmark data for coding-agent sessions run with different configurations.

Goal: determine which agent/scenario combinations allow completing the most instructions before the plan usage limit is reached.

Each scenario had its own plan. After completing each instruction, the plan usage % was recorded manually. The test ran until the plan hit 100% or "half" (limit hit mid-instruction).

Here is the data:

\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`

Key fields:
- label: display name for the agent/scenario combination
- lastCompleted: last instruction fully completed
- halfAt: instruction where plan limit hit mid-execution
- effectiveInstructions: lastCompleted + 0.5 if halfAt is set
- avgPctPerInstruction: average % of plan consumed per instruction
- pctProgression: per-instruction plan usage with deltas
- tokenMetrics: cumulative session token and cost totals from session-stats.json

Please provide a concise analytical Markdown report that:
1. Ranks combinations by effective instructions and compares each optimized scenario with the same agent's normal baseline when available
2. Compares average plan-consumption pace and progression variance
3. Explains any "half" events and remaining capacity
4. Analyzes whether better endurance correlates with token, cache, or cost changes
5. Recommends the best configuration for maximizing session endurance

Use the label field for display names and include a comparison table.`;
}

function buildProgressionTable(scenarios: ScenarioFullMetrics[]): string {
  const allNs = new Set<number>();
  for (const m of scenarios) {
    for (const e of m.instructions) {
      if (e.usage.kind !== 'pending') allNs.add(e.n);
    }
  }
  const sorted = [...allNs].sort((a, b) => a - b);

  const header = `| # | ${scenarios.flatMap((m) => [`${formatAgentScenarioLabel(m.agent, m.scenario)} %`, `${formatAgentScenarioLabel(m.agent, m.scenario)} Δ`]).join(' | ')} |`;
  const separator = `|---|${scenarios.map(() => '---|---').join('|')}|`;

  const rows: string[] = [];
  for (const n of sorted) {
    const cells: string[] = [`${n}`];
    for (const m of scenarios) {
      const entry = m.instructions.find((e) => e.n === n);
      if (!entry) {
        cells.push('', '');
        continue;
      }
      switch (entry.usage.kind) {
        case 'pct':
          cells.push(
            `${entry.usage.value}%${entry.usage.value === 100 ? ' ⛔' : ''}`,
            entry.delta !== null ? `+${entry.delta}` : '',
          );
          break;
        case 'half':
          cells.push('*half* 🔶', '');
          break;
        case 'not-run':
          cells.push('–', '');
          break;
        default:
          cells.push('', '');
      }
    }
    rows.push(`| ${cells.join(' | ')} |`);
  }

  return [header, separator, ...rows].join('\n');
}

function buildMarkdownReport(
  generatedAt: string,
  scenarios: ScenarioFullMetrics[],
  analysis: string,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US');

  const lines: string[] = [
    `# Session Endurance Report`,
    ``,
    `*Generated at: ${generatedAt}*`,
    ``,
    `## Plan Usage Progression`,
    ``,
    buildProgressionTable(scenarios),
    ``,
    `## Endurance Summary`,
    ``,
    `| Scenario | Instructions Completed | Effective | Avg %/Instruction | Total Cost |`,
    `|---|---:|---:|---:|---:|`,
    ...scenarios.map((m) =>
      `| **${formatAgentScenarioLabel(m.agent, m.scenario)}** | ${m.lastCompleted} | ${m.effectiveInstructions} | ${m.avgPctPerInstruction.toFixed(2)}% | $${m.tokens.totalCost.toFixed(4)} |`,
    ),
    ``,
  ];

  const hasTokenData = scenarios.some((m) => m.tokens.totalInputTokens > 0);
  if (hasTokenData) {
    lines.push(
      `## Token & Cost Data`,
      ``,
      `| Scenario | Input Tokens | Output Tokens | Cache Reads | Cache Creates | API Duration |`,
      `|---|---:|---:|---:|---:|---:|`,
      ...scenarios.map((m) => {
        const t = m.tokens;
        return `| **${formatAgentScenarioLabel(m.agent, m.scenario)}** | ${fmt(t.totalInputTokens)} | ${fmt(t.totalOutputTokens)} | ${fmt(t.cacheReadTokens)} | ${fmt(t.cacheCreationTokens)} | ${(t.apiDurationMs / 1000).toFixed(0)}s |`;
      }),
      ``,
    );
  }

  lines.push(`## Analysis`, ``, analysis);
  return lines.join('\n');
}

async function main() {
  const cwd = process.cwd();
  const env = { ...loadEnv(path.join(cwd, '.env')), ...process.env };

  const apiToken = env.EDGEE_API_TOKEN_REPORT;
  if (!apiToken) throw new Error('EDGEE_API_TOKEN_REPORT not found in .env or environment');

  console.log('Scanning for -full benchmark directories...');
  const scenarios = loadFullScenarios(cwd);

  if (scenarios.length === 0) {
    console.error('No readable -full scenario directories found');
    process.exit(1);
  }

  for (const m of scenarios) {
    const total = m.tokens.totalInputTokens + m.tokens.totalOutputTokens;
    console.log(
      `  ${m.key}: effective=${m.effectiveInstructions}, avg=${m.avgPctPerInstruction.toFixed(1)}%/instr, cost=$${m.tokens.totalCost.toFixed(4)}, tokens=${total.toLocaleString()}`,
    );
  }

  console.log('\nCalling Claude via Edgee API...');
  const edgeeBaseUrl = env.EDGEE_BASE_URL ?? 'https://api.edgee.ai';
  const res = await fetch(`${edgeeBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-6',
      messages: [{ role: 'user', content: buildPrompt(scenarios) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Edgee API error ${res.status}: ${body}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const analysisText = data.choices[0]?.message?.content ?? '';

  console.log('\n' + '─'.repeat(80));
  console.log('ENDURANCE ANALYSIS REPORT');
  console.log('─'.repeat(80));
  console.log(analysisText);
  console.log('─'.repeat(80));

  const generatedAt = new Date().toISOString();
  const base = `report-full-${generatedAt.replace(/[:.]/g, '-')}`;

  const jsonOutput = {
    generatedAt,
    scenarios: Object.fromEntries(
      scenarios.map((m) => [m.key, {
        key: m.key,
        agent: m.agent,
        scenario: m.scenario,
        sourceDir: m.sourceDir,
        lastCompleted: m.lastCompleted,
        halfAt: m.halfAt,
        effectiveInstructions: m.effectiveInstructions,
        avgPctPerInstruction: m.avgPctPerInstruction,
        instructions: m.instructions.map((e) => ({ n: e.n, usage: e.usage, delta: e.delta })),
        tokens: m.tokens,
      }]),
    ),
    analysis: analysisText,
  };

  fs.writeFileSync(path.join(cwd, `${base}.json`), JSON.stringify(jsonOutput, null, 2));
  console.log(`\nReport saved to: ${base}.json`);

  fs.writeFileSync(path.join(cwd, `${base}.md`), buildMarkdownReport(generatedAt, scenarios, analysisText));
  console.log(`Report saved to: ${base}.md`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
