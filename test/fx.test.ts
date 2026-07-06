import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getUsdJpy } from '../src/fx';
import type { Config } from '../src/types';

function makeConfig(fxOverrides?: Partial<Config['fx']>): Config {
  return {
    notify: { os: true, slack: null },
    minNotifyUSD: 0,
    costLabel: 'api_equivalent',
    fx: { fallbackRate: 150, cacheHours: 12, ...fxOverrides },
    includeDailyTotal: true,
  };
}

function frankfurterResponse(rate: number) {
  return { json: async () => ({ amount: 1, base: 'USD', date: '2026-07-06', rates: { JPY: rate } }) };
}

function erApiResponse(rate: number) {
  return { json: async () => ({ result: 'success', base_code: 'USD', rates: { JPY: rate } }) };
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'acn-fx-test-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cacheFilePath(): string {
  return join(cacheDir, 'fx.json');
}

function seedCache(rate: number, fetchedAt: string): void {
  writeFileSync(cacheFilePath(), JSON.stringify({ rate, fetchedAt }), 'utf8');
}

describe('getUsdJpy', () => {
  it('1. フレッシュキャッシュがあれば fetch を一度も呼ばず source:cache を返す', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fetchedAt = new Date().toISOString();
    seedCache(160.5, fetchedAt);

    const result = await getUsdJpy(makeConfig(), cacheDir);

    expect(result).toEqual({ rate: 160.5, source: 'cache', fetchedAt });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2. キャッシュが無く1次APIが成功すれば source:live で返しキャッシュに保存する', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(frankfurterResponse(157.25));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getUsdJpy(makeConfig(), cacheDir);

    expect(result.source).toBe('live');
    expect(result.rate).toBe(157.25);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(readFileSync(cacheFilePath(), 'utf8')) as { rate: number; fetchedAt: string };
    expect(saved.rate).toBe(157.25);
    expect(saved.fetchedAt).toBe(result.fetchedAt);
  });

  it('3. 1次が失敗(ネットワークエラー)しても2次が成功すれば source:live', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(erApiResponse(159.9));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getUsdJpy(makeConfig(), cacheDir);

    expect(result.source).toBe('live');
    expect(result.rate).toBe(159.9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('4. 両方失敗+期限切れキャッシュありならそのレートで source:cache を返す', async () => {
    const staleFetchedAt = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    seedCache(140, staleFetchedAt);
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getUsdJpy(makeConfig(), cacheDir);

    expect(result).toEqual({ rate: 140, source: 'cache', fetchedAt: staleFetchedAt });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('5. 両方失敗+キャッシュ無しなら cfg.fx.fallbackRate で source:fixed', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getUsdJpy(makeConfig({ fallbackRate: 152 }), cacheDir);

    expect(result.source).toBe('fixed');
    expect(result.rate).toBe(152);
    expect(typeof result.fetchedAt).toBe('string');
  });

  it('6. 1次がタイムアウト相当(AbortError)でも2次へ進む', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(frankfurterResponse(158));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getUsdJpy(makeConfig(), cacheDir);

    expect(result.source).toBe('live');
    expect(result.rate).toBe(158);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('7. JPYがNaN/負数のレスポンスは失敗扱いで次のソースへ進む', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ rates: { JPY: NaN } }) })
      .mockResolvedValueOnce({ json: async () => ({ rates: { JPY: -10 } }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getUsdJpy(makeConfig({ fallbackRate: 145 }), cacheDir);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe('fixed');
    expect(result.rate).toBe(145);
  });

  it('8. 破損キャッシュファイル(不正JSON)でも throw せずフォールバックする', async () => {
    writeFileSync(cacheFilePath(), '{ this is not valid json', 'utf8');
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUsdJpy(makeConfig({ fallbackRate: 149 }), cacheDir)).resolves.toEqual({
      rate: 149,
      source: 'fixed',
      fetchedAt: expect.any(String),
    });
  });
});
