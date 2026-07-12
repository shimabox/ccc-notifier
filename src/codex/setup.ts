// src/codex/setup.ts — Codex CLI の hooks.json への安全な hook 登録 / 解除。
//
// Claude 側 settings.json(src/setup.ts)と同格の「最も破壊リスクの高い」モジュール。
// 対象はユーザーが手で育てた ~/.codex/hooks.json で、PermissionRequest 等の承認フックが
// 既に入っていることが多い。「既存設定を1項目たりとも壊さない」ことが絶対の品質基準であり、
// setup.ts と同じ流儀で次の不変条件を守る:
//   - 破損 JSON / 予期しない構造には絶対に書き込まない(manual に倒して手動追記を案内する)
//   - 書き込む場合は直前に必ず `<path>.bak-<timestamp>` バックアップを取る
//   - マーカー一致(= 自分のもの)以外の Stop エントリ・他イベントには一切触れない
//   - 出力は 2スペースインデント + 末尾改行(ユーザーの実ファイルの見た目を維持)
//
// Claude 側との唯一の構造差: Codex の hook エントリは timeout を持たない(Codex 未対応のため)。
// マーカー判定は setup.ts の matchesMarker(command 文字列に "ccc-notifier" を含むか)を共有する。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { matchesMarker } from "../setup";
import { codexHome } from "./env";

export interface CodexHookResult {
  status: "written" | "unchanged" | "manual";
  backupPath: string | null;
  manualSnippet?: string; // manual のときだけ: hooks.Stop に手で足すべき1エントリの整形 JSON。
}

// ============ 小ヘルパー ============

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** hooks.json の絶対パス。codexHome() を毎回評価するため env の差し替えに追従する。 */
export function codexHooksFile(): string {
  return join(codexHome(), "hooks.json");
}

/**
 * hook コマンド文字列を組み立てる。Claude 側 buildHookCommand と同じ流儀:
 * win32 ではパス区切りを "/" に正規化し、空白入りパスに耐えるよう両パスを常に "" で囲む。
 * 末尾サブコマンドだけ track ではなく track --codex(cli.ts が Codex 経路へ振り分ける)。
 */
export function codexHookCommand(nodePath: string, cliPath: string): string {
  let node = nodePath;
  let cli = cliPath;
  if (process.platform === "win32") {
    node = node.replace(/\\/g, "/");
    cli = cli.replace(/\\/g, "/");
  }
  return `"${node}" "${cli}" track --codex`;
}

/** 本ツールが Codex hooks.json に置く Stop エントリの正準構造(timeout は付けない)。 */
function ourCodexStopEntry(command: string): Record<string, unknown> {
  return { hooks: [{ type: "command", command }] };
}

/**
 * Stop エントリ(マッチャーグループ)が本ツールのものか。
 * setup.ts の isOurStopEntry と同一判定: いずれかの hook の command がマーカーを含むか。
 */
function isOurStopEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => isPlainObject(h) && typeof h.command === "string" && matchesMarker(h.command),
  );
}

/** 手動追記用スニペット(hooks.Stop に足すべき1エントリの整形 JSON)。 */
function buildManualSnippet(command: string): string {
  return JSON.stringify(ourCodexStopEntry(command), null, 2);
}

