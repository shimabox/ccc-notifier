// notify モジュール専用の小ヘルパー群。
// store.ts (T4) とは意図的に独立させている(並行実装中で store.ts に依存できないため、
// また通知系はいかなる失敗でも本体の処理を妨げてはならないため、ここでのファイル I/O は
// 常にベストエフォートかつ黙殺可能な作りにする)。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * データディレクトリのパスを返す。存在しなければ作成する(mkdir -p 相当)。
 * CCCN_HOME 環境変数があればそれを優先。既定は ~/.ccc-notifier。
 */
export function cccnHome(): string {
  const home = process.env.CCCN_HOME || join(homedir(), ".ccc-notifier");
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    // ディレクトリ作成に失敗しても通知処理自体は止めない(ベストエフォート)。
  }
  return home;
}

/**
 * 通知処理中に起きたエラーを `${cccnHome()}/error.log` に追記する。
 * この関数自体が失敗しても黙殺し、決して例外を投げない。
 */
export function appendNotifyError(context: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const line = `[${new Date().toISOString()}] [${context}] ${message}\n`;
    appendFileSync(join(cccnHome(), "error.log"), line, "utf8");
  } catch {
    // ログ書き込み自体の失敗も黙殺する。
  }
}

/**
 * DRY RUN 時の送信内容を `${cccnHome()}/last-notify.json` に保存する。
 * 既存内容を読み込み、対象チャンネルのキーだけを差し替えてマージ保存する。
 * 失敗しても黙殺する(ベストエフォート)。
 */
export function writeDryRun(channel: "os" | "slack", payload: unknown): void {
  try {
    const file = join(cccnHome(), "last-notify.json");
    let existing: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = {};
      }
    }

    const payloadRecord: Record<string, unknown> =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : { value: payload };

    const next: Record<string, unknown> = {
      ...existing,
      [channel]: { ...payloadRecord, ts: new Date().toISOString() },
    };

    writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  } catch {
    // 書き込み失敗は黙殺する。
  }
}
