// SWE-bench Lite task loader + random sampler.
//
// Port of bench_tokens.py lines 157-207 (`sample_random_tasks`, `fetch_task`).
//
// Storage layout:
//   ~/.cache/cache_bench_swe/lite-test.parquet     ← whole dataset (~1.2MB)
//   ~/.cache/cache_bench_swe/tasks/<task_id>.json  ← per-task metadata shard
//                                                   (interoperable with Python's cache)
//
// First-run flow:
//   1. Download the SWE-bench Lite test parquet from HuggingFace.
//   2. Decode with hyparquet → array of Task records.
//   3. Write per-task JSON shards next to the Python ones.
//
// `BENCH_SWE_LITE_PATH` env var lets you point at a local parquet (air-gapped).

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SeededRng } from './rng.js';
import { SWE_CACHE, TASKS_CACHE } from './config.js';
import { Task } from './types.js';

const HF_PARQUET_URL =
  'https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite/resolve/main/data/test-00000-of-00001.parquet';
const LOCAL_PARQUET_CACHE = path.join(SWE_CACHE, 'lite-test.parquet');

let datasetCache: Task[] | null = null;

/**
 * Load SWE-bench Lite test split. Cached after first call.
 * If BENCH_SWE_LITE_PATH is set, loads from there instead of HuggingFace.
 */
export async function loadSweBenchLite(override?: string | null): Promise<Task[]> {
  if (datasetCache !== null) return datasetCache;

  const parquetPath = override ?? (await ensureParquetCached());
  // Dynamic import keeps hyparquet out of the eager require graph (matters
  // for the unit tests which never touch this path).
  const { parquetReadObjects } = await import('hyparquet');
  const buf = await readFile(parquetPath);
  const rows = (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })) as Task[];
  datasetCache = rows;
  return rows;
}

async function ensureParquetCached(): Promise<string> {
  try {
    const s = await stat(LOCAL_PARQUET_CACHE);
    if (s.size > 0) return LOCAL_PARQUET_CACHE;
  } catch {
    // not cached yet
  }
  await mkdir(SWE_CACHE, { recursive: true });
  const response = await fetch(HF_PARQUET_URL);
  if (!response.ok) {
    throw new Error(`failed to fetch SWE-bench Lite parquet: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(LOCAL_PARQUET_CACHE, bytes);
  return LOCAL_PARQUET_CACHE;
}

/**
 * Get a single SWE-bench Lite task by instance_id. Hits the per-task JSON
 * cache first (interoperable with Python's bench), otherwise loads the
 * dataset and writes the shard. Returns null if the task isn't in the split.
 *
 * Mirrors bench_tokens.py `fetch_task` (lines 189-207).
 */
export async function fetchTask(taskId: string, override?: string | null): Promise<Task | null> {
  const shardPath = path.join(TASKS_CACHE, `${taskId}.json`);
  try {
    const text = await readFile(shardPath, 'utf8');
    return JSON.parse(text) as Task;
  } catch {
    // not in shard cache
  }

  const rows = await loadSweBenchLite(override);
  const row = rows.find(r => r.instance_id === taskId);
  if (row === undefined) return null;

  await mkdir(TASKS_CACHE, { recursive: true });
  await writeFile(shardPath, JSON.stringify(row));
  return row;
}

/**
 * Sample N task ids from SWE-bench Lite using the provided seeded RNG.
 * Writes per-task shards alongside (caches the metadata for fetchTask).
 *
 * Mirrors bench_tokens.py `sample_random_tasks` (lines 157-186). Like the
 * Python version, the returned list is SORTED (so iteration order is
 * deterministic given the seed AND independent of the sample size).
 */
export async function sampleRandomTasks(
  n: number,
  rng: SeededRng,
  override?: string | null,
): Promise<string[]> {
  const rows = await loadSweBenchLite(override);
  const allIds = rows.map(r => r.instance_id);
  if (n > allIds.length) {
    n = allIds.length;
  }
  const sampled = rng.sample(allIds, n).slice().sort();

  // Cache shards for the sampled tasks so fetchTask doesn't re-load the
  // dataset on every per-task lookup downstream.
  await mkdir(TASKS_CACHE, { recursive: true });
  const sampledSet = new Set(sampled);
  for (const row of rows) {
    if (!sampledSet.has(row.instance_id)) continue;
    const shardPath = path.join(TASKS_CACHE, `${row.instance_id}.json`);
    try {
      await stat(shardPath);
    } catch {
      await writeFile(shardPath, JSON.stringify(row));
    }
  }

  return sampled;
}

/** Test hook: reset the in-memory dataset cache. Tests use this to force a re-load. */
export function _resetDatasetCacheForTests(): void {
  datasetCache = null;
}
