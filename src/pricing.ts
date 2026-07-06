import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PriceTable, ModelPrice, UsageByModel, CostBreakdown } from './types';

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_FETCH_TIMEOUT_MS = 3000;
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;

function price(
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  source: ModelPrice['source'],
): ModelPrice {
  return { input, output, cacheWrite5m, cacheWrite1h, cacheRead, source };
}

/** Anthropic 公式レートに基づく組み込み単価表(単位: USD / 100万トークン)。 */
export function builtinPriceTable(): PriceTable {
  return {
    'claude-fable-5': price(10, 50, 12.5, 20, 1.0, 'builtin'),
    'claude-mythos-5': price(10, 50, 12.5, 20, 1.0, 'builtin'),

    'claude-opus-4-8': price(5, 25, 6.25, 10, 0.5, 'builtin'),
    'claude-opus-4-7': price(5, 25, 6.25, 10, 0.5, 'builtin'),
    'claude-opus-4-6': price(5, 25, 6.25, 10, 0.5, 'builtin'),
    'claude-opus-4-5': price(5, 25, 6.25, 10, 0.5, 'builtin'),

    'claude-opus-4-1': price(15, 75, 18.75, 30, 1.5, 'builtin'),
    'claude-opus-4': price(15, 75, 18.75, 30, 1.5, 'builtin'), // 旧 claude-opus-4-20250514 の受け皿
    'claude-3-opus': price(15, 75, 18.75, 30, 1.5, 'builtin'),

    'claude-sonnet-5': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-sonnet-4-6': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-sonnet-4-5': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-sonnet-4': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-3-7-sonnet': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-3-5-sonnet': price(3, 15, 3.75, 6, 0.3, 'builtin'),

    'claude-haiku-4-5': price(1, 5, 1.25, 2, 0.1, 'builtin'),
    'claude-3-5-haiku': price(0.8, 4, 1.0, 1.6, 0.08, 'builtin'),
    'claude-3-haiku': price(0.25, 1.25, 0.3125, 0.5, 0.025, 'builtin'),
  };
}

/**
 * モデルIDを正規化する(内部関数):
 * 小文字化 → 先頭の "anthropic/" "anthropic." を除去 → 末尾の "[1m]" を除去 →
 * 末尾の日付 "-20\d{6}" を除去 → trim。
 */
function normalizeModelId(modelId: string): string {
  let s = modelId.toLowerCase();
  s = s.replace(/^anthropic[\/.]/, '');
  s = s.replace(/\[1m\]$/, '');
  s = s.replace(/-20\d{6}$/, '');
  return s.trim();
}

/** normalize 後、テーブルキーとの最長プレフィックス一致でモデル単価を解決する。一致なしは null。 */
export function resolvePrice(modelId: string, table: PriceTable): ModelPrice | null {
  const target = normalizeModelId(modelId);
  let bestKeyLen = -1;
  let bestPrice: ModelPrice | null = null;

  for (const rawKey of Object.keys(table)) {
    const key = normalizeModelId(rawKey);
    if (key.length === 0 || !target.startsWith(key)) continue;
    if (key.length > bestKeyLen) {
      bestKeyLen = key.length;
      bestPrice = table[rawKey];
    }
  }

  return bestPrice ? { ...bestPrice } : null;
}

/** main / sidechain の UsageByModel からコストを算出する(表示用の丸めはしない)。 */
export function computeCost(
  main: UsageByModel,
  sidechain: UsageByModel,
  table: PriceTable,
): CostBreakdown {
  const byModel: Record<string, number> = {};
  const unknownModels: string[] = [];
  let usd = 0;

  const accumulate = (usage: UsageByModel): void => {
    for (const [model, tokens] of Object.entries(usage)) {
      const p = resolvePrice(model, table);
      let cost = 0;
      if (p === null) {
        if (!unknownModels.includes(model)) unknownModels.push(model);
      } else {
        cost =
          (tokens.input * p.input +
            tokens.output * p.output +
            tokens.cacheWrite5m * p.cacheWrite5m +
            tokens.cacheWrite1h * p.cacheWrite1h +
            tokens.cacheRead * p.cacheRead) /
          1_000_000;
      }
      byModel[model] = (byModel[model] ?? 0) + cost;
      usd += cost;
    }
  };

  accumulate(main);
  accumulate(sidechain);

  return { usd, byModel, unknownModels };
}

