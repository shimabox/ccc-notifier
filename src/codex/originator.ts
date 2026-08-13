// src/codex/originator.ts — Codex rollout の session_meta.originator を surface へ正規化する。
//
// 実機で観測される originator: codex-tui / "Codex Desktop" / "Claude Code" / codex_exec /
// codex-chrome-extension-sidepanel / codex_work_desktop など。生の originator 値は別フィールド
// (TurnRecord.originator)に必ず保持する。未知値は "other" へフォールバックする。

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
