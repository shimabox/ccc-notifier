// src/surface.ts — history レコードの利用元(surface)の共通ヘルパー。
//
// dashboard / report / doctor が同じ後方互換ルールを使うための単一の実装場所。
// 旧レコード(surface フィールドが存在しない)は cli として解釈する(マイグレーション不要)。

import type { Surface, TurnRecord } from "./types";

export const ALL_SURFACES: readonly Surface[] = [
  "cli",
  "desktop",
  "vscode",
  "claude-code",
  "chrome-extension",
  "other",
];

/** レコードの実効 surface を返す。欠損(旧レコード) = cli。 */
export function effectiveSurface(rec: Pick<TurnRecord, "surface">): Surface {
  return rec.surface ?? "cli";
}

const SURFACE_LABELS: Record<Surface, string> = {
  cli: "CLI",
  desktop: "デスクトップアプリ",
  vscode: "VS Code拡張",
  "claude-code": "Claude Code(Codex rollout)",
  "chrome-extension": "Chrome拡張",
  other: "その他",
};

/** 表示用の日本語ラベル。未知値は surface 文字列そのままを返す。 */
export function surfaceLabel(surface: Surface): string {
  return SURFACE_LABELS[surface] ?? surface;
}
