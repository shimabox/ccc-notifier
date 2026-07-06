// src/track.ts (T6) — Stop hook 統合パイプライン
//
// 契約: src/contracts.md の "src/track.ts (T6)" 参照。
//
// この関数は Claude Code の Stop hook から毎ターン呼ばれる「フェイルセーフ境界」であり、
// いかなる失敗でも Claude Code 本体を妨げないことが最優先の品質基準:
//   - 関数全体を try/catch し、失敗は logError('track', err) へ。例外/rejection を外へ漏らさない。
//   - stdout へは一切出力しない(console.log/console.error を使わない。エラーは error.log のみ)。
//   - ネット待ちは各モジュール内のタイムアウト(fx 1.5s×2 / Slack 3s)で構造的に有界。
//     track 側で無限待ちの await を追加しない。

import { getUsdJpy } from "./fx";
import { notifyOS } from "./notify/os";
import { notifySlack } from "./notify/slack";
import { computeCost, loadPriceTable } from "./pricing";
import {
  appendTurn,
  loadCursor,
  logError,
  paths,
  readConfig,
  saveCursor,
  todayTotalUSD,
} from "./store";
import { aggregateNewTurn } from "./transcript";
import type { Cursor, StopHookInput, TokenBuckets, TurnRecord, UsageByModel } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * loadCursor の戻り値を「形全体」で検証する。
 * cursors.json は理論上手で編集されうるため、文字列だけの seenMessageKeys フィルタでは足りない。
 * offset が有限数値 / lastUuid が string|null / lastTs が string|null / seenMessageKeys が string 配列 —
 * この形でなければ(部分的な不正も含め)全体を null に落とす。null なら以降はフルリスキャン
 * ではなく「新規読み込み」になり、二重計上は aggregateNewTurn 内の重複排除に委ねられる。
 */
function sanitizeCursor(raw: unknown): Cursor | null {
  if (!isRecord(raw)) return null;
  const { offset, lastUuid, lastTs, seenMessageKeys } = raw;
  if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
  if (lastUuid !== null && typeof lastUuid !== "string") return null;
  if (lastTs !== null && typeof lastTs !== "string") return null;
  if (!Array.isArray(seenMessageKeys)) return null;
  const keys: string[] = [];
  for (const key of seenMessageKeys) {
    if (typeof key !== "string") return null;
    keys.push(key);
  }
  return { offset, lastUuid, lastTs, seenMessageKeys: keys };
}

function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

/** UsageByModel の全モデルを 1 つの TokenBuckets に合算する。 */
function sumBuckets(usage: UsageByModel): TokenBuckets {
  const total = emptyBuckets();
  for (const b of Object.values(usage)) {
    total.input += b.input;
    total.output += b.output;
    total.cacheWrite5m += b.cacheWrite5m;
    total.cacheWrite1h += b.cacheWrite1h;
    total.cacheRead += b.cacheRead;
  }
  return total;
}

/** main のモデル → sidechain のみに現れるモデル の順で重複排除する(contracts.md 準拠)。 */
function collectModels(main: UsageByModel, sidechain: UsageByModel): string[] {
  const models: string[] = [];
  for (const m of Object.keys(main)) {
    if (!models.includes(m)) models.push(m);
  }
  for (const m of Object.keys(sidechain)) {
    if (!models.includes(m)) models.push(m);
  }
  return models;
}

export async function runTrack(stdinText: string): Promise<void> {
  try {
    // 1. stdin(StopHookInput)を厳格にパースする。
    //    パース失敗 / オブジェクトでない / transcript_path が文字列でない → 静かに return。
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdinText);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const input = parsed as StopHookInput;
    const transcriptPath = input.transcript_path;
    if (typeof transcriptPath !== "string") return;

    // 2. 設定 + カーソル(形全体をサニタイズ)。
    const cfg = readConfig();
    const cursor = sanitizeCursor(loadCursor(transcriptPath));

    // 3. 新規ターンの集計。新規 assistant usage が無ければ何もせず終了する
    //    (カーソルも保存しない: 次回まとめて処理される設計)。
    const agg = await aggregateNewTurn(transcriptPath, cursor);
    if (agg === null) return;

    // 4. 単価(track 経路はネットに出ないため offline)+ コスト算出。
    const cacheDir = paths().cacheDir;
    const table = await loadPriceTable(cacheDir, { offline: true });
    const breakdown = computeCost(agg.main, agg.sidechain, table);

    // 5. 為替(モジュール内タイムアウトで有界。失敗時は fixed フォールバック)。
    const fx = await getUsdJpy(cfg, cacheDir);

    // 6. TurnRecord を構築する。
    const sessionId =
      agg.sessionId || (typeof input.session_id === "string" ? input.session_id : "") || "";
    const project = agg.cwd ?? (typeof input.cwd === "string" ? input.cwd : undefined) ?? "";
    const sidechainHasModels = Object.keys(agg.sidechain).length > 0;

    const record: TurnRecord = {
      schemaVersion: 1,
      ts: agg.lastTs ?? new Date().toISOString(),
      sessionId,
      project,
      gitBranch: agg.gitBranch,
      models: collectModels(agg.main, agg.sidechain),
      tokens: sumBuckets(agg.main),
      sidechainTokens: sidechainHasModels ? sumBuckets(agg.sidechain) : null,
      apiCalls: agg.apiCalls,
      costUSD: breakdown.usd,
      costJPY: breakdown.usd * fx.rate, // 丸めない(表示時に丸める)
      fxRate: fx.rate,
      fxSource: fx.source,
      prompt: agg.prompt ?? "",
    };
    if (breakdown.unknownModels.length > 0) {
      record.unknownModels = breakdown.unknownModels;
    }

    // 7. 記録 → カーソル保存(この順序固定)。
    //    クラッシュ時は「記録済み・カーソル未更新」側に倒し、seenMessageKeys による重複排除で
    //    二重計上を防ぐ。逆順にすると「カーソルだけ進んで未記録」= 恒久的なコスト取りこぼしになる。
    appendTurn(record);
    saveCursor(transcriptPath, agg.newCursor);

    // 8. しきい値を超えるときのみ通知する。todayUSD は append 後に集計するため当該ターンを含む。
    //    OS / Slack は互いに独立(allSettled で片方の失敗が他方に影響しない)。どちらも throw しない契約。
    if (record.costUSD >= cfg.minNotifyUSD) {
      const todayUSD = cfg.includeDailyTotal ? todayTotalUSD() : undefined;
      await Promise.allSettled([
        notifyOS(record, cfg, todayUSD),
        notifySlack(record, cfg, todayUSD),
      ]);
    }
  } catch (err) {
    // フェイルセーフ最終境界: いかなる失敗も error.log に留め、外へは決して漏らさない。
    logError("track", err);
  }
}
