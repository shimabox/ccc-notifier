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

import { aggregateCodexTurn } from "./codex/transcript";
import { closeCodexRootContext } from "./codex/subagent-store";
import { writeDashboardHtml } from "./dashboard";
import {
  isFullDashboardDue,
  makeFullDashboardState,
  writeFullDashboardStateAtomic,
} from "./dashboard-state";
import { waitForDataLock } from "./data-lock";
import { getUsdJpy } from "./fx";
import { notifyOS } from "./notify/os";
import { notifySlack } from "./notify/slack";
import { computeCost, loadPriceTable } from "./pricing";
import {
  appendTurn,
  isMuted,
  loadCursor,
  logError,
  paths,
  readConfig,
  readTurns,
  sanitizeCursor,
  saveCursor,
  todayTotalUSD,
} from "./store";
import { collectSubagentUsage } from "./subagents";
import type { SubagentUsage } from "./subagents";
import { aggregateNewTurn } from "./transcript";
import type { StopHookInput, TokenBuckets, TurnAggregate, TurnRecord, UsageByModel } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

/**
 * Codex 経路のモデル決定(contracts.md 準拠)。hook payload の model(非空 string)を優先し、
 * agg.main のキー(rollout 由来。判別不能なら "unknown")を payload.model に組み替える。
 * バケットはそのまま。payload.model が無ければ agg のキーを保持する
 * (aggregateCodexTurn の main はキーがちょうど1つ)。
 */
function withCodexModel(agg: TurnAggregate, payloadModel: unknown): TurnAggregate {
  const model = typeof payloadModel === "string" && payloadModel.length > 0 ? payloadModel : null;
  if (model === null) return agg; // payload.model 無し → agg のキー("unknown" 含む)をそのまま使う
  const buckets = Object.values(agg.main)[0] ?? emptyBuckets();
  return { ...agg, main: { [model]: buckets } };
}

