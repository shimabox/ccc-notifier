// src/claude-roots.ts — Claude transcript を読むべきルート一覧(スキャンルートの複数化)。
//
// 既定は CLI 用の projectsRoot(surface=cli)1件と、macOS の場合のみ Claude デスクトップアプリの
// サンドボックス transcript ルート(surface=desktop)。デスクトップルートは
// `~/Library/Application Support/Claude/local-agent-mode-sessions` 配下を bounded 再帰探索して
// `.claude/projects` ディレクトリを見つける(実機確認では
// `local-agent-mode-sessions/<id>/<id>/local_<uuid>/.claude/projects` という深さだったが、
// 非公開レイアウトでアプリ更新により変わり得るため、固定深さを仮定せず bounded walk にする)。
// 環境変数 CCCN_CLAUDE_DESKTOP_ROOTS(path.delimiter 区切りのリスト)が設定されていれば、
// それを desktop ルートとして採用する(自動検出を置き換える)。
// 存在しないルートは黙ってスキップする(呼び出し側はルートの実在を気にしなくてよい)。

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Surface } from "./types";

export interface ClaudeTranscriptRoot {
  path: string;
  surface: Surface & ("cli" | "desktop");
}

const DESKTOP_DISCOVERY_MAX_DEPTH = 8;

/** 既存の projectsRoot 解決(src/sweep.ts の projectsRoot と同一規則)。 */
export function defaultClaudeProjectsRoot(override?: string | null): string {
  if (override) return override;
  return process.env.CCCN_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
}

export function defaultClaudeDesktopSessionsRoot(): string {
  return join(homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fsp.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Claude デスクトップのサンドボックス root 配下から `.claude/projects` ディレクトリを bounded 再帰探索する。 */
async function discoverDesktopProjectRoots(sessionsRoot: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > DESKTOP_DISCOVERY_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === ".claude") {
        const projects = join(full, "projects");
        if (await isDirectory(projects)) found.push(projects);
        continue; // .claude 配下(projects 以外)はさらに掘らない
      }
      await walk(full, depth + 1);
    }
  };
  await walk(sessionsRoot, 0);
  return found;
}

export interface ClaudeTranscriptRootsOptions {
  /** --projects 等での明示上書き(sweep の既存 --projects オプション相当)。 */
  projectsOverride?: string | null;
}

/**
 * Claude transcript を読むべきルート一覧を返す(順序: cli 1件 → desktop 0件以上)。
 */
export async function claudeTranscriptRoots(
  opts: ClaudeTranscriptRootsOptions = {},
): Promise<ClaudeTranscriptRoot[]> {
  const roots: ClaudeTranscriptRoot[] = [
    { path: defaultClaudeProjectsRoot(opts.projectsOverride), surface: "cli" },
  ];

  const override = process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
  if (typeof override === "string" && override.length > 0) {
    for (const raw of override.split(delimiter)) {
      const p = raw.trim();
      if (p.length > 0) roots.push({ path: p, surface: "desktop" });
    }
    return roots;
  }

  if (process.platform === "darwin") {
    const sessionsRoot = defaultClaudeDesktopSessionsRoot();
    if (await isDirectory(sessionsRoot)) {
      for (const p of await discoverDesktopProjectRoots(sessionsRoot)) {
        roots.push({ path: p, surface: "desktop" });
      }
    }
  }

  return roots;
}

/**
 * transcript パスがどの surface のルート配下にあるかを判定する(surface/originator 記録用)。
 * 複数ルートに一致する場合は最も長い(=最も具体的な)パスを優先する。どのルートにも一致しない
 * 場合は cli(旧レコード・想定外パスの安全側フォールバック)。
 */
export function surfaceForClaudePath(
  transcriptPath: string,
  roots: readonly ClaudeTranscriptRoot[],
): Surface {
  return rootForClaudePath(transcriptPath, roots)?.surface ?? "cli";
}

/** transcript パスを含む最長一致のルート。どのルートにも属さなければ null。 */
export function rootForClaudePath(
  transcriptPath: string,
  roots: readonly ClaudeTranscriptRoot[],
): ClaudeTranscriptRoot | null {
  let best: ClaudeTranscriptRoot | null = null;
  for (const root of roots) {
    const withSep = root.path.endsWith("/") ? root.path : `${root.path}/`;
    if (transcriptPath === root.path || transcriptPath.startsWith(withSep)) {
      if (best === null || root.path.length > best.path.length) best = root;
    }
  }
  return best;
}

/**
 * track.ts の hook 経路向け軽量判定。CCCN_CLAUDE_DESKTOP_ROOTS が未設定なら、既定のデスクトップ
 * ルート(macOS 固定パス)の prefix に一致しない限り surface=cli と即断でき、bounded とはいえ
 * サンドボックス配下の readdir 再帰探索を毎 Stop hook で走らせずに済む(CLI 利用が大多数のため)。
 * 環境変数で desktop ルートを上書きしている場合は任意パスになり得るため、通常の
 * claudeTranscriptRoots() 経由の判定にフォールバックする。
 */
export async function determineClaudeSurface(transcriptPath: string): Promise<Surface> {
  if (process.env.CCCN_CLAUDE_DESKTOP_ROOTS === undefined) {
    if (process.platform !== "darwin") return "cli";
    const sessionsRoot = defaultClaudeDesktopSessionsRoot();
    const withSep = sessionsRoot.endsWith("/") ? sessionsRoot : `${sessionsRoot}/`;
    if (transcriptPath !== sessionsRoot && !transcriptPath.startsWith(withSep)) return "cli";
  }
  const roots = await claudeTranscriptRoots();
  return surfaceForClaudePath(transcriptPath, roots);
}
