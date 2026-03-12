import fs from 'fs';
import path from 'path';

// ─── Load .env ───────────────────────────────────────────────────────────────

function loadEnv(envPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      env[key] = val;
    }
  } catch {
    // .env not found — rely on process.env
  }
  return env;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

interface ScenarioMetrics {
  dirCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  linesAdded: number;
  linesRemoved: number;
  apiDurationMs: number;
  byModel: Record<string, ModelUsage>;
}

type ScenarioType = 'normal' | 'edgee' | 'rtk';

const SCENARIO_LABELS: Record<ScenarioType, string> = {
  normal:   'Claude',
  edgee: 'Claude + Edgee',
  rtk:      'Claude + RTK',
};

// ─── Find scenario dirs ───────────────────────────────────────────────────────

async function findScenarioDirs(cwd: string): Promise<Record<ScenarioType, string[]>> {
  const entries = fs.readdirSync(cwd, { withFileTypes: true });
  const dirs: Record<ScenarioType, string[]> = { normal: [], edgee: [], rtk: [] };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const fullPath = path.join(cwd, name);
    if (name.endsWith('-full')) continue;
    if (name.startsWith('_normal-')) dirs.normal.push(fullPath);
    else if (name.startsWith('_edgee-')) dirs.edgee.push(fullPath);
    else if (name.startsWith('_rtk-')) dirs.rtk.push(fullPath);
  }

  return dirs;
}

// ─── Clean cli/ dirs ─────────────────────────────────────────────────────────

async function cleanCliDirs(scenarioDirs: Record<ScenarioType, string[]>): Promise<void> {
  const allDirs = Object.values(scenarioDirs).flat();
  for (const dir of allDirs) {
    const cliPath = path.join(dir, 'cli');
    await fs.promises.rm(cliPath, { recursive: true, force: true });
    console.log(`Cleaned: ${cliPath}`);
  }
}

// ─── Parse .claude.json ───────────────────────────────────────────────────────

function parseClaudeJson(dir: string): ScenarioMetrics | null {
  const jsonPath = path.join(dir, '.claude', '.claude.json');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    console.warn(`  Warning: Could not read ${jsonPath}`);
    return null;
  }

  const projects = (data.projects ?? {}) as Record<string, Record<string, unknown>>;
  const metrics: ScenarioMetrics = {
    dirCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    linesAdded: 0,
    linesRemoved: 0,
    apiDurationMs: 0,
    byModel: {},
  };

  for (const proj of Object.values(projects)) {
    metrics.totalInputTokens += (proj.lastTotalInputTokens as number) ?? 0;
    metrics.totalOutputTokens += (proj.lastTotalOutputTokens as number) ?? 0;
    metrics.totalCost += (proj.lastCost as number) ?? 0;
    metrics.cacheReadTokens += (proj.lastTotalCacheReadInputTokens as number) ?? 0;
    metrics.cacheCreationTokens += (proj.lastTotalCacheCreationInputTokens as number) ?? 0;
    metrics.linesAdded += (proj.lastLinesAdded as number) ?? 0;
    metrics.linesRemoved += (proj.lastLinesRemoved as number) ?? 0;
    metrics.apiDurationMs += (proj.lastAPIDuration as number) ?? 0;

    const modelUsage = (proj.lastModelUsage ?? {}) as Record<string, ModelUsage>;
    for (const [model, usage] of Object.entries(modelUsage)) {
      if (!metrics.byModel[model]) {
        metrics.byModel[model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
        };
      }
      metrics.byModel[model].inputTokens += usage.inputTokens ?? 0;
      metrics.byModel[model].outputTokens += usage.outputTokens ?? 0;
      metrics.byModel[model].cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
      metrics.byModel[model].cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
      metrics.byModel[model].costUSD += usage.costUSD ?? 0;
    }
  }

  return metrics;
}

// ─── Aggregate by scenario type ───────────────────────────────────────────────