/** 既存 hooks.json を `<path>.bak-<epoch millis>` にコピーし、そのパスを返す(書き込み前に必ず呼ぶ)。 */
function backupHooks(path: string): string {
  const backupPath = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

/** 2スペースインデント + 末尾改行で書き出す(ユーザーの実ファイルの見た目を維持。setup.ts と同じ)。 */
function writeHooks(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ============ registerCodexHook ============

/**
 * hooks.json に本ツールの Stop フックを非破壊マージする(冪等)。
 * - ファイル不在: 新規作成(バックアップ不要)。codexHome 自体が無ければ掘る(init は detectCodex 済みだが防御)。
 * - 破損 JSON / ルート非オブジェクト / 予期しない構造(hooks が配列・Stop が文字列など): 絶対に書き込まず manual。
 * - マーカー一致エントリが既にあり command が同一: unchanged(書き込み・バックアップなし)。
 * - command が異なる(古い Node/CLI パス等): そのエントリのマーカー hook の command のみ更新(同居 hook は温存)。
 * - 一致エントリ無し: hooks.Stop 末尾に追記(無ければ Stop 配列を作る)。他イベント・他エントリは不変。
 */
export function registerCodexHook(nodePath: string, cliPath: string): CodexHookResult {
  const hooksFile = codexHooksFile();
  const command = codexHookCommand(nodePath, cliPath);

  // (1) ファイル不在 → 新規作成。
  if (!existsSync(hooksFile)) {
    mkdirSync(dirname(hooksFile), { recursive: true });
    writeHooks(hooksFile, { hooks: { Stop: [ourCodexStopEntry(command)] } });
    return { status: "written", backupPath: null };
  }

  // (2) 既存ファイル → パース。破損は書かずに手動案内へ倒す(追記なので、勝手な修復より手動が安全)。
  const raw = readFileSync(hooksFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "manual", backupPath: null, manualSnippet: buildManualSnippet(command) };
  }
  if (!isPlainObject(parsed)) {
    return { status: "manual", backupPath: null, manualSnippet: buildManualSnippet(command) };
  }
  const obj = parsed;

  // (3) 予期しない構造は clobber せず manual に倒す。
  //     setup.ts(Claude)は hooks/Stop を作り直すが、Codex hooks.json はユーザーが手で育てた
  //     承認フックの塊で、hooks が配列・Stop が文字列という異形も「壊さない」を優先して温存する
  //     (キーが存在するのに型が違うときだけ manual。欠損しているだけなら下で新設して問題ない)。
  const hooksVal = obj.hooks;
  if (hooksVal !== undefined && !isPlainObject(hooksVal)) {
    return { status: "manual", backupPath: null, manualSnippet: buildManualSnippet(command) };
  }
  const hooks = (hooksVal ?? {}) as Record<string, unknown>;
  const stopVal = hooks.Stop;
  if (stopVal !== undefined && !Array.isArray(stopVal)) {
    return { status: "manual", backupPath: null, manualSnippet: buildManualSnippet(command) };
  }
  const stop = (stopVal ?? []) as unknown[];

  // (4) マーカー一致(= 自分の)エントリを探す。
  const idx = stop.findIndex(isOurStopEntry);
  if (idx >= 0) {
    const entry = stop[idx] as Record<string, unknown>;
    const entryHooks = entry.hooks as unknown[];
    // 既存のマーカー hook がすべて新 command と一致していれば何もしない(冪等 = unchanged)。
    const needsUpdate = entryHooks.some(
      (h) =>
        isPlainObject(h) &&
        typeof h.command === "string" &&
        matchesMarker(h.command) &&
        h.command !== command,
    );
    if (!needsUpdate) return { status: "unchanged", backupPath: null };

    // command が変わった → マーカー hook の command のみ差し替え、同居する非マーカー hook は温存する。
    const backupPath = backupHooks(hooksFile);
    for (const h of entryHooks) {
      if (isPlainObject(h) && typeof h.command === "string" && matchesMarker(h.command)) {
        h.command = command;
      }
    }
    obj.hooks = hooks;
    hooks.Stop = stop;
    writeHooks(hooksFile, obj);
    return { status: "written", backupPath };
  }

  // (5) 自分のエントリ無し → Stop 末尾に追記(既存エントリ・他イベントは不変)。
  const backupPath = backupHooks(hooksFile);
  stop.push(ourCodexStopEntry(command));
  obj.hooks = hooks;
  hooks.Stop = stop;
  writeHooks(hooksFile, obj);
  return { status: "written", backupPath };
}

// ============ removeCodexHook ============

/**
 * hooks.json からマーカー一致の Stop エントリのみを除去する。
 * - ファイル不在 / 破損 JSON / 非オブジェクト / マーカー未登録: いずれも unchanged で何もしない。
 *   破損時に register は manual だが remove は unchanged にする —— 削除操作で壊れたファイルへ手を入れる方が
 *   危険なため、触らず素通りするのが安全(ユーザーは手動で消せる)。
 * - 除去後 Stop が空配列なら Stop キーごと削除(hooks の他キーは維持)。他エントリが残るなら配列を維持。
 */
export function removeCodexHook(): CodexHookResult {
  const hooksFile = codexHooksFile();

  if (!existsSync(hooksFile)) return { status: "unchanged", backupPath: null };

  const raw = readFileSync(hooksFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unchanged", backupPath: null };
  }
  if (!isPlainObject(parsed)) return { status: "unchanged", backupPath: null };
  const obj = parsed;

  const hooks = isPlainObject(obj.hooks) ? (obj.hooks as Record<string, unknown>) : null;
  const stop = hooks && Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : null;
  if (!hooks || !stop || !stop.some(isOurStopEntry)) {
    return { status: "unchanged", backupPath: null };
  }

  const backupPath = backupHooks(hooksFile);
  const filtered = stop.filter((e) => !isOurStopEntry(e));
  if (filtered.length === 0) {
    delete hooks.Stop; // 空配列になったら Stop キー自体を削除(他 hooks キーは残す)。
  } else {
    hooks.Stop = filtered;
  }
  writeHooks(hooksFile, obj);
  return { status: "written", backupPath };
}
