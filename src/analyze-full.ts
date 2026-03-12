import fs from 'fs';
import path from 'path';

// ─── Load .env ────────────────────────────────────────────────────────────────

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
  } catch { /* rely on process.env */ }
  return env;
}

// ─── Display names ────────────────────────────────────────────────────────────

const SCENARIO_LABELS: Record<string, string> = {
  normal:   'Claude',
  edgee: 'Claude + Edgee',
  rtk:      'Claude + RTK',
};

function label(scenario: string): string {
  return SCENARIO_LABELS[scenario] ?? scenario;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ParsedUsage =
  | { kind: 'pct';     value: number }  // plan % at end of instruction
  | { kind: 'half'                   }  // plan limit hit mid-instruction
  | { kind: 'not-run'                }  // "-": scenario already exhausted
  | { kind: 'pending'                }; // "": not yet executed

interface InstructionEntry {
  n: number;
  usage: ParsedUsage;
  delta: number | null; // % consumed since previous completed instruction
}

interface TokenMetrics {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  apiDurationMs: number;
}

interface ScenarioFullMetrics {
  scenario: string;
  sourceDir: string;
  instructions: InstructionEntry[];
  lastCompleted: number;           // last instruction n with numeric %
  halfAt: number | null;           // instruction where "half" occurred
  effectiveInstructions: number;   // lastCompleted + 0.5 if halfAt !== null
  avgPctPerInstruction: number;    // mean delta across completed instructions
  tokens: TokenMetrics;
}

// ─── Parse single usage value ─────────────────────────────────────────────────

function parseUsage(raw: string): ParsedUsage {
  const t = raw.trim();
  if (t === '-') return { kind: 'not-run' };
  if (t === 'half') return { kind: 'half' };
  if (t === '') return { kind: 'pending' };
  const n = parseInt(t, 10);
  return isNaN(n) ? { kind: 'pending' } : { kind: 'pct', value: n };
}

// ─── Parse single-scenario claude-pro-usage.json ─────────────────────────────

function parseScenarioUsageFile(dir: string, scenario: string): ScenarioFullMetrics | null {
  const usagePath = path.join(dir, 'claude-pro-usage.json');
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

  // Sort instruction keys numerically
  const sortedKeys = Object.keys(raw).sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    return isNaN(na) || isNaN(nb) ? a.localeCompare(b) : na - nb;
  });

  const entries: InstructionEntry[] = [];
  let lastPct = 0;
  let lastCompleted = 0;
  let halfAt: number | null = null;
  const deltas: number[] = [];

  for (const key of sortedKeys) {
    const n = parseInt(key, 10);
    if (isNaN(n)) continue;
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

  const avgPctPerInstruction = deltas.length > 0
    ? deltas.reduce((a, b) => a + b, 0) / deltas.length
    : 0;

  return {
    scenario,
    sourceDir: path.basename(dir),
    instructions: entries,
    lastCompleted,
    halfAt,
    effectiveInstructions: lastCompleted + (halfAt !== null ? 0.5 : 0),
    avgPctPerInstruction,
    tokens: { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, apiDurationMs: 0 },
  };
}

// ─── Extract token data from .claude.json ────────────────────────────────────

function extractTokenMetrics(dir: string): TokenMetrics {
  const zero: TokenMetrics = { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, apiDurationMs: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, '.claude', '.claude.json'), 'utf8')) as Record<string, unknown>;
    const projects = (data.projects ?? {}) as Record<string, Record<string, unknown>>;
    const m = { ...zero };
    for (const proj of Object.values(projects)) {
      m.totalInputTokens    += (proj.lastTotalInputTokens               as number) ?? 0;
      m.totalOutputTokens   += (proj.lastTotalOutputTokens              as number) ?? 0;
      m.totalCost           += (proj.lastCost                           as number) ?? 0;
      m.cacheReadTokens     += (proj.lastTotalCacheReadInputTokens      as number) ?? 0;
      m.cacheCreationTokens += (proj.lastTotalCacheCreationInputTokens  as number) ?? 0;
      m.apiDurationMs       += (proj.lastAPIDuration                    as number) ?? 0;
    }
    return m;
  } catch {
    return zero;
  }
}

// ─── Find and load all -full scenario directories ────────────────────────────

