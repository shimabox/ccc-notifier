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

// 専用の AppUserModelID(AUMID)。トースト通知の送信元を "ccc-notifier" として表示するために使う。
const WIN_AUMID = "ccc-notifier.notify";
// フォールバック用: Windows に必ず登録済みの PowerShell の AUMID(専用登録に失敗しても通知は出す)。
const WIN_FALLBACK_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * スタートメニューに `ccc-notifier` ショートカットを作り、専用 AUMID を紐付ける C#。
 * トーストは AUMID がスタートメニューのショートカットに紐付いていないと送信元・内容が正しく
 * 表示されない(汎用の「新しい通知」に化ける)ため、初回のみ登録する。バックスラッシュ・バック
 * クォート・`${` を含めない(この文字列は JS テンプレートリテラルとして安全に埋め込むため)。
 * パスは Path.Combine で組み立ててリテラルのバックスラッシュを避ける。
 */
const WIN_SHORTCUT_CSHARP = `
using System;
using System.Runtime.InteropServices;
public static class CccShortcut {
  public static void Create(string shortcutPath, string aumid) {
    var link = (IShellLinkW)new CShellLink();
    string ps = System.IO.Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
    link.SetPath(ps);
    var store = (IPropertyStore)link;
    PROPVARIANT pv; InitPropVariantFromString(aumid, out pv);
    var key = new PROPERTYKEY(); key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); key.pid = 5;
    store.SetValue(ref key, ref pv); store.Commit();
    ((IPersistFile)link).Save(shortcutPath, true);
    PropVariantClear(ref pv);
  }
  [DllImport("propsys.dll")] static extern int InitPropVariantFromString([MarshalAs(UnmanagedType.LPWStr)] string psz, out PROPVARIANT ppropvar);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pvar);
}
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder f, int c, IntPtr p, int fl);
  void GetIDList(out IntPtr ppidl); void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder n, int c);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder d, int c);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder a, int c);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
  void GetHotkey(out short w); void SetHotkey(short w);
  void GetShowCmd(out int s); void SetShowCmd(int s);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder i, int c, out int idx);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string i, int idx);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string r, int d);
  void Resolve(IntPtr h, int f); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
interface IPersistFile {
  void GetClassID(out Guid c); [PreserveSig] int IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string f, int m);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool r);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
  void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
interface IPropertyStore {
  void GetCount(out uint c); void GetAt(uint i, out PROPERTYKEY k);
  void GetValue(ref PROPERTYKEY k, out PROPVARIANT pv);
  void SetValue(ref PROPERTYKEY k, ref PROPVARIANT pv); void Commit();
}
[StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; }
`;

/**
 * Windows / WSL2: WinRT のトースト通知(Windows 10/11 標準・追加インストール不要)。
 *
 * WSL2 から powershell.exe を起動する場合、Linux 側の環境変数は WSLENV に載せない限り Windows 側へ
 * 渡らない。当初はタイトル・本文を環境変数で渡していたが、これだと WSL2 では本文が空になり、汎用の
 * 「新しい通知」表示に化けてしまう。そこで:
 *  - タイトル・本文は Base64 でスクリプトに直接埋め込む(WSL 境界を越える。クォート・改行のエスケープ
 *    問題も同時に回避できる)。
 *  - 送信元を "ccc-notifier" として表示するため、初回のみスタートメニューに `ccc-notifier` ショートカット +
 *    専用 AUMID を登録する(トーストは AUMID がショートカットに紐付いていないと内容が正しく表示されない)。
 *  - 登録や表示に失敗しても、PowerShell の既知 AUMID にフォールバックして通知(本文つき)は必ず出す。
 * スクリプト本体は -EncodedCommand(UTF-16LE → Base64)で渡す。
 */
function spawnWin32Notify(title: string, body: string): ChildProcess {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const csB64 = Buffer.from(WIN_SHORTCUT_CSHARP, "utf8").toString("base64");

  const psScript = [
    "$ErrorActionPreference='Stop'",
    `$psAumid='${WIN_FALLBACK_AUMID}'`,
    `$aumid='${WIN_AUMID}'`,
    // 初回のみ ccc-notifier のショートカット + AUMID を登録。失敗したら PowerShell の AUMID へ倒す。
    "try {",
    "  $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'ccc-notifier.lnk'",
    "  if(-not (Test-Path -LiteralPath $lnk)){",
    `    Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${csB64}')))`,
    "    [CccShortcut]::Create($lnk, $aumid)",
    "  }",
    "} catch { $aumid = $psAumid }",
    // 本文は環境変数ではなく Base64 埋め込みから復元する(WSL でも確実に渡すため)。
    `$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}'))`,
    `$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(body)}'))`,
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]",
    "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$n=$t.GetElementsByTagName('text')",
    "[void]$n.Item(0).AppendChild($t.CreateTextNode($title))",
    "[void]$n.Item(1).AppendChild($t.CreateTextNode($body))",
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($t)",
    "try { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast) }",
    "catch { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($psAumid).Show($toast) }",
  ].join("\n");
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");

  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { stdio: "ignore" },
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

    if (process.env.CCCN_DRY_RUN === "1") {
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
