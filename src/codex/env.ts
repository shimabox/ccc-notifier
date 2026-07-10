// src/codex/env.ts — Codex CLI(OpenAI)のホーム検出。
//
// Codex は Claude Code とは別ディレクトリ(既定 ~/.codex)にセッションログ(rollout jsonl)と
// hooks.json を持つ。ここではその「ホーム」の解決と存在検出だけを担う、setup.ts / sweep.ts /
// doctor.ts / transcript.ts 共通の入口。副作用は持たない(検出のみ)。

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex ホームの絶対パス。
 * CCCN_CODEX_HOME があれば最優先(テスト・サンドボックス用の上書き)、無ければ ~/.codex。
 * setup.ts の settingsPath() と同様にモジュールロード時へ固定せず呼び出しのたびに env を評価する
 * (テストが afterEach で env を差し替えても追従できるようにするため)。
 */
export function codexHome(): string {
  return process.env.CCCN_CODEX_HOME || join(homedir(), ".codex");
}

/**
 * Codex CLI が導入されているか(= codexHome がディレクトリとして実在するか)。
 * statSync が投げる系(不在・権限不足など)はすべて「未導入」とみなして false に倒す。
 * 同名のファイルが存在する異常系も isDirectory() が false になり、未導入扱いになる。
 */
export function detectCodex(): boolean {
  try {
    return statSync(codexHome()).isDirectory();
  } catch {
    return false;
  }
}
