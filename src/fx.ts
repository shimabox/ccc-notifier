import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, FxResult } from './types';

// Stop hook 経路(応答完了ごと)から呼ばれる。速度最優先・この関数は絶対に throw しない。

const FETCH_TIMEOUT_MS = 1500;
const CACHE_FILE_NAME = 'fx.json';

// frankfurter.dev → open.er-api.com の順で試行。どちらも { rates: { JPY: number } } 形状。
const FX_SOURCES = [
  'https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY',
  'https://open.er-api.com/v6/latest/USD',
] as const;

interface FxCache {
  rate: number;
  fetchedAt: string;
}

function cacheFilePath(cacheDir: string): string {
  return join(cacheDir, CACHE_FILE_NAME);
}

function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function parseFxCache(raw: unknown): FxCache | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!isPositiveFiniteNumber(obj.rate)) return null;
  if (typeof obj.fetchedAt !== 'string') return null;
  return { rate: obj.rate, fetchedAt: obj.fetchedAt };
}

async function readFxCache(cacheDir: string): Promise<FxCache | null> {
  try {
    const raw = await readFile(cacheFilePath(cacheDir), 'utf8');
    return parseFxCache(JSON.parse(raw) as unknown);
  } catch {
    // 不在・読取失敗・破損JSON・形状不正のいずれも「キャッシュ無し」として扱う
    return null;
  }
}

async function writeFxCache(cacheDir: string, cache: FxCache): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFilePath(cacheDir), JSON.stringify(cache), 'utf8');
  } catch {
    // 保存に失敗しても取得済みレートは返せるため握りつぶす
  }
}

function isFresh(fetchedAt: string, cacheHours: number): boolean {
  const fetchedMs = Date.parse(fetchedAt);
  if (Number.isNaN(fetchedMs)) return false;
  const ageMs = Date.now() - fetchedMs;
  return ageMs <= cacheHours * 60 * 60 * 1000;
}

function extractJpyRate(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const rates = (json as Record<string, unknown>).rates;
  if (typeof rates !== 'object' || rates === null) return null;
  const jpy = (rates as Record<string, unknown>).JPY;
  return isPositiveFiniteNumber(jpy) ? jpy : null;
}

async function fetchJpyRate(url: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const json: unknown = await res.json();
    return extractJpyRate(json);
  } catch {
    // タイムアウト(AbortError)・ネットワークエラー・JSON解析失敗のいずれも次のソースへ
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getUsdJpy(cfg: Config, cacheDir: string): Promise<FxResult> {
  const cache = await readFxCache(cacheDir);

  if (cache && isFresh(cache.fetchedAt, cfg.fx.cacheHours)) {
    return { rate: cache.rate, source: 'cache', fetchedAt: cache.fetchedAt };
  }

  for (const url of FX_SOURCES) {
    const rate = await fetchJpyRate(url);
    if (rate !== null) {
      const fetchedAt = new Date().toISOString();
      await writeFxCache(cacheDir, { rate, fetchedAt });
      return { rate, source: 'live', fetchedAt };
    }
  }

  if (cache) {
    // 期限切れだが無いよりはまし。取得時刻はキャッシュ本来の値を維持する。
    return { rate: cache.rate, source: 'cache', fetchedAt: cache.fetchedAt };
  }

  return { rate: cfg.fx.fallbackRate, source: 'fixed', fetchedAt: new Date().toISOString() };
}