function loadFullScenarios(cwd: string): ScenarioFullMetrics[] {
  const results: ScenarioFullMetrics[] = [];
  const entries = fs.readdirSync(cwd, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('-full')) continue;
    const name = entry.name;
    // Match _<scenario>-<hash>-full or _<scenario>-full
    const match = name.match(/^_([a-z]+)-(?:[a-z0-9]+-)?full$/);
    if (!match) continue;
    const scenario = match[1];
    const dir = path.join(cwd, name);

    const metrics = parseScenarioUsageFile(dir, scenario);
    if (!metrics) continue;

    metrics.tokens = extractTokenMetrics(dir);
    results.push(metrics);
    console.log(`  Found: ${name} → scenario "${scenario}", ${metrics.lastCompleted} instructions${metrics.halfAt ? `, half at #${metrics.halfAt}` : ''}`);
  }

  // Sort by scenario name for consistent output
  results.sort((a, b) => a.scenario.localeCompare(b.scenario));
  return results;
}

// ─── Build LLM prompt ─────────────────────────────────────────────────────────

function buildPrompt(scenarios: ScenarioFullMetrics[]): string {
  const summary = scenarios.map(m => ({
    scenario: label(m.scenario),
    lastCompleted: m.lastCompleted,
    halfAt: m.halfAt,
    effectiveInstructions: m.effectiveInstructions,
    avgPctPerInstruction: +m.avgPctPerInstruction.toFixed(2),
    pctProgression: Object.fromEntries(
      m.instructions
        .filter(e => e.usage.kind === 'pct' || e.usage.kind === 'half')
        .map(e => [
          e.n,
          e.usage.kind === 'pct'
            ? `${e.usage.value}% (Δ${e.delta !== null ? '+' + e.delta : '?'})`
            : 'half (limit mid-instruction)',
        ])
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

  return `You are analyzing endurance benchmark data for Claude Code sessions run with different configurations against individual Claude Pro plans.

**Goal**: Determine which scenario allows completing the most instructions before the Claude Pro plan usage limit (100%) is reached.

Each scenario had a dedicated Claude Pro plan. After completing each instruction, the plan usage % was manually recorded. The test ran until each scenario hit 100% (or "half" = plan limit struck mid-instruction, after which remaining instructions show "-").

Here is the data:

\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`

Scenario descriptions:
- **${label('normal')}**: Standard Claude Code session, no optimizations
- **${label('edgee')}**: Edgee conversation compression gateway enabled (reduces context sent to the model)
- **${label('rtk')}**: RTK local bash proxy that pre-processes large shell outputs

Use these display names throughout the report.

Key fields:
- \`lastCompleted\`: last instruction fully completed (numeric %)
- \`halfAt\`: instruction where plan limit hit mid-execution (null = plan wasn't hit during an instruction)
- \`effectiveInstructions\`: lastCompleted + 0.5 if halfAt is set
- \`avgPctPerInstruction\`: average % of plan consumed per instruction — lower is better
- \`pctProgression\`: per-instruction plan usage with delta (Δ = % consumed by that instruction)
- \`tokenMetrics\`: cumulative API token/cost data for the full session

Please provide a concise analytical report covering:

1. **Instructions completed**: Rank scenarios by effective instructions. Show absolute (+N instructions) and % gain vs ${label('normal')}.
2. **Pace of plan consumption**: Which scenario consumed the least % per instruction? Show average pace per scenario and variance.
3. **The "half" event**: For scenarios with a half event, what does it mean for remaining capacity? How much plan was left?
4. **Token & cost correlation**: Does the scenario with better plan endurance also show lower token costs and better cache efficiency? Analyze the relationship.
5. **Why ${label('edgee')} helps**: Based on the data, hypothesize why compression extends plan longevity — is it fewer tokens per instruction, or better cache utilization?
6. **Recommendation**: Which scenario should a user choose to maximize their Claude Pro plan usage, and what is the expected improvement?

Format in clear Markdown with headers and a comparison table.`;
}

// ─── Markdown progression table ───────────────────────────────────────────────

function buildProgressionTable(scenarios: ScenarioFullMetrics[]): string {
  // Collect all instruction numbers that have at least one non-pending entry
  const allNs = new Set<number>();
  for (const m of scenarios) {
    for (const e of m.instructions) {
      if (e.usage.kind !== 'pending') allNs.add(e.n);
    }
  }
  const sorted = [...allNs].sort((a, b) => a - b);

  const scenarioNames = scenarios.map(m => m.scenario);
  const colPairs = scenarioNames.flatMap(s => [`${label(s)} %`, `${label(s)} Δ`]);
  const header    = `| # | ${colPairs.join(' | ')} |`;
  const separator = `|---|${scenarioNames.map(() => '---|---').join('|')}|`;

  const rows: string[] = [];
  for (const n of sorted) {
    const cells: string[] = [`${n}`];
    for (const m of scenarios) {
      const entry = m.instructions.find(e => e.n === n);
      if (!entry) { cells.push('', ''); continue; }
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

// ─── Markdown report ──────────────────────────────────────────────────────────

function buildMarkdownReport(
  generatedAt: string,
  scenarios: ScenarioFullMetrics[],
  analysis: string,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US');

  const lines: string[] = [
    `# Claude Pro Plan Endurance Report`,
    ``,
    `_Generated at: ${generatedAt}_`,
    ``,
    `## Plan Usage Progression`,
    ``,
    buildProgressionTable(scenarios),
    ``,
    `## Endurance Summary`,
    ``,
    `| Scenario | Instructions Completed | Effective | Avg %/Instruction | Total Cost |`,
    `|---|---:|---:|---:|---:|`,
    ...scenarios.map(m =>
      `| **${label(m.scenario)}** | ${m.lastCompleted} | ${m.effectiveInstructions} | ${m.avgPctPerInstruction.toFixed(2)}% | $${m.tokens.totalCost.toFixed(4)} |`
    ),
    ``,
  ];

  const hasTokenData = scenarios.some(m => m.tokens.totalInputTokens > 0);
  if (hasTokenData) {
    lines.push(
      `## Token & Cost Data`,
      ``,
      `| Scenario | Input Tokens | Output Tokens | Cache Reads | Cache Creates | API Duration |`,
      `|---|---:|---:|---:|---:|---:|`,
      ...scenarios.map(m => {
        const t = m.tokens;
        return `| **${label(m.scenario)}** | ${fmt(t.totalInputTokens)} | ${fmt(t.totalOutputTokens)} | ${fmt(t.cacheReadTokens)} | ${fmt(t.cacheCreationTokens)} | ${(t.apiDurationMs / 1000).toFixed(0)}s |`;
      }),
      ``,
    );
  }

  lines.push(`## Analysis`, ``, analysis);
  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cwd = process.cwd();
  const env = { ...loadEnv(path.join(cwd, '.env')), ...process.env };

  const apiToken = env.EDGEE_API_TOKEN_REPORT;
  if (!apiToken) throw new Error('EDGEE_API_TOKEN_REPORT not found in .env or environment');

  // 1. Find and load all -full scenario directories
  console.log('Scanning for -full scenario directories...');
  const scenarios = loadFullScenarios(cwd);

  if (scenarios.length === 0) {
    console.error('No -full scenario directories found');
    process.exit(1);
  }

  for (const m of scenarios) {
    const total = m.tokens.totalInputTokens + m.tokens.totalOutputTokens;
    console.log(`  ${m.scenario}: effective=${m.effectiveInstructions}, avg=${m.avgPctPerInstruction.toFixed(1)}%/instr, cost=$${m.tokens.totalCost.toFixed(4)}, tokens=${total.toLocaleString()}`);
  }

  // 2. Call LLM
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

  // 3. Output
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
      scenarios.map(m => [m.scenario, {
        scenario: m.scenario,
        sourceDir: m.sourceDir,
        lastCompleted: m.lastCompleted,
        halfAt: m.halfAt,
        effectiveInstructions: m.effectiveInstructions,
        avgPctPerInstruction: m.avgPctPerInstruction,
        instructions: m.instructions.map(e => ({ n: e.n, usage: e.usage, delta: e.delta })),
        tokens: m.tokens,
      }])
    ),
    analysis: analysisText,
  };

  fs.writeFileSync(path.join(cwd, `${base}.json`), JSON.stringify(jsonOutput, null, 2));
  console.log(`\nReport saved to: ${base}.json`);

  fs.writeFileSync(path.join(cwd, `${base}.md`), buildMarkdownReport(generatedAt, scenarios, analysisText));
  console.log(`Report saved to: ${base}.md`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
