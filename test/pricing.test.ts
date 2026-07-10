import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinPriceTable, resolvePrice, computeCost, loadPriceTable } from '../src/pricing';
import type { UsageByModel, PriceTable } from '../src/types';

function fakeResponse(body: unknown, ok = true, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok, status, json: async () => body };
}

describe('computeCost against GOLDEN.md bucket values', () => {
  it('fable-5 main / haiku-4-5 sidechain add up to 0.267 USD', () => {
    const table = builtinPriceTable();
    const main: UsageByModel = {
      'claude-fable-5': { input: 100, output: 200, cacheWrite5m: 0, cacheWrite1h: 10000, cacheRead: 50000 },
    };
    const sidechain: UsageByModel = {
      'claude-haiku-4-5': { input: 1000, output: 500, cacheWrite5m: 2000, cacheWrite1h: 0, cacheRead: 0 },
    };

    const result = computeCost(main, sidechain, table);

    expect(result.byModel['claude-fable-5']).toBeCloseTo(0.261, 10);
    expect(result.byModel['claude-haiku-4-5']).toBeCloseTo(0.006, 10);
    expect(result.usd).toBeCloseTo(0.267, 10);
    expect(result.unknownModels).toEqual([]);
  });
});

describe('resolvePrice: normalization', () => {
  const table = builtinPriceTable();

  it('resolves a date-suffixed model id', () => {
    const p = resolvePrice('claude-sonnet-4-5-20250929', table);
    expect(p).toEqual(table['claude-sonnet-4-5']);
  });

  it('resolves a [1m] suffixed model id', () => {
    const p = resolvePrice('claude-fable-5[1m]', table);
    expect(p).toEqual(table['claude-fable-5']);
  });

  it('resolves an anthropic/-prefixed model id', () => {
    const p = resolvePrice('anthropic/claude-3-5-sonnet-20241022', table);
    expect(p).toEqual(table['claude-3-5-sonnet']);
  });
});

describe('resolvePrice: longest-prefix match', () => {
  const table = builtinPriceTable();

  it('claude-opus-4-8-20260101 resolves to claude-opus-4-8 (5/25), not claude-opus-4 (15/75)', () => {
    const p = resolvePrice('claude-opus-4-8-20260101', table);
    expect(p?.input).toBe(5);
    expect(p?.output).toBe(25);
  });

  it('claude-opus-4-20250514 resolves to claude-opus-4 (15/75)', () => {
    const p = resolvePrice('claude-opus-4-20250514', table);
    expect(p?.input).toBe(15);
    expect(p?.output).toBe(75);
  });
});

