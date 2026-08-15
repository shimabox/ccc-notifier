import { describe, it, expect } from 'vitest';
import { formatIngestSummary, modelDisplayName } from '../src/format';
import { DEFAULT_CONFIG } from '../src/types';

// OpenAI Codex CLI 対応(2026-07-10 契約追加分)

describe('modelDisplayName: OpenAI (Codex CLI) models', () => {
  it('formats bare gpt-5.x ids as "GPT-<version>"', () => {
    expect(modelDisplayName('gpt-5.5')).toBe('GPT-5.5');
    expect(modelDisplayName('gpt-5.1')).toBe('GPT-5.1');
    expect(modelDisplayName('gpt-5')).toBe('GPT-5');
  });

  it('formats -codex suffixed ids as "GPT-<version> Codex"', () => {
    expect(modelDisplayName('gpt-5.5-codex')).toBe('GPT-5.5 Codex');
    expect(modelDisplayName('gpt-5-codex')).toBe('GPT-5 Codex');
    expect(modelDisplayName('gpt-5.1-codex')).toBe('GPT-5.1 Codex');
  });

  it('leaves o3 unchanged', () => {
    expect(modelDisplayName('o3')).toBe('o3');
  });
});

describe('modelDisplayName: existing Claude formatting is unaffected', () => {
  it('still formats claude-haiku-4-5 as "Haiku 4.5"', () => {
    expect(modelDisplayName('claude-haiku-4-5')).toBe('Haiku 4.5');
  });
});

describe('formatIngestSummary: 合計トークン表示', () => {
  const base = {
    recordCount: 2,
    totalUSD: 0.5,
    totalJPY: 80,
    bySurface: { desktop: { turns: 2, usd: 0.5 } },
  };

  it('1. 総トークンとキャッシュ率を本文1行目に添える', () => {
    const { body } = formatIngestSummary(
      { ...base, totalTokens: 1_000_000, cacheTokens: 970_000 },
      DEFAULT_CONFIG,
    );
    expect(body.split('\n')[0]).toBe('desktop: 2件 $0.500 · 計 1.0M tokens(cache 97%)');
  });

  it('2. トークン0(該当レコード無し・旧データ)のときはトークン表記を出さない', () => {
    const { body } = formatIngestSummary({ ...base, totalTokens: 0, cacheTokens: 0 }, DEFAULT_CONFIG);
    expect(body.split('\n')[0]).toBe('desktop: 2件 $0.500');
    expect(body).not.toContain('tokens');
  });

  it('3. モデル不明で金額 $0 でもトークン数は表示される(Codex Desktop の total のみケース)', () => {
    const { title, body } = formatIngestSummary(
      {
        recordCount: 1,
        totalUSD: 0,
        totalJPY: 0,
        totalTokens: 54_141,
        cacheTokens: 54_141,
        bySurface: { desktop: { turns: 1, usd: 0 } },
      },
      DEFAULT_CONFIG,
    );
    expect(title).toContain('$0.0000');
    expect(body).toContain('計 54.1k tokens(cache 100%)');
  });
});