function aggregateScenario(dirs: string[]): ScenarioMetrics {
  const agg: ScenarioMetrics = {
    dirCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    linesAdded: 0,
    linesRemoved: 0,
    apiDurationMs: 0,
    byModel: {},
  };

  for (const dir of dirs) {
    const m = parseClaudeJson(dir);
    if (!m) continue;
    agg.dirCount++;
    agg.totalInputTokens += m.totalInputTokens;
    agg.totalOutputTokens += m.totalOutputTokens;
    agg.totalCost += m.totalCost;
    agg.cacheReadTokens += m.cacheReadTokens;
    agg.cacheCreationTokens += m.cacheCreationTokens;
    agg.linesAdded += m.linesAdded;
    agg.linesRemoved += m.linesRemoved;
    agg.apiDurationMs += m.apiDurationMs;

    for (const [model, usage] of Object.entries(m.byModel)) {
      if (!agg.byModel[model]) {
        agg.byModel[model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
        };
      }
      agg.byModel[model].inputTokens += usage.inputTokens;
      agg.byModel[model].outputTokens += usage.outputTokens;
      agg.byModel[model].cacheReadInputTokens += usage.cacheReadInputTokens;
      agg.byModel[model].cacheCreationInputTokens += usage.cacheCreationInputTokens;
      agg.byModel[model].costUSD += usage.costUSD;
    }
  }

  return agg;
}

// ─── Build prompt ─────────────────────────────────────────────────────────────

function buildPrompt(scenarios: Record<ScenarioType, ScenarioMetrics>): string {
  const dataJson = JSON.stringify(scenarios, null, 2);
  return `You are analyzing token usage data from Claude Code benchmark sessions run across three scenarios:
- **${SCENARIO_LABELS.normal}**: Standard Claude Code session with no special configuration
- **${SCENARIO_LABELS.edgee}**: Session using Edgee conversation compression to reduce context size
- **${SCENARIO_LABELS.rtk}**: Session using RTK local bash proxy that pre-processes large shell outputs

Here is the aggregated token usage data (JSON, keys are scenario IDs):

\`\`\`json
${dataJson}
\`\`\`

Scenario ID mapping: normal = "${SCENARIO_LABELS.normal}", edgee = "${SCENARIO_LABELS.edgee}", rtk = "${SCENARIO_LABELS.rtk}"

Token fields:
- totalInputTokens: fresh input tokens sent to the API
- totalOutputTokens: tokens generated by the model
- cacheReadTokens: tokens served from the prompt cache (very cheap)
- cacheCreationTokens: tokens written to the prompt cache
- totalCost: total USD cost
- byModel: breakdown per model

Please provide a concise analytical report covering:

1. **Overall token consumption**: Which scenario consumed the fewest total tokens (input + output combined)?
2. **${SCENARIO_LABELS.edgee} vs ${SCENARIO_LABELS.normal} savings**: Absolute and percentage reduction in total tokens and cost
3. **${SCENARIO_LABELS.rtk} vs ${SCENARIO_LABELS.normal} savings**: Absolute and percentage reduction in total tokens and cost
4. **Cache efficiency**: Cache hit rate (cacheReadTokens / (cacheReadTokens + cacheCreationTokens + totalInputTokens)) per scenario — which scenario uses the cache most effectively?
5. **Cost comparison**: Rank scenarios by cost, highlight the cheapest
6. **Recommendation**: Which scenario would you recommend for production use and why?

Use the display names (${SCENARIO_LABELS.normal}, ${SCENARIO_LABELS.edgee}, ${SCENARIO_LABELS.rtk}) throughout the report, not the internal IDs.

Format the report in clear Markdown with headers and a summary table where appropriate.`;
}

// ─── Markdown report ──────────────────────────────────────────────────────────

