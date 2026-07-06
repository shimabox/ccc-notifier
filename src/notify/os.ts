import notifier from "node-notifier";
import type { Config, TurnRecord } from "../types";
import { formatSummary } from "../format";
import { appendNotifyError, writeDryRun } from "./util";

const NOTIFY_TIMEOUT_MS = 3000;

/**
 * OS ネイティブ通知を送る。通知はベストエフォートであり、
 * どのような失敗が起きても reject しない(本体 Claude Code の処理を妨げない)。
 */
export async function notifyOS(record: TurnRecord, cfg: Config, todayUSD?: number): Promise<void> {
  try {
    if (!cfg?.notify?.os) return;

    const { title, body } = formatSummary(record, cfg, todayUSD);

    if (process.env.ACN_DRY_RUN === "1") {
      writeDryRun("os", { title, body });
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          try {
            notifier.notify({ title, message: body }, (err) => {
              if (err) reject(err);
              else resolve();
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("notifyOS: timed out after 3000ms")), NOTIFY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (err) {
    appendNotifyError("notifyOS", err);
  }
}
