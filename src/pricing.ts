import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PriceTable, ModelPrice, UsageByModel, CostBreakdown } from './types';

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_FETCH_TIMEOUT_MS = 3000;
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
const SONNET_5_STANDARD_PRICE_START_MS = Date.UTC(2026, 8, 1);

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

/** Anthropic / OpenAI の公開単価に基づく組み込み単価表(単位: USD / 100万トークン)。 */
export function builtinPriceTable(now: Date = new Date()): PriceTable {
  // Sonnet 5 は 2026-08-31 まで導入価格。2026-09-01 00:00 UTC から通常価格。
  // cache write/read は公式の 5m=1.25x / 1h=2x / read=0.1x を適用する。
  const sonnet5 = now.getTime() < SONNET_5_STANDARD_PRICE_START_MS
    ? price(2, 10, 2.5, 4, 0.2, 'builtin')
    : price(3, 15, 3.75, 6, 0.3, 'builtin');
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

    'claude-sonnet-5': sonnet5,
    'claude-sonnet-4-6': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-sonnet-4-5': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-sonnet-4': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-3-7-sonnet': price(3, 15, 3.75, 6, 0.3, 'builtin'),
    'claude-3-5-sonnet': price(3, 15, 3.75, 6, 0.3, 'builtin'),

    'claude-haiku-4-5': price(1, 5, 1.25, 2, 0.1, 'builtin'),
    'claude-3-5-haiku': price(0.8, 4, 1.0, 1.6, 0.08, 'builtin'),
    'claude-3-haiku': price(0.25, 1.25, 0.3125, 0.5, 0.025, 'builtin'),

    // OpenAI Codex CLI 対応(公式レートに基づく単価。キャッシュ書き込み課金は無いため 0)
    'gpt-5.5': price(5, 30, 0, 0, 0.5, 'builtin'),
    'gpt-5.1': price(1.25, 10, 0, 0, 0.125, 'builtin'),
    'gpt-5': price(1.25, 10, 0, 0, 0.125, 'builtin'),
    'gpt-5-codex': price(1.25, 10, 0, 0, 0.125, 'builtin'),
    'gpt-5.1-codex': price(1.25, 10, 0, 0, 0.125, 'builtin'),
    'o3': price(2, 8, 0, 0, 0.5, 'builtin'),
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

/**
 * normalize 後の完全一致でモデル単価を解決する。一致なしは null。
 *
 * 日付suffix等の既知の表記差は吸収するが、任意suffixのprefix一致は行わない。
 * これにより、例えば未登録の gpt-5.6-sol を古い gpt-5 の単価で誤計算しない。
 */
export function resolvePrice(modelId: string, table: PriceTable): ModelPrice | null {
  const target = normalizeModelId(modelId);
  for (const rawKey of Object.keys(table)) {
    const key = normalizeModelId(rawKey);
    if (key.length > 0 && target === key) return { ...table[rawKey] };
  }
  return null;
}

/** main / sidechain の UsageByModel からコストを算出する(表示用の丸めはしない)。 */
export function computeCost(
  main: UsageByModel,
  sidechain: UsageByModel,
  table: PriceTable,
): CostBreakdown {
  const byModel = Object.create(null) as Record<string, number>;
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
      byModel[model] = (Object.hasOwn(byModel, model) ? byModel[model] : 0) + cost;
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

/**
 * cache と builtin のマージ。
 * - fresh cache: LiteLLM を優先して新しい単価を反映する。
 * - stale cache: 未知モデルの補完には使うが、既知モデルは builtin を優先する。
 * - Sonnet 5: 日付境界を builtin が管理するため、cache の鮮度にかかわらず builtin を優先する。
 *
 * provider prefix / 日付suffixなどraw keyが異なっても、normalize後に同じモデルなら
 * builtin側のcanonical keyへ集約する。返すtableには同じ正規化IDの別名を残さず、
 * resolvePriceの走査順で優先順位が逆転しないようにする。
 */
function mergePriceTables(builtin: PriceTable, cached: PriceTable, fresh: boolean): PriceTable {
  const merged: PriceTable = { ...builtin };
  const builtinKeyById = new Map<string, string>();
  for (const rawKey of Object.keys(builtin)) {
    const normalized = normalizeModelId(rawKey);
    if (normalized.length > 0) builtinKeyById.set(normalized, rawKey);
  }

  // cache内だけで同じ正規化IDのaliasが複数ある場合も、最後の1件へ集約する。
  const cachedKeyById = new Map<string, string>();
  for (const [model, modelPrice] of Object.entries(cached)) {
    const normalized = normalizeModelId(model);
    if (normalized.length === 0) continue;
    // Sonnet 5の期間境界と、stale cacheの既知モデルは、
    // provider prefix・日付付きalias等でもbuiltinより先に解決させない。
    if (normalized === 'claude-sonnet-5') continue;

    const builtinKey = builtinKeyById.get(normalized);
    if (builtinKey !== undefined) {
      if (fresh) merged[builtinKey] = modelPrice;
      continue;
    }

    const priorCachedKey = cachedKeyById.get(normalized);
    if (priorCachedKey !== undefined && priorCachedKey !== model) delete merged[priorCachedKey];
    // JSON cache由来のモデルIDをdata keyとして扱う。`__proto__`でもprototype setterを起動しない。
    Object.defineProperty(merged, model, {
      value: modelPrice,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    cachedKeyById.set(normalized, model);
  }
  return merged;
}

function toFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// LiteLLM 取り込みで採用する OpenAI 系モデルキー(gpt-* / o3 / o3-* / codex-*)
const LITELLM_OPENAI_KEY_RE = /^(gpt-|o3($|-)|codex-)/;

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

    // OpenAI(Codex CLI 対応): provider が 'openai' のエントリは gpt-/o3/codex- 系キーのみ採用する。
    // OpenAI にはキャッシュ書き込み課金が無いため write 系は 0(cacheRead は無ければ 0)。
    if (provider === 'openai') {
      const key = rawKey.toLowerCase();
      if (!LITELLM_OPENAI_KEY_RE.test(key)) continue;

      const inputRaw = toFiniteNumber(entry.input_cost_per_token);
      const outputRaw = toFiniteNumber(entry.output_cost_per_token);
      if (inputRaw === null || inputRaw <= 0) continue;
      if (outputRaw === null || outputRaw <= 0) continue;

      const cacheReadRaw = toFiniteNumber(entry.cache_read_input_token_cost);

      table[key] = {
        input: inputRaw * 1_000_000,
        output: outputRaw * 1_000_000,
        cacheRead: cacheReadRaw !== null ? cacheReadRaw * 1_000_000 : 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        source: 'litellm',
      };
      continue;
    }

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
    return mergePriceTables(builtin, cached.table, true);
  }

  if (opts?.offline === true) {
    return cached !== null ? mergePriceTables(builtin, cached.table, false) : builtin;
  }

  try {
    const remoteTable = await fetchLiteLLMPriceTable();
    await writePriceCache(cacheDir, remoteTable);
    return mergePriceTables(builtin, remoteTable, true);
  } catch {
    return cached !== null ? mergePriceTables(builtin, cached.table, false) : builtin;
  }
}
