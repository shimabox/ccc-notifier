import { describe, it, expect } from 'vitest';
import { modelDisplayName } from '../src/format';

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