interface PriceCacheFile {
  fetchedAt: string;
  table: PriceTable;
}

function cacheFilePath(cacheDir: string): string {
  return path.join(cacheDir, 'pricing.json');
}

async function readPriceCache(cacheDir: string): Promise<PriceCacheFile | null> {
  try {
    const raw = await fs.readFile(cacheFilePath(cacheDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).fetchedAt === 'string' &&
      typeof (parsed as Record<string, unknown>).table === 'object' &&
      (parsed as Record<string, unknown>).table !== null
    ) {
      const p = parsed as { fetchedAt: string; table: PriceTable };
      return { fetchedAt: p.fetchedAt, table: p.table };
    }
    return null;
  } catch {
    return null;
  }
}

async function writePriceCache(cacheDir: string, table: PriceTable): Promise<void> {
  const file = cacheFilePath(cacheDir);
  const payload: PriceCacheFile = { fetchedAt: new Date().toISOString(), table };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
}

function isCacheFresh(fetchedAt: string): boolean {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= CACHE_FRESH_MS;
}

function toFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** LiteLLM の model_prices_and_context_window.json を PriceTable(litellm 由来分のみ)へ変換する。 */
function convertLiteLLMPayload(payload: unknown): PriceTable {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('invalid litellm payload: not an object');
  }

  const table: PriceTable = {};

  for (const [rawKey, rawEntry] of Object.entries(payload as Record<string, unknown>)) {
    if (rawEntry === null || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;

    const provider = entry.litellm_provider;
    if (typeof provider === 'string' && provider !== 'anthropic') continue;

    let key = rawKey.toLowerCase();
    if (key.startsWith('anthropic/')) key = key.slice('anthropic/'.length);
    if (!key.startsWith('claude')) continue;

    const inputRaw = toFiniteNumber(entry.input_cost_per_token);
    const outputRaw = toFiniteNumber(entry.output_cost_per_token);
    if (inputRaw === null || inputRaw <= 0) continue;
    if (outputRaw === null || outputRaw <= 0) continue;

    const input = inputRaw * 1_000_000;
    const output = outputRaw * 1_000_000;

    const cacheReadRaw = toFiniteNumber(entry.cache_read_input_token_cost);
    const cacheWrite5mRaw = toFiniteNumber(entry.cache_creation_input_token_cost);
    const cacheWrite1hRaw = toFiniteNumber(entry.cache_creation_input_token_cost_above_1hr);

    table[key] = {
      input,
      output,
      cacheRead: cacheReadRaw !== null ? cacheReadRaw * 1_000_000 : input * 0.1,
      cacheWrite5m: cacheWrite5mRaw !== null ? cacheWrite5mRaw * 1_000_000 : input * 1.25,
      cacheWrite1h: cacheWrite1hRaw !== null ? cacheWrite1hRaw * 1_000_000 : input * 2,
      source: 'litellm',
    };
  }

  return table;
}

async function fetchLiteLLMPriceTable(): Promise<PriceTable> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LITELLM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LITELLM_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`litellm fetch failed with status ${res.status}`);
    }
    const json: unknown = await res.json();
    return convertLiteLLMPayload(json);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 単価表をロードする。
 * 1. キャッシュが24時間以内 → builtin + cache をマージして返す
 * 2. opts.offline === true → キャッシュ(期限切れ可)があればマージ、無ければ builtin のみ
 * 3. それ以外 → LiteLLM を fetch。成功なら変換してキャッシュ保存+マージ、
 *    失敗ならキャッシュ(期限切れ可)→ builtin の順でフォールバック
 */
export async function loadPriceTable(
  cacheDir: string,
  opts?: { offline?: boolean },
): Promise<PriceTable> {
  const builtin = builtinPriceTable();
  const cached = await readPriceCache(cacheDir);

  if (cached !== null && isCacheFresh(cached.fetchedAt)) {
    return { ...builtin, ...cached.table };
  }

  if (opts?.offline === true) {
    return cached !== null ? { ...builtin, ...cached.table } : builtin;
  }

  try {
    const remoteTable = await fetchLiteLLMPriceTable();
    await writePriceCache(cacheDir, remoteTable);
    return { ...builtin, ...remoteTable };
  } catch {
    return cached !== null ? { ...builtin, ...cached.table } : builtin;
  }
}
