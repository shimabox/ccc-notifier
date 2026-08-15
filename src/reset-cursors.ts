// src/reset-cursors.ts — `cccn reset-cursors` サブコマンド。取り込み位置(cursors.json)を捨てる。
//
// 取り込み保留マーカー(cache/pending-append.json)が壊れると、どの transcript に
// 「カーソル未反映の append」があったのか復元できず、安全側として全 transcript を保留扱いにする
// 予約キーが立つ。これを解除するには「全 transcript のカーソルが history を反映している」ことが
// 必要だが、hook でしか触らない(走査ルート外の)transcript もあり得るため、その証明はできない。
//
// 証明の代わりに前提そのものを消す: カーソルを全部捨ててから予約キーを消す。カーソルが無ければ
// 次回の取り込みは必ず history 側の指紋・下限と突合するので、二重計上は起きない
// (cursors.json 全損と同じ状態)。
//
// 順序は「カーソル破棄 → マーカー削除」で固定する。途中で落ちても「カーソル無し + 予約キー残存」
// になり安全側へ倒れる。逆順だと「マーカーは消えたがカーソルは古いまま」= 二重計上の窓ができる。
//
// history.jsonl・config・通知設定・単価/為替キャッシュには触らない。

import { rmSync } from "node:fs";
import { waitForDataLock } from "./data-lock";
import { paths, pendingAppendPath } from "./store";

export async function runResetCursors(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error(`不明なoptionまたは余分な引数です: ${argv[0]}\n使い方 / Usage: ccc-notifier reset-cursors`);
    return 1;
  }

  const lock = await waitForDataLock();
  if (lock === null) {
    console.error("reset-cursors の data lock を取得できませんでした。後でもう一度お試しください");
    return 1;
  }
  try {
    // 1. 取り込み位置を捨てる(この時点で次回は必ず history と突合する)。
    rmSync(paths().cursorsFile, { force: true });
    // 2. その後に保留マーカーを消す。
    rmSync(pendingAppendPath(), { force: true });
  } catch (err) {
    console.error(
      `取り込み位置の破棄に失敗しました / failed to reset cursors: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    lock.release();
  }

  console.log("取り込み位置(cursors.json)と保留マーカーを破棄しました。");
  console.log("履歴(history.jsonl)・設定・通知先はそのままです。二重計上は履歴側の指紋で防ぎます。");
  console.log("次回の取り込みは全 transcript / rollout を読み直すため、一度だけ時間がかかります。");
  console.log(
    "注意: 過去に未計上だった分(例: 旧バージョンで計上していなかった Codex サブエージェント分)も新規に取り込まれるため、履歴総額・月予算の消化が増えることがあります。",
  );
  return 0;
}