export async function runTrack(stdinText: string, opts?: { codex?: boolean }): Promise<void> {
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
    const isCodex = opts?.codex === true;
    // root context closeはpricing/FX/transcript集計より先に確定する。失敗はmain料金記録から隔離する。
    let activityProjectionKey: string | null = null;
    if (isCodex) {
      try {
        activityProjectionKey = closeCodexRootContext(parsed);
      } catch {
        logError("track:codex-subagent-projection", new Error("activity projection was not attached"));
      }
    }
    const transcriptPath = input.transcript_path;
    if (typeof transcriptPath !== "string") return;

    // 2. 設定・単価・為替はdata lock外で準備する。
    const cfg = readConfig();
    const cacheDir = paths().cacheDir;
    const table = await loadPriceTable(cacheDir, { offline: true });
    const fx = await getUsdJpy(cfg, cacheDir);
    let record!: TurnRecord;

    // cursor snapshotからhistory/cursor commitまでを1つのdata lockで直列化する。
    const commitLock = await waitForDataLock(1000);
    if (commitLock === null) {
      logError("track:data-lock", new Error("data lock timeout; turn was not consumed"));
      return;
    }
    try {
      const cursor = sanitizeCursor(loadCursor(transcriptPath));

    // 3. 新規ターンの集計。新規 usage が無ければ何もせず終了する
    //    (カーソルも保存しない: 次回まとめて処理される設計)。
    //    Codex 経路(opts.codex)は rollout(累積カウンタの逐次差分)を集計する。
    let agg = isCodex
      ? await aggregateCodexTurn(transcriptPath, cursor)
      : await aggregateNewTurn(transcriptPath, cursor);
    if (agg === null) return;

    // 3a. Codex はモデルを hook payload 優先で決める(rollout 由来のキーを payload.model に組み替える)。
    if (isCodex) {
      agg = withCodexModel(agg, input.model);
    }

    // 3b. サブエージェント usage の増分集計(Claude 経路のみ。Codex に SA 概念は無いので収集しない)。
    //     collectSubagentUsage 自体は defensive だが、二重に try/catch で境界を作る。
    let sa: SubagentUsage | null = null;
    if (!isCodex) {
      try {
        sa = await collectSubagentUsage(transcriptPath);
      } catch (err) {
        logError("track:subagents", err);
        sa = null;
      }
    }

    // 4. lock外で準備済みの単価でコスト算出。
    const breakdown = computeCost(agg.main, agg.sidechain, table);

    // 6. TurnRecord を構築する。
    const sessionId =
      agg.sessionId || (typeof input.session_id === "string" ? input.session_id : "") || "";
    const project = agg.cwd ?? (typeof input.cwd === "string" ? input.cwd : undefined) ?? "";
    const sidechainHasModels = Object.keys(agg.sidechain).length > 0;

    record = {
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
      costByModel: breakdown.byModel, // モデル別 USD(main+sidechain 合算、丸めない)
      costJPY: breakdown.usd * fx.rate, // 丸めない(表示時に丸める)
      fxRate: fx.rate,
      fxSource: fx.source,
      prompt: agg.prompt ?? "",
    };
    // Codex 由来の記録には source を付ける(ダッシュボード/レポートのソース識別用。Claude は付けない)。
    if (isCodex) {
      record.source = "codex";
      // valid parent turnにはactivityの到着順と無関係に、keyCheck検証済みの匿名join keyを保存する。
      // key/ledger整合性の検証失敗だけをmain記録から隔離し、未検証keyは履歴へ付けない。
      if (activityProjectionKey !== null) record.activityProjectionKey = activityProjectionKey;
    }
    if (breakdown.unknownModels.length > 0) {
      record.unknownModels = breakdown.unknownModels;
    }

    // 6b. サブエージェント枠を記録に付加する(新規 SA usage がある場合のみ)。
    //     通知のしきい値判定・通知金額は従来どおり record.costUSD(メインのみ)であり、
    //     ここで record.costUSD には一切加算しない(通知は一切変えない)。
    if (sa !== null && sa.apiCalls > 0) {
      const saBreakdown = computeCost(sa.perModel, {}, table);
      record.subagents = {
        costUSD: saBreakdown.usd,
        costByModel: saBreakdown.byModel,
        tokens: sumBuckets(sa.perModel),
        apiCalls: sa.apiCalls,
        agentFiles: sa.agentFiles,
      };
      // SA 側の unknownModels を record.unknownModels にマージ(重複なし)。
      if (saBreakdown.unknownModels.length > 0) {
        const merged = record.unknownModels ? [...record.unknownModels] : [];
        for (const m of saBreakdown.unknownModels) {
          if (!merged.includes(m)) merged.push(m);
        }
        record.unknownModels = merged;
      }
    }

    // 7. 記録 → カーソル保存(この順序固定)。
    //    クラッシュ時は「記録済み・カーソル未更新」側に倒し、seenMessageKeys による重複排除で
    //    二重計上を防ぐ。逆順にすると「カーソルだけ進んで未記録」= 恒久的なコスト取りこぼしになる。
    //    SA のカーソルはメインより後に保存する(途中クラッシュで SA 分が再集計されても、
    //    次回 seenMessageKeys で重複排除される側に倒す)。
    appendTurn(record);
    saveCursor(transcriptPath, agg.newCursor);
    if (sa !== null) {
      for (const nc of sa.newCursors) {
        saveCursor(nc.path, nc.cursor);
      }
    }
    } finally {
      commitLock.release();
    }

    // 8. 後処理を「互いに独立なタスク」として集め、allSettled でまとめて待つ。どれか1つが
    //    失敗しても他は止まらない(通知 ↔ 再生成 も相互に独立)。
    //    - 通知(OS / Slack): いずれかのチャネルが有効で、しきい値 minNotifyUSD 以上、かつ
    //      ミュート中(ccc-notifier mute)でないときのみ。両チャネル無効(通知なしモード)では
    //      todayTotalUSD の履歴走査ごとスキップする。ミュートは通知だけを抑止し、記録・再生成には
    //      影響しない。todayUSD は append 後に集計するため当該ターンを含む。どちらも throw しない契約。
    //    - report.html 再生成: cfg.dashboard.autoRegenerate のときのみ。埋め込み対象は
    //      cfg.dashboard.days(既定30日)に制限し、HTML 構築・書き込み・ブラウザ描画の負荷を抑える。
    //      履歴の read/parse は当月予算の正確性を保つため全履歴が対象(O(全履歴))。
    //      履歴が更新された以上、
    //      通知の有無(しきい値)とは独立に実行する。失敗は logError に留め、通知を止めない。
    const tasks: Promise<unknown>[] = [];

    if ((cfg.notify.os || cfg.notify.slack !== null) && record.costUSD >= cfg.minNotifyUSD && !isMuted()) {
      const todayUSD = cfg.includeDailyTotal ? todayTotalUSD() : undefined;
      tasks.push(notifyOS(record, cfg, todayUSD));
      tasks.push(notifySlack(record, cfg, todayUSD));
    }

    if (cfg.dashboard.autoRegenerate) {
      tasks.push(
        (async () => {
          const now = new Date();
          const dashboardLock = await waitForDataLock(1000);
          if (dashboardLock === null) {
            logError("track:dashboard-lock", new Error("data lock timeout; dashboard skipped"));
            return;
          }
          try {
            // privacy: 履歴snapshotの取得から両canonical書込まで同じ所有権lock内に置く。
            let allTurns: TurnRecord[];
            try {
              allTurns = readTurns();
            } catch (err) {
              logError("track:dashboard-read", err);
              return;
            }

            try {
              writeDashboardHtml({
                days: cfg.dashboard.days,
                outPath: paths().recentDashboardFile,
                autoReloadSec: cfg.dashboard.autoReloadSec,
                allTurns,
                variant: "recent",
              });
            } catch (err) {
              logError("track:dashboard-recent", err);
            }

            if (isFullDashboardDue(now)) {
              try {
                writeDashboardHtml({
                  days: null,
                  outPath: paths().fullDashboardFile,
                  autoReloadSec: cfg.dashboard.autoReloadSec,
                  allTurns,
                  variant: "full",
                  generatedAt: now.toISOString(),
                });
                // HTML の atomic rename が成功した後だけ state を進める。
                writeFullDashboardStateAtomic(makeFullDashboardState(now));
              } catch (err) {
                logError("track:dashboard-full", err);
              }
            }

          } finally {
            dashboardLock.release();
          }
        })(),
      );
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  } catch (err) {
    // フェイルセーフ最終境界: いかなる失敗も error.log に留め、外へは決して漏らさない。
    logError("track", err);
  }
}
