// src/cli.ts (T8) — エントリポイント配線。
//
// 契約: src/contracts.md の "src/cli.ts, src/doctor.ts, src/report.ts (T8)" 参照。
//
// track / init / uninstall の実体(src/track.ts / src/setup.ts)は並行実装中のため、
// あえて動的 import() にしている(トップレベルの静的 import にしない)。
// これにより、たとえ track.ts / setup.ts がまだ存在しない・型エラーを含むタイミングでも、
// このファイル自体のロードや --version / --help / doctor / report の動作は妨げられない
// (静的 import はモジュール解決に失敗した時点でファイル全体のロードごと失敗するが、
// 動的 import はその呼び出しだけが失敗する)。

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDoctor } from "./doctor";
import { runReport } from "./report";

// コマンド一覧は配列で持ち、cmd 列の幅を自動計算して揃える(手動パディングのズレを防ぐため)。
const COMMANDS: ReadonlyArray<{ cmd: string; ja: string; en: string }> = [
  { cmd: "init", ja: "Stop hook を対話形式でセットアップ", en: "Interactively set up the Stop hook" },
  {
    cmd: "uninstall [--purge]",
    ja: "Stop hook を削除(--purge でデータも削除)",
    en: "Remove the Stop hook (--purge also deletes data)",
  },
  { cmd: "doctor", ja: "設定・通知・単価・為替の動作診断", en: "Diagnose hook, notifications, pricing and fx" },
  {
    cmd: "report [--days N] [--json]",
    ja: "集計レポートをターミナルに表示",
    en: "Print an aggregated cost report",
  },
  {
    cmd: "dashboard [--days N] [--no-open] [--out <path>] [--refresh <sec>|--no-refresh]",
    ja: "HTMLダッシュボードを生成してブラウザで開く",
    en: "Generate and open the HTML dashboard",
  },
  {
    cmd: "sweep [--dry-run] [--days N] [--include-active]",
    ja: "過去の未計上分を一括で履歴に取り込む(進行中セッションは自動スキップ)",
    en: "Backfill uncounted history (active sessions are skipped)",
  },
  {
    cmd: "mute [30m|2h|1d]",
    ja: "通知を一時停止(期間省略で無期限。記録は続く)",
    en: "Pause notifications (indefinitely if no duration; tracking continues)",
  },
  { cmd: "unmute", ja: "通知を再開", en: "Resume notifications" },
  {
    cmd: "track",
    ja: "Stop hook から呼ばれる内部コマンド(手動実行は不要)",
    en: "Internal command invoked by the Stop hook (not for manual use)",
  },
  { cmd: "--version, -v", ja: "バージョンを表示", en: "Show the version" },
  { cmd: "--help, -h", ja: "このヘルプを表示", en: "Show this help" },
];

const CMD_COLUMN_WIDTH = Math.max(...COMMANDS.map((c) => c.cmd.length)) + 2;

const HELP_TEXT = [
  "agent-cost-notifier (acn) — Claude Code のプロンプトごとのコスト通知 / per-prompt cost notifier for Claude Code",
  "",
  "使い方 / Usage: acn <command> [options]",
  "",
  ...COMMANDS.map((c) => `  ${c.cmd.padEnd(CMD_COLUMN_WIDTH)}${c.ja} / ${c.en}`),
].join("\n");

function printHelp(): void {
  console.log(HELP_TEXT);
}

/**
 * package.json の version フィールドを読む。
 * createRequire(import.meta.url) を使うことで、開発時(src/cli.ts)・
 * ビルド後(dist/cli.js)のどちらから実行されても "../package.json" の相対解決が effectively
 * 同じ場所(リポジトリ / パッケージのルート)を指すようにする。失敗時は "unknown"。
 */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * stdin を読む。
 * - process.stdin.isTTY なら(パイプ入力が無い対話実行) "" を即返す。
 * - それ以外は 'data' を集め、'end' が来たら解決する。
 * - timeoutMs までに 'end' が来なくても、そこまで集めた内容で解決する
 *   (hook 側が stdin を閉じずに待たせ続けるケースでハングしないため)。
 * - 解決後は listener を外し stdin を pause/unref してプロセスの自然終了を妨げないようにする。
 */
function readStdin(timeoutMs = 500): Promise<string> {
  return new Promise<string>((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let data = "";
    let settled = false;

    const finish = (result: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      try {
        process.stdin.pause();
      } catch {
        // 停止に失敗しても解決自体は続行する。
      }
      try {
        process.stdin.unref();
      } catch {
        // unref できない環境でも致命的ではない。
      }
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };
    const onEnd = (): void => finish(data);
    const onError = (): void => finish(data);

    const timer = setTimeout(() => finish(data), timeoutMs);

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  try {
    switch (cmd) {
      case "track": {
        const text = await readStdin();
        try {
          const trackMod = await import("./track");
          await trackMod.runTrack(text);
        } catch {
          // track は Claude Code の応答完了経路(Stop hook)から呼ばれるため、
          // モジュール読み込み失敗・想定外の例外を含め、何が起きても必ず 0 を返す
          // (runTrack 自体は契約上例外を外に出さないが、二重に保険をかける)。
          // stdout には一切出力しない。
        }
        return 0;
      }
      case "init": {
        const { runInit } = await import("./setup");
        return await runInit(rest);
      }
      case "uninstall": {
        const { runUninstall } = await import("./setup");
        return await runUninstall(rest);
      }
      case "doctor":
        return await runDoctor();
      case "report":
        return await runReport(rest);
      case "dashboard": {
        const { runDashboard } = await import("./dashboard");
        return await runDashboard(rest);
      }
      case "sweep": {
        const { runSweep } = await import("./sweep");
        return await runSweep(rest);
      }
      case "mute": {
        const { runMute } = await import("./mute");
        return runMute(rest);
      }
      case "unmute": {
        const { runUnmute } = await import("./mute");
        return runUnmute();
      }
      case "--version":
      case "-v":
        console.log(readVersion());
        return 0;
      case "--help":
      case "-h":
      case undefined:
        printHelp();
        return 0;
      default:
        // 未知コマンドは絶対に track へフォールバックしない。
        printHelp();
        return 1;
    }
  } catch (err) {
    // main(): Promise<number> は決して reject しない契約とする。
    console.error(
      `agent-cost-notifier: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

/**
 * このファイルが node の直接の実行対象(エントリポイント)かどうかを判定する。
 * pathToFileURL で比較し、symlink 経由実行(npm の bin 経由など)による realpath の
 * 揺れは realpathSync で吸収する。解決に失敗した場合はエントリポイントでないとみなす
 * (vitest 等からの import で誤って main() が走らないようにするための安全側フォールバック)。
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;

  try {
    const invokedUrl = pathToFileURL(realpathSync(invoked)).href;
    const selfUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return invokedUrl === selfUrl;
  } catch {
    try {
      return pathToFileURL(invoked).href === import.meta.url;
    } catch {
      return false;
    }
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
