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

  it('resolvePrice returns null for an unknown model id', () => {
    expect(resolvePrice('gpt-5', table)).toBeNull();
  });

  it('computeCost puts unknown models in unknownModels at 0 cost, without duplicates', () => {
    const main: UsageByModel = {
      'gpt-5': { input: 100, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    };
    const sidechain: UsageByModel = {
      'gpt-5': { input: 50, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    };

    const result = computeCost(main, sidechain, table);

    expect(result.usd).toBe(0);
    expect(result.unknownModels).toEqual(['gpt-5']);
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
        'gpt-4': {
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

    expect(table['gpt-4']).toBeUndefined();
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
