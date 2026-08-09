// test/setup.ts — テスト全体に適用される安全網。
//
// desktop-cost-tracking(claudeTranscriptRoots / ingest / track 便乗り取込)は、明示的な env
// 上書きが無い限り実マシンの `~/.claude/projects`・`~/.codex/sessions`・
// `~/Library/Application Support/Claude/local-agent-mode-sessions` を走査しうる。
// テストがこれらを実際に踏むと(1) 実行マシン依存でテストが不安定になり、(2) 実データ(プロンプト
// 全文を含む)が一時 CCCN_HOME 配下の history.jsonl に書かれてしまう("実データの生テキストを
// テストに含めない" 方針に反する)。
//
// そのため、各テストファイル固有の beforeEach(CCCN_CLAUDE_PROJECTS 等を独自の一時ディレクトリへ
// 差し替えるもの)が上書きできるよう「外側」の beforeEach として、存在しない固定パスへ倒しておく。
// 存在しないルートは黙ってスキップされる設計なので、これらのテストは何も検出しない。

import { afterEach, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SAFE_CLAUDE_PROJECTS = join(tmpdir(), "ccc-notifier-test-safety-net", "claude-projects");
const SAFE_CLAUDE_DESKTOP_ROOTS = join(tmpdir(), "ccc-notifier-test-safety-net", "claude-desktop-roots");
const SAFE_CODEX_HOME = join(tmpdir(), "ccc-notifier-test-safety-net", "codex-home");

let prevProjects: string | undefined;
let prevDesktopRoots: string | undefined;
let prevCodexHome: string | undefined;

beforeEach(() => {
  prevProjects = process.env.CCCN_CLAUDE_PROJECTS;
  prevDesktopRoots = process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
  prevCodexHome = process.env.CCCN_CODEX_HOME;
  process.env.CCCN_CLAUDE_PROJECTS = SAFE_CLAUDE_PROJECTS;
  process.env.CCCN_CLAUDE_DESKTOP_ROOTS = SAFE_CLAUDE_DESKTOP_ROOTS;
  process.env.CCCN_CODEX_HOME = SAFE_CODEX_HOME;
});

afterEach(() => {
  if (prevProjects === undefined) delete process.env.CCCN_CLAUDE_PROJECTS;
  else process.env.CCCN_CLAUDE_PROJECTS = prevProjects;
  if (prevDesktopRoots === undefined) delete process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
  else process.env.CCCN_CLAUDE_DESKTOP_ROOTS = prevDesktopRoots;
  if (prevCodexHome === undefined) delete process.env.CCCN_CODEX_HOME;
  else process.env.CCCN_CODEX_HOME = prevCodexHome;
});