describe('unknown models', () => {
  const table = builtinPriceTable();

  // OpenAI 対応で gpt-* は既知モデルになったため、フィクスチャを架空 ID に変更(2026-07-10)

  it('resolvePrice returns null for an unknown model id', () => {
    expect(resolvePrice('unknown-model-xyz', table)).toBeNull();
  });

  it('computeCost puts unknown models in unknownModels at 0 cost, without duplicates', () => {
    const main: UsageByModel = {
      'unknown-model-xyz': { input: 100, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    };
    const sidechain: UsageByModel = {
      'unknown-model-xyz': { input: 50, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    };

    const result = computeCost(main, sidechain, table);

    expect(result.usd).toBe(0);
    expect(result.unknownModels).toEqual(['unknown-model-xyz']);
  });
});

describe('loadPriceTable', () => {
  let cacheDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cccn-pricing-test-'));
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('(a) converts $/token to $/MTok and applies fallback factors for missing cache prices', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        'claude-test-model': {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
          litellm_provider: 'anthropic',
          // no cache_* fields -> exercise fallback factors (x0.1 / x1.25 / x2)
        },
        'anthropic/claude-test-model-2': {
          input_cost_per_token: 0.00001,
          output_cost_per_token: 0.00002,
          cache_read_input_token_cost: 0.000002,
          cache_creation_input_token_cost: 0.0000125,
          cache_creation_input_token_cost_above_1hr: 0.00002,
        },
        // OpenAI 対応で gpt-* は既知になったため架空 ID に変更(2026-07-10)
        'unknown-model-xyz': {
          input_cost_per_token: 0.00001,
          output_cost_per_token: 0.00003,
          litellm_provider: 'openai',
        },
        'claude-zero-cost': {
          input_cost_per_token: 0,
          output_cost_per_token: 0.00001,
        },
      }),
    );

    const table = await loadPriceTable(cacheDir);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const testModel = table['claude-test-model'];
    expect(testModel.source).toBe('litellm');
    expect(testModel.input).toBeCloseTo(3, 10);
    expect(testModel.output).toBeCloseTo(15, 10);
    expect(testModel.cacheRead).toBeCloseTo(0.3, 10); // fallback input x 0.1
    expect(testModel.cacheWrite5m).toBeCloseTo(3.75, 10); // fallback input x 1.25
    expect(testModel.cacheWrite1h).toBeCloseTo(6, 10); // fallback input x 2

    const testModel2 = table['claude-test-model-2'];
    expect(testModel2.source).toBe('litellm');
    expect(testModel2.input).toBeCloseTo(10, 10);
    expect(testModel2.output).toBeCloseTo(20, 10);
    expect(testModel2.cacheRead).toBeCloseTo(2, 10);
    expect(testModel2.cacheWrite5m).toBeCloseTo(12.5, 10);
    expect(testModel2.cacheWrite1h).toBeCloseTo(20, 10);

    expect(table['unknown-model-xyz']).toBeUndefined();
    expect(table['claude-zero-cost']).toBeUndefined();

    // builtin entries survive the merge
    expect(table['claude-fable-5']).toEqual(builtinPriceTable()['claude-fable-5']);

    // cache file persisted with litellm-only entries (not merged with builtin)
    const cacheRaw = await fs.readFile(path.join(cacheDir, 'pricing.json'), 'utf8');
    const cached = JSON.parse(cacheRaw) as { fetchedAt: string; table: PriceTable };
    expect(typeof cached.fetchedAt).toBe('string');
    expect(Number.isNaN(Date.parse(cached.fetchedAt))).toBe(false);
    expect(cached.table['claude-test-model']).toBeDefined();
    expect(cached.table['claude-fable-5']).toBeUndefined();
  });

  it('(b) litellm entries override builtin entries for the same key', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        'claude-sonnet-4-5': {
          input_cost_per_token: 0.000999,
          output_cost_per_token: 0.001999,
          litellm_provider: 'anthropic',
        },
      }),
    );

    const table = await loadPriceTable(cacheDir);

    expect(table['claude-sonnet-4-5'].source).toBe('litellm');
    expect(table['claude-sonnet-4-5'].input).toBeCloseTo(999, 10);
    expect(table['claude-sonnet-4-5'].output).toBeCloseTo(1999, 10);
  });

  it('(c) falls back to an expired cache when fetch fails', async () => {
    const staleFetchedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const staleTable: PriceTable = {
      'claude-stale-model': {
        input: 42,
        output: 84,
        cacheWrite5m: 1,
        cacheWrite1h: 2,
        cacheRead: 3,
        source: 'litellm',
      },
    };
    await fs.writeFile(
      path.join(cacheDir, 'pricing.json'),
      JSON.stringify({ fetchedAt: staleFetchedAt, table: staleTable }),
      'utf8',
    );

    fetchMock.mockRejectedValue(new Error('network down'));

    const table = await loadPriceTable(cacheDir);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(table['claude-stale-model']).toEqual(staleTable['claude-stale-model']);
    expect(table['claude-fable-5']).toEqual(builtinPriceTable()['claude-fable-5']);
  });

  it('(d) offline:true never calls fetch and merges a stale cache when present', async () => {
    const staleFetchedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const staleTable: PriceTable = {
      'claude-offline-model': {
        input: 7,
        output: 8,
        cacheWrite5m: 9,
        cacheWrite1h: 10,
        cacheRead: 11,
        source: 'litellm',
      },
    };
    await fs.writeFile(
      path.join(cacheDir, 'pricing.json'),
      JSON.stringify({ fetchedAt: staleFetchedAt, table: staleTable }),
      'utf8',
    );

    const table = await loadPriceTable(cacheDir, { offline: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(table['claude-offline-model']).toEqual(staleTable['claude-offline-model']);
    expect(table['claude-fable-5']).toEqual(builtinPriceTable()['claude-fable-5']);
  });

  it('(d2) offline:true with no cache present returns builtin only', async () => {
    const table = await loadPriceTable(cacheDir, { offline: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(table).toEqual(builtinPriceTable());
  });

  it('(e) a cache within 24h is used without calling fetch', async () => {
    const freshFetchedAt = new Date().toISOString();
    const freshTable: PriceTable = {
      'claude-fresh-model': {
        input: 1,
        output: 2,
        cacheWrite5m: 3,
        cacheWrite1h: 4,
        cacheRead: 5,
        source: 'litellm',
      },
    };
    await fs.writeFile(
      path.join(cacheDir, 'pricing.json'),
      JSON.stringify({ fetchedAt: freshFetchedAt, table: freshTable }),
      'utf8',
    );

    const table = await loadPriceTable(cacheDir);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(table['claude-fresh-model']).toEqual(freshTable['claude-fresh-model']);
  });
});

// OpenAI Codex CLI 対応(2026-07-10 契約追加分)

describe('builtin OpenAI (Codex CLI) pricing', () => {
  const table = builtinPriceTable();

  it('gpt-5.5 / gpt-5.1 / gpt-5 / gpt-5-codex / gpt-5.1-codex / o3 have the contracted USD/1M rates', () => {
    expect(table['gpt-5.5']).toEqual({
      input: 5,
      output: 30,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0.5,
      source: 'builtin',
    });
    expect(table['gpt-5.1']).toEqual({
      input: 1.25,
      output: 10,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0.125,
      source: 'builtin',
    });
    expect(table['gpt-5']).toEqual({
      input: 1.25,
      output: 10,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0.125,
      source: 'builtin',
    });
    expect(table['gpt-5-codex']).toEqual({
      input: 1.25,
      output: 10,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0.125,
      source: 'builtin',
    });
    expect(table['gpt-5.1-codex']).toEqual({
      input: 1.25,
      output: 10,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0.125,
      source: 'builtin',
    });
    expect(table['o3']).toEqual({
      input: 2,
      output: 8,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0.5,
      source: 'builtin',
    });
  });
});

describe('resolvePrice: OpenAI (Codex) longest-prefix match', () => {
  const table = builtinPriceTable();

  it('gpt-5.5-codex-mini and gpt-5.5-xyz both fall back to the gpt-5.5 entry (no dedicated gpt-5.5-codex entry exists)', () => {
    const base = table['gpt-5.5'];
    expect(resolvePrice('gpt-5.5-codex-mini', table)).toEqual(base);
    expect(resolvePrice('gpt-5.5-xyz', table)).toEqual(base);
  });

  it('o3-mini resolves to the o3 entry via prefix match', () => {
    expect(resolvePrice('o3-mini', table)).toEqual(table['o3']);
  });
});

describe('loadPriceTable: litellm OpenAI (Codex CLI) entries', () => {
  let cacheDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cccn-pricing-openai-'));
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('(c) adopts openai gpt-/codex- entries, keeps anthropic claude, and excludes keys not matching the regex', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        'claude-test-model': {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
          litellm_provider: 'anthropic',
        },
        'gpt-5.5': {
          input_cost_per_token: 0.000005,
          output_cost_per_token: 0.00003,
          cache_read_input_token_cost: 0.0000005,
          litellm_provider: 'openai',
        },
        'gpt-5.1-codex': {
          // cache_read_input_token_cost 無し → cacheRead は 0(claude 系の x0.1 フォールバックは適用しない)
          input_cost_per_token: 0.00000125,
          output_cost_per_token: 0.00001,
          litellm_provider: 'openai',
        },
        'codex-mini-latest': {
          input_cost_per_token: 0.0000015,
          output_cost_per_token: 0.000006,
          litellm_provider: 'openai',
        },
        'text-embedding-3-small': {
          input_cost_per_token: 0.00000002,
          output_cost_per_token: 0.00000001,
          litellm_provider: 'openai',
        },
        'gpt-no-output': {
          input_cost_per_token: 0.000001,
          litellm_provider: 'openai',
        },
      }),
    );

    const table = await loadPriceTable(cacheDir);

    // openai エントリが USD/MTok 換算で採用される(write 系は 0)
    const gpt55 = table['gpt-5.5'];
    expect(gpt55.source).toBe('litellm');
    expect(gpt55.input).toBeCloseTo(5, 10);
    expect(gpt55.output).toBeCloseTo(30, 10);
    expect(gpt55.cacheRead).toBeCloseTo(0.5, 10);
    expect(gpt55.cacheWrite5m).toBe(0);
    expect(gpt55.cacheWrite1h).toBe(0);

    // cache_read_input_token_cost 欠損 → cacheRead 0
    const codex51 = table['gpt-5.1-codex'];
    expect(codex51.source).toBe('litellm');
    expect(codex51.input).toBeCloseTo(1.25, 10);
    expect(codex51.output).toBeCloseTo(10, 10);
    expect(codex51.cacheRead).toBe(0);
    expect(codex51.cacheWrite5m).toBe(0);
    expect(codex51.cacheWrite1h).toBe(0);

    // codex- プレフィックスも採用対象
    expect(table['codex-mini-latest'].source).toBe('litellm');

    // anthropic の claude 系は従来どおり採用される
    const claude = table['claude-test-model'];
    expect(claude.source).toBe('litellm');
    expect(claude.input).toBeCloseTo(3, 10);
    expect(claude.output).toBeCloseTo(15, 10);

    // 正規表現に合わない openai キー・output 欠損のエントリは除外される
    expect(table['text-embedding-3-small']).toBeUndefined();
    expect(table['gpt-no-output']).toBeUndefined();
  });

  it('(d) adopts openai o3 (overriding builtin) and o3-mini resolves to it by prefix', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        'o3': {
          input_cost_per_token: 0.000004,
          output_cost_per_token: 0.000016,
          cache_read_input_token_cost: 0.000001,
          litellm_provider: 'openai',
        },
      }),
    );

    const table = await loadPriceTable(cacheDir);

    const o3 = table['o3'];
    expect(o3.source).toBe('litellm');
    expect(o3.input).toBeCloseTo(4, 10);
    expect(o3.output).toBeCloseTo(16, 10);
    expect(o3.cacheRead).toBeCloseTo(1, 10);
    expect(o3.cacheWrite5m).toBe(0);
    expect(o3.cacheWrite1h).toBe(0);

    // litellm の o3 が builtin の o3 を上書きし、o3-mini はプレフィックス一致でそれを解決する
    expect(resolvePrice('o3-mini', table)).toEqual(o3);
  });
});
