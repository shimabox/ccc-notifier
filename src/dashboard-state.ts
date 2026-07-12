// 全履歴ダッシュボードの日次生成状態と排他ロック。
// HTML の生成成功後にだけ state を更新し、失敗時は次の新規ターンで再試行できるようにする。

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { paths } from "./store";

export interface FullDashboardState {
  localDate: string;
  timeZone: string;
  generatedAt: string;
}

function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
}

export function makeFullDashboardState(now: Date = new Date()): FullDashboardState {
  return { localDate: localDate(now), timeZone: timeZone(), generatedAt: now.toISOString() };
}

function readState(): FullDashboardState | null {
  const file = paths().dashboardFullStateFile;
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (
      typeof v.localDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.localDate) ||
      typeof v.timeZone !== "string" ||
      v.timeZone.length === 0 ||
      typeof v.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(v.generatedAt))
    ) {
      return null;
    }
    return v as unknown as FullDashboardState;
  } catch {
    return null;
  }
}

/** state が今日・現在TZ・未来でない、かつ full HTML が存在するときだけ生成済み。 */
export function isFullDashboardDue(now: Date = new Date()): boolean {
  const p = paths();
  if (!existsSync(p.fullDashboardFile)) return true;
  try {
    const fd = openSync(p.fullDashboardFile, "r");
    try {
      const head = Buffer.alloc(512);
      const n = readSync(fd, head, 0, head.length, 0);
      if (head.toString("utf8", 0, n).includes('name="cccn-placeholder"')) return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    return true;
  }
  const state = readState();
  if (state === null) return true;
  const expected = makeFullDashboardState(now);
  if (state.timeZone !== expected.timeZone) return true;
  if (state.localDate !== expected.localDate) return true;
  if (state.localDate > expected.localDate) return true;
  if (Date.parse(state.generatedAt) > now.getTime()) return true;
  return false;
}

export function writeFullDashboardStateAtomic(state: FullDashboardState): void {
  const file = paths().dashboardFullStateFile;
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 履歴の削除・redact 後に、プロンプトを含みうる canonical 生成物と状態を無効化する。 */
export function invalidateCanonicalDashboards(): void {
  const p = paths();
  for (const file of [p.recentDashboardFile, p.fullDashboardFile, p.dashboardFullStateFile]) {
    rmSync(file, { force: true });
  }
}
