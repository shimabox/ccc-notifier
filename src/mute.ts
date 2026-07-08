// src/mute.ts — `ccc-notifier mute` / `ccc-notifier unmute`(通知の一時停止・再開)
//
// 抑止するのは OS/Slack 通知のみ。track の履歴記録・ダッシュボード再生成は止めない
// (「静かにしてほしいが計上は続けたい」が典型ユースケースのため)。
// 状態は CCCN_HOME/muted.json({ until: string | null })。config.json には触れない。

import { clearMuteState, isMuted, readMuteState, writeMuteState } from "./store";

/** "30m" / "2h" / "1d" 形式をミリ秒へ。形式不正・0 以下は null。 */
function parseDuration(arg: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(arg);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unitMs = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return n * unitMs;
}

/** ローカルの "YYYY-MM-DD HH:mm"。表示用(dashboard.ts の fmtLocalDateTime と同形式)。doctor でも使う。 */
export function fmtMuteUntil(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function runMute(args: string[]): number {
  const duration = args[0];

  if (duration === undefined) {
    writeMuteState({ until: null });
    console.log("通知を停止しました(無期限)。再開するには ccc-notifier unmute を実行してください。");
    console.log("Notifications muted indefinitely. Run `ccc-notifier unmute` to resume.");
    console.log("※ コストの記録・ダッシュボード更新は続きます / cost tracking continues.");
    return 0;
  }

  const ms = parseDuration(duration);
  if (ms === null) {
    console.error(`期間の形式が不正です: ${duration}(例: 30m / 2h / 1d)`);
    console.error(`Invalid duration: ${duration} (examples: 30m / 2h / 1d)`);
    return 1;
  }

  const until = new Date(Date.now() + ms).toISOString();
  writeMuteState({ until });
  console.log(`通知を停止しました(${fmtMuteUntil(until)} まで)。それ以降は自動で再開します。`);
  console.log(`Notifications muted until ${fmtMuteUntil(until)} (local time), then resume automatically.`);
  console.log("※ コストの記録・ダッシュボード更新は続きます / cost tracking continues.");
  return 0;
}

export function runUnmute(): number {
  const state = readMuteState();
  if (state === null) {
    console.log("通知は停止されていません(ミュートなし)。/ Notifications are not muted.");
    return 0;
  }

  // 期限切れの muted.json が残っているだけのケースでも、掃除して「再開」と伝えてよい。
  const wasActive = isMuted();
  clearMuteState();
  if (wasActive) {
    console.log("通知を再開しました。/ Notifications resumed.");
  } else {
    console.log("期限切れのミュートを削除しました(通知はすでに再開しています)。/ Cleared an expired mute.");
  }
  return 0;
}
