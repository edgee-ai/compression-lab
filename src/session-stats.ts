import fs from 'fs';
import path from 'path';

export const SESSION_COST_DIVISOR = 1_000_000_000;

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface TokenMetrics {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  apiDurationMs: number;
}

export interface SessionStatsMetrics extends TokenMetrics {
  byModel: Record<string, ModelUsage>;
}

interface SessionStatsByModelEntry {
  provider?: unknown;
  model?: unknown;
  total_cost?: unknown;
  total_input_tokens?: unknown;
  total_output_tokens?: unknown;
  total_cached_input_tokens?: unknown;
  total_cache_creation_input_tokens?: unknown;
}

/** Token/cost totals from edgee session-stats (nested under `stats`). */
interface SessionStatsBlock {
  total_cost?: unknown;
  total_input_tokens?: unknown;
  total_output_tokens?: unknown;
  total_cached_input_tokens?: unknown;
  total_cache_creation_input_tokens?: unknown;
  by_model?: unknown;
}

/** Edgee CLI `SessionLogEntry` written as session-stats.json. */
interface SessionStatsFile {
  session_id?: unknown;
  tool_name?: unknown;
  ended_at?: unknown;
  ended_at_unix?: unknown;
  logs_url?: unknown;
  stats?: SessionStatsBlock;
  // Legacy flat layout (pre-nested format)
  total_cost?: unknown;
  total_input_tokens?: unknown;
  total_output_tokens?: unknown;
  total_cached_input_tokens?: unknown;
  total_cache_creation_input_tokens?: unknown;
  by_model?: unknown;
}

function extractStatsBlock(data: SessionStatsFile): SessionStatsBlock {
  if (data.stats && typeof data.stats === 'object') {
    return data.stats;
  }
  return data;
}

export interface SessionDescriptor {
  agent: string;
  scenario: string;
  dir: string;
  full: boolean;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function costToUsd(rawCost: unknown): number {
  return asNumber(rawCost) / SESSION_COST_DIVISOR;
}

export function formatAgentName(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

export function formatScenarioName(scenario: string): string {
  if (scenario === 'normal') return '';
  if (scenario === 'edgee') return ' + Edgee';
  if (scenario === 'rtk') return ' + RTK';
  return ` + ${scenario.charAt(0).toUpperCase()}${scenario.slice(1)}`;
}

export function formatAgentScenarioLabel(agent: string, scenario: string): string {
  return `${formatAgentName(agent)}${formatScenarioName(scenario)}`;
}

export function discoverSessionDirs(cwd: string, full: boolean): SessionDescriptor[] {
  const entries = fs.readdirSync(cwd, { withFileTypes: true });
  const sessions: SessionDescriptor[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^_([a-z0-9]+)-([a-z0-9]+)-(.+)$/i);
    if (!match) continue;

    const [, agent, scenario, suffix] = match;
    const isFull = suffix.endsWith('-full');
    if (isFull !== full) continue;

    sessions.push({
      agent,
      scenario,
      dir: path.join(cwd, entry.name),
      full: isFull,
    });
  }

  sessions.sort((a, b) => {
    const agentCmp = a.agent.localeCompare(b.agent);
    if (agentCmp !== 0) return agentCmp;
    const scenarioCmp = a.scenario.localeCompare(b.scenario);
    if (scenarioCmp !== 0) return scenarioCmp;
    return path.basename(a.dir).localeCompare(path.basename(b.dir));
  });

  return sessions;
}

export function readSessionStats(dir: string): SessionStatsMetrics | null {
  const statsPath = path.join(dir, 'session-stats.json');
  let data: SessionStatsFile;

  try {
    data = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as SessionStatsFile;
  } catch {
    console.warn(`  Warning: Could not read ${statsPath}`);
    return null;
  }

  const stats = extractStatsBlock(data);

  const metrics: SessionStatsMetrics = {
    totalCost: costToUsd(stats.total_cost),
    totalInputTokens: asNumber(stats.total_input_tokens),
    totalOutputTokens: asNumber(stats.total_output_tokens),
    cacheReadTokens: asNumber(stats.total_cached_input_tokens),
    cacheCreationTokens: asNumber(stats.total_cache_creation_input_tokens),
    apiDurationMs: 0,
    byModel: {},
  };

  const byModel = Array.isArray(stats.by_model) ? stats.by_model as SessionStatsByModelEntry[] : [];
  for (const entry of byModel) {
    const provider = typeof entry.provider === 'string' ? entry.provider : 'unknown';
    const model = typeof entry.model === 'string' ? entry.model : 'unknown';
    const key = provider === 'unknown' ? model : `${provider}/${model}`;

    metrics.byModel[key] = {
      inputTokens: asNumber(entry.total_input_tokens),
      outputTokens: asNumber(entry.total_output_tokens),
      cacheReadInputTokens: asNumber(entry.total_cached_input_tokens),
      cacheCreationInputTokens: asNumber(entry.total_cache_creation_input_tokens),
      costUSD: costToUsd(entry.total_cost),
    };
  }

  return metrics;
}
