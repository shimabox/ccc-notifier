import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateNewTurn } from '../src/transcript';
import type { Cursor, TokenBuckets } from '../src/types';

// Shared golden fixture (read-only). Anything that mutates a transcript works on
// a copy under os.tmpdir() instead.
const FIXTURE = fileURLToPath(new URL('./fixtures/transcript-basic.jsonl', import.meta.url));
const NEWLINE_BYTE = 0x0a;

// ---- builders -------------------------------------------------------------

function usageNew(
  input: number,
  output: number,
  cacheRead = 0,
  w5 = 0,
  w1 = 0,
): Record<string, unknown> {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
  };
}

function asst(o: {
  id: string;
  req: string;
  usage: Record<string, unknown>;
  model?: string;
  sidechain?: boolean;
  uuid?: string;
  ts?: string;
}): Record<string, unknown> {
  return {
    type: 'assistant',
    isSidechain: o.sidechain ?? false,
    requestId: o.req,
    sessionId: 'sess-x',
    cwd: '/work',
    gitBranch: 'branch-x',
    uuid: o.uuid ?? o.id,
    timestamp: o.ts ?? '2026-07-06T00:00:00.000Z',
    message: {
      id: o.id,
      type: 'message',
      role: 'assistant',
      model: o.model ?? 'claude-fable-5',
      content: [{ type: 'text', text: 'x' }],
      usage: o.usage,
    },
  };
}

function userLine(o: {
  content: unknown;
  sidechain?: boolean;
  uuid?: string;
  ts?: string;
}): Record<string, unknown> {
  return {
    type: 'user',
    isSidechain: o.sidechain ?? false,
    uuid: o.uuid ?? 'u',
    timestamp: o.ts ?? '2026-07-06T00:00:00.000Z',
    message: { role: 'user', content: o.content },
  };
}

