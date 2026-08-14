// src/counted-calls.ts — 「その API 呼び出しを計上済みか」を内容だけで決めるための指紋。
//
// カーソル(cursors.json)は「ファイルのどこまで読んだか」の目印であって、計上済みかどうかの
// 真実源ではない。カーソルが失われた瞬間に未計上と誤認され、同じ呼び出しが再び history へ
// 追記される。そこで history レコード自身に「このレコードで計上した呼び出しの指紋」を持たせ、
// 取り込み側は history から作った指紋集合を除外条件に使う。カーソルが壊れても、
// 同じ呼び出しが二度計上されない。
//
//  - Claude: 1 呼び出し = assistant メッセージ("<messageId>:<requestId>")。親ターンの分も
//    サブエージェント(agent-*.jsonl)の分も同じ名前空間で扱う。
//  - Codex: rollout に呼び出し単位の ID は無いので、token_count イベント1件を1呼び出しとみなし、
//    セッション ID + そのイベント行のバイトオフセット + 累積カウンタから指紋を作る。
//
// 指紋は sha256 の先頭 64bit(16 hex)。個人の履歴が取りうる規模では衝突確率が無視でき、
// 生キーをそのまま持つより history.jsonl の肥大を抑えられる。

import { createHash } from "node:crypto";
import type { TurnRecord } from "./types";

const FINGERPRINT_HEX = 16;

function sha256Hex(material: string): string {
  return createHash("sha256").update(material).digest("hex");
}

/** Claude の messageKey("<messageId>:<requestId>")→ 指紋。 */
export function callFingerprint(messageKey: string): string {
  return sha256Hex(`claude-call|${messageKey}`).slice(0, FINGERPRINT_HEX);
}

export function callFingerprints(messageKeys: Iterable<string>): string[] {
  const out: string[] = [];
  for (const key of messageKeys) out.push(callFingerprint(key));
  return out;
}

/**
 * Codex の 1 呼び出し(= token_count イベント1件)の指紋。
 *
 * rollout には呼び出し単位の ID が無いので、rollout 内で位置が確定している不変量から作る:
 * rollout ファイル名 + セッション ID + そのイベント行のファイル先頭からのバイトオフセット +
 * そのイベントが運ぶ累積カウンタ。rollout は追記専用なので、これらはどこから読み始めても
 * 変わらない(ターン境界の取り方・集計窓の広さ・取り込み経路に依存しない)。
 * ファイル名を素材に含めるのは、同じ session_id を持つ別 rollout が偶然同じオフセット・
 * 同じカウンタになったときに同一イベントと誤判定しないため。
 */
export function codexEventFingerprint(
  rolloutFile: string,
  sessionId: string,
  byteOffset: number,
  totals: { input: number; cached: number; output: number },
): string {
  const material = [
    "codex-event",
    rolloutFile,
    sessionId,
    byteOffset,
    totals.input,
    totals.cached,
    totals.output,
  ].join("|");
  return sha256Hex(material).slice(0, FINGERPRINT_HEX);
}

/**
 * レコードの一意キー(計上した呼び出し集合そのものから決まる)。
 * 呼び出しを1件も計上していないレコードは、内容で識別できないので undefined
 * (キーが無いレコードは重複判定の対象外 = 取りこぼさない側に倒す)。
 */
export function ingestKeyOf(fingerprints: readonly string[]): string | undefined {
  if (fingerprints.length === 0) return undefined;
  return sha256Hex([...fingerprints].sort().join(","));
}

/**
 * レコードへ「計上した呼び出しの指紋」を載せ、そこから一意キーを決める。
 * 重複を除いて安定した順序にするので、同じ集合なら必ず同じ ingestKey になる。
 */
export function setCountedCalls(rec: TurnRecord, fingerprints: readonly string[]): TurnRecord {
  const unique = [...new Set(fingerprints)].sort();
  if (unique.length === 0) {
    delete rec.countedCalls;
    delete rec.ingestKey;
    return rec;
  }
  rec.countedCalls = unique;
  rec.ingestKey = ingestKeyOf(unique);
  return rec;
}

/** レコードに既に載っている指紋へ追加する(サブエージェント分の後付け合算用)。 */
export function addCountedCalls(rec: TurnRecord, fingerprints: readonly string[]): TurnRecord {
  return setCountedCalls(rec, [...(rec.countedCalls ?? []), ...fingerprints]);
}

/** messageKey が計上済みかを判定する述語。aggregateNewTurn / splitIntoTurnDrafts の除外条件に渡す。 */
export interface MessageKeyFilter {
  has(messageKey: string): boolean;
}

/** 指紋集合を messageKey ベースの述語に変換する。 */
export function messageKeyFilterOf(counted: ReadonlySet<string>): MessageKeyFilter {
  return { has: (messageKey: string) => counted.has(callFingerprint(messageKey)) };
}

/** 2つの述語の論理和(カーソル由来の除外集合と history 由来の除外集合を重ねる)。 */
export function anyOf(filters: readonly (MessageKeyFilter | undefined)[]): MessageKeyFilter {
  const active = filters.filter((f): f is MessageKeyFilter => f !== undefined);
  return { has: (messageKey: string) => active.some((f) => f.has(messageKey)) };
}
