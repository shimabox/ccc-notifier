// src/env.ts — 実行環境の検出。
//
// 現状の関心事は WSL(Windows Subsystem for Linux)判定のみ。WSL2 の中では
// process.platform === "linux" になるため、素の Linux 経路(notify-send / xdg-open)を
// 通ってしまい、通知が無音になったりダッシュボードがブラウザで開けなかったりする。
// isWSL() を通知・ブラウザ起動の分岐に使い、Windows 側(powershell.exe など)へ橋渡しする。

import { readFileSync } from "node:fs";

/**
 * WSL 上で動作しているか。
 * - CCCN_FORCE_WSL=1/0 が最優先(テスト・強制切替用の上書き)。
 * - process.platform が linux 以外なら false。
 * - WSL は必ず WSL_DISTRO_NAME を設定するため、まずこれを見る。
 * - 予備として /proc/version の "microsoft"/"wsl" 文字列を確認する。
 *
 * 判定は環境に依存し実行中に変化しないため、キャッシュせず毎回評価しても実質無コスト
 * (WSL では WSL_DISTRO_NAME で即決、それ以外でも /proc/version は memory-backed)。
 */
export function isWSL(): boolean {
  const forced = process.env.CCCN_FORCE_WSL;
  if (forced === "1") return true;
  if (forced === "0") return false;

  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;

  try {
    const v = readFileSync("/proc/version", "utf8").toLowerCase();
    return v.includes("microsoft") || v.includes("wsl");
  } catch {
    return false;
  }
}
