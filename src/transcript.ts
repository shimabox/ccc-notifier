// T1: transcript aggregation.
//
// Claude Code writes an append-only JSONL transcript. `aggregateNewTurn` reads
// the portion of that file that has appeared since the previous cursor and
// aggregates token usage for the "turn" that just completed. Getting this wrong
// mis-reports every user's cost, so the logic below is deliberately defensive:
// corrupt lines, half-written tail lines, duplicated assistant rows and stale /
// broken cursors must never crash and must never double-count.

import { readFile } from 'node:fs/promises';
import type { Cursor, TokenBuckets, TurnAggregate, UsageByModel } from './types';

const NEWLINE = 0x0a; // '\n'
const MAX_SEEN_KEYS = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Non-finite / missing values collapse to 0 so a single bad field can't poison a sum. */
function numOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function addToModel(target: UsageByModel, model: string, b: TokenBuckets): void {
  const cur = target[model] ?? emptyBuckets();
  cur.input += b.input;
  cur.output += b.output;
  cur.cacheWrite5m += b.cacheWrite5m;
  cur.cacheWrite1h += b.cacheWrite1h;
  cur.cacheRead += b.cacheRead;
  target[model] = cur;
}

function extractBucket(usage: Record<string, unknown>): TokenBuckets {
  const input = numOf(usage.input_tokens);
  const output = numOf(usage.output_tokens);
  const cacheRead = numOf(usage.cache_read_input_tokens);

  let cacheWrite5m: number;
  let cacheWrite1h: number;
  const cc = usage.cache_creation;
  if (isRecord(cc)) {
    // Current format: cache creation split by TTL.
    cacheWrite5m = numOf(cc.ephemeral_5m_input_tokens);
    cacheWrite1h = numOf(cc.ephemeral_1h_input_tokens);
  } else {
    // Legacy format: a single scalar; treat all of it as the 5m bucket.
    cacheWrite5m = numOf(usage.cache_creation_input_tokens);
    cacheWrite1h = 0;
  }
  return { input, output, cacheWrite5m, cacheWrite1h, cacheRead };
}

/**
 * Turn a `user` message's `content` into a prompt candidate (raw / untrimmed),
 * or null if this row is not a real prompt:
 *  - string content  -> itself
 *  - array content   -> excluded entirely if it contains any tool_result block;
 *                       otherwise the text blocks joined with "\n"
 */
function promptCandidate(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let hasToolResult = false;
    const texts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') hasToolResult = true;
      else if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
    if (hasToolResult) return null;
    return texts.join('\n');
  }
  return null;
}

interface PendingMsg {
  model: string;
  isSidechain: boolean;
  bucket: TokenBuckets;
}

async function readAll(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null; // missing / unreadable file -> caller returns null, never throws
  }
}

