// src/codex/originator.ts — Codex rollout の session_meta.originator を surface へ正規化する。
//
// 実機での originator 分布(2026-07-23 調査時点): codex-tui 217 / "Codex Desktop" 43 /
// "Claude Code" 17 / codex_exec 3 / codex-chrome-extension-sidepanel 2 / codex_work_desktop 1。
// マップの粒度は実装者判断でよい契約(request.md 未確定事項)だが、生の originator 値は
// 別フィールド(TurnRecord.originator)に必ず保持する。未知値は "other" へフォールバックする。

import type { Surface } from "../types";

const ORIGINATOR_TO_SURFACE: Record<string, Surface> = {
  "codex-tui": "cli",
  "codex_cli_rs": "cli",
  "codex_exec": "cli",
  "Codex Desktop": "desktop",
  "codex_desktop": "desktop",
  "codex_work_desktop": "desktop",
  "codex_vscode": "vscode",
  "Claude Code": "claude-code",
  "codex-chrome-extension-sidepanel": "chrome-extension",
};

/** originator(生値・null 許容)を surface へ正規化する。未知/欠損は "other"。 */
export function normalizeCodexOriginator(originator: string | null | undefined): Surface {
  if (typeof originator !== "string" || originator.length === 0) return "other";
  return ORIGINATOR_TO_SURFACE[originator] ?? "other";
}
