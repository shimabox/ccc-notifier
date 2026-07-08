import { spawn, type ChildProcess } from "node:child_process";
import type { Config, TurnRecord } from "../types";
import { formatSummary } from "../format";
import { isWSL } from "../env";
import { appendNotifyError, writeDryRun } from "./util";

const NOTIFY_TIMEOUT_MS = 3000;

/**
 * macOS: AppleScript 経由で通知センターに表示する。
 * タイトル・本文は `on run argv` の引数として渡すことで、スクリプト文字列への
 * 埋め込みによるエスケープ問題(クォートや改行を含むプロンプトなど)を根本的に回避する。
 */
function spawnDarwinNotify(title: string, body: string): ChildProcess {
  return spawn(
    "osascript",
    [
      "-e", "on run argv",
      "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run",
      title,
      body,
    ],
    { stdio: "ignore" },
  );
}

/**
 * Windows: WinRT のトースト通知(Windows 10/11 標準・追加インストール不要)。
 * タイトル・本文は環境変数(ACN_TITLE / ACN_BODY)経由で渡し、スクリプト本体は
 * -EncodedCommand(UTF-16LE → Base64)で渡すことでクォート・改行のエスケープ問題を回避する。
 */
function spawnWin32Notify(title: string, body: string): ChildProcess {
  const psScript = [
    "$ErrorActionPreference='Stop'",
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]",
    "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$n=$t.GetElementsByTagName('text')",
    "[void]$n.Item(0).AppendChild($t.CreateTextNode($env:ACN_TITLE))",
    "[void]$n.Item(1).AppendChild($t.CreateTextNode($env:ACN_BODY))",
    "$aumid='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show([Windows.UI.Notifications.ToastNotification]::new($t))",
  ].join("; ");
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");

  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { stdio: "ignore", env: { ...process.env, ACN_TITLE: title, ACN_BODY: body } },
  );
}

/**
 * Linux 等その他: notify-send によるベストエフォート通知。
 * ディストリビューションによっては通知デーモン自体が存在しないことも珍しくないため、
 * コマンド不在に伴う "error" イベントは(共通の待機処理内で)記録せず黙殺する。
 */
function spawnLinuxNotify(title: string, body: string): ChildProcess {
  return spawn("notify-send", [title, body], { stdio: "ignore" });
}

/** 通知バックエンドの種別と、spawn 失敗("error" イベント)を握りつぶすか。 */
export type NotifyBackend = { kind: "darwin" | "win32" | "linux"; swallowError: boolean };

/**
 * 現在の実行環境に応じた通知バックエンドを選ぶ(spawn しない純粋関数・テスト用に export)。
 * - WSL2 は process.platform === "linux" だが notify-send は届かないのが普通なので、
 *   Windows interop 経由で powershell.exe のトースト(win32 バックエンド)に橋渡しする。
 *   powershell.exe は通常 PATH 上にあり失敗は稀なので、素の Linux と違い失敗は記録する。
 * - 素の Linux は notify-send。通知デーモン不在によるコマンド不在は日常的なため握りつぶす。
 */
export function selectNotifyBackend(): NotifyBackend {
  if (process.platform === "darwin") return { kind: "darwin", swallowError: false };
  if (process.platform === "win32") return { kind: "win32", swallowError: false };
  if (isWSL()) return { kind: "win32", swallowError: false };
  return { kind: "linux", swallowError: true };
}

/**
 * 選択したバックエンドに応じた通知コマンドを spawn する。
 * swallowError: true の場合、spawn 自体の失敗("error" イベント)を error.log に記録しない。
 */
function spawnNotifyChild(title: string, body: string): { child: ChildProcess; swallowError: boolean } {
  const backend = selectNotifyBackend();
  if (backend.kind === "darwin") {
    return { child: spawnDarwinNotify(title, body), swallowError: backend.swallowError };
  }
  if (backend.kind === "win32") {
    return { child: spawnWin32Notify(title, body), swallowError: backend.swallowError };
  }
  return { child: spawnLinuxNotify(title, body), swallowError: backend.swallowError };
}

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

    const { child, swallowError } = spawnNotifyChild(title, body);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        child.on("error", (err) => {
          if (!swallowError) appendNotifyError("notifyOS", err);
          resolve();
        });
        child.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            appendNotifyError("notifyOS", new Error(`exit code ${code}`));
          }
          resolve();
        });
        timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // kill 自体の失敗も黙殺する。
          }
          resolve();
        }, NOTIFY_TIMEOUT_MS);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (err) {
    appendNotifyError("notifyOS", err);
  }
}