export async function aggregateNewTurn(
  transcriptPath: string,
  cursor: Cursor | null,
): Promise<TurnAggregate | null> {
  const buffer = await readAll(transcriptPath);
  if (buffer === null) return null;
  const fileSize = buffer.length;

  // 1. Where do we start, and are we in normal (incremental) or rescan mode?
  //    Normal mode is only trusted when the cursor points exactly at a line
  //    boundary (the byte just before `offset` is a newline). Anything else
  //    (null cursor / offset 0 / offset past EOF / mid-line) falls back to a
  //    full read; when a cursor exists that full read is a "rescan" that must
  //    re-skip anything already accounted for.
  let startOffset: number;
  let rescan: boolean;
  if (
    cursor !== null &&
    cursor.offset > 0 &&
    cursor.offset <= fileSize &&
    buffer[cursor.offset - 1] === NEWLINE
  ) {
    startOffset = cursor.offset;
    rescan = false;
  } else {
    startOffset = 0;
    rescan = cursor !== null;
  }

  const seenKeys = new Set<string>(cursor?.seenMessageKeys ?? []);
  const tsFloor = cursor?.lastTs ?? null;

  const pending = new Map<string, PendingMsg>();
  let sessionId = '';
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let lastUuid: string | null = null;
  let prompt: string | null = null;

  const handleLine = (raw: string): void => {
    if (raw.trim().length === 0) return; // blank line
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return; // corrupt JSON: one bad line must not break the whole read
    }
    if (!isRecord(obj)) return;

    const ts = strOrNull(obj.timestamp);
    // Rescan guard #1 (timestamp lower bound): a line at or before the last
    // processed timestamp was already counted last time -> skip the whole line.
    if (rescan && tsFloor !== null && ts !== null && ts <= tsFloor) return;

    const isSide = obj.isSidechain === true;

    // 5. context (from every processed line)
    const sid = strOrNull(obj.sessionId);
    if (sid !== null) sessionId = sid;
    if (!isSide) {
      const c = strOrNull(obj.cwd);
      if (c !== null) cwd = c;
      const gb = strOrNull(obj.gitBranch);
      if (gb !== null) gitBranch = gb;
    }
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    const uuid = strOrNull(obj.uuid);
    if (uuid !== null) lastUuid = uuid;

    const type = obj.type;
    const message = isRecord(obj.message) ? obj.message : null;

    // 4. prompt extraction: real user prompts only (never sub-agent instructions)
    if (type === 'user' && !isSide && message !== null) {
      const cand = promptCandidate(message.content);
      if (cand !== null) {
        const t = cand.trim();
        // Reject empties and pseudo-messages such as <command-name>…</command-name>.
        if (t.length > 0 && !t.startsWith('<')) prompt = t;
      }
    }

    // 3. assistant usage accounting
    if (type === 'assistant' && message !== null) {
      const usage = message.usage;
      if (isRecord(usage)) {
        const id = strOrNull(message.id) ?? '';
        const reqId = strOrNull(obj.requestId) ?? '';
        const key = `${id}:${reqId}`;
        // Rescan guard #2 (seen keys): also the primary dedupe path in normal
        // mode. A key we have already accounted for is never counted again.
        if (!seenKeys.has(key)) {
          const model = strOrNull(message.model) ?? 'unknown';
          // Same key across duplicated rows: last write wins (identical or
          // corrected values), and it still only counts once.
          pending.set(key, { model, isSidechain: isSide, bucket: extractBucket(usage) });
        }
      }
    }
  };

  // 2. Walk byte-by-byte and process only newline-terminated lines. A trailing
  //    line without a newline is treated as still-being-written: it is not
  //    processed, and the cursor offset is left at its first byte so the next
  //    read re-reads it once complete. `lineStart` after the loop is exactly
  //    that offset (== fileSize when the file ends with a newline).
  let lineStart = startOffset;
  for (let pos = startOffset; pos < fileSize; pos++) {
    if (buffer[pos] !== NEWLINE) continue;
    handleLine(buffer.toString('utf8', lineStart, pos));
    lineStart = pos + 1;
  }
  const newOffset = lineStart;

  // 6. No newly-counted assistant messages -> nothing happened this turn.
  if (pending.size === 0) return null;

  const main: UsageByModel = {};
  const sidechain: UsageByModel = {};
  const newKeys: string[] = [];
  for (const [key, pm] of pending) {
    newKeys.push(key);
    if (pm.isSidechain) addToModel(sidechain, pm.model, pm.bucket);
    else addToModel(main, pm.model, pm.bucket);
  }

  // Ring buffer: previous keys followed by this turn's keys, newest kept.
  const combined = [...(cursor?.seenMessageKeys ?? []), ...newKeys];
  const seenMessageKeys =
    combined.length > MAX_SEEN_KEYS ? combined.slice(combined.length - MAX_SEEN_KEYS) : combined;

  return {
    sessionId,
    main,
    sidechain,
    apiCalls: pending.size,
    prompt,
    cwd,
    gitBranch,
    firstTs,
    lastTs,
    newCursor: {
      offset: newOffset,
      lastUuid,
      lastTs,
      seenMessageKeys,
    },
  };
}