function buildMarkdownReport(
  generatedAt: string,
  scenarios: Record<ScenarioType, ScenarioMetrics>,
  analysis: string,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  const pct = (a: number, b: number) =>
    b === 0 ? 'N/A' : `${(((a - b) / b) * 100).toFixed(1)}%`;

  const rows = (['normal', 'edgee', 'rtk'] as ScenarioType[]).map(type => {
    const s = scenarios[type];
    const total = s.totalInputTokens + s.totalOutputTokens;
    const totalCache = s.cacheReadTokens + s.cacheCreationTokens + s.totalInputTokens;
    const hitRate = totalCache === 0 ? 0 : (s.cacheReadTokens / totalCache) * 100;
    return { type, s, total, hitRate };
  });

  const lines: string[] = [
    `# Token Usage Analysis Report`,
    ``,
    `_Generated at: ${generatedAt}_`,
    ``,
    `## Raw Metrics`,
    ``,
    `| Scenario | Input Tokens | Output Tokens | Total I/O | Cache Reads | Cache Creates | Cache Hit Rate | Cost (USD) |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|`,
    ...rows.map(({ type, s, total, hitRate }) =>
      `| **${SCENARIO_LABELS[type]}** | ${fmt(s.totalInputTokens)} | ${fmt(s.totalOutputTokens)} | ${fmt(total)} | ${fmt(s.cacheReadTokens)} | ${fmt(s.cacheCreationTokens)} | ${hitRate.toFixed(1)}% | $${s.totalCost.toFixed(4)} |`
    ),
    ``,
    `## Model Breakdown`,
    ``,
  ];

  for (const { type, s } of rows) {
    lines.push(`### ${SCENARIO_LABELS[type]}`);
    lines.push(``);
    lines.push(`| Model | Input | Output | Cache Reads | Cache Creates | Cost (USD) |`);
    lines.push(`|---|---:|---:|---:|---:|---:|`);
    for (const [model, u] of Object.entries(s.byModel)) {
      lines.push(`| ${model} | ${fmt(u.inputTokens)} | ${fmt(u.outputTokens)} | ${fmt(u.cacheReadInputTokens)} | ${fmt(u.cacheCreationInputTokens)} | $${u.costUSD.toFixed(4)} |`);
    }
    lines.push(``);
  }

  lines.push(`## Analysis`);
  lines.push(``);
  lines.push(analysis);

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cwd = process.cwd();
  const env = { ...loadEnv(path.join(cwd, '.env')), ...process.env };

  const apiToken = env.EDGEE_API_TOKEN_REPORT;
  if (!apiToken) {
    throw new Error('EDGEE_API_TOKEN_REPORT not found in .env or environment');
  }

  // 1. Find scenario dirs
  console.log('Finding scenario directories...');
  const scenarioDirs = await findScenarioDirs(cwd);
  for (const [type, dirs] of Object.entries(scenarioDirs)) {
    console.log(`  ${type}: ${dirs.length} dir(s) — ${dirs.map(d => path.basename(d)).join(', ') || 'none'}`);
  }

  if (scenarioDirs.normal.length === 0 && scenarioDirs.edgee.length === 0 && scenarioDirs.rtk.length === 0) {
    console.error('No scenario directories found');
    process.exit(1);
  }

  // 2. Clean cli/ dirs
  console.log('\nCleaning cli/ directories...');
  await cleanCliDirs(scenarioDirs);

  // 3. Parse and aggregate metrics
  console.log('\nParsing .claude.json files...');
  const scenarios: Record<ScenarioType, ScenarioMetrics> = {
    normal: aggregateScenario(scenarioDirs.normal),
    edgee: aggregateScenario(scenarioDirs.edgee),
    rtk: aggregateScenario(scenarioDirs.rtk),
  };

  for (const [type, metrics] of Object.entries(scenarios)) {
    const total = metrics.totalInputTokens + metrics.totalOutputTokens;
    console.log(`  ${type}: ${metrics.dirCount} run(s), ${total.toLocaleString()} total tokens, $${metrics.totalCost.toFixed(4)}`);
  }

  // 4. Call LLM via Edgee API (OpenAI-compatible endpoint)
  console.log('\nCalling Claude via Edgee API...');
  const prompt = buildPrompt(scenarios);

  const edgeeBaseUrl = env.EDGEE_BASE_URL ?? 'https://api.edgee.ai';
  const res = await fetch(`${edgeeBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-6',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Edgee API error ${res.status}: ${errBody}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: unknown;
    compression?: unknown;
  };

  const analysisText: string = data.choices[0]?.message?.content ?? '';
  const compressionInfo = data.compression ?? null;

  if (compressionInfo) {
    console.log(`  Edgee compression: ${JSON.stringify(compressionInfo)}`);
  }

  // 5. Output
  console.log('\n' + '─'.repeat(80));
  console.log('ANALYSIS REPORT');
  console.log('─'.repeat(80));
  console.log(analysisText);
  console.log('─'.repeat(80));

  const generatedAt = new Date().toISOString();
  const reportData = {
    generatedAt,
    scenarios,
    analysis: analysisText,
  };

  const reportBase = `report-${generatedAt.replace(/[:.]/g, '-')}`;

  const reportFile = path.join(cwd, `${reportBase}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(reportData, null, 2));
  console.log(`\nReport saved to: ${reportFile}`);

  const mdContent = buildMarkdownReport(generatedAt, scenarios, analysisText);
  const mdFile = path.join(cwd, `${reportBase}.md`);
  fs.writeFileSync(mdFile, mdContent);
  console.log(`Report saved to: ${mdFile}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