async function writeJsonl(file: string, objs: unknown[]): Promise<void> {
  await fs.writeFile(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

const ZERO: TokenBuckets = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

// ---- suite ----------------------------------------------------------------

describe('aggregateNewTurn', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cccn-transcript-test-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // 1. basic: fixture with a null cursor must reproduce every GOLDEN value.
  it('1. aggregates the golden fixture', async () => {
    const r = await aggregateNewTurn(FIXTURE, null);
    expect(r).not.toBeNull();
    if (r === null) return;

    expect(r.apiCalls).toBe(2); // msg_A appears on two rows but dedupes to one
    expect(r.prompt).toBe('テスト用プロンプトです');
    expect(r.sessionId).toBe('sess-1');
    expect(r.cwd).toBe('/tmp/proj');
    expect(r.gitBranch).toBe('main');

    expect(Object.keys(r.main)).toEqual(['claude-fable-5']);
    expect(Object.keys(r.sidechain)).toEqual(['claude-haiku-4-5']);
    expect(r.main['claude-fable-5']).toEqual({
      input: 100,
      output: 200,
      cacheWrite5m: 0,
      cacheWrite1h: 10000,
      cacheRead: 50000,
    });
    expect(r.sidechain['claude-haiku-4-5']).toEqual({
      input: 1000,
      output: 500,
      cacheWrite5m: 2000,
      cacheWrite1h: 0,
      cacheRead: 0,
    });

    // both deduped keys are remembered for next time
    expect(r.newCursor.seenMessageKeys).toEqual(
      expect.arrayContaining(['msg_A:req_A', 'msg_B:req_B']),
    );
  });

  // 2. cursor continuation: a fresh assistant row appended after run 1 is the
  //    only thing counted on run 2.
  it('2. continues from the cursor and counts only new rows', async () => {
    const f = path.join(dir, 't.jsonl');
    await writeJsonl(f, [asst({ id: 'msg_X', req: 'req_X', usage: usageNew(10, 20) })]);

    const r1 = await aggregateNewTurn(f, null);
    expect(r1).not.toBeNull();
    if (r1 === null) return;
    expect(r1.apiCalls).toBe(1);
    expect(r1.main['claude-fable-5']).toEqual({ ...ZERO, input: 10, output: 20 });

    // cursor sits exactly at EOF (file ends with a newline) -> normal mode next
    const size1 = (await fs.stat(f)).size;
    expect(r1.newCursor.offset).toBe(size1);

    await fs.appendFile(
      f,
      JSON.stringify(asst({ id: 'msg_Y', req: 'req_Y', usage: usageNew(5, 7), ts: '2026-07-06T00:00:02.000Z' })) + '\n',
    );

    const r2 = await aggregateNewTurn(f, r1.newCursor);
    expect(r2).not.toBeNull();
    if (r2 === null) return;
    expect(r2.apiCalls).toBe(1);
    expect(r2.main['claude-fable-5']).toEqual({ ...ZERO, input: 5, output: 7 });
  });

  // 3. duplicate skip: re-appending an already-seen message id + requestId
  //    yields null on the next run.
  it('3. skips a duplicated (id, requestId) row -> null', async () => {
    const f = path.join(dir, 't.jsonl');
    const row = asst({ id: 'msg_A', req: 'req_A', usage: usageNew(10, 20) });
    await writeJsonl(f, [row]);

    const r1 = await aggregateNewTurn(f, null);
    expect(r1).not.toBeNull();
    if (r1 === null) return;
    expect(r1.apiCalls).toBe(1);
    expect(r1.newCursor.seenMessageKeys).toContain('msg_A:req_A');

    // same id + requestId, different uuid/timestamp (Claude Code really does this)
    await fs.appendFile(
      f,
      JSON.stringify(asst({ id: 'msg_A', req: 'req_A', usage: usageNew(10, 20), uuid: 'dup', ts: '2026-07-06T00:01:00.000Z' })) + '\n',
    );

    const r2 = await aggregateNewTurn(f, r1.newCursor);
    expect(r2).toBeNull();
  });

  // 4. corrupt cursor: a bad offset forces a rescan that must not double-count.
  it('4. survives a corrupt cursor without double-counting', async () => {
    const r1 = await aggregateNewTurn(FIXTURE, null);
    expect(r1).not.toBeNull();
    if (r1 === null) return;

    const buf = await fs.readFile(FIXTURE);
    const size = buf.length;
    const midOffset = Math.max(1, Math.floor(buf.indexOf(NEWLINE_BYTE) / 2)); // inside line 1

    // (a) offset past EOF, real lastTs + seenKeys -> both guards active
    const beyond: Cursor = {
      offset: size + 100,
      lastUuid: r1.newCursor.lastUuid,
      lastTs: r1.newCursor.lastTs,
      seenMessageKeys: r1.newCursor.seenMessageKeys,
    };
    expect(await aggregateNewTurn(FIXTURE, beyond)).toBeNull();

    // (b) offset in the middle of a line -> rescan
    const midline: Cursor = { ...beyond, offset: midOffset };
    expect(await aggregateNewTurn(FIXTURE, midline)).toBeNull();

    // (c) lastTs nulled out: only the seenMessageKeys guard can prevent the
    //     double count now, which is exactly what this test is about.
    const keysOnly: Cursor = {
      offset: size + 100,
      lastUuid: null,
      lastTs: null,
      seenMessageKeys: r1.newCursor.seenMessageKeys,
    };
    expect(await aggregateNewTurn(FIXTURE, keysOnly)).toBeNull();
  });

  // 5. half-written tail: a final line with no newline is ignored until it is
  //    completed, then counted.
  it('5. ignores a half-written final line, counts it once completed', async () => {
    const f = path.join(dir, 't.jsonl');
    const lineA = JSON.stringify(asst({ id: 'msg_M', req: 'req_M', usage: usageNew(1, 2) }));
    const fullB = JSON.stringify(
      asst({ id: 'msg_N', req: 'req_N', usage: usageNew(3, 4), ts: '2026-07-06T00:00:02.000Z' }),
    );
    const partialB = fullB.slice(0, 25); // truncated, and no trailing newline

    await fs.writeFile(f, lineA + '\n' + partialB);

    const r1 = await aggregateNewTurn(f, null);
    expect(r1).not.toBeNull();
    if (r1 === null) return;
    expect(r1.apiCalls).toBe(1); // only msg_M
    expect(r1.main['claude-fable-5']).toEqual({ ...ZERO, input: 1, output: 2 });
    // cursor points at the first byte of the half-written line
    expect(r1.newCursor.offset).toBe(Buffer.byteLength(lineA + '\n'));

    // now finish the line and add its newline
    await fs.writeFile(f, lineA + '\n' + fullB + '\n');

    const r2 = await aggregateNewTurn(f, r1.newCursor);
    expect(r2).not.toBeNull();
    if (r2 === null) return;
    expect(r2.apiCalls).toBe(1); // only msg_N
    expect(r2.main['claude-fable-5']).toEqual({ ...ZERO, input: 3, output: 4 });
  });

  // 6. prompt extraction: tool_result rows, "<"-prefixed rows and sidechain user
  //    rows are all ignored; the last real prompt wins.
  it('6. extracts the last real user prompt only', async () => {
    const f = path.join(dir, 't.jsonl');
    await writeJsonl(f, [
      userLine({ content: '古いプロンプト', uuid: 'u1', ts: '2026-07-06T00:00:01.000Z' }),
      // array of text blocks joined with "\n" -> the last valid candidate
      userLine({
        content: [
          { type: 'text', text: '新しい' },
          { type: 'text', text: 'プロンプト' },
        ],
        uuid: 'u2',
        ts: '2026-07-06T00:00:02.000Z',
      }),
      // has a tool_result block -> excluded even though it also has text
      userLine({
        content: [
          { type: 'text', text: 'ツール結果テキストは無視' },
          { type: 'tool_result', tool_use_id: 't', content: 'ok' },
        ],
        uuid: 'u3',
        ts: '2026-07-06T00:00:03.000Z',
      }),
      // pseudo message -> excluded by the "<" rule
      userLine({ content: '<command-name>/foo</command-name>', uuid: 'u4', ts: '2026-07-06T00:00:04.000Z' }),
      // sub-agent instruction -> excluded by isSidechain
      userLine({ content: 'サブエージェントへの指示', sidechain: true, uuid: 'u5', ts: '2026-07-06T00:00:05.000Z' }),
      // makes the turn non-null
      asst({ id: 'msg_P', req: 'req_P', usage: usageNew(1, 1), ts: '2026-07-06T00:00:06.000Z' }),
    ]);

    const r = await aggregateNewTurn(f, null);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.apiCalls).toBe(1);
    expect(r.prompt).toBe('新しい\nプロンプト');
  });

  // 7. resilience: empty file / missing path -> null; a corrupt JSON line is
  //    skipped while valid lines still count.
  it('7. handles empty, missing and corrupt inputs', async () => {
    const empty = path.join(dir, 'empty.jsonl');
    await fs.writeFile(empty, '');
    expect(await aggregateNewTurn(empty, null)).toBeNull();

    expect(await aggregateNewTurn(path.join(dir, 'does-not-exist.jsonl'), null)).toBeNull();

    const mixed = path.join(dir, 'mixed.jsonl');
    const broken = '{"type":"assistant","oops"'; // invalid JSON
    const valid = JSON.stringify(asst({ id: 'msg_Q', req: 'req_Q', usage: usageNew(9, 8) }));
    await fs.writeFile(mixed, broken + '\n' + valid + '\n');

    const r = await aggregateNewTurn(mixed, null);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.apiCalls).toBe(1);
    expect(r.main['claude-fable-5']).toEqual({ ...ZERO, input: 9, output: 8 });
  });

  // 8. legacy cache_creation: when there is no cache_creation object, the scalar
  //    cache_creation_input_tokens all lands in cacheWrite5m.
  it('8. maps legacy cache_creation_input_tokens into cacheWrite5m', async () => {
    const f = path.join(dir, 't.jsonl');
    await writeJsonl(f, [
      {
        type: 'assistant',
        isSidechain: false,
        requestId: 'req_O',
        uuid: 'ao',
        timestamp: '2026-07-06T00:00:01.000Z',
        message: {
          id: 'msg_O',
          role: 'assistant',
          model: 'claude-fable-5',
          content: [{ type: 'text', text: 'o' }],
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 7777, // legacy scalar, no cache_creation object
          },
        },
      },
    ]);

    const r = await aggregateNewTurn(f, null);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.main['claude-fable-5']).toEqual({
      input: 100,
      output: 200,
      cacheWrite5m: 7777,
      cacheWrite1h: 0,
      cacheRead: 50,
    });
  });

  // 9. synthetic model rows: client-generated placeholder assistant rows
  //    (message.model === "<synthetic>", usage often zero-filled) must never
  //    be counted as an API call, must never create a "<synthetic>" model key
  //    in main or sidechain, and must not affect normal rows' aggregates.
  it('9. ignores synthetic model rows without affecting normal aggregation', async () => {
    const f = path.join(dir, 't.jsonl');
    const syntheticUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    await writeJsonl(f, [
      userLine({ content: '実プロンプト', ts: '2026-07-06T00:00:01.000Z' }),
      asst({ id: 'msg_A1', req: 'req_A1', usage: usageNew(10, 20), ts: '2026-07-06T00:00:02.000Z' }),
      asst({
        id: 'msg_B1',
        req: 'req_B1',
        usage: usageNew(5, 6),
        model: 'claude-haiku-4-5',
        sidechain: true,
        ts: '2026-07-06T00:00:03.000Z',
      }),
      asst({
        id: 'msg_S1',
        req: 'req_S1',
        usage: syntheticUsage,
        model: '<synthetic>',
        ts: '2026-07-06T00:00:04.000Z',
      }),
      asst({
        id: 'msg_S2',
        req: 'req_S2',
        usage: syntheticUsage,
        model: '<synthetic>',
        sidechain: true,
        ts: '2026-07-06T00:00:05.000Z',
      }),
    ]);

    const r = await aggregateNewTurn(f, null);
    expect(r).not.toBeNull();
    if (r === null) return;

    // only the two normal rows count as API calls; the synthetic ones do not
    expect(r.apiCalls).toBe(2);
    expect(r.prompt).toBe('実プロンプト');

    // "<synthetic>" never appears as a model key in either bucket
    expect(Object.keys(r.main)).toEqual(['claude-fable-5']);
    expect(Object.keys(r.sidechain)).toEqual(['claude-haiku-4-5']);

    // normal rows' aggregates are unaffected by the synthetic rows
    expect(r.main['claude-fable-5']).toEqual({ ...ZERO, input: 10, output: 20 });
    expect(r.sidechain['claude-haiku-4-5']).toEqual({ ...ZERO, input: 5, output: 6 });

    // synthetic keys are not remembered either (never entered pending)
    expect(r.newCursor.seenMessageKeys).toEqual(
      expect.arrayContaining(['msg_A1:req_A1', 'msg_B1:req_B1']),
    );
    expect(r.newCursor.seenMessageKeys).not.toContain('msg_S1:req_S1');
    expect(r.newCursor.seenMessageKeys).not.toContain('msg_S2:req_S2');
  });
});
