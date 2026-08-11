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

import { aggregateCodexTurn, codexConsumedCursor, codexResumePointAtTs } from "./codex/transcript";
import { closeCodexRootContext } from "./codex/subagent-store";
import { normalizeCodexOriginator } from "./codex/originator";
import { determineClaudeSurface } from "./claude-roots";
import { writeDashboardHtml } from "./dashboard";
import {
  isFullDashboardDue,
  makeFullDashboardState,
  writeFullDashboardStateAtomic,
} from "./dashboard-state";
import { waitForDataLock } from "./data-lock";
import { getUsdJpy } from "./fx";
import { notifyIngestSummary, runIngest } from "./ingest";
import { notifyOS } from "./notify/os";
import { notifySlack } from "./notify/slack";
import { basename } from "node:path";
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
  clearPendingAppend,
  floorKey,
  hasPendingAppend,
  loadHistoryIndex,
  markPendingAppend,
} from "./store";
import type { FloorScope, HistoryIndex } from "./store";
import { anyOf, callFingerprints, messageKeyFilterOf, setCountedCalls } from "./counted-calls";
import type { MessageKeyFilter } from "./counted-calls";
import { collectSubagentUsage } from "./subagents";
import type { SubagentUsage } from "./subagents";
import { aggregateNewTurn } from "./transcript";
import type { Cursor, StopHookInput, TokenBuckets, TurnAggregate, TurnRecord, UsageByModel } from "./types";

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
    let hasMainUsage = false;

    // cursor snapshotからhistory/cursor commitまでを1つのdata lockで直列化する。
    const commitLock = await waitForDataLock(1000);
    if (commitLock === null) {
      logError("track:data-lock", new Error("data lock timeout; turn was not consumed"));
      return;
    }
    try {
      const cursor = sanitizeCursor(loadCursor(transcriptPath));

    // 3. 新規ターンの集計。Claude はメイン usage が無くても、遅れて完了した
    //    サブエージェント差分を回収するため、この時点では return しない。
    //    Codex 経路(opts.codex)は rollout(累積カウンタの逐次差分)を集計する。
    //
    //    カーソルが無い(消失・破損)ときは、そのファイルを先頭から読み直すことになる。
    //    カーソルの不在は「未計上」の証拠にならないので、history に指紋として残っている
    //    呼び出しを除外条件にする。カーソルが健全なら history は1バイトも読まない。
    //    さらに、前回の append 後にカーソル保存が完了していない(= マーカーが残っている)ときも
    //    カーソルは真実を反映していない。この場合カーソル自体は有効なので窓は狭いままだが、
    //    その窓には既計上の呼び出しが混ざる。どちらの場合も history の指紋を除外条件に重ねて、
    //    呼び出し単位で弾く(レコード単位のキー照合では、新しいターンが加わって集計範囲が
    //    変わった時点で別キーになり、弾けない)。
    const cursorMayBeStale = cursor === null || hasPendingAppend(transcriptPath);
    let indexCache: HistoryIndex | null = null;
    const history = (): HistoryIndex => (indexCache ??= loadHistoryIndex());
    const counted = (): Set<string> => history().countedCalls;
    /** 計上済み呼び出しの除外条件。カーソルが信用できるときは undefined(history を読まない)。 */
    const countedFilter = (): MessageKeyFilter | undefined =>
      cursorMayBeStale ? messageKeyFilterOf(counted()) : undefined;
    // 指紋を持たない旧レコードぶんのフォールバック(ingest と同じ規則)。
    const sessionKey =
      (typeof input.session_id === "string" && input.session_id.length > 0
        ? input.session_id
        : basename(transcriptPath).replace(/\.jsonl$/, ""));
    const legacyFloorMs = (scope: FloorScope): number | null => {
      const iso = history().legacyFloors.get(floorKey(scope, sessionKey));
      if (iso === undefined) return null;
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? ms + 1 : null;
    };

    // 既計上分しか無かったときに張り直すカーソル(ゼロ件のレコードは作らない)。
    let recoveredCursor: Cursor | null = null;

    let agg: (TurnAggregate & { messageKeys?: string[] }) | null;
    if (isCodex) {
      let readFrom = cursor;
      const scanOpts = cursorMayBeStale ? { excludeEvents: counted() } : {};
      if (cursor === null) {
        const floorIso = history().legacyFloors.get(floorKey("codex", sessionKey));
        if (floorIso !== undefined) readFrom = await codexResumePointAtTs(transcriptPath, floorIso);
      }
      agg = await aggregateCodexTurn(transcriptPath, readFrom, scanOpts);
      if (agg === null) {
        // 新規 usage 無し。カーソルが信用できない状態だったなら、読み切った位置まで
        // 張り直して次回以降の Stop で history を読み直さずに済むようにする。
        if (cursorMayBeStale) {
          const consumed = await codexConsumedCursor(transcriptPath, readFrom, scanOpts);
          if (consumed !== null) saveCursor(transcriptPath, consumed);
          clearPendingAppend(transcriptPath);
        }
        return;
      }
    } else if (cursorMayBeStale) {
      const recovered = await aggregateNewTurn(transcriptPath, cursor, {
        excludeMessageKeys: messageKeyFilterOf(counted()),
        // 指紋を持たない旧レコードぶんのフォールバックは、先頭から読み直すときだけ効かせる。
        minTimestampMs: cursor === null ? legacyFloorMs("claude") : null,
        returnEmpty: true,
      });
      if (recovered !== null && recovered.apiCalls === 0) {
        recoveredCursor = recovered.newCursor; // 既計上分だけだった
        agg = null;
      } else {
        agg = recovered;
      }
    } else {
      agg = await aggregateNewTurn(transcriptPath, cursor);
    }
    hasMainUsage = agg !== null;

    // 3a. Codex はモデルを hook payload 優先で決める(rollout 由来のキーを payload.model に組み替える)。
    if (isCodex && agg !== null) {
      agg = withCodexModel(agg, input.model);
    }

    // 3b. サブエージェント usage の増分集計(Claude 経路のみ。Codex に SA 概念は無いので収集しない)。
    //     collectSubagentUsage 自体は defensive だが、二重に try/catch で境界を作る。
    let sa: SubagentUsage | null = null;
    if (!isCodex) {
      try {
        const excluded = new Set(cursor?.seenMessageKeys ?? []);
        if (agg !== null && "messageKeys" in agg) {
          for (const key of (agg as TurnAggregate & { messageKeys: string[] }).messageKeys) excluded.add(key);
        }
        const staleFilter = countedFilter();
        sa = await collectSubagentUsage(transcriptPath, {
          excludeMessageKeys: staleFilter === undefined ? excluded : anyOf([excluded, staleFilter]),
          // agent ファイル側のカーソルだけを失っている場合もあるので、そのファイルに限って
          // history 由来の指紋と旧レコード向けの下限で弾く
          // (すべてのカーソルが健全なら一度も呼ばれない = history を読まない)。
          recovery: () => ({
            excludeMessageKeys: messageKeyFilterOf(counted()),
            minTimestampMs: legacyFloorMs("claude-sa"),
          }),
        });
      } catch (err) {
        logError("track:subagents", err);
        sa = null;
      }
    }
    if (agg === null && (sa === null || sa.apiCalls === 0)) {
      // A newly discovered file may contain only a copy of already-counted main
      // calls. Persist its consumed cursor without creating a zero-value row.
      if (recoveredCursor !== null) saveCursor(transcriptPath, recoveredCursor);
      for (const nc of sa?.newCursors ?? []) saveCursor(nc.path, nc.cursor);
      if (cursorMayBeStale) clearPendingAppend(transcriptPath);
      return;
    }

    // SA-only completion is a normal Claude history record with zero main cost.
    // This keeps notifications main-only while making the late usage visible now.
    const main = agg?.main ?? {};
    const sidechain = agg?.sidechain ?? {};

    // 4. lock外で準備済みの単価でコスト算出。
    const breakdown = computeCost(main, sidechain, table);

    // 6. TurnRecord を構築する。
    const sessionId =
      agg?.sessionId || sa?.sessionId || (typeof input.session_id === "string" ? input.session_id : "") || "";
    const project = agg?.cwd ?? sa?.cwd ?? (typeof input.cwd === "string" ? input.cwd : undefined) ?? "";
    const sidechainHasModels = Object.keys(sidechain).length > 0;

    record = {
      schemaVersion: 1,
      ts: agg?.lastTs ?? sa?.lastTs ?? new Date().toISOString(),
      sessionId,
      project,
      gitBranch: agg?.gitBranch ?? sa?.gitBranch ?? null,
      models: hasMainUsage ? collectModels(main, sidechain) : collectModels(sa?.perModel ?? {}, {}),
      tokens: sumBuckets(main),
      sidechainTokens: sidechainHasModels ? sumBuckets(sidechain) : null,
      apiCalls: agg?.apiCalls ?? 0,
      costUSD: breakdown.usd,
      costByModel: breakdown.byModel, // モデル別 USD(main+sidechain 合算、丸めない)
      costJPY: breakdown.usd * fx.rate, // 丸めない(表示時に丸める)
      fxRate: fx.rate,
      fxSource: fx.source,
      prompt: agg?.prompt ?? "",
    };
    // Codex 由来の記録には source を付ける(ダッシュボード/レポートのソース識別用。Claude は付けない)。
    if (isCodex) {
      record.source = "codex";
      // valid parent turnにはactivityの到着順と無関係に、keyCheck検証済みの匿名join keyを保存する。
      // key/ledger整合性の検証失敗だけをmain記録から隔離し、未検証keyは履歴へ付けない。
      if (activityProjectionKey !== null) record.activityProjectionKey = activityProjectionKey;
      const rawOriginator = agg?.originator;
      record.surface = normalizeCodexOriginator(rawOriginator);
      if (typeof rawOriginator === "string") record.originator = rawOriginator;
    } else {
      try {
        record.surface = await determineClaudeSurface(transcriptPath);
      } catch (err) {
        logError("track:surface", err);
      }
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

    // 6c. 計上した呼び出しの指紋を載せる(親ターン分 + サブエージェント分)。
    //     カーソルが失われても、ここに載った呼び出しは以後どの経路でも再計上されない。
    if (isCodex) {
      // rollout は token_count イベント1件を1呼び出しとみなして指紋を付ける。
      setCountedCalls(record, agg?.codexEventKeys ?? []);
    } else {
      const countedKeys: string[] = [];
      if (agg !== null && "messageKeys" in agg) {
        countedKeys.push(...(agg as TurnAggregate & { messageKeys: string[] }).messageKeys);
      }
      for (const group of sa?.groups ?? []) countedKeys.push(...group.messageKeys);
      setCountedCalls(record, callFingerprints(countedKeys));
    }

    // 7. 記録 → カーソル保存(この順序固定)。
    //    クラッシュ時は「記録済み・カーソル未更新」側に倒す。逆順にすると「カーソルだけ進んで
    //    未記録」= 恒久的なコスト取りこぼしになる。ただし前回の append 後にカーソル保存が
    //    失敗していると、古い有効カーソルから同じ範囲を読み直して同じレコードを作ってしまう。
    //    直近の履歴に同じ一意キーがあれば append をスキップする(カーソルだけ張り直して収束させる)。
    //    SA のカーソルはメインより後に保存する(途中クラッシュで SA 分が再集計されても、
    //    次回 seenMessageKeys で重複排除される側に倒す)。
    markPendingAppend(transcriptPath, record.ingestKey ?? "");
    appendTurn(record);
    if (agg !== null) saveCursor(transcriptPath, agg.newCursor);
    if (sa !== null) {
      for (const nc of sa.newCursors) {
        saveCursor(nc.path, nc.cursor);
      }
    }
    // ここまで来たらカーソルは append を反映している。
    clearPendingAppend(transcriptPath);
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
    //      履歴の read/parse は、保存済み履歴の当月分を集計対象から落とさないため
    //      全履歴が対象(O(全履歴))。
    //      履歴が更新された以上、
    //      通知の有無(しきい値)とは独立に実行する。失敗は logError に留め、通知を止めない。
    const tasks: Promise<unknown>[] = [];

    if (hasMainUsage && (cfg.notify.os || cfg.notify.slack !== null) && record.costUSD >= cfg.minNotifyUSD && !isMuted()) {
      const todayUSD = cfg.includeDailyTotal ? todayTotalUSD() : undefined;
      tasks.push(notifyOS(record, cfg, todayUSD));
      tasks.push(notifySlack(record, cfg, todayUSD));
    }

    // ingest 便乗り取込 → report.html 再生成の順で1本の直列タスクにする(この2つは同じ data lock を
    // 奪い合わないよう、あえて Promise.allSettled の別要素にせず直列合成する。並列にすると、送信通知
    // タスクとは独立でよいが、この2つ自身は同じ lock を取り合ってどちらかがタイムアウトしうるため)。
    // ingest を先にすることで、直後の dashboard 再生成に新規取り込み分を反映できる。
    tasks.push(
      (async () => {
        // - ingest 便乗り取込(hook 非依存の増分取り込み。デスクトップアプリ等の hook 取りこぼしの保険):
        //   本来のターン処理(上の記録・カーソル保存)の後にベストエフォートで実行する。runIngest 自身が
        //   実際の書き込み区間だけを data lock で直列化する(config/単価/為替の準備・ファイル列挙は
        //   lock 外)。失敗しても track 本来の処理は失敗させない(logError のみ)。単価表はキャッシュのみ
        //   (offlinePricing)で毎 hook のネット待ちを避ける。新規に取り込んだターン群の合計が
        //   minNotifyUSD 以上ならまとめて1通通知する(notifyIngestSummary はミュート・しきい値を尊重)。
        try {
          const result = await runIngest({ dryRun: false, offlinePricing: true });
          if (result.records.length > 0) {
            await notifyIngestSummary(result, cfg);
          }
        } catch (err) {
          logError("track:ingest", err);
        }

        if (!cfg.dashboard.autoRegenerate) return;
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

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  } catch (err) {
    // フェイルセーフ最終境界: いかなる失敗も error.log に留め、外へは決して漏らさない。
    logError("track", err);
  }
}
